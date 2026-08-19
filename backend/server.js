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
  const valid = ['name', 'position', 'overall', 'rating', 'pts', 'trb', 'ast', 'stl', 'blk', 'oepm', 'depm', 'epm', 'age'];
  const col = valid.includes(sort) ? sort : 'overall';
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
  res.json({ players });
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
app.get('/api/draft', (req, res) => {
  const offseasonPicks = parseInt(getState('offseason_picks') || '0', 10);
  // Annual rookie draft: always 1 pick per team, board is the full draft class
  const isRookieDraft = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;
  const offseason = isRookieDraft;
  let candidates = isRookieDraft ? draftBoard() : sim.draftCandidates(db);
  const hard = getState('difficulty') === 'hard';
  const rosterCount = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  const spent = hard
    ? db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
        .reduce((s, p) => s + sim.playerSalary(p.overall, p.epm), 0)
    : 0;

  // hard mode: guarantee at least one candidate fits the budget (initial draft only)
  if (hard && !isRookieDraft) {
    const minSalary = sim.playerSalary(db.prepare('SELECT MIN(overall) m FROM players').get().m, 0);
    const remaining = sim.HARD_MODE_BUDGET - spent;
    const usable = remaining - (sim.ROSTER_SIZE - rosterCount - 1) * minSalary;
    if (!candidates.some(c => sim.playerSalary(c.overall, c.epm) <= usable)) {
      const drafted = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));
      const affordable = db.prepare('SELECT * FROM players WHERE session_id IS NULL OR session_id = ?').all(currentSession())
        .filter(p => !drafted.has(p.id) && sim.playerSalary(p.overall, p.epm) <= usable);
      if (affordable.length) candidates[0] = sim.shuffle(affordable)[0];
    }
  }

  res.json({
    rerolls: ensureRerolls(),
    rosterCount,
    rosterSize: sim.ROSTER_SIZE,
    candidates: candidates.map(playerBrief),
    hardMode: hard,
    budget: hard ? sim.HARD_MODE_BUDGET : null,
    spent: hard ? spent : null,
    offseason,
    offseasonPicks: isRookieDraft ? 1 : offseasonPicks,
    draftBoard: isRookieDraft ? candidates.map(playerBrief) : null,
    userPosition: isRookieDraft ? draftUserPosition() : null,
    picks: isRookieDraft ? (getState('draft_picks') ? JSON.parse(getState('draft_picks')) : []) : [],
    canPass: getState('draft_can_pass') === '1',
  });
});
app.post('/api/draft/reroll', (req, res) => {
  let rerolls = ensureRerolls();
  if (rerolls <= 0) return res.status(400).json({ error: 'No rerolls left' });
  setState('rerolls', rerolls - 1);
  const offseason = parseInt(getState('offseason_picks') || '0', 10) > 0;
  const candidates = offseason ? draftBoard() : sim.draftCandidates(db);
  res.json({ rerolls: rerolls - 1, candidates: candidates.map(playerBrief) });
});
app.post('/api/roster', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  let count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  const isRookieDraft = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;

  // Rookie draft: roster may be full (10/10), in that case auto-cut the worst player
  if (count >= sim.ROSTER_SIZE) {
    if (!isRookieDraft) return res.status(400).json({ error: 'Roster already full' });
    const roster = applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
    const benchPlayers = roster.filter(p => p.role === 'bench').sort((a, b) => a.overall - b.overall);
    const cut = benchPlayers[0];
    if (cut) {
      db.prepare('DELETE FROM roster WHERE player_id = ? AND session_id = ?').run(cut.id, currentSession());
      const contracts = playerContracts();
      delete contracts[cut.name];
      setPlayerContracts(contracts);
    }
    count = db.prepare('SELECT COUNT(*) c FROM roster WHERE session_id = ?').get(currentSession()).c;
  }
  if (db.prepare('SELECT 1 FROM roster WHERE player_id = ? AND session_id = ?').get(playerId, currentSession()))
    return res.status(400).json({ error: 'Player already drafted' });

  // hard mode: enforce the salary cap (initial draft only — rookie draft has its own budget logic)
  if (getState('difficulty') === 'hard' && !isRookieDraft) {
    const p = db.prepare('SELECT overall, epm FROM players WHERE id = ?').get(playerId);
    const spent = db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession())
      .reduce((s, x) => s + sim.playerSalary(x.overall, x.epm), 0);
    const salary = sim.playerSalary(p.overall, p.epm);
    const futurePicks = sim.ROSTER_SIZE - count - 1; // picks left after this one
    const minSalary = sim.playerSalary(db.prepare('SELECT MIN(overall) m FROM players').get().m, 0);
    const total = spent + salary;
    if (total + futurePicks * minSalary > sim.HARD_MODE_BUDGET) {
      const maxNow = sim.HARD_MODE_BUDGET - futurePicks * minSalary;
      return res.status(400).json({ error: `Over budget: $${total}M (max $${maxNow}M now — keep $${minSalary}M per remaining pick)` });
    }
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
  const isDrafting = getState('draft_class') && JSON.parse(getState('draft_class')).length > 0;
  if (isDrafting) {
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
  res.json({ roster: roster.map(p => ({ ...playerBrief(p), role: p.role, slot: p.slot, contract: contracts[p.name] ?? null })), rosterSize: sim.ROSTER_SIZE, starterCount: sim.STARTER_COUNT });
});

// ---- offseason free agency (dynasty) ----
const FA_MARKET_SIZE = 15;
const FA_MAX_REFRESH = 3;
const FA_SALARY_CAP = 450; // tighter cap for FA
const FA_SIGN_LIMIT = 3;   // max signings per offseason

function faMarket() {
  return getState('fa_market') ? JSON.parse(getState('fa_market')) : [];
}
function faRefreshes() {
  return parseInt(getState('fa_refreshes') || String(FA_MAX_REFRESH), 10);
}

// Generate the initial FA market: a fixed pool of candidates drawn once.
function buildFAMarket() {
  const pool = sim.freeAgentPool(db);
  const market = sim.shuffle(pool).slice(0, FA_MARKET_SIZE);
  setState('fa_market', JSON.stringify(market.map(p => p.id)));
  setState('fa_refreshes', String(FA_MAX_REFRESH));
  return market;
}

app.get('/api/freeagency', (req, res) => {
  const roster = applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
  const contracts = playerContracts();
  let market = faMarket();
  if (!market.length) market = buildFAMarket();
  const salTotal = roster.reduce((s, p) => s + sim.playerSalary(p.overall, p.epm), 0);
  const signed = parseInt(getState('fa_signed') || '0', 10);
  // position needs
  const posCount = {};
  for (const p of roster) posCount[p.position] = (posCount[p.position] || 0) + 1;
  const needs = sim.POSITIONS.filter(pos => (posCount[pos] || 0) < 2);
  res.json({
    roster: roster.map((p) => ({ ...playerBrief(p), role: p.role, slot: p.slot, contract: contracts[p.name] ?? null })),
    rosterSize: sim.ROSTER_SIZE,
    candidates: market.map(playerBrief),
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
  res.json({ candidates: market.map(playerBrief), refreshes: left - 1 });
});

app.post('/api/release', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  const session = currentSession();
  const row = db.prepare('SELECT p.name FROM roster r JOIN players p ON p.id = r.player_id WHERE r.player_id = ? AND r.session_id = ?').get(playerId, session);
  if (!row) return res.status(400).json({ error: 'Player not on your roster' });
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
  const p = db.prepare('SELECT name, age, session_id, overall, epm FROM players WHERE id = ?').get(playerId);
  if (!p) return res.status(400).json({ error: 'Player not found' });
  // FA salary cap check
  const roster = applyDynasty(db.prepare('SELECT p.* FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session));
  const curSal = roster.reduce((s, x) => s + sim.playerSalary(x.overall, x.epm), 0);
  const newSal = curSal + sim.playerSalary(p.overall, p.epm);
  if (getState('game_mode') === 'dynasty' && newSal > FA_SALARY_CAP) {
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
  // Dynasty mode forces hard (salary cap) + open (no blind) and is capped at 10 seasons.
  const isDynasty = gameMode === 'dynasty';
  db.prepare('DELETE FROM roster WHERE session_id = ?').run(currentSession());
  db.prepare('DELETE FROM state WHERE session_id = ?').run(currentSession());
  if (isDynasty || difficulty === 'hard') setState('difficulty', 'hard');
  setState('mode', isDynasty ? 'open' : (mode === 'blind' ? 'blind' : 'open'));
  setState('game_mode', isDynasty ? 'dynasty' : 'normal');
  setState('season_number', '1');
  setState('season_history', '[]');
  setState('phase', 'draft');
  res.json({ ok: true, gameMode: isDynasty ? 'dynasty' : 'normal' });
});

// ---- dynasty: advance to the next season ----
// Persist this season's (post-trade) AI rosters, age the whole league +1, retire
// players past their caliber-based retirement age, generate a rookie class, then run
// the annual draft: the user picks first (one per retiree), then AI teams auto-pick.
const DYNASTY_MAX_SEASONS = 10;

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

  // append this season's outcome to the dynasty history before clearing transient state
  const record = getState('season_record') ? JSON.parse(getState('season_record')) : null;
  const playoff = getState('playoff_result') ? JSON.parse(getState('playoff_result')) : null;
  const seasonResult = getState('season_result') ? JSON.parse(getState('season_result')) : null;
  let history = getState('season_history') ? JSON.parse(getState('season_history')) : [];
  if (record) {
    const champion = playoff && playoff.champion;
    const userChampion = champion != null && !playoff.userEliminated;
    const mvp = seasonResult && seasonResult.awards && seasonResult.awards.mvp ? seasonResult.awards.mvp.player : null;
    history.push({
      season: seasonNumber,
      wins: record.wins, losses: record.losses,
      result: userChampion ? 'champion' : (playoff && playoff.userEliminated ? `eliminated_r${playoff.userEliminatedRound || '?'}` : (playoff ? 'playoffs' : 'missed_playoffs')),
      champion: champion || null, // champion team name
      userChampion,
      mvp,
    });
  }

  // full draft order (worst record first, user included) from this season's standings
  const standings = getState('season_standings') ? JSON.parse(getState('season_standings')) : null;
  const userTeamName = getState('team_name') || 'My Team';
  let fullOrder = [];
  if (standings) {
    fullOrder = [...standings.east, ...standings.west]
      .sort((a, b) => a.wins - b.wins)
      .map((t) => t.name);
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
  const roster = db.prepare('SELECT r.player_id, p.name, p.age, p.overall, p.position FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(session);
  for (const row of roster) {
    if (ages[row.name] != null && ages[row.name] >= sim.retireAge(row.overall)) {
      retirements.push(row.name);
      userRetirePositions.push(row.position);
      if (row.overall >= 85) retiredLegends.push({ name: row.name, position: row.position, overall: row.overall, team: userTeamName, isUser: true });
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

  const totalRetirees = retirements.length + Object.values(aiNeeds).reduce((a, b) => a + b.length, 0);

  // reset transient season state, keep identity + dynasty + difficulty/mode + history
  const keep = ['team_name', 'conference', 'replaced_team', 'difficulty', 'mode', 'game_mode', 'player_ages', 'player_contracts', 'player_devo', 'player_morale', 'prev_overalls', 'hall_of_fame'];
  const keepVals = {};
  for (const k of keep) { const v = getState(k); if (v !== null) keepVals[k] = v; }
  db.prepare('DELETE FROM state WHERE session_id = ?').run(session);
  for (const [k, v] of Object.entries(keepVals)) setState(k, v);
  setState('season_history', JSON.stringify(history));
  setState('season_number', String(seasonNumber + 1));
  setState('rerolls', String(sim.REROLLS_PER_RUN));

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

  res.json({
    ok: true,
    retirements,
    aiRetirees: aiNeeds,
    refused: refused || [],
    offseasonPicks: retirements.length,
    seasonNumber: seasonNumber + 1,
    isFinal: isDynasty && seasonNumber >= DYNASTY_MAX_SEASONS,
    seasonRecap: {
      season: seasonNumber,
      champion: playoff ? playoff.champion : null,
      mvp: seasonResult && seasonResult.awards && seasonResult.awards.mvp ? { player: seasonResult.awards.mvp.player, team: seasonResult.awards.mvp.team } : null,
      retiredLegends,
      refused: refused || [],
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
  if (devo[name] == null) devo[name] = +(0.90 + Math.random() * 0.20).toFixed(2); // 0.90–1.10
}

// Overwrite overall + age on a team's roster rows with their dynasty-adjusted values,
// plus a season-morale nudge (±3) and a fallback potential for new players.
// EPM is now derived from current effective OVR via sim.derivedEpm().
// No independent EPM drift — EPM always reflects actual ability.

function applyDynasty(players) {
  const ages = playerAges();
  const morale = playerMorale();
  const devo = playerDevo();
  for (const p of players) {
    const curAge = ages[p.name] != null ? ages[p.name] : p.age;
    if (ages[p.name] != null) {
      const baseAge = p.age;
      const baseOverall = p.overall;
      const baseEpm = p.epm; // database value = base EPM for individual variation
      p.overall = sim.effectiveOverall(baseOverall, baseAge, curAge, devo[p.name] || 1);
      // EPM derived from current effective OVR, blended with individual base EPM
      p.epm = sim.derivedEpm(p.overall, baseEpm);
      const epmFromOvr = (p.overall - 80) * 0.33;
      const blended = epmFromOvr * 0.85 + baseEpm * 0.15;
      p.oepm = +Math.max(-3, Math.min(5, blended * 0.55)).toFixed(1);
      p.depm = +Math.max(-3, Math.min(4, blended * 0.45)).toFixed(1);
      p.age = curAge;
    }
    const m = morale[p.name] || 0;
    if (m) p.overall = Math.max(40, p.overall + Math.round(m * 0.5));
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
function draftBoard() {
  const classIds = getState('draft_class') ? JSON.parse(getState('draft_class')) : [];
  const session = currentSession();
  const picked = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session).map((r) => r.player_id));
  const avail = classIds.filter((id) => !picked.has(id));
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

// AI teams auto-pick in `teamsToPick` order, each taking rookies for its retired
// positions. Records each pick into `draft_picks` for the draft-board view.
function runAIDraft(teamsToPick) {
  const classIds = getState('draft_class') ? JSON.parse(getState('draft_class')) : [];
  const needs = getState('draft_needs') ? JSON.parse(getState('draft_needs')) : {};
  if (!classIds.length || !teamsToPick || !teamsToPick.length) return;
  const session = currentSession();
  const picked = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session).map((r) => r.player_id));
  const available = new Set(classIds.filter((id) => !picked.has(id)));
  const confOf = {};
  for (const t of sim.NBA_TEAMS) confOf[t.name] = t.conf;
  const ins = db.prepare('INSERT INTO league_teams (session_id, team_name, conf, player_id, role, slot) VALUES (?, ?, ?, ?, ?, ?)');
  const ages = playerAges();
  const contracts = playerContracts();
  const devo = playerDevo();
  const picks = getState('draft_picks') ? JSON.parse(getState('draft_picks')) : [];
  for (const team of teamsToPick) {
    const wanted = needs[team] || [];
    for (const pos of wanted) {
      const rookieId = bestAvailableRookie(available, [pos]);
      if (rookieId == null) break;
      available.delete(rookieId);
      const p = db.prepare('SELECT name, age, position, overall FROM players WHERE id = ?').get(rookieId);
      ins.run(session, team, confOf[team], rookieId, 'bench', null);
      if (p) { ages[p.name] = p.age; contracts[p.name] = 4; seedDevo(devo, p.name); }
      picks.push({ team, player: p.name, position: p.position, overall: p.overall });
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

// Shared season-finish: awards → trophies, save state, auto-save team, respond.
function finishSeason(res, config, result, playerAverages) {
  setState('season_result', JSON.stringify(result));
  const conf = config.conference;
  const myConf = conf === 'East' ? result.east : result.west;
  const madePlayoffs = myConf.slice(0, 8).some((t) => t.isUser);
  const myStanding = [...result.east, ...result.west].find((t) => t.isUser);
  setState('season_record', JSON.stringify({ wins: myStanding.wins, losses: myStanding.losses, conference: conf }));
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
  };
  setState('phase', 'season');
  setState('season_report', JSON.stringify(report));
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

  const { teams, leagueAvg, aiBonus } = resolveLeague(userTeam, config);
  const schedule = sim.buildSchedule(teams);
  const standings = sim.simulateGames(teams, schedule.first, aiBonus);

  setState('season_league', JSON.stringify({ teams, leagueAvg, aiBonus }));
  setState('season_schedule', JSON.stringify(schedule));
  setState('season_standings', JSON.stringify(standings));
  setState('trade_points', '0');
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
  // Dynasty mode: smooth age curve peaking at 27, gradually declining after.
  if (getState('game_mode') !== 'dynasty') return players.reduce((s, p) => s + p.overall, 0);
  const ages = playerAges();
  return players.reduce((s, p) => {
    const age = ages[p.name] || p.age || 26;
    // Smooth linear ramp: young premium up to +5.6% at age 20, no adjustment at 27,
    // gradual decline to -18% at age 37+.
    const f = age <= 27 ? 1.0 + (27 - age) * 0.008 : Math.max(0.80, 1.0 - (age - 27) * 0.018);
    return s + Math.round(p.overall * f);
  }, 0);
}

function myRosterRows() {
  return applyDynasty(db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id WHERE r.session_id = ?').all(currentSession()));
}

function brief(p) { return { id: p.id, name: p.name, position: p.position, overall: p.overall }; }

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
  const rawLeague = getState('season_league');
  if (!rawLeague) return res.status(400).json({ error: 'Start the season first' });
  const league = JSON.parse(rawLeague);
  const myRoster = myRosterRows().map(brief);
  const aiPlayers = league.teams.filter((t) => !t.isUser).flatMap((t) => t.players.map((p) => ({ ...brief(p), team: t.name }))).sort((a, b) => b.overall - a.overall);
  res.json({ myRoster, aiPlayers, remainingPoints: MAX_TRADE_POINTS - tradePoints(), leagueTradeLog: getState('league_trade_log') ? JSON.parse(getState('league_trade_log')) : [] });
});

// Player-initiated (or accept an offer): n-for-n trade.
app.post('/api/trade', (req, res) => {
  const { myPlayerIds, aiPlayerIds } = req.body || {};
  const bad = !Array.isArray(myPlayerIds) || !Array.isArray(aiPlayerIds) || !myPlayerIds.length || myPlayerIds.length !== aiPlayerIds.length || myPlayerIds.length > 3;
  if (bad) return res.status(400).json({ error: 'Pick the same number of players (1-3) on each side' });

  const myPlayers = myRosterRows().filter((p) => myPlayerIds.includes(+p.id));
  if (myPlayers.length !== myPlayerIds.length) return res.status(400).json({ error: 'One of your players is not on your roster' });

  const rawLeague = getState('season_league');
  if (!rawLeague) return res.status(400).json({ error: 'Start the season first' });
  const league = JSON.parse(rawLeague);

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

  const rawLeague = getState('season_league');
  if (!rawLeague) return res.status(400).json({ error: 'Start the season first' });
  const league = JSON.parse(rawLeague);

  const n = myPlayers.length;
  const target = tradeValue(myPlayers);
  const margin = TRADE_ACCEPT_MARGIN * n;
  const rand = mulberry32(hashIds(myPlayerIds)); // same combination → same 15 offers (no refresh)
  const offers = [];
  const aiTeams = shuffleSeeded(league.teams.filter((t) => !t.isUser), rand).slice(0, 15);
  for (const t of aiTeams) {
    // AI lowballs/highballs within the margin, concentrated near fair (triangular) —
    // only a small share of offers hit the ±margin extremes. The package is capped at
    // target + margin so an offer never lets the player exceed the max-difference bound.
    const noise = (rand() + rand() - 1) * margin;
    const pkg = bestPackage(t.players, n, target + noise, target + margin);
    if (!pkg) continue;
    offers.push({ aiTeam: t.name, aiPlayers: pkg.map(brief), aiTotal: tradeValue(pkg) });
  }
  res.json({ offers, myPlayers: myPlayers.map(brief), myTotal: target });
});

// Incoming AI proposals (fixed 15, generated once at season start).
app.get('/api/trade/proposals', (req, res) => {
  const raw = getState('trade_proposals');
  const proposals = raw ? JSON.parse(raw) : [];
  // drop proposals whose target players are no longer on the roster (traded away)
  const myIds = new Set(myRosterRows().map((p) => p.id));
  const valid = proposals.filter((p) => p.myPlayers.every((x) => myIds.has(x.id)));
  res.json({ proposals: valid });
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

function simulateSeries(a, b) {
  let aw = 0, bw = 0;
  const games = [];
  const aIsUser = a.isUser, bIsUser = b.isUser;
  const aAcc = {}, bAcc = {};

  // playoff strength (top-heavy minutes) + hard-mode AI bonus, computed once
  const aStrength = sim.teamStrength(a.players, true) + (a.isUser ? 0 : sim.HARD_AI_BONUS);
  const bStrength = sim.teamStrength(b.players, true) + (b.isUser ? 0 : sim.HARD_AI_BONUS);

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
    aName: s.a.name, bName: s.b.name,
    aStats: s.aStats, bStats: s.bStats,
    aRoster: s.a.players.map(p => ({ name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)) })),
    bRoster: s.b.players.map(p => ({ name: p.name, position: p.position, overall: p.overall, rating: f1(sim.powerRating(p)) })),
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

app.post('/api/playoffs/round', (req, res) => {
  const raw = getState('playoff_state');
  if (!raw) return res.status(400).json({ error: 'Start the playoffs first' });
  const state = JSON.parse(raw);
  if (state.champion) return res.status(400).json({ error: 'Playoffs already finished' });

  const matchups = matchupsFor(state);
  const results = matchups.map(m => ({ ...simulateSeries(m.a, m.b), conf: m.conf, a: m.a, b: m.b }));

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
  if (!userStillIn) { state.userEliminated = true; state.userEliminatedRound = state.round; }

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
    gameMode: getState('game_mode') === 'dynasty' ? 'dynasty' : 'normal',
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
  out.offseasonPicks = parseInt(getState('offseason_picks') || '0', 10);
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
  const gameMode = getState('game_mode') === 'dynasty' ? 'dynasty' : 'normal';
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
    dynastyMax: gameMode === 'dynasty' ? DYNASTY_MAX_SEASONS : null,
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
