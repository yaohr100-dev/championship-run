// Championship Run — simulation engine.
// Pure game logic on top of SQLite. The API (server.js) calls these.

const { DatabaseSync } = require('node:sqlite');
const { currentSession } = require('./session');
const { dbPath } = require('./db-path');

const DB_PATH = dbPath();

// ---- constants (calibratable) ----
const EPM_COEF = 0.5;          // 实力值 = overall + epm * 0.5
const MINUTES_FLOOR = 55;      // 时间权重 = max(0, rating - 55)
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const ROSTER_SIZE = 10;
const STARTER_COUNT = 5;
const TOTAL_MINUTES = 240;
const REROLLS_PER_RUN = 5;
const HARD_MODE_BUDGET = 400;  // hard mode salary cap
const HARD_AI_BONUS = 0;       // hard mode: strength bonus for every AI team (0 = off)
const PTS_SHARE_EXP = 1.2;     // scoring-share exponent: >1 lets stars keep a bigger slice (usage)
const OVERALL_SHARE_EXP = 0.5; // overall weighting: higher-overall players get a bigger scoring slice
const TOP_HEAVY_EXP = 1.5;    // playoff minutes curve: (rating-55)^1.5 (favours starters/top-8)
const SEASON_GAMES = 82;
const SCALE_RS = 12;           // regular season: flatter (bigger randomness)
const SCALE_PO = 7;            // playoffs: steeper (better team wins more reliably)
const TEAMS_PER_CONF = 15;

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

// Hard-mode salary: superstars cost disproportionately more, so under the cap you
// can't just hoard the best players. (overall-55)^2/20 → 60 costs 1, 80 costs 31,
// 95 costs 80.
function playerSalary(overall) {
  return Math.max(1, Math.round((overall - 55) * (overall - 55) / 20));
}

function minutesWeight(rating, topHeavy = false) {
  const x = Math.max(0, rating - MINUTES_FLOOR);
  // topHeavy (playoffs) concentrates minutes more on the best players
  return topHeavy ? Math.pow(x, TOP_HEAVY_EXP) : x;
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
function teamStrength(players, topHeavy = false) {
  let num = 0, den = 0;
  for (const p of players) {
    const r = powerRating(p);
    const w = minutesWeight(r, topHeavy);
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

// ---- AI team generation ----
// Build one 10-player AI team from the pool (excluding the user's drafted players AND
// any players already assigned to another AI team), position-balanced, whose team
// strength is close to `target`. Returns array of player rows with role/slot.
function generateAITeam(db, excludeIds, target) {
  const pool = db.prepare('SELECT * FROM players').all().filter(p => !excludeIds.has(p.id));
  let best = null, bestDiff = Infinity;
  for (let attempt = 0; attempt < 60; attempt++) {
    // pick 2 per position = 10 players, position balanced
    const picked = [];
    for (const pos of POSITIONS) {
      const atPos = pool.filter(p => p.position === pos);
      picked.push(...shuffle(atPos).slice(0, 2));
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
  const minS = 72, maxS = 88; // calibratable ("2 per position" sampling tops out ~88)
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

// Simulate `games` games for every team. Each returned team carries wins/losses,
// the user's W/L game log, and `acc` (player stat TOTALS keyed by player name).
function simulateGames(teams, leagueAvg, aiBonus, games) {
  const strengthOf = (t) => teamStrength(t.players) + (t.isUser ? 0 : aiBonus);
  return teams.map((t) => {
    const s = strengthOf(t);
    const acc = {};
    for (const p of t.players) acc[p.name] = { name: p.name, position: p.position, games: 0, pts: 0, trb: 0, ast: 0, stl: 0, blk: 0, epm: 0, depm: 0, fgPct: 0, threePct: 0, ftPct: 0 };
    let wins = 0;
    const gameLog = t.isUser ? [] : null;
    for (let g = 0; g < games; g++) {
      const F = teamForm(t.players) * gameLuck();   // team form + "any given night" luck
      const eff = s * F;
      const win = Math.random() < winProb(eff - leagueAvg, SCALE_RS);
      if (win) wins++;
      if (t.isUser) gameLog.push(win ? 'W' : 'L');
      for (const st of simulateSeasonGame(t.players, s)) {
        const entry = acc[st.name];
        if (!entry) continue;
        const p = t.players.find((x) => x.name === st.name);
        entry.games += 1;
        entry.pts += st.pts; entry.trb += st.trb; entry.ast += st.ast; entry.stl += st.stl; entry.blk += st.blk;
        entry.epm += gameEPM(st, p); entry.depm += gameDEPM(st, p);
        entry.fgPct += st.fgPct; entry.threePct += st.threePct; entry.ftPct += st.ftPct;
      }
    }
    return { ...t, strength: s, wins, losses: games - wins, winPct: wins / games, gameLog, acc };
  });
}

// Merge two half-season results (same teams, same order) into one full season.
// Player lists may differ between halves (trades), so merge the UNION of names.
function mergeStandings(s1, s2, totalGames) {
  const FIELDS = ['pts', 'trb', 'ast', 'stl', 'blk', 'epm', 'depm', 'fgPct', 'threePct', 'ftPct'];
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
      return { name: s.name, position: s.position, half: s.half || 'full', pts: s.pts / g, trb: s.trb / g, ast: s.ast / g, stl: s.stl / g, blk: s.blk / g, epm: s.epm / g, depm: s.depm / g, fgPct: s.fgPct / g, threePct: s.threePct / g, ftPct: s.ftPct / g };
    });
  }
  const east = standings.filter((t) => t.conf === 'East').sort((a, b) => b.wins - a.wins);
  const west = standings.filter((t) => t.conf === 'West').sort((a, b) => b.wins - a.wins);
  return { east, west, leagueAvg, awards: computeAwards(standings) };
}

// Full-season convenience (one call).
function simulateSeason(db, userTeam, config) {
  const { teams, leagueAvg, aiBonus } = buildLeague(db, userTeam, config);
  const standings = simulateGames(teams, leagueAvg, aiBonus, SEASON_GAMES);
  return finalizeSeason(standings, SEASON_GAMES, leagueAvg);
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
    const w = minutesWeight(powerRating(p), topHeavy);
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
    const benchAdj = p.role === 'starter' ? 1 : 0.6; // bench plays fewer minutes (counting stats)
    return { p, f, disc, benchAdj };
  });

  const score = Math.round(teamScore);
  // every player scores at least 1 point, so a 0-point line can't conflict with FG%
  const minPts = 1;
  const remaining = Math.max(0, score - minPts * rows.length);
  // Points are proportional to real scoring^PTS_SHARE_EXP × overall^OVERALL_SHARE_EXP
  // (stars with high real scoring AND high overall get the biggest slice). No minutes
  // term, so a defensive specialist (high overall, low pts) isn't over-inflated.
  const pts = allocateInteger(rows.map(x => Math.pow(Math.max(0.1, x.p.pts), PTS_SHARE_EXP) * Math.pow(x.p.overall, OVERALL_SHARE_EXP) * x.f * x.disc), remaining);
  for (let i = 0; i < pts.length; i++) pts[i] += minPts;
  const trb = allocateInteger(rows.map(x => x.p.trb * x.f * x.benchAdj), teamStatTotal(44, 3.9));
  const ast = allocateInteger(rows.map(x => x.p.ast * x.f * x.benchAdj), teamStatTotal(27, 3.3));
  const stl = allocateRandom(rows.map(x => x.p.stl * x.f * x.benchAdj), teamStatTotal(9, 1.5));
  const blk = allocateRandom(rows.map(x => x.p.blk * x.f * x.benchAdj), teamStatTotal(5, 0.8));

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
  draftCandidates, generateAITeam, simulateSeason, buildLeague, simulateGames, mergeStandings, finalizeSeason,
  simulateMatchup, simulateSeasonGame,
  teamForm, shuffle, gameEPM, gameDEPM, POSITIONS, ROSTER_SIZE, STARTER_COUNT, REROLLS_PER_RUN, NBA_TEAMS,
  HARD_MODE_BUDGET, HARD_AI_BONUS,
};
