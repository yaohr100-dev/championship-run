const express = require('express');
const path = require('path');
const sim = require('./sim');
const { ensureSeeded, normalize } = require('./seed');
const { als, currentSession } = require('./session');

const app = express();
const PORT = 3000; // fixed port — Railway domain target port must match this

app.use(express.json({ limit: '5mb' })); // save files (~600KB) exceed the 100kb default

// Scope every request to its own session (multi-user isolation).
app.use((req, res, next) => {
  als.run({ session: (req.query.session || 'default').toString().slice(0, 64) }, () => next());
});

ensureSeeded(); // seed the database on first run / fresh volume
const db = sim.openDb();

// ---- state helpers ----
function getState(key, def = null) {
  const row = db.prepare('SELECT value FROM state WHERE session_id = ? AND key = ?').get(currentSession(), key);
  return row ? row.value : def;
}
function setState(key, value) {
  db.prepare('INSERT INTO state (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value')
    .run(currentSession(), key, String(value));
}
function ensureRerolls() {
  const r = getState('rerolls');
  if (r === null) setState('rerolls', sim.REROLLS_PER_RUN);
  return parseInt(getState('rerolls'), 10);
}
const f1 = (x) => Math.round(x * 10) / 10;
const f3 = (x) => Math.round(x * 1000) / 1000; // 命中率保留到小数点后一位（如 45.2%）

function playerBrief(p) {
  return {
    id: p.id, name: p.name, position: p.position, position2: p.position2, age: p.age,
    overall: p.overall, epm: p.epm, oepm: p.oepm, depm: p.depm,
    pts: p.pts, trb: p.trb, ast: p.ast, stl: p.stl, blk: p.blk,
    fgPct: p.fg_pct, threePct: p.three_pct, ftPct: p.ft_pct,
    rating: +sim.powerRating(p).toFixed(1),
    salary: sim.playerSalary(p.overall, p.epm),
  };
}

// Blind mode: hide ability data server-side so DevTools / curl can't peek.
function isBlindMode() {
  return getState('mode') === 'blind';
}

// Salary cap: only NORMAL mode with hard difficulty. Dynasty deliberately has NO
// total salary cap, so a dynasty can stack talent and break through without being
// budget-blocked (difficulty stays 'hard' there for other effects, e.g. AI bonus).
function salaryCapActive() {
  return getState('difficulty') === 'hard' && getState('game_mode') !== 'dynasty';
}

// Strip ability fields from a playerBrief object in blind mode.
// Keeps: id, name, position, position2, age, pts, trb, ast, stl, blk, fgPct, threePct, ftPct
// Hides: overall, epm, oepm, depm, rating, salary
function stripAbility(brief) {
  if (!isBlindMode()) return brief;
  const { overall, epm, oepm, depm, rating, salary, ...rest } = brief;
  return rest;
}

// Apply stripAbility to an array of playerBrief objects.
function stripAbilityAll(arr) {
  if (!isBlindMode()) return arr;
  return arr.map(stripAbility);
}

// team view: starters always, full roster optional
function teamView(t, includeRoster = false) {
  const starters = t.players.filter(p => p.role === 'starter')
    .map(p => ({ name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)) }));
  const view = {
    name: t.name, isUser: t.isUser, conf: t.conf,
    strength: f1(t.strength), wins: t.wins, losses: t.losses,
    starters, games: t.gameLog || null,
  };
  if (includeRoster) {
    view.roster = t.players.map(p => ({
      name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)), role: p.role, slot: p.slot,
    }));
  }
  return view;
}

// ---- health / meta ----
app.get('/api/health', (req, res) => res.json({ ok: true, message: 'Championship Run API' }));
app.get('/api/nba-teams', (req, res) => res.json({ teams: sim.NBA_TEAMS }));

// ---- player library ----
app.get('/api/players', (req, res) => {
  const { sort = 'overall', order = 'desc', pos, q } = req.query;
  const blind = isBlindMode();
  // Blind mode: only allow sorting by non-ability columns
  const valid = blind
    ? ['name', 'position', 'age', 'pts', 'trb', 'ast', 'stl', 'blk']
    : ['name', 'position', 'overall', 'rating', 'pts', 'trb', 'ast', 'stl', 'blk', 'oepm', 'depm', 'epm', 'age'];
  const col = valid.includes(sort) ? sort : (blind ? 'name' : 'overall');
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  let sql = 'SELECT id, name, position, position2, age, overall, pts, trb, ast, stl, blk, oepm, depm, epm FROM players';
  const params = [];
  const where = ['(session_id IS NULL OR session_id = ?)'];
  params.push(currentSession());
  if (pos && ['PG', 'SG', 'SF', 'PF', 'C'].includes(pos)) { where.push('position = ?'); params.push(pos); }
  if (q) { where.push('name LIKE ?'); params.push(`%${q}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  if (col !== 'rating') sql += ` ORDER BY ${col} ${dir}`;
  const players = db.prepare(sql).all(...params).map(p => ({ ...p, rating: +sim.powerRating(p).toFixed(1) }));
  if (col === 'rating') players.sort((a, b) => (dir === 'ASC' ? a.rating - b.rating : b.rating - a.rating));
  res.json({ players: stripAbilityAll(players) });
});

// ---- matchup simulator ----
function buildMatchupTeam(spec) {
  if (!spec || !Array.isArray(spec.players) || spec.players.length !== sim.ROSTER_SIZE)
    throw new Error('Each team needs exactly 10 players');
  const starters = Array.isArray(spec.starters) ? spec.starters : [];
  const players = spec.players.map(id => db.prepare('SELECT * FROM players WHERE id = ?').get(id)).filter(Boolean);
  if (players.length !== sim.ROSTER_SIZE) throw new Error('Invalid player id in team');
  return players.map(p => {
    const s = starters.find(x => x.playerId === p.id);
    return { ...p, role: s ? 'starter' : 'bench', slot: s ? s.slot : null };
  });
}

app.post('/api/matchup', (req, res) => {
  const { teamA, teamB, mode, times } = req.body || {};
  const n = Math.max(1, Math.min(100, Math.round(+times || 10)));
  const m = mode === 'playoff' ? 'playoff' : 'regular';
  try {
    const a = buildMatchupTeam(teamA);
    const b = buildMatchupTeam(teamB);

    const accumulate = (obj, stats) => {
      for (const s of stats) {
        if (!obj[s.name]) obj[s.name] = { name: s.name, position: s.position, pts: 0, trb: 0, ast: 0, stl: 0, blk: 0 };
        obj[s.name].pts += s.pts; obj[s.name].trb += s.trb; obj[s.name].ast += s.ast; obj[s.name].stl += s.stl; obj[s.name].blk += s.blk;
      }
    };

    let aWins = 0, bWins = 0, aScoreSum = 0, bScoreSum = 0;
    const aAcc = {}, bAcc = {};
    for (let i = 0; i < n; i++) {
      const r = sim.simulateMatchup(a, b, m);
      if (r.aWins) aWins++; else bWins++;
      aScoreSum += r.aScore; bScoreSum += r.bScore;
      accumulate(aAcc, r.aStats);
      accumulate(bAcc, r.bStats);
    }

    const avg = (obj) => Object.values(obj).map(s => ({
      name: s.name, position: s.position,
      pts: f1(s.pts / n), trb: f1(s.trb / n), ast: f1(s.ast / n), stl: f1(s.stl / n), blk: f1(s.blk / n),
    }));

    res.json({
      times: n, mode: m,
      aWins, bWins,
      aAvgScore: f1(aScoreSum / n), bAvgScore: f1(bScoreSum / n),
      aStrength: f1(sim.teamStrength(a, m === 'playoff')), bStrength: f1(sim.teamStrength(b, m === 'playoff')),
      aStats: avg(aAcc), bStats: avg(bAcc),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- draft ----
// Hard-mode affordability guarantee: ensure at least one candidate fits the budget.
// Uses ACTUAL minimum salary from the player pool (not the formula estimate) so
// the reservation is correct even when low-OVR players have negative EPM.
function guaranteeAffordableCandidate(candidates, spent, rosterCount) {
  const remaining = sim.HARD_MODE_BUDGET - spent;
  const futurePicks = sim.ROSTER_SIZE - rosterCount - 1; // picks left AFTER this one
  // Actual minimum salary from the full player pool (accounts for negative EPM)
  const allSalaries = db.prepare('SELECT overall, epm FROM players WHERE session_id IS NULL OR session_id = ?').all(currentSession())
    .map(p => sim.playerSalary(p.overall, p.epm));
  const actualMinSalary = allSalaries.length ? Math.min(...allSalaries) : 1;
  // Reserve enough for future picks, but never less than actualMinSalary per pick
  const reserved = futurePicks * actualMinSalary;
  let usable = remaining - reserved;
  if (usable < actualMinSalary) usable = actualMinSalary; // never softlock
  if (candidates.some(c => sim.playerSalary(c.overall, c.epm) <= usable)) return candidates;
  // Inject an affordable player
  const drafted = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));
  const affordable = db.prepare('SELECT * FROM players WHERE session_id IS NULL OR session_id = ?').all(currentSession())
    .filter(p => !drafted.has(p.id) && sim.playerSalary(p.overall, p.epm) <= usable);
  if (affordable.length) candidates[0] = sim.shuffle(affordable)[0];
  return candidates;
}

app.get('/api/draft', (req, res) => {
  const offseasonPicks = parseInt(getState('offseason_picks') || '0', 10);
  // Annual rookie draft: always 1 pick per team, board is the full draft class
  const isRookieDraft = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;
  const offseason = isRookieDraft;
  // Dynasty's INITIAL draft shows 3 cards per round (harder choice); normal shows 5.
  const candidateCount = getState('game_mode') === 'dynasty' ? 3 : 5;
  let candidates = isRookieDraft ? draftBoard() : sim.draftCandidates(db, candidateCount);
  const hard = salaryCapActive();
  const rosterCount = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  const spent = hard
    ? db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
        .reduce((s, p) => s + sim.playerSalary(p.overall, p.epm), 0)
    : 0;

  // hard mode: guarantee at least one candidate fits the budget
  if (hard && !isRookieDraft) {
    candidates = guaranteeAffordableCandidate(candidates, spent, rosterCount);
  }

  res.json({
    rerolls: ensureRerolls(),
    rosterCount,
    rosterSize: sim.ROSTER_SIZE,
    candidates: stripAbilityAll(candidates.map(playerBrief)),
    hardMode: hard,
    budget: hard ? sim.HARD_MODE_BUDGET : null,
    spent: hard ? spent : null,
    offseason,
    offseasonPicks: isRookieDraft ? 1 : offseasonPicks,
    draftBoard: isRookieDraft ? stripAbilityAll(candidates.map(playerBrief)) : null,
    userPosition: isRookieDraft ? draftUserPosition() : null,
    picks: isRookieDraft ? (getState('draft_picks') ? JSON.parse(getState('draft_picks')) : []) : [],
    canPass: getState('draft_can_pass') === '1',
    signLimit: FA_SIGN_LIMIT, // offseason release guard uses FA sign capacity
  });
});
app.post('/api/draft/reroll', (req, res) => {
  let rerolls = ensureRerolls();
  if (rerolls <= 0) return res.status(400).json({ error: 'No rerolls left' });
  setState('rerolls', rerolls - 1);
  const offseason = parseInt(getState('offseason_picks') || '0', 10) > 0;
  const candidateCount = getState('game_mode') === 'dynasty' ? 3 : 5;
  let candidates = offseason ? draftBoard() : sim.draftCandidates(db, candidateCount);
  // hard mode (normal difficulty only): also guarantee affordability on reroll
  if (salaryCapActive() && !offseason) {
    const rosterCount = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
    const spent = db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
      .reduce((s, p) => s + sim.playerSalary(p.overall, p.epm), 0);
    candidates = guaranteeAffordableCandidate(candidates, spent, rosterCount);
  }
  res.json({ rerolls: rerolls - 1, candidates: stripAbilityAll(candidates.map(playerBrief)) });
});
app.post('/api/roster', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  // A draft pick is only valid during the draft phase. This closes the double-submit
  // window where a lagging second pick request (e.g. clicking a second card while the
  // first is in flight) lands AFTER the first pick already advanced the phase — it
  // would otherwise insert an extra player from the normal pool.
  if (getState('phase') !== 'draft') {
    return res.status(400).json({ error: 'Draft is not active right now' });
  }
  let count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  const isRookieDraft = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;

  // Roster must have room — user must release a player first
  if (count >= sim.ROSTER_SIZE) {
    return res.status(400).json({ error: 'Roster full — release a player first' });
  }
  if (db.prepare('SELECT 1 FROM roster WHERE player_id = ? AND session_id = ?').get(playerId, currentSession()))
    return res.status(400).json({ error: 'Player already drafted' });

  // salary cap: enforce (normal hard mode only; dynasty has no cap, and the rookie
  // draft has its own budget logic)
  if (salaryCapActive() && !isRookieDraft) {
    const p = db.prepare('SELECT overall, epm FROM players WHERE id = ?').get(playerId);
    const spent = db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
      .reduce((s, x) => s + sim.playerSalary(x.overall, x.epm), 0);
    const salary = sim.playerSalary(p.overall, p.epm);
    const futurePicks = sim.ROSTER_SIZE - count - 1; // picks left after this one
    // Use ACTUAL minimum salary (not formula estimate) to avoid blocking valid picks
    const allSalaries = db.prepare('SELECT overall, epm FROM players WHERE session_id IS NULL OR session_id = ?').all(currentSession())
      .map(x => sim.playerSalary(x.overall, x.epm));
    const actualMinSalary = allSalaries.length ? Math.min(...allSalaries) : 1;
    const total = spent + salary;
    if (total + futurePicks * actualMinSalary > sim.HARD_MODE_BUDGET) {
      const maxNow = sim.HARD_MODE_BUDGET - futurePicks * actualMinSalary;
      return res.status(400).json({ error: `Over budget: $${total}M (max $${maxNow}M now — keep $${actualMinSalary}M per remaining pick)` });
    }
  }

  // rookie draft: check availability BEFORE inserting (prevents data corruption)
  if (isRookieDraft) {
    const alreadyPicked = db.prepare('SELECT 1 FROM league_teams WHERE player_id = ? AND session_id = ?').get(playerId, currentSession());
    if (alreadyPicked) return res.status(400).json({ error: 'This player was already drafted by another team' });
  }

  db.prepare('INSERT INTO roster (session_id, player_id, role, slot) VALUES (?, ?, ?, ?)').run(currentSession(), playerId, 'bench', null);
  // initialize dynasty age + contract + devo for this player (by NAME, unless already tracked)
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  const pname = db.prepare('SELECT name, age, session_id FROM players WHERE id = ?').get(playerId);
  if (pname) {
    if (ages[pname.name] == null) ages[pname.name] = pname.age;
    seedContract(contracts, pname.name, pname.session_id != null);
    seedDevo(devo, pname.name);
    setPlayerAges(ages);
    setPlayerContracts(contracts);
    setPlayerDevo(devo);
  }
  // rookie draft: record the pick, then AI teams behind the user auto-draft
  if (isRookieDraft) {
    const p = db.prepare('SELECT name, position, overall FROM players WHERE id = ?').get(playerId);
    const picks = getState('draft_picks') ? JSON.parse(getState('draft_picks')) : [];
    picks.push({ team: getState('team_name') || 'My Team', player: p.name, position: p.position, overall: p.overall });
    setState('draft_picks', JSON.stringify(picks));
    // done: AI teams behind the user pick, then clear draft state
    const afterUser = getState('draft_pending_after') ? JSON.parse(getState('draft_pending_after')) : [];
    runAIDraft(afterUser);
    clearDraftState();
    setState('phase', 'freeagency');
  }
  res.json({ ok: true, rosterCount: count + 1 });
});

// Pass on the annual rookie draft: skip your pick, remaining AI teams auto-draft.
app.post('/api/draft/pass', (req, res) => {
  if (getState('phase') !== 'draft') return res.status(400).json({ error: 'Draft is not active right now' });
  const isDrafting = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;
  if (!isDrafting) return res.status(400).json({ error: 'No active draft to pass' });
  const picks = getState('draft_picks') ? JSON.parse(getState('draft_picks')) : [];
  picks.push({ team: getState('team_name') || 'My Team', player: '(passed)', position: '', overall: 0 });
  setState('draft_picks', JSON.stringify(picks));
  const afterUser = getState('draft_pending_after') ? JSON.parse(getState('draft_pending_after')) : [];
  runAIDraft(afterUser);
  clearDraftState();
  setState('phase', 'freeagency');
  res.json({ ok: true });
});

// ---- roster / lineup ----
app.get('/api/roster', (req, res) => {
  const roster = applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
  const contracts = playerContracts();
  res.json({ roster: roster.map(p => ({ ...stripAbility(playerBrief(p)), role: p.role, slot: p.slot, contract: contracts[p.name] ?? null })), rosterSize: sim.ROSTER_SIZE, starterCount: sim.STARTER_COUNT });
});

// ---- offseason free agency (dynasty) ----
const FA_MARKET_SIZE = 15;
const FA_MAX_REFRESH = 1;    // only one refresh per offseason
const FA_SALARY_CAP = 450; // tighter cap for FA
const FA_SIGN_LIMIT = 2;   // max signings per offseason

function faMarket() {
  return getState('fa_market') ? JSON.parse(getState('fa_market')) : [];
}

// The FA market is persisted as a list of player IDs (see buildFAMarket). Resolve
// them back to full player rows so playerBrief() gets objects, not bare ids —
// calling playerBrief on an id produced all-undefined candidates ("undefined" cards).
function faMarketPlayers() {
  const ids = faMarket();
  if (!ids.length) return [];
  // Drop any market player who has since been signed onto the roster, so their card
  // (with the Sign button) disappears instead of staying clickable after signing.
  const rosterIds = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map((r) => r.player_id));
  const byId = new Map(db.prepare(`SELECT * FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter((p) => p && !rosterIds.has(p.id));
}
function faRefreshes() {
  return parseInt(getState('fa_refreshes') || String(FA_MAX_REFRESH), 10);
}

// Generate a new FA market: a fixed pool of candidates drawn once.
// NOTE: does NOT reset fa_refreshes — that counter is only (re)set when the market
// is first built, so a manual refresh actually consumes a refresh.
function buildFAMarket() {
  const pool = sim.freeAgentPool(db);
  const market = sim.shuffle(pool).slice(0, FA_MARKET_SIZE);
  setState('fa_market', JSON.stringify(market.map(p => p.id)));
  return market;
}

app.get('/api/freeagency', (req, res) => {
  const roster = applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
  const contracts = playerContracts();
  let market = faMarketPlayers();
  if (!market.length) {
    market = buildFAMarket();
    setState('fa_refreshes', String(FA_MAX_REFRESH)); // full refreshes only on a fresh market
  }
  const salTotal = roster.reduce((s, p) => s + sim.playerSalary(p.overall, p.epm), 0);
  const signed = parseInt(getState('fa_signed') || '0', 10);
  // position needs
  const posCount = {};
  for (const p of roster) posCount[p.position] = (posCount[p.position] || 0) + 1;
  const needs = sim.POSITIONS.filter(pos => (posCount[pos] || 0) < 2);
  res.json({
    roster: roster.map((p) => ({ ...stripAbility(playerBrief(p)), role: p.role, slot: p.slot, contract: contracts[p.name] ?? null })),
    rosterSize: sim.ROSTER_SIZE,
    candidates: stripAbilityAll(market.map(playerBrief)),
    salTotal,
    salCap: FA_SALARY_CAP,
    refreshes: faRefreshes(),
    needs,
    signLimit: FA_SIGN_LIMIT,
    signed,
  });
});

app.post('/api/fa/refresh', (req, res) => {
  const left = faRefreshes();
  if (left <= 0) return res.status(400).json({ error: 'No refreshes left' });
  setState('fa_refreshes', String(left - 1));
  const market = buildFAMarket();
  res.json({ candidates: stripAbilityAll(market.map(playerBrief)), refreshes: left - 1 });
});

app.post('/api/release', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  const session = currentSession();
  const row = db.prepare('SELECT p.name FROM roster r JOIN players p ON p.id = r.player_id WHERE r.player_id = ? AND r.session_id = ?').get(playerId, session);
  if (!row) {
    // Player not on roster — already released or removed. Still clear contract.
    const pname = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId);
    if (pname) {
      const contracts = playerContracts();
      delete contracts[pname.name];
      setPlayerContracts(contracts);
    }
    return res.json({ ok: true });
  }
  // Dynasty offseason soft-lock guard: FA can only fill `FA_SIGN_LIMIT - signed`
  // more spots, and the season needs exactly 10 — so releasing past that point would
  // leave the roster unable to refill and the player stuck. Applies during free
  // agency and the annual rookie draft (where releases free a pick slot).
  if (getState('game_mode') === 'dynasty') {
    const phase = getState('phase');
    const inRookieDraft = phase === 'draft' && (getState('draft_class') && JSON.parse(getState('draft_class')).length > 0);
    if (phase === 'freeagency' || inRookieDraft) {
      const count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(session).c;
      const signed = parseInt(getState('fa_signed') || '0', 10);
      const fillCapacity = FA_SIGN_LIMIT - signed;
      if (count - 1 < sim.ROSTER_SIZE - fillCapacity) {
        return res.status(400).json({ error: `Cannot release: roster would drop below what free agency can refill (${fillCapacity} signing${fillCapacity === 1 ? '' : 's'} left)` });
      }
    }
  }
  db.prepare('DELETE FROM roster WHERE player_id = ? AND session_id = ?').run(playerId, session);
  const contracts = playerContracts();
  delete contracts[row.name];
  setPlayerContracts(contracts);
  res.json({ ok: true });
});

app.post('/api/sign', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  const session = currentSession();
  const count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(session).c;
  if (count >= sim.ROSTER_SIZE) return res.status(400).json({ error: 'Roster full — release a player first' });
  // prevent signing a player already on the roster — a stale FA card double-click
  // would otherwise insert a duplicate roster row for the same player
  if (db.prepare('SELECT 1 FROM roster WHERE player_id = ? AND session_id = ?').get(playerId, session)) {
    return res.status(400).json({ error: 'This player is already on your roster' });
  }
  const p = db.prepare('SELECT name, age, session_id, overall, epm FROM players WHERE id = ?').get(playerId);
  if (!p) return res.status(400).json({ error: 'Player not found' });
  // FA salary cap check
  const roster = applyDynasty(db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session));
  const curSal = roster.reduce((s, x) => s + sim.playerSalary(x.overall, x.epm), 0);
  const newSal = curSal + sim.playerSalary(p.overall, p.epm);
  if (salaryCapActive() && newSal > FA_SALARY_CAP) {
    return res.json({ accepted: false, message: `薪资空间不足: 当前 $${curSal}M + 签约 $${sim.playerSalary(p.overall, p.epm)}M = $${newSal}M (上限 $${FA_SALARY_CAP}M)` });
  }
  // FA signing limit per offseason
  const signed = parseInt(getState('fa_signed') || '0', 10);
  if (getState('game_mode') === 'dynasty' && signed >= FA_SIGN_LIMIT) {
    return res.json({ accepted: false, message: `本赛季自由市场签约已达上限(${FA_SIGN_LIMIT}人)` });
  }
  db.prepare('INSERT INTO roster (session_id, player_id, role, slot) VALUES (?, ?, ?, ?)').run(session, playerId, 'bench', null);
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  if (ages[p.name] == null) ages[p.name] = p.age;
  seedContract(contracts, p.name, p.session_id != null);
  // FA signings get shorter contracts (1-2 years, not the normal 2-4)
  if (getState('game_mode') === 'dynasty') contracts[p.name] = 1 + Math.floor(Math.random() * 2); // 1-2 years
  seedDevo(devo, p.name);
  setPlayerAges(ages);
  setPlayerContracts(contracts);
  setPlayerDevo(devo);
  setState('fa_signed', String(signed + 1));
  res.json({ ok: true, rosterCount: count + 1, salary: newSal });
});

// Leave free agency and move to the lineup (roster must be full).
// AI teams also fill their gaps from the FA market.
app.post('/api/freeagency/done', (req, res) => {
  const session = currentSession();
  const count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(session).c;
  if (count !== sim.ROSTER_SIZE) return res.status(400).json({ error: `Roster must be full (${sim.ROSTER_SIZE}) before continuing` });

  // AI teams auto-sign from remaining FA pool to fill gaps
  const marketIds = faMarket();
  const available = new Set(marketIds);
  // remove players already on user roster
  for (const r of db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session)) available.delete(r.player_id);
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  const confOf = {};
  for (const t of sim.NBA_TEAMS) confOf[t.name] = t.conf;
  const ltRows = db.prepare('SELECT team_name, player_id FROM league_teams WHERE session_id = ?').all(session);
  const byTeam = {};
  for (const r of ltRows) { if (!byTeam[r.team_name]) byTeam[r.team_name] = []; byTeam[r.team_name].push(r.player_id); }
  const ins = db.prepare('INSERT INTO league_teams (session_id, team_name, conf, player_id, role, slot) VALUES (?, ?, ?, ?, ?, ?)');
  // fill teams that have <10 players
  const draftOrder = getState('draft_order') ? JSON.parse(getState('draft_order')) : Object.keys(byTeam);
  for (const team of draftOrder) {
    const roster = byTeam[team] || [];
    while (roster.length < sim.ROSTER_SIZE && available.size > 0) {
      const pickId = [...available].reduce((best, id) => {
        const p = db.prepare('SELECT id, overall FROM players WHERE id = ?').get(id);
        return p && (!best || p.overall > best.overall) ? p : best;
      }, null);
      if (!pickId) break;
      available.delete(pickId.id);
      const p = db.prepare('SELECT name, age FROM players WHERE id = ?').get(pickId.id);
      ins.run(session, team, confOf[team] || 'West', pickId.id, roster.length < sim.STARTER_COUNT ? 'starter' : 'bench', null);
      if (p) { ages[p.name] = p.age; contracts[p.name] = 2; seedDevo(devo, p.name); }
      roster.push(pickId.id);
    }
  }
  setPlayerAges(ages);
  setPlayerContracts(contracts);
  setPlayerDevo(devo);
  setState('fa_market', '[]');
  setState('fa_refreshes', String(FA_MAX_REFRESH));
  setState('phase', 'lineup');
  res.json({ ok: true });
});
app.post('/api/lineup', (req, res) => {
  const { teamName, conference, replacedTeam, starters } = req.body || {};
  const rosterCount = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  if (rosterCount !== sim.ROSTER_SIZE) return res.status(400).json({ error: 'Roster must be full (10)' });
  if (!Array.isArray(starters) || starters.length !== sim.STARTER_COUNT)
    return res.status(400).json({ error: 'Need exactly 5 starters with slots' });

  // Mid-season "Adjust lineup" must NOT reset the run back to preseason (that would
  // re-simulate the first half, carry traded-in players into it, and reset trade
  // points). Team name/conference/phase are only set when the season hasn't started.
  const curPhase = getState('phase');
  const isMidseason = curPhase === 'midseason';
  if (!isMidseason) {
    setState('team_name', teamName || replacedTeam || 'My Team');
    setState('conference', conference === 'East' ? 'East' : 'West');
    setState('replaced_team', replacedTeam || 'Boston Celtics');
  }
  db.prepare("UPDATE roster SET role = 'bench', slot = NULL WHERE session_id = ?").run(currentSession());
  for (const s of starters) {
    db.prepare("UPDATE roster SET role = 'starter', slot = ? WHERE player_id = ? AND session_id = ?").run(s.slot, s.playerId, currentSession());
  }
  upsertCurrentTeam();
  if (!isMidseason) setState('phase', 'preseason');
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  const { difficulty, mode, gameMode } = req.body || {};
  // Dynasty/short modes force hard + open; short modes set a lower max seasons.
  const gm = gameMode || 'normal';
  const isDynasty = gm === 'dynasty';
  db.prepare('DELETE FROM roster WHERE session_id = ?').run(currentSession());
  db.prepare('DELETE FROM league_teams WHERE session_id = ?').run(currentSession());
  db.prepare('DELETE FROM state WHERE session_id = ?').run(currentSession());
  // A new run in the same session must start from a clean slate: drop this session's
  // generated rookies too, so a fresh draft draws only from the real player pool
  // (and resolveLeague won't rebuild an old dynasty league on season 1).
  db.prepare('DELETE FROM players WHERE session_id = ?').run(currentSession());
  if (isDynasty || difficulty === 'hard') setState('difficulty', 'hard');
  setState('mode', isDynasty ? 'open' : (mode === 'blind' ? 'blind' : 'open'));
  setState('game_mode', gm);
  setState('dynasty_max', String(DYNASTY_MAX_SEASONS));
  setState('season_number', '1');
  setState('season_history', '[]');
  setState('phase', 'draft');
  res.json({ ok: true, gameMode: gm });
});

// ---- dynasty: advance to the next season ----
// Persist this season's (post-trade) AI rosters, age the whole league +1, retire
// players past their caliber-based retirement age, generate a rookie class, then run
// the annual draft: the user picks first (one per retiree), then AI teams auto-pick.
const DYNASTY_MAX_SEASONS = 10;

// Append (or update-in-place) this season's outcome to the dynasty history.
// Called from next-season, and also when a run ends WITHOUT calling next-season
// (the final dynasty season, whether made or missed the playoffs), so the last
// season is always recorded. Deduplicated by season number so the final-season
// and next-season paths can both fire safely.
function appendSeasonHistory(seasonNumber) {
  const record = getState('season_record') ? JSON.parse(getState('season_record')) : null;
  if (!record) return;
  const playoff = getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null;
  const seasonResult = getState('season_result') ? JSON.parse(getState('season_result')) : null;
  const champion = playoff && playoff.champion;
  const userChampion = champion != null && !playoff.userEliminated;
  const mvp = seasonResult && seasonResult.awards && seasonResult.awards.mvp ? seasonResult.awards.mvp.player : null;
  let history = getState('season_history') ? JSON.parse(getState('season_history')) : [];
  history = history.filter((h) => h.season !== seasonNumber); // dedup
  history.push({
    season: seasonNumber,
    wins: record.wins, losses: record.losses,
    result: userChampion ? 'champion' : (playoff && playoff.userEliminated ? `eliminated_r${playoff.userEliminatedRound || '?'}` : (playoff ? 'playoffs' : 'missed_playoffs')),
    champion: champion || null, // champion team name
    userChampion,
    mvp,
  });
  setState('season_history', JSON.stringify(history));
}

app.post('/api/next-season', (req, res) => {
  const isDynasty = getState('game_mode') === 'dynasty';
  const seasonNumber = parseInt(getState('season_number') || '1', 10);
  const session = currentSession();

  // Persist this season's AI rosters (post-trade) into league_teams so trades carry over.
  const rawLeague = getState('season_league');
  if (rawLeague) persistLeague(JSON.parse(rawLeague));

  // snapshot this season's (pre-morale) user overalls so next season's result screen
  // can show each player's year-over-year growth.
  const prevAges = playerAges();
  const prevDevo = playerDevo();
  const prevRosterRows = db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
  const prevOveralls = {};
  for (const p of prevRosterRows) {
    const curAge = prevAges[p.name] != null ? prevAges[p.name] : p.age;
    prevOveralls[p.name] = sim.effectiveOverall(p.overall, p.age, curAge, prevDevo[p.name] || 1);
  }
  setState('prev_overalls', JSON.stringify(prevOveralls));

  // Record this season in the dynasty history (done here so the entry survives the
  // transient-state reset below; the final dynasty season also appends via
  // appendSeasonHistory from the run-end path, deduped by season number).
  const record = getState('season_record') ? JSON.parse(getState('season_record')) : null;
  const playoff = getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null;
  const seasonResult = getState('season_result') ? JSON.parse(getState('season_result')) : null;

  // full draft order: lottery for non-playoff teams (weighted by record), then
  // playoff teams in reverse order. Worst non-playoff team gets best odds.
  const standings = getState('season_standings') ? JSON.parse(getState('season_standings')) : null;
  const userTeamName = getState('team_name') || 'My Team';
  let fullOrder = [];
  if (standings) {
    const allTeams = [...standings.east, ...standings.west].sort((a, b) => a.wins - b.wins);
    const nonPlayoff = allTeams.slice(0, 14); // bottom 14 teams
    const playoff = allTeams.slice(14);        // top 16 teams
    // lottery: each non-playoff team gets balls proportional to (max_wins - wins + 1)
    // worst team gets most balls, but no guaranteed top pick
    const maxWins = Math.max(...nonPlayoff.map(t => t.wins));
    const lotteryPool = [];
    for (const t of nonPlayoff) {
      const balls = maxWins - t.wins + 1; // worst team: most balls
      for (let i = 0; i < balls; i++) lotteryPool.push(t);
    }
    // draw lottery order (remove duplicates as they're drawn)
    const drawn = new Set();
    const lotteryOrder = [];
    while (lotteryOrder.length < nonPlayoff.length && lotteryPool.length > 0) {
      const idx = Math.floor(Math.random() * lotteryPool.length);
      const t = lotteryPool[idx];
      if (!drawn.has(t.name)) {
        drawn.add(t.name);
        lotteryOrder.push(t);
      }
      lotteryPool.splice(idx, 1);
    }
    // remaining non-playoff teams not drawn (shouldn't happen but safety)
    for (const t of nonPlayoff) {
      if (!drawn.has(t.name)) lotteryOrder.push(t);
    }
    // playoff teams already sorted ascending by wins → worst playoff record picks
    // first, best record picks last (no reverse — reversing would hand the top
    // rookie to the best team).
    fullOrder = [...lotteryOrder, ...playoff].map(t => t.name);
    // store lottery results for UI
    setState('draft_lottery', JSON.stringify(lotteryOrder.map((t, i) => ({
      pick: i + 1, team: t.name, wins: t.wins, isUser: t.name === userTeamName,
    }))));
  } else {
    fullOrder = [userTeamName, ...sim.shuffle(sim.NBA_TEAMS.map((t) => t.name)).slice(0, 29)];
  }
  const userIndex = fullOrder.indexOf(userTeamName);

  // age the whole league +1, then retire each player past their caliber-based age
  const ages = playerAges();
  for (const name of Object.keys(ages)) ages[name] += 1;

  const retirements = []; // user retirees (names)
  const userRetirePositions = []; // user retirees' positions (for draft needs)
  const retiredLegends = []; // hall-of-fame worthy retirees (overall >= 85)
  const userRetirees = []; // full user retirees incl. role players (for the recap)
  const roster = db.prepare('SELECT r.player_id, p.name, p.age, p.overall, p.position FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
  for (const row of roster) {
    if (ages[row.name] != null && ages[row.name] >= sim.retireAge(row.overall)) {
      retirements.push(row.name);
      userRetirePositions.push(row.position);
      const legend = row.overall >= 85;
      userRetirees.push({ name: row.name, position: row.position, overall: row.overall, legend });
      if (legend) retiredLegends.push({ name: row.name, position: row.position, overall: row.overall, team: userTeamName, isUser: true });
      db.prepare('DELETE FROM roster WHERE player_id = ? AND session_id = ?').run(row.player_id, session);
      delete ages[row.name];
    }
  }

  const aiNeeds = {}; // team_name -> [retired positions]
  const aiRows = db.prepare('SELECT lt.team_name, lt.player_id, p.name, p.overall, p.position FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.session_id = ?').all(session);
  for (const r of aiRows) {
    if (ages[r.name] != null && ages[r.name] >= sim.retireAge(r.overall)) {
      (aiNeeds[r.team_name] = aiNeeds[r.team_name] || []).push(r.position);
      if (r.overall >= 85) retiredLegends.push({ name: r.name, position: r.position, overall: r.overall, team: r.team_name, isUser: false });
      db.prepare('DELETE FROM league_teams WHERE player_id = ? AND session_id = ?').run(r.player_id, session);
      delete ages[r.name];
    }
  }
  setPlayerAges(ages);

  // enshrine hall-of-fame worthy retirees
  if (retiredLegends.length) {
    const hof = getState('hall_of_fame') ? JSON.parse(getState('hall_of_fame')) : [];
    for (const l of retiredLegends) hof.push({ ...l, season: seasonNumber });
    setState('hall_of_fame', JSON.stringify(hof));
  }

  // P7: Record career stats for all user players this season
  const careerStats = getState('career_stats') ? JSON.parse(getState('career_stats')) : {};
  const myAverages = getState('season_averages') ? JSON.parse(getState('season_averages')) : [];
  for (const p of myAverages) {
    if (!careerStats[p.name]) careerStats[p.name] = { seasons: [], totalPts: 0, totalGames: 0 };
    careerStats[p.name].seasons.push({ season: seasonNumber, pts: p.pts, trb: p.trb, ast: p.ast });
    const gamesPlayed = p.half === 'first' || p.half === 'second' ? HALF_GAMES : HALF_GAMES * 2; // full season = 82
    careerStats[p.name].totalPts += p.pts * gamesPlayed;
    careerStats[p.name].totalGames += gamesPlayed;
  }
  setState('career_stats', JSON.stringify(careerStats));

  // P8: Generate league news from this season.
  // Stored as STRUCTURED events (type + data), NOT rendered strings — the recap
  // screen localizes them on the client, so English/中文 both work regardless of
  // which language the backend "speaks".
  const news = [];
  if (playoff && playoff.champion) news.push({ type: 'champion', team: playoff.champion, season: sim.seasonLabel(seasonNumber) });
  if (seasonResult && seasonResult.awards && seasonResult.awards.mvp) {
    const mvp = seasonResult.awards.mvp;
    news.push({ type: 'mvp', player: mvp.player, team: mvp.team });
  }
  if (retiredLegends.length) {
    news.push({ type: 'legends', names: retiredLegends.slice(0, 3).map(l => l.name) });
  }
  if (record) {
    if (record.wins >= 60) news.push({ type: 'dominant', team: userTeamName, wins: record.wins });
    else if (record.wins <= 25) news.push({ type: 'rebuild', team: userTeamName, wins: record.wins });
  }
  if (myAverages.length) {
    const top = myAverages.sort((a, b) => b.pts - a.pts)[0];
    if (top.pts >= 25) news.push({ type: 'scorer', player: top.name, pts: top.pts.toFixed(1) });
  }
  setState('league_news', JSON.stringify(news));

  // decrement contracts league-wide. Expired deals roll for re-sign willingness:
  // factors include team record, player morale, age, and overall. If the player
  // refuses, they leave the roster (user) or league_teams (AI) and become a free agent.
  const contracts = playerContracts();
  const morale = playerMorale();
  const alive = new Set(Object.keys(ages));
  const expiring = []; // {name, overall, age, morale} for players whose contract hit 0
  for (const name of Object.keys(contracts)) {
    if (!alive.has(name)) { delete contracts[name]; delete morale[name]; continue; }
    contracts[name] -= 1;
    if (contracts[name] <= 0) {
      // find this player's overall from DB
      const pRow = db.prepare('SELECT overall FROM players WHERE name = ?').get(name);
      const ovr = pRow ? pRow.overall : 70;
      const curAge = ages[name] || 26;
      const m = morale[name] || 0;
      expiring.push({ name, overall: ovr, age: curAge, morale: m });
      // auto-renew for now; will be removed below if player refuses
      contracts[name] = veteranContract();
    }
  }

  // Re-sign willingness: multiplicative model applied to ALL players (user + AI).
  //   base: 12% for everyone
  //   quality multiplier: stars (OVR≥85) have 1.5x leverage, superstars (≥90) 2.0x
  //   morale multiplier: unhappy (≤-2) → 1.8x, slightly unhappy (<0) → 1.3x
  //   team multiplier: bad teams (winPct<35%) → 1.4x
  //   age dampener: veterans (≥33) → 0.5x (prefer stability)
  //   clamp: 3% - 45%
  // NOTE: morale and winPct are per-player (from their own team), not global.
  const refused = [];

  // Build per-team win% from standings for AI teams
  const teamWinPct = {};
  if (standings) {
    for (const t of [...(standings.east || []), ...(standings.west || [])]) {
      const total = (t.wins || 0) + (t.losses || 0);
      teamWinPct[t.name] = total > 0 ? t.wins / total : 0.5;
    }
  }
  // User's own win%
  const userWinPct = record ? record.wins / (record.wins + record.losses) : 0.5;

  // Find which team each player belongs to (for AI players)
  const playerTeam = {};
  const ltAll = db.prepare('SELECT p.name, lt.team_name FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.session_id = ?').all(session);
  for (const r of ltAll) playerTeam[r.name] = r.team_name;
  // User's players belong to userTeamName
  const userRosterNames = db.prepare('SELECT p.name FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
  for (const r of userRosterNames) playerTeam[r.name] = userTeamName;

  for (const p of expiring) {
    const isUser = playerTeam[p.name] === userTeamName;
    // Each player's team record matters, not the global user record
    const myWinPct = isUser ? userWinPct : (teamWinPct[playerTeam[p.name]] || 0.5);

    let prob = 0.12;
    if (p.overall >= 90) prob *= 2.0;
    else if (p.overall >= 85) prob *= 1.5;
    else if (p.overall >= 78) prob *= 1.2;
    if (p.morale <= -2) prob *= 1.8;
    else if (p.morale < 0) prob *= 1.3;
    if (myWinPct < 0.35) prob *= 1.4;
    if (p.age >= 33) prob *= 0.5;
    prob = Math.max(0.03, Math.min(0.45, prob));
    if (Math.random() < prob) {
      refused.push({ ...p, team: playerTeam[p.name] || '?' });
      delete contracts[p.name];
    }
  }

  // Remove refused players from user roster and AI league_teams
  if (refused.length) {
    const refusedNames = new Set(refused.map(p => p.name));
    // user roster
    const userRoster = db.prepare('SELECT r.player_id, p.name FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
    for (const r of userRoster) {
      if (refusedNames.has(r.name)) {
        db.prepare('DELETE FROM roster WHERE player_id = ? AND session_id = ?').run(r.player_id, session);
      }
    }
    // AI league_teams
    const ltRows = db.prepare('SELECT lt.player_id, p.name FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.session_id = ?').all(session);
    for (const r of ltRows) {
      if (refusedNames.has(r.name)) {
        db.prepare('DELETE FROM league_teams WHERE player_id = ? AND session_id = ?').run(r.player_id, session);
      }
    }
  }

  setPlayerContracts(contracts);

  // settle season morale for ALL players (user + AI): winning lifts it, losing
  // drags it, and bench players grow dissatisfied with a smaller role.
  // User players: morale based on user's own record
  const moraleRows = db.prepare('SELECT p.name, r.role FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
  for (const row of moraleRows) {
    let m = morale[row.name] || 0;
    if (userWinPct > 0.6) m += 2;
    else if (userWinPct < 0.4) m -= 2;
    if (row.role === 'bench') m -= 1;
    morale[row.name] = Math.max(-5, Math.min(5, m));
  }
  // AI players: morale based on their own team's record
  if (standings) {
    const allTeams = [...(standings.east || []), ...(standings.west || [])];
    for (const t of allTeams) {
      const total = (t.wins || 0) + (t.losses || 0);
      const wp = total > 0 ? t.wins / total : 0.5;
      const aiPlayers = db.prepare('SELECT p.name, lt.role FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.team_name = ? AND lt.session_id = ?').all(t.name, session);
      for (const row of aiPlayers) {
        let m = morale[row.name] || 0;
        if (wp > 0.6) m += 2;
        else if (wp < 0.4) m -= 2;
        if (row.role === 'bench') m -= 1;
        morale[row.name] = Math.max(-5, Math.min(5, m));
      }
    }
  }
  setPlayerMorale(morale);

  // update chemistry: players who stayed on roster get +1 per season, new arrivals start at 0
  // Applies to user AND AI teams (fair)
  const chem = playerChemistry();
  const rosterNames = db.prepare('SELECT p.name FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session).map(r => r.name);
  for (const name of rosterNames) {
    chem[name] = (chem[name] || 0) + 1;
  }
  // AI teams: track chemistry for their players too
  if (standings) {
    for (const t of [...(standings.east || []), ...(standings.west || [])]) {
      const aiRoster = db.prepare('SELECT p.name FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.team_name = ? AND lt.session_id = ?').all(t.name, session);
      for (const r of aiRoster) {
        chem[r.name] = (chem[r.name] || 0) + 1;
      }
    }
  }
  setPlayerChemistry(chem);

  // goal failure penalty: if dynasty goal not met, -1 morale to all user players
  const goal = getState('season_goal') ? JSON.parse(getState('season_goal')) : null;
  if (goal && record) {
    const seasonRes = getState('season_result') ? JSON.parse(getState('season_result')) : null;
    const conf = getState('conference') || 'West';
    const goalEval = seasonRes ? evaluateGoal(goal, seasonRes, conf) : null;
    const goalMet = goalEval ? goalEval.met : false;
    if (!goalMet) {
      for (const row of moraleRows) {
        morale[row.name] = Math.max(-5, (morale[row.name] || 0) - 1);
      }
      setPlayerMorale(morale);
    }
  }

  const totalRetirees = retirements.length + Object.values(aiNeeds).reduce((a, b) => a + b.length, 0);

  // reset transient season state, keep identity + dynasty + difficulty/mode + history
  const keep = ['team_name', 'conference', 'replaced_team', 'difficulty', 'mode', 'game_mode', 'player_ages', 'player_contracts', 'player_devo', 'player_morale', 'player_chemistry', 'prev_overalls', 'hall_of_fame', 'career_stats', 'league_news', 'season_history'];
  const keepVals = {};
  for (const k of keep) { const v = getState(k); if (v !== null) keepVals[k] = v; }
  db.prepare('DELETE FROM state WHERE session_id = ?').run(session);
  for (const [k, v] of Object.entries(keepVals)) setState(k, v);
  appendSeasonHistory(seasonNumber);
  setState('season_number', String(seasonNumber + 1));
  setState('rerolls', String(sim.REROLLS_PER_RUN));

  // AI offseason trades: teams with positional surpluses trade with teams that have
  // gaps. Up to 5 trades, balanced value only. This makes the AI league dynamic —
  // teams actively improve, not just passively age.
  const aiTradeLog = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const ltRows2 = db.prepare('SELECT lt.team_name, lt.player_id, p.name, p.overall, p.position FROM league_teams lt JOIN players p ON p.id = lt.player_id WHERE lt.session_id = ?').all(session);
    const byTeam2 = {};
    for (const r of ltRows2) { if (!byTeam2[r.team_name]) byTeam2[r.team_name] = []; byTeam2[r.team_name].push(r); }
    const teamNames = Object.keys(byTeam2);
    if (teamNames.length < 2) break;
    // pick two random teams
    const tA = teamNames[Math.floor(Math.random() * teamNames.length)];
    let tB = teamNames[Math.floor(Math.random() * teamNames.length)];
    if (tA === tB) continue;
    const rosterA = byTeam2[tA] || [];
    const rosterB = byTeam2[tB] || [];
    // find a position where A has surplus (3+) and B has weakness (1 or fewer)
    for (const pos of sim.POSITIONS) {
      const surplusA = rosterA.filter(p => p.position === pos);
      const weakB = rosterB.filter(p => p.position === pos);
      if (surplusA.length >= 3 && weakB.length <= 1) {
        // B has something A needs?
        for (const pos2 of sim.POSITIONS) {
          if (pos2 === pos) continue;
          const surplusB = rosterB.filter(p => p.position === pos2);
          const weakA = rosterA.filter(p => p.position === pos2);
          if (surplusB.length >= 3 && weakA.length <= 1) {
            // swap: A gives worst of pos, B gives worst of pos2
            const giveA = surplusA.sort((a,b) => a.overall - b.overall)[0];
            const giveB = surplusB.sort((a,b) => a.overall - b.overall)[0];
            if (Math.abs(giveA.overall - giveB.overall) <= 8) {
              // execute swap in league_teams
              db.prepare('UPDATE league_teams SET team_name = ? WHERE player_id = ? AND session_id = ?').run(tB, giveA.player_id, session);
              db.prepare('UPDATE league_teams SET team_name = ? WHERE player_id = ? AND session_id = ?').run(tA, giveB.player_id, session);
              aiTradeLog.push(`${tA} ⇄ ${tB}: ${giveA.name}(${giveA.position}) for ${giveB.name}(${giveB.position})`);
              break;
            }
          }
        }
        break;
      }
    }
  }

  // generate exactly 30 rookies every year, always run the draft
  const rookies = sim.generateDraftClass(db, 30);
  setState('draft_class', JSON.stringify(rookies.map((r) => r.id)));
  setState('draft_order', JSON.stringify(fullOrder));
  setState('draft_needs', JSON.stringify({ ...aiNeeds, [userTeamName]: userRetirePositions }));
  setState('draft_picks', '[]');

  // AI teams ahead of the user pick first; user picks 1 at their slot (or passes);
  // remaining AI teams pick after. User can cut a player if roster is full.
  runAIDraft(fullOrder.slice(0, userIndex));
  setState('draft_pending_after', JSON.stringify(fullOrder.slice(userIndex + 1)));
  setState('phase', 'draft');
  setState('draft_can_pass', '1');

  const dynastyMax = parseInt(getState('dynasty_max') || String(DYNASTY_MAX_SEASONS), 10);
  res.json({
    ok: true,
    retirements,
    aiRetirees: aiNeeds,
    refused: refused || [],
    offseasonPicks: 1, // the annual rookie draft is always one pick per team
    seasonNumber: seasonNumber + 1,
    isFinal: isDynasty && seasonNumber >= dynastyMax,
    seasonRecap: {
      season: seasonNumber,
      champion: playoff ? playoff.champion : null,
      mvp: seasonResult && seasonResult.awards && seasonResult.awards.mvp ? { player: seasonResult.awards.mvp.player, team: seasonResult.awards.mvp.team } : null,
      retirements: userRetirees, // ALL user retirees (role players too), not just legends
      retiredLegends,
      refused: refused || [],
      aiTrades: aiTradeLog || [],
      news: getState('league_news') ? JSON.parse(getState('league_news')) : [],
    },
  });
});

// ---- save / load teams ----
// ---- auto-save: one clean record per team, upserted as the run progresses ----
function currentResults() {
  const ps = getState('playoff_state');
  return {
    season: getState('season_record') ? JSON.parse(getState('season_record')) : null,
    seasonStandings: getState('season_standings') ? JSON.parse(getState('season_standings')) : null,
    seasonAverages: getState('season_averages') ? JSON.parse(getState('season_averages')) : null,
    playoff: getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null,
    playoffAverages: getState('playoff_averages') ? JSON.parse(getState('playoff_averages')) : null,
    leagueTradeLog: getState('league_trade_log') ? JSON.parse(getState('league_trade_log')) : [],
    playoffBracket: ps ? JSON.parse(ps).rounds.map((round) => round.map((s) => ({ conf: s.conf, winner: s.winner, loser: s.loser, wins: s.wins, mvp: s.mvp, isUserSeries: s.isUserSeries, winnerIsUser: s.winnerIsUser, loserIsUser: s.loserIsUser }))) : null,
  };
}

// Save (or update) the current roster as a named team. Teams are matched by their
// exact 10-player roster, so re-saving the same team updates one record instead of
// piling up duplicates.
function upsertCurrentTeam(nameOverride) {
  const roster = db.prepare('SELECT player_id, role, slot FROM roster WHERE session_id = ?').all(currentSession());
  if (roster.length !== sim.ROSTER_SIZE) return null;
  const name = nameOverride || getState('team_name') || 'My Team';
  const resultsJson = JSON.stringify(currentResults());

  const sortedIds = roster.map(r => r.player_id).sort((a, b) => a - b);
  const existing = db.prepare('SELECT id FROM teams WHERE session_id = ?').all(currentSession()).find(t => {
    const ids = db.prepare('SELECT player_id FROM team_players WHERE team_id = ?').all(t.id)
      .map(r => r.player_id).sort((a, b) => a - b);
    return ids.length === sortedIds.length && ids.every((v, i) => v === sortedIds[i]);
  });

  const ins = db.prepare('INSERT INTO team_players (team_id, player_id, role, slot) VALUES (?, ?, ?, ?)');
  if (existing) {
    db.prepare('UPDATE teams SET name = ?, results_json = ? WHERE id = ?').run(name, resultsJson, existing.id);
    db.prepare('DELETE FROM team_players WHERE team_id = ?').run(existing.id);
    for (const r of roster) ins.run(existing.id, r.player_id, r.role, r.slot);
    return existing.id;
  }
  const info = db.prepare('INSERT INTO teams (session_id, name, results_json) VALUES (?, ?, ?)').run(currentSession(), name, resultsJson);
  const teamId = info.lastInsertRowid;
  for (const r of roster) ins.run(teamId, r.player_id, r.role, r.slot);
  return teamId;
}

app.post('/api/save', (req, res) => {
  const { name } = req.body || {};
  const teamId = upsertCurrentTeam(name);
  if (teamId === null) return res.status(400).json({ error: 'Roster must be full (10) to save' });
  res.json({ ok: true, teamId });
});
app.get('/api/teams', (req, res) => {
  const teams = db.prepare('SELECT id, name, created_at, results_json FROM teams WHERE session_id = ? ORDER BY id DESC').all(currentSession());
  res.json({ teams: teams.map(t => ({ id: t.id, name: t.name, created_at: t.created_at, results: t.results_json ? JSON.parse(t.results_json) : null })) });
});
app.delete('/api/teams/:id', (req, res) => {
  db.prepare('DELETE FROM team_players WHERE team_id = ?').run(req.params.id);
  db.prepare('DELETE FROM teams WHERE id = ? AND session_id = ?').run(req.params.id, currentSession());
  res.json({ ok: true });
});

// ---- trophy room ----
app.get('/api/trophies', (req, res) => {
  res.json({ trophies: db.prepare('SELECT id, type, player_name, team_name, season_number, created_at FROM trophies WHERE session_id = ? ORDER BY season_number DESC, id DESC').all(currentSession()) });
});

// Hall of Fame: retired legends (overall >= 85) across this dynasty run.
app.get('/api/halloffame', (req, res) => {
  const hof = getState('hall_of_fame') ? JSON.parse(getState('hall_of_fame')) : [];
  res.json({ legends: hof });
});

// ---- regular season (split into two halves with a mid-season lineup adjustment) ----

const HALF_GAMES = 41;

function getConfig() {
  return {
    conference: getState('conference') || 'West',
    replacedTeam: getState('replaced_team') || 'Boston Celtics',
    teamName: getState('team_name') || 'My Team',
    hard: getState('difficulty') === 'hard',
    seasonNumber: parseInt(getState('season_number') || '1', 10),
  };
}

function getUserTeam() {
  const team = db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
    .sort((a, b) => {
      // same order as AI teams: starters first, then bench; each group by 2K overall desc
      if (a.role !== b.role) return a.role === 'starter' ? -1 : 1;
      return b.overall - a.overall || sim.powerRating(b) - sim.powerRating(a);
    });
  return applyDynasty(team);
}

// ---- dynasty (multi-season) ----
// Each session tracks a per-player CURRENT age in state (`player_ages`, a JSON map
// player NAME -> age). A player's effective overall is their base 2K overall plus the
// age curve: young players rise to their peak, veterans decline. Applied to the whole
// league (user + all AI teams), which is persisted in `league_teams` across seasons.
// Keyed by NAME (not id) so reseeds and export/import — which remap players by name —
// preserve dynasty ages.
function playerAges() {
  const raw = getState('player_ages');
  return raw ? JSON.parse(raw) : {};
}
function setPlayerAges(ages) {
  setState('player_ages', JSON.stringify(ages));
}

// Per-player remaining contract years, keyed by NAME (same convention as player_ages
// so reseeds/export-import preserve it). Rookies get a 4-year deal; veterans 2-4.
function playerContracts() {
  const raw = getState('player_contracts');
  return raw ? JSON.parse(raw) : {};
}
function setPlayerContracts(contracts) {
  setState('player_contracts', JSON.stringify(contracts));
}
const veteranContract = () => 2 + Math.floor(Math.random() * 3); // 2-4 years
// Seed a contract length for `name` if not already tracked.
function seedContract(contracts, name, isRookie) {
  if (contracts[name] == null) contracts[name] = isRookie ? 4 : veteranContract();
}

// Chemistry: tracks how many seasons each player has been on the user's roster.
// Keyed by NAME. Higher chemistry = player performs slightly better (+0.5 OVR per
// season together, capped at +3). Resets when player leaves.
function playerChemistry() {
  const raw = getState('player_chemistry');
  return raw ? JSON.parse(raw) : {};
}
function setPlayerChemistry(chem) {
  setState('player_chemistry', JSON.stringify(chem));
}

// Season-level morale per player (keyed by NAME), range -5..5. Settled each offseason
// from role + team record; nudges a player's effective overall by ~±3.
function playerMorale() {
  const raw = getState('player_morale');
  return raw ? JSON.parse(raw) : {};
}
function setPlayerMorale(morale) {
  setState('player_morale', JSON.stringify(morale));
}

// Per-player development factor (keyed by NAME), range 0.90–1.10. Generated once when
// a player first enters a dynasty run, stays stable for that run, varies between runs.
// Applied only to growth (age curve going up), not decline.
function playerDevo() {
  const raw = getState('player_devo');
  return raw ? JSON.parse(raw) : {};
}
function setPlayerDevo(devo) {
  setState('player_devo', JSON.stringify(devo));
}
function seedDevo(devo, name) {
  if (devo[name] == null) devo[name] = +(0.70 + Math.random() * 0.60).toFixed(2); // 0.70–1.30 (wider range for more bust/boom variance)
}

// Overwrite overall + age on a team's roster rows with their dynasty-adjusted values,
// plus a season-morale nudge (±3) and a fallback potential for new players.
// EPM is now derived from current effective OVR via sim.derivedEpm().
// No independent EPM drift — EPM always reflects actual ability.

function applyDynasty(players) {
  const ages = playerAges();
  const morale = playerMorale();
  const devo = playerDevo();
  const chem = playerChemistry();
  for (const p of players) {
    const curAge = ages[p.name] != null ? ages[p.name] : p.age;
    if (ages[p.name] != null) {
      const baseAge = p.age;
      const baseOverall = p.overall;
      const baseEpm = p.epm; // database value = base EPM for individual variation
      p.overall = sim.effectiveOverall(baseOverall, baseAge, curAge, devo[p.name] || 1);
      p.epm = sim.derivedEpm(p.overall, baseEpm);
      const epmFromOvr = (p.overall - 80) * 0.33;
      const blended = epmFromOvr * 0.85 + baseEpm * 0.15;
      p.oepm = +Math.max(-3, Math.min(5, blended * 0.55)).toFixed(1);
      p.depm = +Math.max(-3, Math.min(4, blended * 0.45)).toFixed(1);
      p.age = curAge;
    }
    // morale: ±0.5 OVR per morale point
    const m = morale[p.name] || 0;
    if (m) p.overall = Math.max(40, p.overall + Math.round(m * 0.5));
    // chemistry: +0.5 OVR per season together, capped at +3
    const c = chem[p.name] || 0;
    if (c > 0) p.overall = Math.min(99, p.overall + Math.min(3, Math.round(c * 0.5)));
  }
  return players;
}

// ---- dynasty league persistence (AI teams carry over and age) ----

// Persist the freshly-built AI league into league_teams (season 1 only).
function persistLeague(league) {
  const session = currentSession();
  db.prepare('DELETE FROM league_teams WHERE session_id = ?').run(session);
  const ins = db.prepare('INSERT INTO league_teams (session_id, team_name, conf, player_id, role, slot) VALUES (?, ?, ?, ?, ?, ?)');
  for (const t of league.teams) {
    if (t.isUser) continue;
    for (const p of t.players) ins.run(session, t.name, t.conf, p.id, p.role, p.slot);
  }
}

// Seed player_ages + contracts + devo for every AI player so the whole league ages.
function seedLeagueAges(league) {
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  for (const t of league.teams) {
    if (t.isUser) continue;
    for (const p of t.players) {
      if (ages[p.name] == null) ages[p.name] = p.age;
      seedContract(contracts, p.name, false);
      seedDevo(devo, p.name);
    }
  }
  setPlayerAges(ages);
  setPlayerContracts(contracts);
  setPlayerDevo(devo);
}

// Rank a 10-man team: top 5 by effective overall as starters at their natural slot.
function assignLeagueRoles(players) {
  const ranked = [...players].sort((a, b) => b.overall - a.overall || sim.powerRating(b) - sim.powerRating(a));
  const starters = ranked.slice(0, sim.STARTER_COUNT);
  const bench = ranked.slice(sim.STARTER_COUNT);
  return [
    ...starters.map((p) => ({ ...p, role: 'starter', slot: p.position })),
    ...bench.map((p) => ({ ...p, role: 'bench', slot: null })),
  ];
}

// Rebuild the league from persisted league_teams (season > 1): join players, apply the
// dynasty age curve to every AI player, and re-rank roles.
function rebuildLeague(userTeam, config) {
  const session = currentSession();
  const rows = db.prepare('SELECT team_name, conf, player_id FROM league_teams WHERE session_id = ?').all(session);
  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.team_name)) byTeam.set(r.team_name, { name: r.team_name, conf: r.conf, ids: [] });
    byTeam.get(r.team_name).ids.push(r.player_id);
  }
  const playersById = new Map();
  const ids = rows.map((r) => r.player_id);
  if (ids.length) {
    for (const p of db.prepare(`SELECT * FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) playersById.set(p.id, p);
  }
  const aiTeams = [];
  for (const t of byTeam.values()) {
    const players = applyDynasty(t.ids.map((id) => playersById.get(id)).filter(Boolean));
    aiTeams.push({ isUser: false, conf: t.conf, players: assignLeagueRoles(players), name: t.name });
  }
  return [{ isUser: true, conf: config.conference, players: userTeam, name: config.teamName || config.replacedTeam }, ...aiTeams];
}

// Resolve the league: build + persist on season 1; rebuild from the table after that.
function resolveLeague(userTeam, config) {
  const session = currentSession();
  const existing = db.prepare('SELECT COUNT(*) c FROM league_teams WHERE session_id = ?').get(session).c;
  if (existing === 0) {
    const league = sim.buildLeague(db, userTeam, config);
    persistLeague(league);
    seedLeagueAges(league);
    return league;
  }
  const teams = rebuildLeague(userTeam, config);
  const aiBonus = config.hard ? sim.HARD_AI_BONUS : 0;
  const strengthOf = (t) => sim.teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  const leagueAvg = teams.reduce((s, t) => s + strengthOf(t), 0) / teams.length;
  return { teams, leagueAvg, aiBonus };
}

// ---- annual rookie draft ----

// This year's full draft board: every unclaimed rookie, best first.
// Excludes rookies already picked by the user (roster) AND by AI teams (league_teams).
function draftBoard() {
  const classIds = getState('draft_class') ? JSON.parse(getState('draft_class')) : [];
  const session = currentSession();
  const pickedByUser = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session).map((r) => r.player_id));
  const pickedByAI = new Set(db.prepare('SELECT player_id FROM league_teams WHERE session_id = ?').all(session).map((r) => r.player_id));
  const avail = classIds.filter((id) => !pickedByUser.has(id) && !pickedByAI.has(id));
  if (!avail.length) return [];
  const players = db.prepare(`SELECT * FROM players WHERE id IN (${avail.map(() => '?').join(',')})`).all(...avail);
  return players.sort((a, b) => b.overall - a.overall);
}

// Highest-overall available rookie, preferring a match on the wanted positions.
function bestAvailableRookie(availableIds, wantedPositions = []) {
  if (!availableIds.size) return null;
  const ids = [...availableIds];
  const players = db.prepare(`SELECT id, overall, position FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (wantedPositions.length) {
    const matches = players.filter((p) => wantedPositions.includes(p.position));
    if (matches.length) { matches.sort((a, b) => b.overall - a.overall); return matches[0].id; }
  }
  players.sort((a, b) => b.overall - a.overall);
  return players[0].id;
}

// AI teams auto-pick in `teamsToPick` order. Every team picks at least 1 rookie
// (real NBA: all 30 teams pick every year regardless of retirements). Teams with
// retired positions get position-specific picks; others pick BPA (best available).
// After picking, teams with >10 players drop their worst bench player.
function runAIDraft(teamsToPick) {
  const classIds = getState('draft_class') ? JSON.parse(getState('draft_class')) : [];
  const needs = getState('draft_needs') ? JSON.parse(getState('draft_needs')) : {};
  if (!classIds.length || !teamsToPick || !teamsToPick.length) return;
  const session = currentSession();
  const picked = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session).map((r) => r.player_id));
  const pickedByAI = new Set(db.prepare('SELECT player_id FROM league_teams WHERE session_id = ?').all(session).map((r) => r.player_id));
  const available = new Set(classIds.filter((id) => !picked.has(id) && !pickedByAI.has(id)));
  const confOf = {};
  for (const t of sim.NBA_TEAMS) confOf[t.name] = t.conf;
  const ins = db.prepare('INSERT INTO league_teams (session_id, team_name, conf, player_id, role, slot) VALUES (?, ?, ?, ?, ?, ?)');
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  const picks = getState('draft_picks') ? JSON.parse(getState('draft_picks')) : [];

  for (const team of teamsToPick) {
    const wanted = needs[team] || [];
    let pickedAny = false;
    // Phase 1: fill retired positions (position-specific)
    for (const pos of wanted) {
      const rookieId = bestAvailableRookie(available, [pos]);
      if (rookieId == null) break;
      available.delete(rookieId);
      const p = db.prepare('SELECT name, age, position, overall FROM players WHERE id = ?').get(rookieId);
      ins.run(session, team, confOf[team], rookieId, 'bench', null);
      if (p) { ages[p.name] = p.age; contracts[p.name] = 4; seedDevo(devo, p.name); }
      picks.push({ team, player: p.name, position: p.position, overall: p.overall });
      pickedAny = true;
    }
    // Phase 2: every team picks at least 1 — if no retirements, take BPA
    if (!pickedAny) {
      const rookieId = bestAvailableRookie(available);
      if (rookieId != null) {
        available.delete(rookieId);
        const p = db.prepare('SELECT name, age, position, overall FROM players WHERE id = ?').get(rookieId);
        ins.run(session, team, confOf[team], rookieId, 'bench', null);
        if (p) { ages[p.name] = p.age; contracts[p.name] = 4; seedDevo(devo, p.name); }
        picks.push({ team, player: p.name, position: p.position, overall: p.overall });
      }
    }
  }

  // Phase 3: teams with >10 players drop their worst bench player
  const ltRows = db.prepare('SELECT team_name, player_id FROM league_teams WHERE session_id = ?').all(session);
  const byTeam = {};
  for (const r of ltRows) { if (!byTeam[r.team_name]) byTeam[r.team_name] = []; byTeam[r.team_name].push(r.player_id); }
  for (const [team, ids] of Object.entries(byTeam)) {
    while (ids.length > sim.ROSTER_SIZE) {
      // find worst bench player
      const players = ids.map(id => db.prepare('SELECT id, overall, position FROM players WHERE id = ?').get(id)).filter(Boolean);
      const worst = players.sort((a, b) => a.overall - b.overall)[0];
      if (worst) {
        db.prepare('DELETE FROM league_teams WHERE player_id = ? AND session_id = ?').run(worst.id, session);
        ids.splice(ids.indexOf(worst.id), 1);
      } else break;
    }
  }

  setPlayerAges(ages);
  setPlayerContracts(contracts);
  setPlayerDevo(devo);
  setState('draft_picks', JSON.stringify(picks));
}

function clearDraftState() {
  setState('draft_class', '[]');
  setState('draft_order', '[]');
  setState('draft_needs', '{}');
  setState('draft_picks', '[]');
  setState('draft_pending_after', '[]');
}

// The user's 1-based draft position this year (based on last season's standings).
function draftUserPosition() {
  const order = getState('draft_order') ? JSON.parse(getState('draft_order')) : [];
  const idx = order.indexOf(getState('team_name') || 'My Team');
  return idx >= 0 ? idx + 1 : null;
}

function validateSeasonTeam(userTeam) {
  if (userTeam.length !== sim.ROSTER_SIZE) return 'Roster must be full';
  if (userTeam.filter((p) => p.role === 'starter').length !== sim.STARTER_COUNT) return 'Set your 5 starters first';
  return null;
}

// Format a team's per-player averages (raw totals divided by `div`, or already-averaged
// values with div=1). Includes ALL players (traded-away ones too) and tags each with
// 'full' | 'first' (traded away at mid-season) | 'second' (traded in at mid-season).
function formatUserAverages(entries, userTeam, div = 1) {
  const byName = new Map(userTeam.map((p) => [p.name, p]));
  return entries.map((a) => {
    const rp = byName.get(a.name);
    return {
      name: a.name, position: a.position, role: rp ? rp.role : null, slot: rp ? rp.slot : null,
      half: a.half || 'full',
      pts: f1(a.pts / div), trb: f1(a.trb / div), ast: f1(a.ast / div), stl: f1(a.stl / div), blk: f1(a.blk / div),
      fgPct: f3(a.fgPct / div), threePct: f3(a.threePct / div), ftPct: f3(a.ftPct / div), epm: f1(a.epm / div),
      mvp: a.mvp || 0,
    };
  }).sort((x, y) => y.pts - x.pts);
}

// Generate a season goal based on team strength relative to the league.
// Returns { type, target, phase } — the DESCRIPTION is localized on the client
// (the backend must not bake in a language).
//   phase: 'regular' = evaluable after regular season; 'playoff' = only after playoffs.
function generateSeasonGoal(teamStrength, leagueAvg) {
  const diff = teamStrength - leagueAvg;
  if (diff > 5) return { type: 'champion', target: 0, phase: 'playoff' };
  if (diff > 2) return { type: 'conf_finals', target: 0, phase: 'playoff' };
  if (diff > -1) return { type: 'playoffs', target: 0, phase: 'regular' };
  if (diff > -4) return { type: 'wins', target: 42, phase: 'regular' };
  return { type: 'wins', target: 35, phase: 'regular' };
}

// Evaluate season goal. Returns null if playoffs haven't finished yet for a
// playoff-phase goal (caller should wait). Result is STRUCTURED ({ met, reasonKey,
// wins, target }) — the client localizes the reason, so no hardcoded language here.
function evaluateGoal(goal, result, conf) {
  if (!goal) return { met: false, reasonKey: 'none', wins: null, target: null };
  const allTeams = [...result.east, ...result.west];
  const me = allTeams.find(t => t.isUser);
  if (!me) return { met: false, reasonKey: 'notFound', wins: null, target: null };
  const madePlayoffs = (conf === 'East' ? result.east : result.west).slice(0, 8).some(t => t.isUser);
  const playoffResult = getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null;

  // Playoff-phase goals: return null if playoffs haven't finished
  if (goal.phase === 'playoff' && !playoffResult) return null;

  switch (goal.type) {
    case 'champion': {
      const userChamp = playoffResult && playoffResult.champion && !playoffResult.userEliminated;
      return { met: !!userChamp, reasonKey: userChamp ? 'champion' : 'champion_miss', wins: null, target: null };
    }
    case 'conf_finals': {
      const reached = playoffResult && (!playoffResult.userEliminated || (playoffResult.userEliminatedRound || 0) >= 3);
      return { met: !!reached, reasonKey: reached ? 'conf_finals' : 'conf_finals_miss', wins: null, target: null };
    }
    case 'playoffs': {
      return { met: madePlayoffs, reasonKey: madePlayoffs ? 'playoffs' : 'playoffs_miss', wins: null, target: null };
    }
    case 'wins': {
      const met = me.wins >= goal.target;
      return { met, reasonKey: met ? 'wins' : 'wins_miss', wins: me.wins, target: goal.target };
    }
    default: return { met: false, reasonKey: 'unknown', wins: null, target: null };
  }
}

// Shared season-finish: awards → trophies, save state, auto-save team, respond.
function finishSeason(res, config, result, playerAverages) {
  setState('season_result', JSON.stringify(result));
  const conf = config.conference;
  const myConf = conf === 'East' ? result.east : result.west;
  const madePlayoffs = myConf.slice(0, 8).some((t) => t.isUser);
  const myStanding = [...result.east, ...result.west].find((t) => t.isUser);
  setState('season_record', JSON.stringify({ wins: myStanding.wins, losses: myStanding.losses, conference: conf }));

  // evaluate season goal (playoff-phase goals deferred until playoffs finish)
  const goal = getState('season_goal') ? JSON.parse(getState('season_goal')) : null;
  const goalResult = goal && goal.phase === 'playoff' ? null : evaluateGoal(goal, result, conf);

  // generate mid-season narrative events from accumulated stats.
  // Structured (type + data) so the client localizes them; no hardcoded language.
  const events = [];
  const myPlayers = playerAverages || [];
  // breakout star: top scorer on user team averaged 25+ ppg
  const topScorer = [...myPlayers].sort((a, b) => b.pts - a.pts)[0];
  if (topScorer && topScorer.pts >= 25) events.push({ type: 'breakout', player: topScorer.name, pts: topScorer.pts.toFixed(1) });
  // defensive anchor: player with most blocks+steals
  const defPlayer = [...myPlayers].sort((a, b) => (b.stl + b.blk) - (a.stl + a.blk))[0];
  if (defPlayer && (defPlayer.stl + defPlayer.blk) >= 3) events.push({ type: 'defense', player: defPlayer.name, stl: defPlayer.stl.toFixed(1), blk: defPlayer.blk.toFixed(1) });
  // team chemistry: if won 50+ games
  if (myStanding.wins >= 50) events.push({ type: 'chemistry', wins: myStanding.wins });
  // struggle: if lost 50+ games
  if ((82 - myStanding.wins) >= 50) events.push({ type: 'struggle', wins: myStanding.wins, losses: 82 - myStanding.wins });
  setState('season_game_log', JSON.stringify(myStanding.gameLog || []));
  setState('season_averages', JSON.stringify(playerAverages));
  setState('season_standings', JSON.stringify({
    east: result.east.map((t) => teamView(t, true)),
    west: result.west.map((t) => teamView(t, true)),
    awards: result.awards,
    leagueAvg: f1(result.leagueAvg),
  }));

  if (result.awards) {
    for (const [type, key] of [['season_mvp', 'mvp'], ['dpoy', 'dpoy'], ['six_man', 'sixMan']]) {
      const a = result.awards[key];
      if (a && a.isUser) addTrophy(type, a.player, a.team);
    }
    for (const a of (result.awards.firstTeam || [])) {
      if (a && a.isUser) addTrophy('all_nba', a.player, a.team);
    }
  }

  upsertCurrentTeam();

  const report = {
    teamName: config.teamName,
    conference: conf,
    replacedTeam: config.replacedTeam,
    leagueAvg: f1(result.leagueAvg),
    east: result.east.map((t) => teamView(t, true)),
    west: result.west.map((t) => teamView(t, true)),
    playerAverages,
    gameLog: myStanding.gameLog || [],
    awards: result.awards,
    madePlayoffs,
    goal,
    goalResult,
    events,
  };
  setState('phase', 'season');
  setState('season_report', JSON.stringify(report));
  // Record a dynasty season that missed the playoffs here — next-season appends the
  // history entry for seasons that continue, but the final dynasty season never
  // calls next-season, so without this its record would be missing from the history.
  if (getState('game_mode') === 'dynasty' && !madePlayoffs) {
    appendSeasonHistory(parseInt(getState('season_number') || '1', 10));
  }
  res.json(report);
}

// Full season in one shot (used by the test scripts).
app.post('/api/season', (req, res) => {
  const userTeam = getUserTeam();
  const err = validateSeasonTeam(userTeam);
  if (err) return res.status(400).json({ error: err });
  const config = getConfig();
  const league = resolveLeague(userTeam, config);
  const result = sim.simulateSeasonWithLeague(league.teams, league.leagueAvg, league.aiBonus);
  const me = [...result.east, ...result.west].find((t) => t.isUser);
  finishSeason(res, config, result, formatUserAverages(me.playerAverages, userTeam));
});

// First half: build the league, simulate 41 games, then hold for a mid-season decision.
app.post('/api/season/start', (req, res) => {
  const userTeam = getUserTeam();
  const err = validateSeasonTeam(userTeam);
  if (err) return res.status(400).json({ error: err });
  const config = getConfig();

  // If the dynasty OFFSEASON trade window already built the league (with trades
  // applied to the AI teams), reuse it instead of rebuilding — otherwise build now.
  // Either way the user team is replaced with the current roster (post-trade).
  let leagueData = null;
  const rawLeague = getState('season_league');
  if (rawLeague && getState('game_mode') === 'dynasty') leagueData = JSON.parse(rawLeague);
  if (!leagueData) leagueData = resolveLeague(userTeam, config);
  const aiBonus = leagueData.aiBonus || 0;
  const teams = leagueData.teams.map((t) => (t.isUser ? { ...t, players: userTeam } : t));
  const strengthOf = (t) => sim.teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  const leagueAvg = teams.reduce((s, t) => s + strengthOf(t), 0) / teams.length;
  const schedule = sim.buildSchedule(teams);
  const standings = sim.simulateGames(teams, schedule.first, aiBonus);

  // generate season goal based on team strength vs league
  const userStr = sim.teamStrength(userTeam);
  const goal = generateSeasonGoal(userStr, leagueAvg);
  setState('season_goal', JSON.stringify(goal));

  setState('season_league', JSON.stringify({ teams, leagueAvg, aiBonus }));
  setState('season_schedule', JSON.stringify(schedule));
  setState('season_standings', JSON.stringify(standings));
  // Dynasty: the offseason trade window already started this cycle's trade points
  // (shared with the upcoming mid-season window). Normal mode: fresh points.
  if (getState('game_mode') !== 'dynasty') setState('trade_points', '0');
  setState('trade_proposals', JSON.stringify(generateProposals(userTeam, teams)));
  setState('league_trade_log', '[]');

  const me = standings.find((t) => t.isUser);
  const east = standings.filter((t) => t.conf === 'East').sort((a, b) => b.wins - a.wins);
  const west = standings.filter((t) => t.conf === 'West').sort((a, b) => b.wins - a.wins);
  const report = {
    games: HALF_GAMES,
    wins: me.wins,
    losses: me.losses,
    gameLog: me.gameLog,
    playerAverages: formatUserAverages(Object.values(me.acc), userTeam, HALF_GAMES),
    east: east.map((t) => teamView(t, true)),
    west: west.map((t) => teamView(t, true)),
    goal: goal,
  };
  setState('phase', 'midseason');
  setState('midseason_report', JSON.stringify(report));
  res.json(report);
});

// Second half: simulate the remaining games (using the possibly-adjusted lineup).
app.post('/api/season/finish', (req, res) => {
  const rawLeague = getState('season_league');
  const rawStandings = getState('season_standings');
  const rawSchedule = getState('season_schedule');
  if (!rawLeague || !rawStandings || !rawSchedule) return res.status(400).json({ error: 'Start the season first' });

  const { teams, leagueAvg, aiBonus } = JSON.parse(rawLeague);
  const standings1 = JSON.parse(rawStandings);
  const schedule = JSON.parse(rawSchedule);

  const userTeam = getUserTeam();
  const err = validateSeasonTeam(userTeam);
  if (err) return res.status(400).json({ error: err });

  // swap in the (possibly adjusted) user team lineup + traded roster
  const teams2 = teams.map((t) => (t.isUser ? { ...t, players: userTeam } : t));
  const strengthOf = (t) => sim.teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  const leagueAvg2 = teams2.reduce((s, t) => s + strengthOf(t), 0) / teams2.length;
  const standings2 = sim.simulateGames(teams2, schedule.second, aiBonus);

  const combined = sim.mergeStandings(standings1, standings2, HALF_GAMES * 2);
  const result = sim.finalizeSeason(combined, HALF_GAMES * 2, leagueAvg2);
  const me = combined.find((t) => t.isUser);

  finishSeason(res, getConfig(), result, formatUserAverages(me.playerAverages, userTeam));
});

// ---- trade window (mid-season) ----

const TRADE_ACCEPT_MARGIN = 3; // per player: AI gives up at most this much total overall more
const MAX_TRADE_POINTS = 3;    // trade points per season: 1-for-1 = 1, 2-for-2 = 2, 3-for-3 = 3

function tradePoints() { return parseInt(getState('trade_points') || '0', 10); }

function tradeValue(players) {
  // Normal mode: pure overall value (no age discount — it's just one season).
  // Dynasty mode: mild age curve so OVR stays the primary factor.
  // Age can shift value by at most ~8% — never enough to bridge a 10-point OVR gap.
  if (getState('game_mode') !== 'dynasty') return players.reduce((s, p) => s + p.overall, 0);
  const ages = playerAges();
  return players.reduce((s, p) => {
    const age = ages[p.name] || p.age || 26;
    // Gentle curve: young premium +0.5%/yr before 27 (capped +3%), old discount
    // -1.0%/yr after 27, floored at -8% so aging stays "mild".
    //   age 22 → +2.5%   age 27 → 0%   age 33 → -6%   age 35 → -8% (floor)
    const f = age <= 27 ? Math.min(1.03, 1.0 + (27 - age) * 0.005) : Math.max(0.92, 1.0 - (age - 27) * 0.01);
    return s + Math.round(p.overall * f);
  }, 0);
}

function myRosterRows() {
  return applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
}

// The league used for trades. During the mid-season window `season_league` already
// exists; in the dynasty OFFSEASON (before a season starts) we build it on demand so
// trades work, and start a FRESH trade-point cycle shared with the upcoming season's
// mid-season window (offseason + mid-season = 3 points total).
function tradeLeague() {
  const raw = getState('season_league');
  if (raw) return JSON.parse(raw);
  const config = getConfig();
  const userTeam = getUserTeam();
  const league = resolveLeague(userTeam, config);
  setState('season_league', JSON.stringify(league));
  if (getState('trade_points') == null) setState('trade_points', '0');
  return league;
}

// Compact player info for trade pool / offers / proposals. Includes age + per-game
// stats (observed performance, shown even in blind mode) so the player can evaluate
// an offer — previously only name/position/overall were sent.
function brief(p) {
  return {
    id: p.id, name: p.name, position: p.position, position2: p.position2,
    age: p.age, overall: p.overall, pts: p.pts, trb: p.trb, ast: p.ast,
  };
}

// Current-season simulated per-game averages (from the standings' per-player acc),
// keyed by player NAME. During the mid-season trade window this reflects how players
// have ACTUALLY played this season (41 games), not their baseline stats.
function currentSeasonStats() {
  const raw = getState('season_standings');
  if (!raw) return {};
  let standings;
  try { standings = JSON.parse(raw); } catch (e) { return {}; }
  const map = {};
  for (const t of (Array.isArray(standings) ? standings : [])) {
    if (!t || !t.acc) continue;
    for (const [name, a] of Object.entries(t.acc)) {
      if (!a || !a.games) continue;
      const g = a.games;
      map[name] = { pts: +(a.pts / g).toFixed(1), trb: +(a.trb / g).toFixed(1), ast: +(a.ast / g).toFixed(1) };
    }
  }
  return map;
}

// Overlay the current-season simulated averages onto a trade brief, so trade
// offers/proposals show THIS season's performance. Falls back to the baseline stats
// when the player has no season games yet.
const applySeasonStats = (statsMap) => (b) => {
  const s = statsMap[b.name];
  if (s) { b.pts = s.pts; b.trb = s.trb; b.ast = s.ast; }
  return b;
};

// Pair incoming players to outgoing players' role/slot (highest overall first),
// so a traded-away starter is replaced by a starter (keeps 5 starters).
function pairRoles(outPlayers, inPlayers) {
  const so = [...outPlayers].sort((a, b) => b.overall - a.overall);
  const si = [...inPlayers].sort((a, b) => b.overall - a.overall);
  return si.map((p, i) => ({ ...p, role: (so[i] || {}).role || 'bench', slot: (so[i] || {}).slot || null }));
}

// Find the n-player package with total overall closest to `target`.
function bestPackage(players, n, target, maxValue = Infinity) {
  const L = players.length;
  let best = null, bestDiff = Infinity;
  const consider = (c) => {
    const v = tradeValue(c);
    if (v > maxValue) return; // never exceed the bound (excess ≤ margin)
    const d = Math.abs(v - target);
    if (d < bestDiff) { bestDiff = d; best = c; }
  };
  for (let i = 0; i < L; i++) {
    if (n === 1) consider([players[i]]);
    for (let j = i + 1; j < L; j++) {
      if (n === 2) consider([players[i], players[j]]);
      for (let k = j + 1; k < L; k++) if (n === 3) consider([players[i], players[j], players[k]]);
    }
  }
  return best;
}

// Seeded RNG (mulberry32) so a given player combination always yields the same offers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashIds(ids) {
  const key = ids.slice().sort((a, b) => a - b).join(',');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function shuffleSeeded(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The season's fixed incoming AI proposals (up to 15), generated once at season start.
function generateProposals(myRoster, teams) {
  const proposals = [];
  const aiTeams = sim.shuffle(teams.filter((t) => !t.isUser)).slice(0, 15);
  for (const t of aiTeams) {
    const n = 1 + Math.floor(Math.random() * 3);
    const myPkg = myRoster.slice().sort((a, b) => b.overall - a.overall).slice(0, n);
    const myTotal = tradeValue(myPkg);
    const margin = TRADE_ACCEPT_MARGIN * n;
    const noise = (Math.random() + Math.random() - 1) * margin;
    const pkg = bestPackage(t.players, n, myTotal + noise, myTotal + margin);
    if (!pkg) continue;
    proposals.push({ aiTeam: t.name, myPlayers: myPkg.map(brief), aiPlayers: pkg.map(brief), aiTotal: tradeValue(pkg), myTotal });
  }
  return proposals;
}

// Execute an n-for-n swap. Mutates the roster DB + the league state.
function executeTrade(myPlayerIds, aiPlayerIds, league) {
  let aiTeam = null;
  for (const t of league.teams) {
    if (t.isUser) continue;
    if (aiPlayerIds.every((id) => t.players.some((p) => p.id === +id))) { aiTeam = t; break; }
  }
  if (!aiTeam) return { ok: false, message: 'Target players are not on one AI team' };

  const myOutgoing = myRosterRows().filter((p) => myPlayerIds.includes(+p.id));
  const aiIncoming = aiTeam.players.filter((p) => aiPlayerIds.includes(+p.id));

  const ins = db.prepare('INSERT INTO roster (session_id, player_id, role, slot) VALUES (?, ?, ?, ?)');
  for (const id of myPlayerIds) db.prepare('DELETE FROM roster WHERE player_id = ? AND session_id = ?').run(id, currentSession());
  for (const p of pairRoles(myOutgoing, aiIncoming)) ins.run(currentSession(), p.id, p.role, p.slot);

  aiTeam.players = [
    ...aiTeam.players.filter((p) => !aiPlayerIds.includes(+p.id)),
    ...pairRoles(aiIncoming, myOutgoing),
  ];
  return { ok: true, aiTeam: aiTeam.name };
}

const LEAGUE_TRADE_MULTIPLIER = 10; // league trade points triggered per player trade point

// After the player spends trade points, AI teams trade with EACH OTHER (no free agents)
// for a total of `budget` trade points of n-for-n swaps (1-for-1 = 1, 2-for-2 = 2, 3-for-3 = 3).
function leagueTrades(league, budget) {
  const changes = [];
  const teams = league.teams.filter((t) => !t.isUser);
  let remaining = budget;
  let guard = 0;
  while (remaining > 0 && guard++ < 100) {
    const n = Math.min(remaining, 1 + Math.floor(Math.random() * 3)); // 1..3
    const a = teams[Math.floor(Math.random() * teams.length)];
    const b = teams[Math.floor(Math.random() * teams.length)];
    if (a === b) continue;
    const r = tryTeamTrade(a, b, n);
    if (r) { changes.push(r); remaining -= n; }
  }
  return changes;
}

// Try an n-for-n swap between two teams: same positions, fair value (within margin).
function tryTeamTrade(a, b, n) {
  const positions = sim.shuffle(sim.POSITIONS).slice(0, n);
  const aOut = [], bOut = [];
  for (const pos of positions) {
    const pa = a.players.filter((p) => p.position === pos);
    const pb = b.players.filter((p) => p.position === pos);
    if (!pa.length || !pb.length) return null;
    let bestA = pa[0], bestB = pb[0], bestDiff = Infinity;
    for (const x of pa) for (const y of pb) {
      const d = Math.abs(x.overall - y.overall);
      if (d < bestDiff) { bestDiff = d; bestA = x; bestB = y; }
    }
    if (bestDiff > TRADE_ACCEPT_MARGIN) return null; // too lopsided to be a real trade
    aOut.push(bestA); bOut.push(bestB);
  }
  for (let i = 0; i < n; i++) {
    const ai = a.players.findIndex((p) => p.id === aOut[i].id);
    const bi = b.players.findIndex((p) => p.id === bOut[i].id);
    a.players[ai] = { ...bOut[i], role: aOut[i].role, slot: aOut[i].slot };
    b.players[bi] = { ...aOut[i], role: bOut[i].role, slot: bOut[i].slot };
  }
  return `${a.name} ⇄ ${b.name}: ${aOut.map((p) => p.name).join(', ')} for ${bOut.map((p) => p.name).join(', ')}`;
}

// Browseable pool: my roster + every AI team's players (for the propose UI).
app.get('/api/trade/pool', (req, res) => {
  const league = tradeLeague(); // works mid-season AND in the dynasty offseason
  const blind = isBlindMode();
  const strip = blind ? (({ overall, ...rest }) => rest) : (p) => p;
  const applySim = applySeasonStats(currentSeasonStats());
  const myRoster = myRosterRows().map(brief).map(applySim).map(strip);
  const aiPlayers = league.teams.filter((t) => !t.isUser).flatMap((t) => t.players.map((p) => ({ ...brief(p), team: t.name }))).map(applySim).map(strip).sort((a, b) => (b.overall || 0) - (a.overall || 0));
  res.json({ myRoster, aiPlayers, remainingPoints: MAX_TRADE_POINTS - tradePoints(), leagueTradeLog: getState('league_trade_log') ? JSON.parse(getState('league_trade_log')) : [] });
});

// Player-initiated (or accept an offer): n-for-n trade.
app.post('/api/trade', (req, res) => {
  const { myPlayerIds, aiPlayerIds } = req.body || {};
  const bad = !Array.isArray(myPlayerIds) || !Array.isArray(aiPlayerIds) || !myPlayerIds.length || myPlayerIds.length !== aiPlayerIds.length || myPlayerIds.length > 3;
  if (bad) return res.status(400).json({ error: 'Pick the same number of players (1-3) on each side' });

  const myPlayers = myRosterRows().filter((p) => myPlayerIds.includes(+p.id));
  if (myPlayers.length !== myPlayerIds.length) return res.status(400).json({ error: 'One of your players is not on your roster' });

  const league = tradeLeague();

  let aiPlayers = null;
  for (const t of league.teams) {
    if (t.isUser) continue;
    const found = aiPlayerIds.map((id) => t.players.find((p) => p.id === +id));
    if (found.every(Boolean)) { aiPlayers = found; break; }
  }
  if (!aiPlayers) return res.status(400).json({ error: 'Target players not found on one AI team' });

  const n = myPlayers.length; // trade cost = n (1-for-1 = 1 point, 2-for-2 = 2, 3-for-3 = 3)
  if (tradePoints() + n > MAX_TRADE_POINTS) {
    return res.status(400).json({ error: `Not enough trade points: a ${n}-for-${n} trade costs ${n}, you have ${MAX_TRADE_POINTS - tradePoints()} left.` });
  }

  const margin = TRADE_ACCEPT_MARGIN * n;
  const myVal = tradeValue(myPlayers), aiVal = tradeValue(aiPlayers);
  const excess = aiVal - myVal;

  // Hard cap on how lopsided a deal can be in EITHER direction: a trade where one
  // side gives up far more ability than it receives (a star for a fringe player, or
  // vice versa) is never accepted — "ability gap too large to proceed".
  const maxGap = margin * 3; // 9 OVR/player
  if (Math.abs(excess) > maxGap) {
    return res.json({ accepted: false, message: `Rejected: ability gap too large (${Math.abs(excess)} OVR, max ${maxGap}).` });
  }

  // Salary soft cap: in hard mode, warn when payroll exceeds $450M but don't block.
  // The AI value check already limits unfair trades; a hard payroll block kills all
  // trade motivation since you can never upgrade through trades.
  if (getState('difficulty') === 'hard') {
    const inSal = aiPlayers.reduce((sum, p) => sum + sim.playerSalary(p.overall, p.epm), 0);
    const outSal = myPlayers.reduce((sum, p) => sum + sim.playerSalary(p.overall, p.epm), 0);
    const currentSal = myRosterRows().reduce((sum, p) => sum + sim.playerSalary(p.overall, p.epm), 0);
    const newSal = currentSal - outSal + inSal;
    if (newSal > 450) {
      // Just a warning, not a block — the AI's own value check prevents lopsided trades.
      // This lets savvy GMs trade up while still feeling the cap pressure.
    }
  }

  // AI evaluation: within the margin it is still not guaranteed — the more the trade
  // favours the player, the less likely the AI is to accept. force=true (accepting a
  // generated offer/proposal) skips evaluation since the AI already agreed.
  if (!req.body.force) {
    if (excess > margin) {
      return res.json({ accepted: false, message: `Rejected: that would upgrade you by ${excess} total OVR (max ${margin}).` });
    }
    const acceptProb = Math.min(0.85, Math.max(0.15, 1 - excess / margin));
    if (Math.random() > acceptProb) {
      return res.json({ accepted: false, message: 'Rejected: the AI was not willing to part with those players this time.' });
    }
  }

  const r = executeTrade(myPlayerIds, aiPlayerIds, league);
  if (!r.ok) return res.status(400).json({ error: r.message });
  const changes = leagueTrades(league, n * LEAGUE_TRADE_MULTIPLIER); // league-wide team-to-team trades
  const log = (getState('league_trade_log') ? JSON.parse(getState('league_trade_log')) : []).concat(changes);
  setState('league_trade_log', JSON.stringify(log));
  const newPoints = tradePoints() + n;
  setState('season_league', JSON.stringify(league));
  setState('trade_points', String(newPoints));
  const msg = changes.length ? `Trade accepted with ${r.aiTeam}! League deadline moves (${changes.length}): ${changes.slice(0, 3).join(' · ')}${changes.length > 3 ? ' …' : ''}` : `Trade accepted with ${r.aiTeam}!`;
  res.json({ accepted: true, message: msg, remainingPoints: MAX_TRADE_POINTS - newPoints });
});

// Shop your players: get up to 5 AI offers.
app.post('/api/trade/offers', (req, res) => {
  const { myPlayerIds } = req.body || {};
  if (!Array.isArray(myPlayerIds) || !myPlayerIds.length || myPlayerIds.length > 3)
    return res.status(400).json({ error: 'Pick 1-3 of your players' });

  const myPlayers = myRosterRows().filter((p) => myPlayerIds.includes(+p.id));
  if (myPlayers.length !== myPlayerIds.length) return res.status(400).json({ error: 'Invalid player' });

  const league = tradeLeague();

  const n = myPlayers.length;
  const target = tradeValue(myPlayers);
  const margin = TRADE_ACCEPT_MARGIN * n;
  const rand = mulberry32(hashIds(myPlayerIds)); // same combination → same 15 offers (no refresh)
  const applySim = applySeasonStats(currentSeasonStats());
  const offers = [];
  const aiTeams = shuffleSeeded(league.teams.filter((t) => !t.isUser), rand).slice(0, 15);
  for (const t of aiTeams) {
    // AI lowballs/highballs within the margin, concentrated near fair (triangular) —
    // only a small share of offers hit the ±margin extremes. The package is capped at
    // target + margin so an offer never lets the player exceed the max-difference bound.
    const noise = (rand() + rand() - 1) * margin;
    const pkg = bestPackage(t.players, n, target + noise, target + margin);
    if (!pkg) continue;
    offers.push({ aiTeam: t.name, aiPlayers: pkg.map(brief).map(applySim), aiTotal: tradeValue(pkg) });
  }
  const blind = isBlindMode();
  const strip = blind ? (({ overall, ...rest }) => rest) : (p) => p;
  res.json({ offers: offers.map(o => ({ ...o, aiPlayers: o.aiPlayers.map(strip) })), myPlayers: myPlayers.map(brief).map(strip), myTotal: target });
});

// Incoming AI proposals (fixed 15, generated once at season start).
app.get('/api/trade/proposals', (req, res) => {
  const raw = getState('trade_proposals');
  const proposals = raw ? JSON.parse(raw) : [];
  // drop proposals whose target players are no longer on the roster (traded away)
  const myIds = new Set(myRosterRows().map((p) => p.id));
  const valid = proposals.filter((p) => p.myPlayers.every((x) => myIds.has(x.id)));
  // Blind mode: strip ability fields from proposal player data
  const blind = isBlindMode();
  const strip = blind ? (({ overall, ...rest }) => rest) : (p) => p;
  const applySim = applySeasonStats(currentSeasonStats());
  const out = valid.map(p => ({ ...p, myPlayers: p.myPlayers.map(applySim).map(strip), aiPlayers: p.aiPlayers.map(applySim).map(strip) }));
  res.json({ proposals: out });
});

// ---- playoffs (round by round) ----
function matchupsFor(state) {
  const e = state.east, w = state.west;
  if (state.round === 1) return [
    { conf: 'East', a: e[0], b: e[7] }, { conf: 'East', a: e[3], b: e[4] },
    { conf: 'East', a: e[1], b: e[6] }, { conf: 'East', a: e[2], b: e[5] },
    { conf: 'West', a: w[0], b: w[7] }, { conf: 'West', a: w[3], b: w[4] },
    { conf: 'West', a: w[1], b: w[6] }, { conf: 'West', a: w[2], b: w[5] },
  ];
  if (state.round === 2) return [
    { conf: 'East', a: e[0], b: e[1] }, { conf: 'East', a: e[2], b: e[3] },
    { conf: 'West', a: w[0], b: w[1] }, { conf: 'West', a: w[2], b: w[3] },
  ];
  if (state.round === 3) return [
    { conf: 'East', a: e[0], b: e[1] }, { conf: 'West', a: w[0], b: w[1] },
  ];
  return [{ conf: 'Finals', a: e[0], b: w[0] }];
}

function accumulateStats(acc, stats, team) {
  if (!stats) return;
  for (const s of stats) {
    if (!acc[s.name]) acc[s.name] = { name: s.name, position: s.position, pts: 0, trb: 0, ast: 0, stl: 0, blk: 0, fgPct: 0, threePct: 0, ftPct: 0, epm: 0 };
    acc[s.name].pts += s.pts; acc[s.name].trb += s.trb; acc[s.name].ast += s.ast; acc[s.name].stl += s.stl; acc[s.name].blk += s.blk;
    acc[s.name].fgPct += s.fgPct; acc[s.name].threePct += s.threePct; acc[s.name].ftPct += s.ftPct;
    const p = team && team.find(x => x.name === s.name);
    if (p) acc[s.name].epm += sim.gameEPM(s, p);
  }
}

function avgStats(acc, games) {
  return Object.values(acc).map(s => ({
    name: s.name, position: s.position,
    pts: f1(s.pts / games), trb: f1(s.trb / games), ast: f1(s.ast / games), stl: f1(s.stl / games), blk: f1(s.blk / games),
    fgPct: f3(s.fgPct / games), threePct: f3(s.threePct / games), ftPct: f3(s.ftPct / games),
    epm: f1(s.epm / games),
  }));
}

function simulateSeries(a, b, aBoost = 0, bBoost = 0) {
  let aw = 0, bw = 0;
  const games = [];
  const aIsUser = a.isUser, bIsUser = b.isUser;
  const aAcc = {}, bAcc = {};

  // playoff strength (top-heavy minutes) + hard-mode AI bonus + strategy boost
  const aStrength = sim.teamStrength(a.players, true) + (a.isUser ? 0 : sim.HARD_AI_BONUS) + aBoost;
  const bStrength = sim.teamStrength(b.players, true) + (b.isUser ? 0 : sim.HARD_AI_BONUS) + bBoost;

  // 2-2-1-1-1 home court: the team with the better regular-season record hosts
  // games 1,2,5,7; the worse record hosts 3,4,6. This uses `wins`, so it stays with
  // the better team even after an upset, and works across conferences in the Finals
  // (a conference seed number is meaningless when East meets West). Ties give home
  // court to team `a`.
  const aIsHome = (a.wins ?? 0) >= (b.wins ?? 0);
  const aHosts = (g) => {
    const aGame = g === 1 || g === 2 || g === 5 || g === 7;
    return aIsHome ? aGame : !aGame;
  };

  for (let g = 1; g <= 7 && aw < 4 && bw < 4; g++) {
    // Home team gets HOME_ADV_PO (scaled to the steeper playoff curve, same ~60%
    // home win rate as the regular season). Team `a` keeps its slot so r.aWins maps cleanly.
    const aEff = aStrength + (aHosts(g) ? sim.HOME_ADV_PO : 0);
    const bEff = bStrength + (aHosts(g) ? 0 : sim.HOME_ADV_PO);
    const r = sim.simulateMatchup(a.players, b.players, 'playoff', aEff, bEff);
    if (r.aWins) aw++; else bw++;
    games.push({ g, winner: r.aWins ? a.name : b.name, aScore: Math.round(r.aScore), bScore: Math.round(r.bScore), home: aHosts(g) ? a.name : b.name });
    accumulateStats(aAcc, r.aStats, a.players);
    accumulateStats(bAcc, r.bStats, b.players);
  }

  const winner = aw > bw ? a : b;
  const loser = aw > bw ? b : a;
  const gamesPlayed = aw + bw;
  const winnerAcc = aw > bw ? aAcc : bAcc;
  const mvp = seriesMVP(avgStats(winnerAcc, gamesPlayed)); // best player on the winning team
  const userAcc = aIsUser ? aAcc : (bIsUser ? bAcc : null);
  const userStats = userAcc ? avgStats(userAcc, gamesPlayed) : null;
  const userTotals = userAcc ? { games: gamesPlayed, players: Object.values(userAcc) } : null;
  const aStats = avgStats(aAcc, gamesPlayed);
  const bStats = avgStats(bAcc, gamesPlayed);

  return {
    winner, loser, games, mvp,
    winnerWins: Math.max(aw, bw), loserWins: Math.min(aw, bw),
    isUserSeries: aIsUser || bIsUser,
    userIsWinner: (aIsUser && aw > bw) || (bIsUser && bw > aw),
    userStats,
    userTotals,
    aStats,
    bStats,
  };
}

function seriesView(s) {
  // Defensive: s may already be a processed view (from stored state.rounds)
  // that lacks raw a/b team objects. Fall back to already-extracted fields.
  const aName = s.a ? s.a.name : (s.aName || s.winner?.name || '?');
  const bName = s.b ? s.b.name : (s.bName || s.loser?.name || '?');
  const aRoster = s.a ? s.a.players.map(p => ({ name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)) })) : (s.aRoster || []);
  const bRoster = s.b ? s.b.players.map(p => ({ name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)) })) : (s.bRoster || []);
  return {
    conf: s.conf,
    winner: s.winner.name, loser: s.loser.name,
    winnerIsUser: s.winner.isUser, loserIsUser: s.loser.isUser,
    wins: `${s.winnerWins}-${s.loserWins}`,
    games: s.games,
    mvp: s.mvp,
    isUserSeries: s.isUserSeries,
    userIsWinner: s.userIsWinner,
    userStats: s.userStats,
    aName, bName,
    aStats: s.aStats, bStats: s.bStats,
    aRoster, bRoster,
  };
}

// best series score: composite box score + simulated EPM (impact)
function seriesMVP(stats) {
  if (!stats || !stats.length) return null;
  let best = stats[0], bestScore = -Infinity;
  for (const s of stats) {
    // Box score (matching gameStar's weighting) + a mild EPM impact term. EPM is
    // averaged over the series so its noise cancels; ×1 keeps scoring dominant
    // (an 18-pt defensive anchor shouldn't beat a 30-pt scorer).
    const score = s.pts + 0.5 * s.trb + 0.5 * s.ast + s.stl + s.blk + (s.epm || 0);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best.name;
}

function addTrophy(type, playerName, teamName) {
  const seasonNumber = parseInt(getState('season_number') || '1', 10);
  db.prepare('INSERT INTO trophies (session_id, type, player_name, team_name, season_number) VALUES (?, ?, ?, ?, ?)').run(currentSession(), type, playerName, teamName, seasonNumber);
}

app.post('/api/playoffs/start', (req, res) => {
  const raw = getState('season_result');
  if (!raw) return res.status(400).json({ error: 'Run the season first' });
  const season = JSON.parse(raw);
  const east = season.east.slice(0, 8);
  const west = season.west.slice(0, 8);
  const madePlayoffs = [...east, ...west].some(t => t.isUser);
  if (!madePlayoffs) return res.status(400).json({ error: 'You missed the playoffs' });

  const state = { round: 1, east, west, rounds: [], champion: null, userEliminated: false, userPlayoffTotals: { games: 0, players: {} } };
  setState('playoff_state', JSON.stringify(state));
  setState('phase', 'playoffs');

  res.json({
    round: 1,
    matchups: matchupsFor(state).map(m => ({ conf: m.conf, a: teamView(m.a, true), b: teamView(m.b, true) })),
  });
});

// Detect opponent playing style from roster data.
//   threeHeavy: team shoots a lot of 3s (avg starter 3P% ≥ 37%)
//   starDominant: one star carries the team (top OVR gap to 5th ≥ 12)
function detectTeamStyle(players) {
  const starters = players.filter(p => p.role === 'starter');
  const pool = starters.length >= 5 ? starters : players;
  const avg3pt = pool.reduce((s, p) => s + (p.three_pct || 0.35), 0) / pool.length;
  const sorted = [...players].sort((a, b) => b.overall - a.overall);
  const starGap = sorted.length >= 5 ? sorted[0].overall - sorted[4].overall : 0;
  return { threeHeavy: avg3pt >= 0.37, starDominant: starGap >= 12, avg3pt, starGap };
}

// Compute defense-strategy boost for a team against a specific opponent.
// Returns { teamBoost, opponentPenalty } — the boost is how much the strategy
// helps, the penalty is how much it hurts (both 0 or positive).
//   man:   baseline, no special effect (+0 against everyone)
//   zone:  strong vs 3PT-heavy (+2.0), weak vs driving/inside teams (-1.0)
//   double: strong vs single-star teams (+2.0), weak vs balanced rosters (-0.5)
function strategyBoost(strategy, opponent) {
  if (strategy === 'zone') {
    if (opponent.threeHeavy) return { teamBoost: 2.0, desc: '联防有效：限制对手三分 (+2.0)' };
    if (!opponent.threeHeavy && opponent.avg3pt < 0.34) return { teamBoost: -1.0, desc: '联防失效：对手主打突破 (-1.0)' };
    return { teamBoost: 0.3, desc: '联防效果一般 (+0.3)' };
  }
  if (strategy === 'double') {
    if (opponent.starDominant) return { teamBoost: 2.0, desc: '包夹有效：限制对手核心 (+2.0)' };
    if (!opponent.starDominant && opponent.starGap < 6) return { teamBoost: -0.5, desc: '包夹失效：对手多点开花 (-0.5)' };
    return { teamBoost: 0.3, desc: '包夹效果一般 (+0.3)' };
  }
  return { teamBoost: 0, desc: '人盯人（默认）' };
}

app.post('/api/playoffs/strategy', (req, res) => {
  const { strategy } = req.body || {};
  const valid = ['man', 'zone', 'double'];
  if (!valid.includes(strategy)) return res.status(400).json({ error: 'Invalid strategy' });
  setState('defense_strategy', strategy);
  const desc = strategy === 'zone'
    ? '联防: +2.0 vs 三分大队, -1.0 vs 突破型, +0.3 vs 其他'
    : strategy === 'double'
      ? '包夹核心: +2.0 vs 单核球队, -0.5 vs 均衡球队, +0.3 vs 其他'
      : '人盯人（默认，无加成无惩罚）';
  res.json({ ok: true, strategy, bonus: desc });
});

app.post('/api/playoffs/round', (req, res) => {
  const raw = getState('playoff_state');
  if (!raw) return res.status(400).json({ error: 'Start the playoffs first' });
  const state = JSON.parse(raw);
  if (state.champion) return res.status(400).json({ error: 'Playoffs already finished' });

  // Apply defensive strategy: each has a trade-off based on OPPONENT STYLE.
  //   man:   baseline, +0 against everyone
  //   zone:  strong vs 3PT-heavy (+2.0), weak vs driving/inside (-1.0)
  //   double: strong vs single-star (+2.0), weak vs balanced rosters (-0.5)
  // Both user and AI use the same detection; the user's explicit choice adds a
  // small edge (+0.5) as "game-planning bonus".
  const strategy = getState('defense_strategy') || 'man';
  const matchups = matchupsFor(state);
  const results = matchups.map(m => {
    let aBoost = 0, bBoost = 0;
    // Detect each team's style from their roster
    const aStyle = detectTeamStyle(m.a.players);
    const bStyle = detectTeamStyle(m.b.players);
    // A's strategy (always 'man' for AI, user's choice for user team)
    const aStrategy = m.a.isUser ? strategy : 'man';
    const bStrategy = m.b.isUser ? strategy : 'man';
    const aResult = strategyBoost(aStrategy, bStyle); // A defends against B's style
    const bResult = strategyBoost(bStrategy, aStyle); // B defends against A's style
    aBoost = aResult.teamBoost;
    bBoost = bResult.teamBoost;
    // User's explicit strategy adds a small "game-planning" edge
    if (m.a.isUser && strategy !== 'man') aBoost += 0.5;
    if (m.b.isUser && strategy !== 'man') bBoost += 0.5;
    return { ...simulateSeries(m.a, m.b, aBoost, bBoost), conf: m.conf, a: m.a, b: m.b };
  });

  // accumulate each round's series for the bracket view
  state.rounds.push(results.map(s => seriesView(s)));

  // accumulate the user's playoff totals across rounds
  const userSeries = results.find(r => r.isUserSeries);
  if (userSeries && userSeries.userTotals) {
    state.userPlayoffTotals = state.userPlayoffTotals || { games: 0, players: {} };
    state.userPlayoffTotals.games += userSeries.userTotals.games;
    for (const p of userSeries.userTotals.players) {
      const t = state.userPlayoffTotals.players[p.name] || { name: p.name, position: p.position, pts: 0, trb: 0, ast: 0, stl: 0, blk: 0, fgPct: 0, threePct: 0, ftPct: 0 };
      t.pts += p.pts; t.trb += p.trb; t.ast += p.ast; t.stl += p.stl; t.blk += p.blk;
      t.fgPct += p.fgPct; t.threePct += p.threePct; t.ftPct += p.ftPct;
      state.userPlayoffTotals.players[p.name] = t;
    }
  }

  const winners = results.map(r => r.winner);
  const userStillIn = winners.some(w => w.isUser);
  // Record the elimination round ONLY on the round it first happens. The AI bracket
  // keeps simulating after the user is out, and without this guard each later round
  // would overwrite userEliminatedRound with the FINAL round — so a first-round exit
  // would wrongly report "Eliminated in round 4". (Also affects the season goal:
  // userEliminatedRound >= 3 is used to judge "reach conference finals".)
  if (!userStillIn && !state.userEliminated) {
    state.userEliminated = true;
    state.userEliminatedRound = state.round;
  }

  const roundPlayed = state.round;

  // Award trophies only for the user's own team. AI teams' MVPs are shown in the
  // round results above, but their achievements stay out of the trophy room.
  if (userSeries && userSeries.userIsWinner) {
    const teamName = getState('team_name') || 'My Team';
    if (roundPlayed === 3) {
      const confKey = getState('conference') === 'East' ? 'east' : 'west';
      addTrophy(`${confKey}_champion`, null, teamName);
      addTrophy(`${confKey}_mvp`, userSeries.mvp, teamName);
    } else if (roundPlayed === 4) {
      addTrophy('championship', null, teamName);
      addTrophy('finals_mvp', userSeries.mvp, teamName);
    }
  }

  if (state.round === 4) {
    state.champion = winners[0].name;
    state.round = 5;
  } else {
    const half = winners.length / 2;
    state.east = winners.slice(0, half);
    state.west = winners.slice(half);
    state.round++;
  }

  setState('playoff_state', JSON.stringify(state));
  if (state.champion) setState('phase', 'finished');

  // when the run is over (champion or eliminated), snapshot the playoff result + user averages
  if (state.champion || state.userEliminated) {
    const totals = state.userPlayoffTotals || { games: 0, players: {} };
    const playoffAverages = totals.games > 0
      ? Object.values(totals.players).map(p => ({
        name: p.name, position: p.position,
        pts: f1(p.pts / totals.games), trb: f1(p.trb / totals.games), ast: f1(p.ast / totals.games), stl: f1(p.stl / totals.games), blk: f1(p.blk / totals.games),
        fgPct: f3(p.fgPct / totals.games), threePct: f3(p.threePct / totals.games), ftPct: f3(p.ftPct / totals.games),
      }))
      : [];
    setState('playoff_result', JSON.stringify({ champion: state.champion, userEliminated: state.userEliminated, userEliminatedRound: state.userEliminatedRound || null }));
    setState('playoff_averages', JSON.stringify(playoffAverages));
    upsertCurrentTeam();
    // record the season in the dynasty history once the playoffs are over (a final
    // dynasty season never calls next-season, so this is its only history entry)
    if (getState('game_mode') === 'dynasty') {
      appendSeasonHistory(parseInt(getState('season_number') || '1', 10));
    }
  }

  const nextMatchups = state.champion ? [] : matchupsFor(state).map(m => ({ conf: m.conf, a: teamView(m.a), b: teamView(m.b) }));

  res.json({
    round: roundPlayed,
    results: results.map(seriesView),
    rounds: state.rounds,
    nextMatchups,
    nextRound: state.round,
    champion: state.champion,
    userEliminated: state.userEliminated,
    userEliminatedRound: state.userEliminatedRound,
  });
});

app.get('/api/playoffs/state', (req, res) => {
  const raw = getState('playoff_state');
  res.json(raw ? JSON.parse(raw) : null);
});

// Render-ready view of the current playoff bracket, for resuming mid-playoffs.
function playoffsView() {
  const raw = getState('playoff_state');
  if (!raw) return null;
  const state = JSON.parse(raw);
  return {
    round: state.round,
    matchups: matchupsFor(state).map((m) => ({ conf: m.conf, a: teamView(m.a, true), b: teamView(m.b, true) })),
    rounds: state.rounds,
    nextMatchups: state.champion ? [] : matchupsFor(state).map((m) => ({ conf: m.conf, a: teamView(m.a), b: teamView(m.b) })),
    champion: state.champion,
    userEliminated: state.userEliminated,
    userEliminatedRound: state.userEliminatedRound || null,
  };
}

// Where am I in the current run? (used by the "Continue last run" button)
app.get('/api/resume', (req, res) => {
  const phase = getState('phase') || 'none';
  const rosterCount = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  const out = {
    phase,
    teamName: getState('team_name') || null,
    conference: getState('conference') || null,
    replacedTeam: getState('replaced_team') || null,
    difficulty: getState('difficulty') === 'hard' ? 'hard' : 'normal',
    mode: getState('mode') === 'blind' ? 'blind' : 'open',
    gameMode: getState('game_mode') || 'normal',
    seasonNumber: parseInt(getState('season_number') || '1', 10),
    seasonLabel: sim.seasonLabel(parseInt(getState('season_number') || '1', 10)),
    rosterCount,
    rosterSize: sim.ROSTER_SIZE,
  };
  if (phase === 'midseason') {
    const r = getState('midseason_report');
    out.midseason = r ? JSON.parse(r) : null;
  } else if (phase === 'season') {
    const r = getState('season_report');
    out.season = r ? JSON.parse(r) : null;
  } else if (phase === 'playoffs') {
    out.playoffs = playoffsView();
  }
  // The annual rookie draft is a normal phase-'draft' but with a live draft class;
  // flag it so the resume label can tell it apart from the opening draft.
  out.offseasonPicks = (getState('draft_class') && JSON.parse(getState('draft_class')).length > 0) ? 1 : 0;
  res.json(out);
});

// ---- result + career ----

// Rich run summary for the result screen.
app.get('/api/result', (req, res) => {
  const seasonRecord = getState('season_record') ? JSON.parse(getState('season_record')) : null;
  const seasonAverages = getState('season_averages') ? JSON.parse(getState('season_averages')) : null;
  const playoff = getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null;
  const seasonResult = getState('season_result') ? JSON.parse(getState('season_result')) : null;
  const gameLog = getState('season_game_log') ? JSON.parse(getState('season_game_log')) : null;
  const roster = applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
  const gameMode = getState('game_mode') || 'normal';
  const seasonNumber = parseInt(getState('season_number') || '1', 10);
  const seasonHistory = getState('season_history') ? JSON.parse(getState('season_history')) : [];
  const contracts = playerContracts();
  const ages = playerAges();
  const devo = playerDevo();
  const prevOveralls = getState('prev_overalls') ? JSON.parse(getState('prev_overalls')) : {};
  res.json({
    teamName: getState('team_name') || 'My Team',
    season: seasonRecord,
    seasonAverages,
    gameLog,
    playoff,
    awards: seasonResult ? seasonResult.awards : null,
    roster: roster.map((p) => {
      const base = db.prepare('SELECT overall, age FROM players WHERE id = ?').get(p.id);
      const curAge = ages[p.name] != null ? ages[p.name] : (base ? base.age : p.age);
      const pure = base ? sim.effectiveOverall(base.overall, base.age, curAge, devo[p.name] || 1) : p.overall;
      const delta = prevOveralls[p.name] != null ? pure - prevOveralls[p.name] : null;
      return { name: p.name, position: p.position, age: p.age, overall: p.overall, rating: +sim.powerRating(p).toFixed(1), role: p.role, contract: contracts[p.name] ?? null, delta };
    }),
    gameMode,
    seasonNumber,
    seasonLabel: sim.seasonLabel(seasonNumber),
    seasonHistory: seasonHistory.map(h => ({ ...h, seasonLabel: h.seasonLabel || sim.seasonLabel(h.season) })),
    dynastyMax: gameMode === 'dynasty' ? parseInt(getState('dynasty_max') || String(DYNASTY_MAX_SEASONS), 10) : null,
  });
});

// Career summary across all past runs (franchise history).
app.get('/api/career', (req, res) => {
  const trophyCounts = db.prepare('SELECT type, COUNT(*) c FROM trophies WHERE session_id = ? GROUP BY type').all(currentSession());
  const teams = db.prepare('SELECT results_json FROM teams WHERE session_id = ?').all(currentSession());
  let totalWins = 0;
  for (const t of teams) {
    const r = t.results_json ? JSON.parse(t.results_json) : null;
    if (r && r.season) totalWins += r.season.wins;
  }
  const count = (type) => (trophyCounts.find((t) => t.type === type) || { c: 0 }).c;
  res.json({
    runs: teams.length,
    totalWins,
    championships: count('championship'),
    mvps: count('season_mvp'),
    dpoy: count('dpoy'),
    finalsMvps: count('finals_mvp'),
  });
});

// ---- back up / restore (cross-deployment save) ----
// A save is everything scoped to this session except the global `players` seed
// (which is rebuilt identically on every deploy). Player references are exported
// by NAME, so a reseed that shifts auto-increment ids still matches on import.

function playerNameById(id) {
  const p = db.prepare('SELECT name FROM players WHERE id = ?').get(id);
  return p ? p.name : null;
}

app.get('/api/export', (req, res) => {
  const sid = currentSession();
  const roster = db.prepare('SELECT player_id, role, slot FROM roster WHERE session_id = ?').all(sid)
    .map((r) => ({ name: playerNameById(r.player_id), role: r.role, slot: r.slot }))
    .filter((r) => r.name);
  const state = {};
  for (const s of db.prepare('SELECT key, value FROM state WHERE session_id = ?').all(sid)) state[s.key] = s.value;
  const teams = db.prepare('SELECT id, name, results_json FROM teams WHERE session_id = ? ORDER BY id').all(sid)
    .map((t) => ({
      name: t.name,
      results_json: t.results_json,
      players: db.prepare('SELECT player_id, role, slot FROM team_players WHERE team_id = ?').all(t.id)
        .map((p) => ({ name: playerNameById(p.player_id), role: p.role, slot: p.slot }))
        .filter((p) => p.name),
    }));
  const trophies = db.prepare('SELECT type, player_name, team_name FROM trophies WHERE session_id = ?').all(sid);
  res.json({ format: 1, exportedAt: new Date().toISOString(), data: { roster, state, teams, trophies } });
});

app.post('/api/import', (req, res) => {
  const data = (req.body && req.body.data) || null;
  if (!data) return res.status(400).json({ error: 'No save data provided' });
  const sid = currentSession();

  const byName = new Map(db.prepare('SELECT id, name FROM players').all().map((p) => [normalize(p.name), p.id]));
  const resolveId = (name) => byName.get(normalize(name));
  const skipped = new Set();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM roster WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM state WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM team_players WHERE team_id IN (SELECT id FROM teams WHERE session_id = ?)').run(sid);
    db.prepare('DELETE FROM teams WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM trophies WHERE session_id = ?').run(sid);

    const insRoster = db.prepare('INSERT INTO roster (session_id, player_id, role, slot) VALUES (?, ?, ?, ?)');
    for (const r of (data.roster || [])) {
      const id = resolveId(r.name);
      if (id == null) { skipped.add(r.name); continue; }
      insRoster.run(sid, id, r.role, r.slot);
    }

    const upsertState = db.prepare('INSERT INTO state (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(data.state || {})) upsertState.run(sid, key, String(value));

    const insTeam = db.prepare('INSERT INTO teams (session_id, name, results_json) VALUES (?, ?, ?)');
    const insTP = db.prepare('INSERT INTO team_players (team_id, player_id, role, slot) VALUES (?, ?, ?, ?)');
    for (const t of (data.teams || [])) {
      const info = insTeam.run(sid, t.name, t.results_json || null);
      for (const p of (t.players || [])) {
        const id = resolveId(p.name);
        if (id == null) { skipped.add(p.name); continue; }
        insTP.run(info.lastInsertRowid, id, p.role, p.slot);
      }
    }

    const insTrophy = db.prepare('INSERT INTO trophies (session_id, type, player_name, team_name) VALUES (?, ?, ?, ?)');
    for (const tr of (data.trophies || [])) insTrophy.run(sid, tr.type, tr.player_name, tr.team_name);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true, skipped: [...skipped] });
});

// serve the frontend static files (same origin, no CORS needed)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
