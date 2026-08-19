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
const USAGE_EXP = 0.5;         // how strongly real usage tendency bends the share
const USAGE_EXP_PO = 0.7;      // playoffs: stars carry even more usage
const SEASON_GAMES = 82;
const START_SEASON = 2025;     // the first season is 2025-26; dynasty seasons advance one year each
const SCALE_RS = 11;           // regular season: moderate randomness (10-pt gap ≈ 72% win rate)
const SCALE_PO = 8;            // playoffs: steeper than the regular season (more decisive)
const HOME_ADV = 1.5;          // home-court strength boost (rating points) — ~57% home win rate
const HOME_ADV_PO = HOME_ADV * (SCALE_PO / SCALE_RS); // kept as a ratio so the home rate stays ~57%
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

// Human-readable season label: season 1 -> "2025-26", season 2 -> "2026-27", etc.
function seasonLabel(n) {
  const y = START_SEASON + n - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}

// Momentum: a win/loss streak nudges a team's effective strength, ±1% per game capped
// at ±6%. Winning builds momentum, losing snowballs — but it's a modest, capped swing.
function moraleFactor(streak) {
  return 1 + Math.max(-6, Math.min(6, streak)) * 0.01;
}

// Dynasty progression: how far a player's overall is from their peak at a given age.
// Growth: rapid 20-23 (+2/yr), slowing 24-25 (+1/yr).
// Prime: 26-28 (3-year peak window).
// Decline: gentle 29-31 (-1/yr), moderate 32-34 (-2/yr), steep 35-37 (-3/yr),
// brutal 38+ (-2/yr continuing, no flat floor).
function ageDelta(age) {
  if (age <= 20) return -6;
  if (age <= 21) return -5;
  if (age <= 22) return -4;
  if (age <= 23) return -3;
  if (age <= 24) return -2;
  if (age <= 25) return -1;
  if (age <= 28) return 0;    // peak: 26-28
  if (age <= 29) return -1;
  if (age <= 30) return -2;
  if (age <= 31) return -3;
  if (age <= 32) return -4;
  if (age <= 33) return -6;
  if (age <= 34) return -8;
  if (age <= 35) return -10;
  if (age <= 36) return -12;
  if (age <= 37) return -14;
  // 38+: continues declining -2/yr, no flat floor
  return -14 - (age - 37) * 2;
}

// ---- EPM derivation from current OVR ----
// Instead of tracking EPM independently, derive it from the player's current effective
// OVR. This ensures EPM always reflects actual ability: OVR 95 → EPM ~6, OVR 87 → ~2,
// OVR 80 → ~-1.5. Clamped to [-4, 8] so fringe players don't get absurd negatives.
// Individual variation comes from each player's base EPM offset stored in the DB.
const EPM_SLOPE = 0.50;
const EPM_INTERCEPT = 83;  // OVR at which EPM ≈ 0
const EPM_MIN = -3;
const EPM_MAX = 8;

function derivedEpm(currentOvr, baseEpm) {
  const fromOvr = (currentOvr - EPM_INTERCEPT) * EPM_SLOPE;
  const blended = fromOvr * 0.85 + baseEpm * 0.15;
  return +Math.max(EPM_MIN, Math.min(EPM_MAX, blended)).toFixed(1);
}

// Retirement age by player caliber: a star's body holds up longer than a role
// player's. All-time greats (LeBron, Curry, Durant) play into their late 30s/early
// 40s, while fringe players age out in their early 30s.
function retireAge(overall) {
  if (overall >= 90) return 40;
  if (overall >= 84) return 39;
  if (overall >= 78) return 38;
  if (overall >= 72) return 37;
  if (overall >= 66) return 36;
  return 34;
}

// A player's effective overall from their base rating + the age curve.
//   GROWTH (rawDelta > 0): scaled by qualityScale so elite players peak higher.
//     qualityScale: 60 OVR → 0.50, 70 → 0.70, 80 → 0.90, 87 → 1.04, 95 → 1.20
//   DECLINE (rawDelta ≤ 0): scaled by declineScale so elite players decline slower.
//     A 95-base player (LeBron archetype) loses only ~55% of the raw decline — their
//     skill/IQ/conditioning compensates for physical aging. Role players decline fully.
//     declineScale: 60 → 1.00, 70 → 0.88, 80 → 0.72, 87 → 0.60, 95 → 0.50
function effectiveOverall(baseOverall, baseAge, currentAge, devoFactor) {
  const rawDelta = ageDelta(currentAge) - ageDelta(baseAge);
  if (rawDelta > 0) {
    const qualityScale = 0.65 + (baseOverall - 60) * 0.025;
    const f = devoFactor || 1;
    return Math.max(40, Math.min(99, Math.round(baseOverall + rawDelta * qualityScale * f)));
  }
  // decline: higher-base players decline slower
  const declineScale = Math.max(0.3, 1.0 - (baseOverall - 60) * 0.025);
  return Math.max(40, Math.min(99, Math.round(baseOverall + rawDelta * declineScale)));
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
  return 0.04 * Math.pow(Math.max(1, overall - 55), 1.95);
}

// Hard-mode salary: based on powerRating (= OVR + EPM×0.5) so high-impact players
// cost more under the cap. Without this, high-EPM/low-OVR players are free strength.
// (rating-55)^2/20 → 60 costs 1, 80 costs 31, 95 costs 80.
function playerSalary(overall, epm = 0) {
  const rating = Math.round(overall + (epm || 0) * EPM_COEF);
  return Math.max(1, Math.round((rating - 55) * (rating - 55) / 20));
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

// Draftable player pool: real players (session_id NULL) plus this session's generated
// rookies. Scoped so one run's rookies can't leak into another run's draft.
function poolPlayers(db) {
  return db.prepare('SELECT * FROM players WHERE session_id IS NULL OR session_id = ?').all(currentSession());
}

// 5 random candidates, excluding drafted, with position diversity (>= 4 of 5)
function draftCandidates(db) {
  const drafted = new Set(db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(currentSession()).map(r => r.player_id));
  const all = poolPlayers(db).filter(p => !drafted.has(p.id));
  let candidates = [];
  for (let i = 0; i < 200; i++) {
    candidates = shuffle(all).slice(0, 5);
    const positions = new Set(candidates.map(p => p.position));
    if (positions.size >= 4) break;
  }
  return candidates;
}

// Free-agent pool: every player (real or generated) not on any team this session.
// Quality is weighted: most FA are role players (60-75 OVR), stars rarely hit the market.
function freeAgentPool(db) {
  const session = currentSession();
  const used = new Set([
    ...db.prepare('SELECT player_id FROM roster WHERE session_id = ?').all(session).map((r) => r.player_id),
    ...db.prepare('SELECT player_id FROM league_teams WHERE session_id = ?').all(session).map((r) => r.player_id),
  ]);
  const all = poolPlayers(db).filter((p) => !used.has(p.id));
  // Weight toward lower-rated players: repeat low-OVR entries so they're more likely to be sampled
  const weighted = [];
  for (const p of all) {
    const copies = p.overall >= 85 ? 1 : p.overall >= 78 ? 2 : p.overall >= 72 ? 3 : 5;
    for (let i = 0; i < copies; i++) weighted.push(p);
  }
  return weighted;
}

// 5 random free agents with position diversity (>= 4 of 5).
function freeAgentCandidates(db) {
  const pool = freeAgentPool(db);
  let candidates = [];
  for (let i = 0; i < 200; i++) {
    candidates = shuffle(pool).slice(0, 5);
    const positions = new Set(candidates.map((p) => p.position));
    if (positions.size >= 4) break;
  }
  return candidates;
}

// ---- generated rookies (annual draft) ----

const FIRST_NAMES = [
  'Jalen', 'Jayden', 'Marcus', 'Devin', 'Cameron', 'Tyler', 'Darius', 'Isaiah', 'Malik',
  'Kenyon', 'Trey', 'Cole', 'Jaden', 'Caleb', 'Andre', 'Desmond', 'Terrell', 'Quinn',
  'Elijah', 'Miles', 'Dante', 'Luka', 'Nikola', 'Victor', 'Giannis', 'Mateo', 'Dmitri',
  'Serge', 'Bogdan', 'Alperen', 'Deni', 'Rui', 'Ousmane', 'Santi', 'Franz', 'Paolo',
  'Cade', 'Amen', 'Ausar', 'Jabari', 'Scoot', 'Keyonte', 'Brandin', 'Jaime',
];
const LAST_NAMES = [
  'Johnson', 'Williams', 'Thompson', 'Rodriguez', 'Petrovic', 'Okafor', 'Ndiaye',
  'Kovacevic', 'Silva', 'Hernandez', 'Moreau', 'Lindqvist', 'Onyeka', 'Diallo', 'Mbeki',
  'Fernandez', 'Novak', 'Carter', 'Bridges', 'Whitfield', 'Hamilton', 'Duncan', 'Foster',
  'Porter', 'Mason', 'Griffin', 'Hughes', 'Bennett', 'Reyes', 'Castillo', 'Dominguez',
  'Adeyemi', 'Ibrahim', 'Sato', 'Yamamoto', 'Khan', 'Singh', 'Osei', 'Mensah', 'Volkov',
  'Baranov', 'Sorensen', 'Jensen', 'Keller', 'Mancini',
];

// Unique random NBA-style name (not colliding with any existing player).
function generateRookieName(db) {
  for (let i = 0; i < 60; i++) {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const name = `${first} ${last}`;
    if (!db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) return name;
  }
  return `${FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]} Jr.`;
}

// Realistic rookie overall: a few franchise prospects, a lottery tier, a first-round
// tier, then a long tail of second-round/undrafted talent.
function draftOverall() {
  const r = Math.random();
  if (r < 0.05) return 80 + Math.floor(Math.random() * 7); // 80-86 franchise
  if (r < 0.25) return 74 + Math.floor(Math.random() * 6); // 74-79 lottery
  if (r < 0.60) return 68 + Math.floor(Math.random() * 6); // 68-73 first round
  return 58 + Math.floor(Math.random() * 10);              // 58-67 second round / undrafted
}

const r2 = (x) => Math.round(x * 100) / 100;

// Position-aware rookie stat estimates, mirrors seed.js estimateStats but nudges the
// big-man / point-guard tendencies so a C rebounds and a PG assists.
function rookieStats(overall, position) {
  const x = overall - 55;
  const mod = {
    PG: { trb: -1.0, ast: 2.0, blk: -0.2 },
    SG: { trb: -0.5, ast: 0.5, blk: -0.1 },
    SF: { trb: 0.2, ast: 0.0, blk: 0.0 },
    PF: { trb: 1.0, ast: -0.5, blk: 0.3 },
    C:  { trb: 1.8, ast: -1.2, blk: 0.6 },
  }[position] || { trb: 0, ast: 0, blk: 0 };
  const epm = r2(0.4 * (overall - 70));
  return {
    pts: r2(0.7 * x),
    trb: r2(Math.max(0.5, 0.22 * x + mod.trb)),
    ast: r2(Math.max(0.3, 0.18 * x + mod.ast)),
    stl: r2(Math.max(0.1, 0.035 * x)),
    blk: r2(Math.max(0.05, 0.03 * x + mod.blk)),
    fgPct: r2(0.40 + (overall - 60) * 0.0045),
    threePct: r2(0.28 + (overall - 60) * 0.0035),
    ftPct: r2(0.62 + (overall - 60) * 0.004),
    epm, oepm: r2(epm * 0.55), depm: r2(epm * 0.45),
  };
}

// Insert one rookie into the players table (session-scoped so it can't leak into
// another run's draft pool). Returns its fresh row summary.
function generateRookie(db) {
  const session = currentSession();
  const name = generateRookieName(db);
  // Weighted position distribution: guards/wings are more common than bigs in the NBA
  const posPool = ['PG','PG','PG','PG', 'SG','SG','SG','SG','SG', 'SF','SF','SF','SF','SF', 'PF','PF','PF','PF', 'C','C','C','C'];
  const position = posPool[Math.floor(Math.random() * posPool.length)];
  const age = 19 + Math.floor(Math.random() * 4); // 19-22
  const overall = draftOverall();
  const s = rookieStats(overall, position);
  const info = db.prepare(`
    INSERT INTO players (name, position, position2, age, overall, epm, oepm, depm, pts, trb, ast, stl, blk, mp, fg_pct, three_pct, ft_pct, session_id)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(name, position, age, overall, s.epm, s.oepm, s.depm, s.pts, s.trb, s.ast, s.stl, s.blk, s.fgPct, s.threePct, s.ftPct, session);
  return { id: info.lastInsertRowid, name, position, age, overall };
}

// Generate this year's draft class (n rookies).
function generateDraftClass(db, n) {
  const rookies = [];
  for (let i = 0; i < n; i++) rookies.push(generateRookie(db));
  return rookies;
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
  const pool = poolPlayers(db).filter(p => !excludeIds.has(p.id));
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
  // League strength range (season-1 only — after that the AI league develops organically
  // via draft picks and free agency rather than a static ramp).
  const minS = 74, maxS = 86; // narrower range so the league has parity (std dev ~10-12 wins)
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
    //    Fatigue: ~15% of games simulate a back-to-back, penalizing both teams -3%.
    const fatigueH = Math.random() < 0.15 ? 0.97 : 1;
    const fatigueA = Math.random() < 0.15 ? 0.97 : 1;
    const hS = (hPlayers.length ? teamStrength(hPlayers) + (H.t.isUser ? 0 : aiBonus) : H.s) * moraleFactor(H.streak) * fatigueH;
    const aS = (aPlayers.length ? teamStrength(aPlayers) + (A.t.isUser ? 0 : aiBonus) : A.s) * moraleFactor(A.streak) * fatigueA;
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

// Simulate a full season against an already-built league (both halves, merged).
function simulateSeasonWithLeague(teams, leagueAvg, aiBonus) {
  const schedule = buildSchedule(teams);
  const s1 = simulateGames(teams, schedule.first, aiBonus);
  const s2 = simulateGames(teams, schedule.second, aiBonus);
  const combined = mergeStandings(s1, s2, SEASON_GAMES);
  return finalizeSeason(combined, SEASON_GAMES, leagueAvg);
}

// Full-season convenience (one call): build the league then simulate. Used by test
// scripts that don't need the persisted dynasty league.
function simulateSeason(db, userTeam, config) {
  const { teams, leagueAvg, aiBonus } = buildLeague(db, userTeam, config);
  return simulateSeasonWithLeague(teams, leagueAvg, aiBonus);
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
      // Games-played factor: players who miss significant time are penalised.
      // Below 50 games the weight drops sharply, below 30 they're essentially ineligible.
      const gpFactor = Math.min(1, (avg.games || SEASON_GAMES) / SEASON_GAMES);
      const avail = gpFactor >= 0.35; // minimum ~29 games to be award-eligible
      all.push({ name: p.name, team: t.name, isUser: t.isUser, role: p.role, winPct, avg, gpFactor, avail });
    }
  }
  const award = (p) => (p ? { player: p.name, team: p.team, isUser: p.isUser } : null);

  // MVP: box-score composite + team wins + simulated EPM (impact), weighted by games played
  const mvpScore = (p) => (p.avg.pts + 1.2 * p.avg.trb + 1.5 * p.avg.ast + 2 * p.avg.stl + 2 * p.avg.blk + p.winPct * 25 + p.avg.epm * 3) * p.gpFactor;
  // DPOY: steals/blocks + team wins + simulated DEPM, weighted by games played
  const dpoyScore = (p) => (p.avg.stl * 3 + p.avg.blk * 3 + p.winPct * 15 + p.avg.depm * 5) * p.gpFactor;

  const eligible = all.filter(p => p.avail);
  const byMvp = [...eligible].sort((a, b) => mvpScore(b) - mvpScore(a));
  const byDpoy = [...eligible].sort((a, b) => dpoyScore(b) - dpoyScore(a));
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
    threePct: shotPct(x.p.three_pct, 0.12, 0.20, 0.55),
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
  draftCandidates, freeAgentCandidates, freeAgentPool, generateAITeam, simulateSeason, simulateSeasonWithLeague, buildLeague, buildSchedule, simulateGames, mergeStandings, finalizeSeason,
  simulateMatchup, simulateSeasonGame,
  generateRookie, generateDraftClass,
  teamForm, shuffle, gameEPM, gameDEPM, POSITIONS, ROSTER_SIZE, STARTER_COUNT, REROLLS_PER_RUN, NBA_TEAMS,
  HARD_MODE_BUDGET, HARD_AI_BONUS, HOME_ADV, HOME_ADV_PO, AI_TEAM_BAND,
  ageDelta, effectiveOverall, derivedEpm, START_SEASON, seasonLabel, retireAge,
};
