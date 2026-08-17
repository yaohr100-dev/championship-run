// Championship Run — simulation engine.
// Pure game logic on top of SQLite. The API (server.js) calls these.

const { DatabaseSync } = require('node:sqlite');
const { currentSession } = require('./session');
const { dbPath } = require('./db-path');

const DB_PATH = dbPath();

// ---- constants (calibratable) ----
const EPM_COEF = 0.5;          // 实力值 = overall + epm * 0.5
// Sigmoid minutes model, fitted to real MP data (fit-mp.js):
//   mp(rating) = MP_A + (MP_B - MP_A) / (1 + exp(-(rating - MP_MU) / s))
// Playoffs use a steeper curve (smaller s) so stars/top-8 get a bigger share.
const MP_A = 7.5;
const MP_B = 33.5;
const MP_MU = 76.5;
const MP_S = 4;    // regular season
const MP_S_PO = 3; // playoffs (top-heavy)
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const ROSTER_SIZE = 10;
const STARTER_COUNT = 5;
const TOTAL_MINUTES = 240;
const REROLLS_PER_RUN = 5;
const HARD_MODE_BUDGET = 400;  // hard mode salary cap
const HARD_AI_BONUS = 0;       // hard mode: strength bonus for every AI team (0 = off)
// Scoring share: anchored to ABILITY via a power-law expected-ppg curve fitted to
// the real data (expectedPts(overall) = 0.072 * (overall-55)^1.60). Raw real ppg is
// used only as a mild "usage tendency" correction (^USAGE_EXP), so a weak player's
// real per-36 rate (often inflated by low-competition minutes) can't balloon them to
// 25+ ppg, while strong players land near their real ppg.
const USAGE_EXP = 0.4;         // how strongly real usage tendency bends the share
const USAGE_EXP_PO = 0.6;      // playoffs: stars carry a bit more usage
const SEASON_GAMES = 82;
const SCALE_RS = 12;           // regular season: flatter (bigger randomness)
const SCALE_PO = 8;            // playoffs: steeper than the regular season (more decisive), but not so steep that a strong Finals opponent is unbeatable. Player title odds peak here (~15%) across the realistic opponent path.
const HOME_ADV = 2.0;          // home-court strength boost (rating points) — ~60% home win rate
const HOME_ADV_PO = HOME_ADV * (SCALE_PO / SCALE_RS); // = HOME_ADV now; kept as a ratio so the home rate stays ~60% in both phases
const AI_TEAM_BAND = 8;        // talent spread around an AI team's target strength (rating units); larger = more role players mixed in
const BENCH_MINUTES_RATIO = 0.75; // bench players play this fraction of their ability-driven minutes, so lineup choice affects team strength
const TEAMS_PER_CONF = 15;

// ---- injuries ----
// Per-game injury probability (26-yo baseline), age-weighted: young/prime players are
// durable, veterans get brittle. Kept low so injuries are felt but not constant.
function injuryProb(age) {
  const base = 0.025;
  const ageFactor = age >= 33 ? 1.7 : age >= 30 ? 1.3 : age >= 26 ? 1.0 : age >= 22 ? 0.85 : 0.7;
  return base * ageFactor;
}
// Games a new injury lasts: mostly 1, occasional 2-3, rare 4-6, very rare 7-12.
function injuryLength() {
  const r = Math.random();
  if (r < 0.40) return 1;
  if (r < 0.75) return 2 + Math.floor(Math.random() * 2);
  if (r < 0.95) return 4 + Math.floor(Math.random() * 3);
  return 7 + Math.floor(Math.random() * 6);
}

// Momentum: a win/loss streak nudges a team's effective strength, ±1% per game capped
// at ±6%. Winning builds momentum, losing snowballs — but it's a modest, capped swing.
function moraleFactor(streak) {
  return 1 + Math.max(-6, Math.min(6, streak)) * 0.01;
}

// Dynasty progression: how far a player's overall is from their peak at a given age.
// Young players rise (+ until 26), prime holds (26-29), then decline accelerates past 30.
function ageDelta(age) {
  const d = [ [-100, 20, -6], [21, 21, -5], [22, 22, -4], [23, 23, -3], [24, 24, -2], [25, 25, -1],
    [26, 29, 0], [30, 30, -1], [31, 31, -2], [32, 32, -3], [33, 33, -4], [34, 34, -5], [35, 35, -6], [36, 200, -8] ];
  for (const [lo, hi, delta] of d) if (age >= lo && age <= hi) return delta;
  return 0;
}

// A player's effective overall = their base 2K overall + (age curve at current age) -
// (age curve at base age). A 21-yo star gets better each year; a 30+ vet declines.
function effectiveOverall(baseOverall, baseAge, currentAge) {
  return Math.max(40, Math.round(baseOverall + ageDelta(currentAge) - ageDelta(baseAge)));
}

function openDb() {
  return new DatabaseSync(DB_PATH);
}

function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// logistic win probability from a rating difference
function winProb(diff, scale) {
  return 1 / (1 + Math.pow(10, -diff / scale));
}

// ---- player rating ----
function powerRating(p) {
  return p.overall + p.epm * EPM_COEF;
}

// Expected per-game points from a player's 2K overall, fitted to the real data.
// Power law (not linear) so low-overall players score far less per game: an 72-ovr
// fringe player ~7 ppg, a 98-ovr superstar ~30 ppg. This is the ability anchor for
// the scoring-share model.
function expectedPts(overall) {
  return 0.072 * Math.pow(Math.max(1, overall - 55), 1.60);
}

// Hard-mode salary: superstars cost disproportionately more, so under the cap you
// can't just hoard the best players. (overall-55)^2/20 → 60 costs 1, 80 costs 31,
// 95 costs 80.
function playerSalary(overall) {
  return Math.max(1, Math.round((overall - 55) * (overall - 55) / 20));
}

function minutesWeight(rating, topHeavy = false) {
  const s = topHeavy ? MP_S_PO : MP_S;
  return MP_A + (MP_B - MP_A) / (1 + Math.exp(-(rating - MP_MU) / s));
}

function positionDistance(a, b) {
  return Math.abs(POSITIONS.indexOf(a) - POSITIONS.indexOf(b));
}

// 位置折扣: 主位置或副位置 100%, 否则 1步97.5%, 2步95%, 3+步90%
function positionDiscount(natural, slot, secondary) {
  if (slot === natural || slot === secondary) return 1.0;
  const d = positionDistance(natural, slot);
  if (d === 1) return 0.975;
  if (d === 2) return 0.95;
  return 0.9;
}

// 球队实力 = 时间加权平均 of (实力值 × 位置折扣)
// `players` entries have { position, overall, epm, role, slot }
// Minutes are ability-driven (minutesWeight), scaled by BENCH_MINUTES_RATIO for bench
// players so WHO you start (vs bench) actually moves team strength.
function roleMinutes(p, topHeavy = false) {
  const w = minutesWeight(powerRating(p), topHeavy);
  return p.role === 'starter' ? w : w * BENCH_MINUTES_RATIO;
}

function teamStrength(players, topHeavy = false) {
  let num = 0, den = 0;
  for (const p of players) {
    const r = powerRating(p);
    const w = roleMinutes(p, topHeavy);
    const disc = p.role === 'starter' && p.slot ? positionDiscount(p.position, p.slot, p.position2) : 1.0;
    num += r * disc * w;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

// age -> form-factor half-range (U-shaped: prime narrow, young/old wide)
function formHalfRange(age) {
  const distance = Math.abs(age - 26);
  const extra = Math.max(0, distance - 4) * 0.06;
  return Math.min(0.4 + extra, 0.5);
}

// per-player form factor, age-dependent, concentrated near 1.0. Playoffs use a
// wider range (1.5x half-range) so individual stat lines swing more game to game.
// (teamForm below deliberately ignores this amplification.)
function formFactor(age, playoff = false) {
  const u = (Math.random() + Math.random() + Math.random()) / 3; // bell-ish around 0.5
  const halfRange = formHalfRange(age) * (playoff ? 1.5 : 1);
  return 1 + (u - 0.5) * 2 * halfRange;
}

// team-level "hot/cold night" factor: triangular centered at 1.0, ~±12%
function gameLuck() {
  return 1 + (Math.random() + Math.random() - 1) * 0.12;
}

// ---- draft ----
function getRosterPlayers(db) {
  return db.prepare(`
    SELECT p.*, r.role, r.slot FROM roster r
    JOIN players p ON p.id = r.player_id
  `).all();
}

// 5 random candidates, excluding drafted, with position diversity (>= 4 of 5)
function draftCandidates(db) {
  const drafted = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));
  const all = db.prepare('SELECT * FROM players').all().filter(p => !drafted.has(p.id));
  let candidates = [];
  for (let i = 0; i < 200; i++) {
    candidates = shuffle(all).slice(0, 5);
    const positions = new Set(candidates.map(p => p.position));
    if (positions.size >= 4) break;
  }
  return candidates;
}

// Offseason free agency: same shape as the draft, but restricted to young players
// (age <= maxAge) so a retired veteran is replaced by an up-and-coming player.
function freeAgentCandidates(db, maxAge = 23) {
  const drafted = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));
  const all = db.prepare('SELECT * FROM players').all().filter(p => !drafted.has(p.id) && p.age <= maxAge);
  const pool = all.length >= 5 ? all : db.prepare('SELECT * FROM players').all().filter(p => !drafted.has(p.id));
  let candidates = [];
  for (let i = 0; i < 200; i++) {
    candidates = shuffle(pool).slice(0, 5);
    const positions = new Set(candidates.map(p => p.position));
    if (positions.size >= 4) break;
  }
  return candidates;
}

// ---- AI team generation ----

// Weighted sample (without replacement) of `n` players, favouring ratings near
// `center` (a Gaussian preference). This lets each AI team tilt toward its target
// strength — strong teams pull the top talent, weak teams pull the bottom — instead
// of every team regressing to the pool median. `band` controls how much a team's
// talent spreads around its center (a star-plus-role-players shape vs a flat roster).
function weightedSampleByRating(list, center, band, n) {
  const arr = [...list];
  const out = [];
  while (out.length < n && arr.length) {
    const weights = arr.map((p) => {
      const d = powerRating(p) - center;
      return Math.exp(-(d * d) / (2 * band * band));
    });
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) { out.push(arr.shift()); continue; }
    let pick = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < arr.length; i++) { pick -= weights[i]; if (pick <= 0) { idx = i; break; } }
    out.push(arr[idx]);
    arr.splice(idx, 1);
  }
  return out;
}

// Build one 10-player AI team from the pool (excluding the user's drafted players AND
// any players already assigned to another AI team), position-balanced, whose team
// strength is close to `target`. Returns array of player rows with role/slot.
function generateAITeam(db, excludeIds, target) {
  const pool = db.prepare('SELECT * FROM players').all().filter(p => !excludeIds.has(p.id));
  let best = null, bestDiff = Infinity;
  for (let attempt = 0; attempt < 60; attempt++) {
    // pick 2 per position = 10 players, tilted toward the target strength
    const picked = [];
    for (const pos of POSITIONS) {
      const atPos = pool.filter(p => p.position === pos);
      picked.push(...weightedSampleByRating(atPos, target, AI_TEAM_BAND, 2));
    }
    const team = shuffle(picked).slice(0, ROSTER_SIZE);
    // assign best 5 (by 2K overall) to their own position slot (starters), rest bench;
    // sort each group by overall desc so the roster shows starters + bench in order
    const ranked = [...team].sort((a, b) => b.overall - a.overall || powerRating(b) - powerRating(a));
    const starters = ranked.slice(0, STARTER_COUNT);
    const bench = ranked.slice(STARTER_COUNT);
    const withRoles = [
      ...starters.map(p => ({ ...p, role: 'starter', slot: p.position })),
      ...bench.map(p => ({ ...p, role: 'bench', slot: null })),
    ];
    const s = teamStrength(withRoles);
    const diff = Math.abs(s - target);
    if (diff < bestDiff) { bestDiff = diff; best = withRoles; }
    if (diff < 0.5) break;
  }
  return best;
}

const NBA_TEAMS = [
  { name: 'Atlanta Hawks', conf: 'East' },
  { name: 'Boston Celtics', conf: 'East' },
  { name: 'Brooklyn Nets', conf: 'East' },
  { name: 'Charlotte Hornets', conf: 'East' },
  { name: 'Chicago Bulls', conf: 'East' },
  { name: 'Cleveland Cavaliers', conf: 'East' },
  { name: 'Dallas Mavericks', conf: 'West' },
  { name: 'Denver Nuggets', conf: 'West' },
  { name: 'Detroit Pistons', conf: 'East' },
  { name: 'Golden State Warriors', conf: 'West' },
  { name: 'Houston Rockets', conf: 'West' },
  { name: 'Indiana Pacers', conf: 'East' },
  { name: 'Los Angeles Clippers', conf: 'West' },
  { name: 'Los Angeles Lakers', conf: 'West' },
  { name: 'Memphis Grizzlies', conf: 'West' },
  { name: 'Miami Heat', conf: 'East' },
  { name: 'Milwaukee Bucks', conf: 'East' },
  { name: 'Minnesota Timberwolves', conf: 'West' },
  { name: 'New Orleans Pelicans', conf: 'West' },
  { name: 'New York Knicks', conf: 'East' },
  { name: 'Oklahoma City Thunder', conf: 'West' },
  { name: 'Orlando Magic', conf: 'East' },
  { name: 'Philadelphia 76ers', conf: 'East' },
  { name: 'Phoenix Suns', conf: 'West' },
  { name: 'Portland Trail Blazers', conf: 'West' },
  { name: 'Sacramento Kings', conf: 'West' },
  { name: 'San Antonio Spurs', conf: 'West' },
  { name: 'Toronto Raptors', conf: 'East' },
  { name: 'Utah Jazz', conf: 'West' },
  { name: 'Washington Wizards', conf: 'East' },
];

// ---- regular season ----

// Build the 30-team league (user + 29 AI teams, exclusive rosters).
function buildLeague(db, userTeam, config) {
  const { conference = 'West', replacedTeam = 'Boston Celtics', teamName = 'My Team', hard = false } = config || {};

  const draftedIds = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));

  // AI teams are the 29 real teams other than the replaced one. Shuffle the names so
  // strong/weak rosters spread across BOTH conferences (NBA_TEAMS lists every East
  // team before every West team, so without this the descending strength assignment
  // would stack the strong teams in one conference).
  const aiNames = shuffle(NBA_TEAMS.filter(t => t.name !== replacedTeam));

  // Build rosters from strongest to weakest so the strongest teams claim the best
  // players first, and every roster is exclusive (no player appears on two teams).
  const usedIds = new Set(draftedIds);
  const aiTeams = [];
  const minS = 70, maxS = 88; // league strength range; cap slightly below the player's ceiling (~90) so a well-built team can still top the league
  for (let i = 0; i < 29; i++) {
    const target = maxS - (maxS - minS) * (i / 28);
    const players = generateAITeam(db, usedIds, target);
    for (const p of players) usedIds.add(p.id);
    aiTeams.push({ isUser: false, conf: aiNames[i].conf, players, name: aiNames[i].name });
  }

  const teams = [{ isUser: true, conf: conference, players: userTeam, name: teamName || replacedTeam }, ...aiTeams];
  const aiBonus = hard ? HARD_AI_BONUS : 0;
  const strengthOf = (t) => teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  const leagueAvg = teams.reduce((s, t) => s + strengthOf(t), 0) / teams.length;
  return { teams, leagueAvg, aiBonus };
}

// Build the 82-game regular-season schedule, split into two 41-game halves so the
// mid-season trade window can sit between them.
//   Half 1: one full round robin (29) + 12 intra-conference games (41)
//   Half 2: the mirrored round robin + the other 12 intra-conference games (41)
// Every team faces every other team exactly twice (once home, once away), plus a
// home-and-home against 12 same-conference opponents — a 30-team analogue of the
// real NBA's conference-heavy schedule.
function buildSchedule(teams) {
  const n = teams.length;
  const rr1 = [], rr2 = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      rr1.push({ home: i, away: j });
      rr2.push({ home: j, away: i });
    }
  }
  // Extra intra-conference home-and-home games (12 opponents per team), built as a
  // cycle so the edges stay symmetric: each team plays the 6 teams ahead of it and
  // the 6 behind it in its conference's circular order.
  const exA = [], exB = [];
  for (const conf of ['East', 'West']) {
    const ids = teams.map((t, k) => (t.conf === conf ? k : -1)).filter((k) => k >= 0);
    const m = ids.length;
    for (let k = 0; k < m; k++) {
      for (let d = 1; d <= 6; d++) {
        const a = ids[k], b = ids[(k + d) % m];
        exA.push({ home: a, away: b });
        exB.push({ home: b, away: a });
      }
    }
  }
  return { first: [...rr1, ...exA], second: [...rr2, ...exB] };
}

// Best box-score line in a single game (used for "player of the game").
// Weighted close to real NBA Game Score: points dominate, rebounds/assists help,
// steals/blocks minor. (A triple-double machine still wins most games, but a
// teammate's scoring outburst can occasionally take it.)
function gameStar(stats) {
  let best = null, bestScore = -Infinity;
  for (const s of stats) {
    const score = s.pts + 0.5 * s.trb + 0.5 * s.ast + s.stl + s.blk;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best ? best.name : null;
}

// Notable single-game lines: a triple-double (a Jokic-type star), or a 25+ point
// outburst (~7% of games — rare enough to feel special, not so rare it never shows).
function milestoneOf(stats) {
  for (const s of stats) {
    if (s.pts >= 10 && s.trb >= 10 && s.ast >= 10) return s.name + ' triple-double';
  }
  for (const s of stats) {
    if (s.pts >= 25) return s.name + ' ' + s.pts + 'pts';
  }
  return null;
}

// Simulate one half's schedule head-to-head. Each matchup produces a real score and
// a winner (home court helps); both teams accumulate stats, W/L and — for the user —
// a per-game log. `schedule` is an array of { home, away } indices into `teams`.
function simulateGames(teams, schedule, aiBonus) {
  const strengthOf = (t) => teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  const rows = teams.map((t) => {
    const s = strengthOf(t);
    const acc = {};
    for (const p of t.players) acc[p.name] = { name: p.name, position: p.position, games: 0, pts: 0, trb: 0, ast: 0, stl: 0, blk: 0, epm: 0, depm: 0, fgPct: 0, threePct: 0, ftPct: 0, mvp: 0 };
    return { t, s, wins: 0, played: 0, gameLog: t.isUser ? [] : null, acc, injured: new Map(), streak: 0 };
  });

  const accumulate = (row, stats) => {
    for (const st of stats) {
      const entry = row.acc[st.name];
      if (!entry) continue;
      const p = row.t.players.find((x) => x.name === st.name);
      entry.games += 1;
      entry.pts += st.pts; entry.trb += st.trb; entry.ast += st.ast; entry.stl += st.stl; entry.blk += st.blk;
      entry.epm += gameEPM(st, p); entry.depm += gameDEPM(st, p);
      entry.fgPct += st.fgPct; entry.threePct += st.threePct; entry.ftPct += st.ftPct;
    }
  };

  for (const { home, away } of schedule) {
    const H = rows[home], A = rows[away];
    // 1. Recover: decrement each injured player's games-left; those at 0 return.
    for (const row of [H, A]) {
      for (const [name, left] of [...row.injured]) {
        if (left <= 1) row.injured.delete(name);
        else row.injured.set(name, left - 1);
      }
    }
    // 2. Healthy lineups (injured players sit out; bench steps up).
    const hPlayers = H.t.players.filter((p) => !H.injured.has(p.name));
    const aPlayers = A.t.players.filter((p) => !A.injured.has(p.name));
    // 3. Effective strength for this game = healthy lineup only (fall back to full
    //    roster if everyone were somehow hurt, which never happens in practice).
    //    Momentum (win/loss streak) nudges it: a hot team plays a bit above itself.
    const hS = (hPlayers.length ? teamStrength(hPlayers) + (H.t.isUser ? 0 : aiBonus) : H.s) * moraleFactor(H.streak);
    const aS = (aPlayers.length ? teamStrength(aPlayers) + (A.t.isUser ? 0 : aiBonus) : A.s) * moraleFactor(A.streak);
    // a = home team; home court adds HOME_ADV to its effective strength.
    const r = simulateMatchup(hPlayers, aPlayers, 'regular', hS + HOME_ADV, aS);
    const homeWon = r.aWins;
    H.played++; A.played++;
    if (homeWon) { H.wins++; H.streak = H.streak > 0 ? H.streak + 1 : 1; A.streak = A.streak < 0 ? A.streak - 1 : -1; }
    else { A.wins++; A.streak = A.streak > 0 ? A.streak + 1 : 1; H.streak = H.streak < 0 ? H.streak - 1 : -1; }
    const starA = gameStar(r.aStats);
    const starB = gameStar(r.bStats);
    const milA = milestoneOf(r.aStats);
    const milB = milestoneOf(r.bStats);
    if (H.gameLog) H.gameLog.push({ opp: A.t.name, home: true, win: homeWon, score: r.aScore, oppScore: r.bScore, star: starA, milestone: milA, streak: H.streak });
    if (A.gameLog) A.gameLog.push({ opp: H.t.name, home: false, win: !homeWon, score: r.bScore, oppScore: r.aScore, star: starB, milestone: milB, streak: A.streak });
    // tally player-of-the-game for the user's team (mvp count)
    if (H.gameLog && starA && H.acc[starA]) H.acc[starA].mvp++;
    if (A.gameLog && starB && A.acc[starB]) A.acc[starB].mvp++;
    accumulate(H, r.aStats);
    accumulate(A, r.bStats);
    // 4. Roll new injuries for each team's healthy players; record on the user's log.
    for (const row of [H, A]) {
      for (const p of row.t.players) {
        if (row.injured.has(p.name)) continue;
        if (Math.random() < injuryProb(p.age)) {
          const games = injuryLength();
          row.injured.set(p.name, games);
          if (row.gameLog) {
            const last = row.gameLog[row.gameLog.length - 1];
            if (last) (last.injuries = last.injuries || []).push({ name: p.name, games });
          }
        }
      }
    }
  }

  return rows.map(({ t, s, wins, played, gameLog, acc }) => ({ ...t, strength: s, wins, losses: played - wins, winPct: played ? wins / played : 0, gameLog, acc }));
}

// Merge two half-season results (same teams, same order) into one full season.
// Player lists may differ between halves (trades), so merge the UNION of names.
function mergeStandings(s1, s2, totalGames) {
  const FIELDS = ['pts', 'trb', 'ast', 'stl', 'blk', 'epm', 'depm', 'fgPct', 'threePct', 'ftPct', 'mvp'];
  return s1.map((t1, i) => {
    const t2 = s2[i];
    const acc = {};
    const names = new Set([...Object.keys(t1.acc), ...Object.keys(t2.acc)]);
    for (const name of names) {
      const a = t1.acc[name], b = t2.acc[name];
      const entry = { name, position: (a || b).position, half: (a && b) ? 'full' : (a ? 'first' : 'second') };
      for (const f of FIELDS) entry[f] = (a ? a[f] : 0) + (b ? b[f] : 0);
      entry.games = (a ? a.games : 0) + (b ? b.games : 0);
      acc[name] = entry;
    }
    const wins = t1.wins + t2.wins;
    const gameLog = [...(t1.gameLog || []), ...(t2.gameLog || [])];
    return { ...t2, wins, losses: totalGames - wins, winPct: wins / totalGames, gameLog, acc };
  });
}

// Turn accumulated standings into final results: per-player averages, sorted
// conferences, and awards.
function finalizeSeason(standings, totalGames, leagueAvg) {
  for (const t of standings) {
    t.playerAverages = Object.values(t.acc).map((s) => {
      const g = s.games || totalGames; // per-player games (a traded-in player plays only one half)
      return { name: s.name, position: s.position, half: s.half || 'full', pts: s.pts / g, trb: s.trb / g, ast: s.ast / g, stl: s.stl / g, blk: s.blk / g, epm: s.epm / g, depm: s.depm / g, fgPct: s.fgPct / g, threePct: s.threePct / g, ftPct: s.ftPct / g, mvp: s.mvp };
    });
  }
  const east = standings.filter((t) => t.conf === 'East').sort((a, b) => b.wins - a.wins);
  const west = standings.filter((t) => t.conf === 'West').sort((a, b) => b.wins - a.wins);
  return { east, west, leagueAvg, awards: computeAwards(standings) };
}

// Full-season convenience (one call): both halves of the schedule, merged.
function simulateSeason(db, userTeam, config) {
  const { teams, leagueAvg, aiBonus } = buildLeague(db, userTeam, config);
  const schedule = buildSchedule(teams);
  const s1 = simulateGames(teams, schedule.first, aiBonus);
  const s2 = simulateGames(teams, schedule.second, aiBonus);
  const combined = mergeStandings(s1, s2, SEASON_GAMES);
  return finalizeSeason(combined, SEASON_GAMES, leagueAvg);
}

// Single-game EPM: anchored to the player's real EPM, adjusted by their per-game
// form factor (0.5..1.5, centred at 1). Range ~-15..+15, mostly within ±3 of real EPM.
function gameEPM(stats, p) {
  return p.epm + (stats.f - 1) * 15;
}

// Single-game DEPM: real DEPM adjusted by the same per-game form. Range ~-6..+8.
function gameDEPM(stats, p) {
  return p.depm + (stats.f - 1) * 6;
}

// Regular-season awards from SIMULATED per-player stats + team success + simulated EPM/DEPM.
function computeAwards(teams) {
  const all = [];
  for (const t of teams) {
    const winPct = t.wins / SEASON_GAMES;
    for (const p of t.players) {
      const avg = t.playerAverages.find(a => a.name === p.name);
      if (!avg) continue;
      all.push({ name: p.name, team: t.name, isUser: t.isUser, role: p.role, winPct, avg });
    }
  }
  const award = (p) => (p ? { player: p.name, team: p.team, isUser: p.isUser } : null);

  // MVP: box-score composite + team wins + simulated EPM (impact)
  const mvpScore = (p) => p.avg.pts + 1.2 * p.avg.trb + 1.5 * p.avg.ast + 2 * p.avg.stl + 2 * p.avg.blk + p.winPct * 25 + p.avg.epm * 3;
  // DPOY: steals/blocks + team wins + simulated DEPM
  const dpoyScore = (p) => p.avg.stl * 3 + p.avg.blk * 3 + p.winPct * 15 + p.avg.depm * 5;

  const byMvp = [...all].sort((a, b) => mvpScore(b) - mvpScore(a));
  const byDpoy = [...all].sort((a, b) => dpoyScore(b) - dpoyScore(a));
  // All-NBA First Team: top 5 players overall (by MVP score), regardless of position
  const firstTeam = byMvp.slice(0, 5).map(p => ({ player: p.name, team: p.team, isUser: p.isUser, position: p.avg.position }));
  return {
    mvp: award(byMvp[0]),
    dpoy: award(byDpoy[0]),
    sixMan: award(byMvp.find(p => p.role === 'bench') || null),
    firstTeam,
  };
}

// team form = minutes-weighted average of individual form factors.
// Uses the NON-amplified form factor even in playoffs: the 1.5x playoff widening is
// for per-player stat lines only (allocateStats). Amplifying team form would add
// team-level noise and cause MORE playoff upsets — the opposite of the intent.
function teamForm(players, topHeavy = false) {
  let num = 0, den = 0;
  for (const p of players) {
    const w = roleMinutes(p, topHeavy);
    num += formFactor(p.age, false) * w;
    den += w;
  }
  return den === 0 ? 1 : num / den;
}

// Head-to-head matchup simulation with a configurable mode (regular/playoff).
// Playoff mode uses a steeper win curve (SCALE_PO) and a top-heavy minutes curve,
// so the starters/top-8 carry more weight.
function simulateMatchup(a, b, mode, aStrengthOverride, bStrengthOverride) {
  const playoff = mode === 'playoff';
  const scale = playoff ? SCALE_PO : SCALE_RS;
  const aStrength = aStrengthOverride != null ? aStrengthOverride : teamStrength(a, playoff);
  const bStrength = bStrengthOverride != null ? bStrengthOverride : teamStrength(b, playoff);
  // team-level "any given night" luck is a regular-season effect. Playoffs are more
  // deterministic: the steeper win curve + top-heavy minutes already decide the game,
  // so we drop gameLuck there (but keep per-player form variance in the stat lines).
  const F_a = teamForm(a, playoff) * (playoff ? 1 : gameLuck());
  const F_b = teamForm(b, playoff) * (playoff ? 1 : gameLuck());
  const eff_a = aStrength * F_a;
  const eff_b = bStrength * F_b;
  const pA = winProb(eff_a - eff_b, scale);
  const aWins = Math.random() < pA;

  const o_a = opponentFactor(bStrength);
  const o_b = opponentFactor(aStrength);
  let aScore = Math.round(teamScore(eff_a) * o_a);
  let bScore = Math.round(teamScore(eff_b) * o_b);
  if (aWins && aScore <= bScore) aScore = bScore + 1 + Math.floor(Math.random() * 3);
  if (!aWins && bScore <= aScore) bScore = aScore + 1 + Math.floor(Math.random() * 3);

  const aStats = allocateStats(a, aScore, playoff);
  const bStats = allocateStats(b, bScore, playoff);
  return { aWins, aScore, bScore, aStats, bStats };
}

// strong team suppresses opponent's output; weak team boosts it
function opponentFactor(oppStrength) {
  const baseline = 82;
  return Math.max(0.85, Math.min(1.15, 1 + (baseline - oppStrength) * 0.006));
}

// team score: calibrated so a league-average strength (~80) scores ~112 (real NBA).
// Gaussian noise (std 8) gives realistic game-to-game score variance.
function teamScore(strength) {
  const noise = gaussian() * 8;
  return Math.max(90, Math.min(140, 112 + (strength - 80) * 1.0 + noise));
}

// Allocate a non-negative integer `total` across `weights` proportionally,
// using the largest-remainder method so the returned integers sum exactly to `total`.
function allocateInteger(weights, total) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    // degenerate: no meaningful weights — spread the total evenly
    const base = Math.floor(total / n);
    const out = new Array(n).fill(base);
    let rem = total - base * n;
    for (let i = 0; rem > 0; i = (i + 1) % n) { out[i]++; rem--; }
    return out;
  }
  const raw = weights.map(w => (w / sum) * total);
  const ints = raw.map(Math.floor);
  let remainder = total - ints.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - ints[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) ints[order[k].i]++;
  return ints;
}

// Like allocateInteger, but rounds each share independently so every player keeps
// their own (possibly sub-1) share. The returned sum lands near `total` rather than
// exactly on it — a small, natural amount of team-level variance. Use this for small
// team totals (STL/BLK) where largest-remainder would force low-share players to 0
// in almost every game.
function allocateRandom(weights, total) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  return weights.map(w => {
    const raw = (w / sum) * total;
    const floor = Math.floor(raw);
    return floor + (Math.random() < raw - floor ? 1 : 0);
  });
}

// Standard normal via Box-Muller: ~N(0, 1), concentrated near 0 with occasional ±3 tails.
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Team-level counting-stat total. `mid` is the center, `sigma` one standard deviation:
// the named ranges below are the MAIN concentration (~90%) — values spill outside ~10% of the time.
//    rebounds ~44 ± 3.9 (mostly 38-50)
//    assists  ~27 ± 3.3 (mostly 22-32)
//    steals   ~9  ± 1.5 (mostly 6-12)
//    blocks   ~5  ± 0.8 (mostly 3-7)
function teamStatTotal(mid, sigma) {
  return Math.max(1, Math.round(mid + gaussian() * sigma));
}

// Allocate team points + counting stats to the roster players.
// Points sum to the team score (90-140); each counting stat sums to a realistic
// team total, then is split among players proportionally to their real per-game number.
function allocateStats(players, teamScore, topHeavy = false) {
  const rows = players.map(p => {
    const f = formFactor(p.age, topHeavy);
    const disc = p.role === 'starter' && p.slot ? positionDiscount(p.position, p.slot, p.position2) : 1.0;
    const simMin = roleMinutes(p, topHeavy); // simulated minutes (sigmoid, bench-scaled)
    const realMp = p.mp > 0 ? p.mp : simMin;               // real MP, sigmoid fallback
    return { p, f, disc, simMin, realMp };
  });

  const score = Math.round(teamScore);
  // every player scores at least 1 point, so a 0-point line can't conflict with FG%
  const minPts = 1;
  const remaining = Math.max(0, score - minPts * rows.length);
  // Scoring share = expectedPts(overall) × (real_pts/expectedPts)^usageExp. The
  // power-law expectedPts anchors to ability so weak players stay low; the usage
  // ratio is a mild tendency correction so a high-usage star edges ahead of a
  // same-overall teammate. Playoffs raise usageExp slightly (stars carry more usage).
  const usageExp = topHeavy ? USAGE_EXP_PO : USAGE_EXP;
  const pts = allocateInteger(rows.map(x => {
    const exp = expectedPts(x.p.overall);
    const usage = Math.max(0.1, x.p.pts) / exp;
    return exp * Math.pow(usage, usageExp) * x.f * x.disc;
  }), remaining);
  for (let i = 0; i < pts.length; i++) pts[i] += minPts;
  // counting stats scale with simulated minutes relative to real minutes
  // (per-minute rate × simulated minutes), so box-score aligns with who the
  // minutes model actually plays — replacing the old binary bench penalty.
  const minShare = (x) => (x.simMin / x.realMp) * x.f;
  const trb = allocateInteger(rows.map(x => x.p.trb * minShare(x)), teamStatTotal(44, 3.9));
  const ast = allocateInteger(rows.map(x => x.p.ast * minShare(x)), teamStatTotal(27, 3.3));
  const stl = allocateRandom(rows.map(x => x.p.stl * minShare(x)), teamStatTotal(9, 1.5));
  const blk = allocateRandom(rows.map(x => x.p.blk * minShare(x)), teamStatTotal(5, 0.8));

  return rows.map((x, i) => ({
    name: x.p.name,
    position: x.p.position,
    f: x.f,
    pts: pts[i],
    trb: trb[i], ast: ast[i], stl: stl[i], blk: blk[i],
    fgPct: shotPct(x.p.fg_pct, 0.08, 0.25, 0.75),
    threePct: shotPct(x.p.three_pct, 0.12, 0.05, 0.55),
    ftPct: shotPct(x.p.ft_pct, 0.08, 0.45, 0.98),
  }));
}

// a regular-season game has no specific opponent: no opponent factor o
function simulateSeasonGame(players, strength) {
  const F = teamForm(players) * gameLuck();
  const eff = strength * F;
  const score = teamScore(eff);
  return allocateStats(players, score);
}

// Per-game shooting percentage: base value + noise, clamped to that stat's own
// realistic range (so a 90% FT shooter isn't crushed down to 60%).
function shotPct(base, amplitude, min, max) {
  return Math.max(min, Math.min(max, base + (Math.random() - 0.5) * amplitude));
}

module.exports = {
  openDb, powerRating, playerSalary, minutesWeight, positionDiscount, teamStrength,
  draftCandidates, freeAgentCandidates, generateAITeam, simulateSeason, buildLeague, buildSchedule, simulateGames, mergeStandings, finalizeSeason,
  simulateMatchup, simulateSeasonGame,
  teamForm, shuffle, gameEPM, gameDEPM, POSITIONS, ROSTER_SIZE, STARTER_COUNT, REROLLS_PER_RUN, NBA_TEAMS,
  HARD_MODE_BUDGET, HARD_AI_BONUS, HOME_ADV, HOME_ADV_PO, AI_TEAM_BAND,
  ageDelta, effectiveOverall,
};
