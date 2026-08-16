// Seed the database by merging three sources by normalized name:
//   1. 2K (name, position, overall) — the player pool
//   2. EPM (name, age, oepm, depm, epm) — rating adjustment + age
//   3. base stats (name, age, pts, trb, ast, stl, blk, fg%, 3p%, ft%)
// Players missing from a source fall back to estimates from `overall`.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { dbPath } = require('./db-path');

const DB_DIR = path.join(__dirname, '..', 'database');
const DB_PATH = dbPath();
const INIT_PATH = path.join(DB_DIR, 'init.sql');
const DATA_2K = path.join(DB_DIR, '2k27_players.txt');
const DATA_EPM = path.join(DB_DIR, 'epm.txt');
const DATA_BASE = path.join(DB_DIR, 'base_stats.txt');
const DATA_BASE_LOW = path.join(DB_DIR, 'base_stats_low.txt');
const DATA_BASE_STARS = path.join(DB_DIR, 'base_stats_stars.txt');
const DATA_MP = path.join(DB_DIR, 'mp.txt');

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/&#?[a-z0-9]+;/gi, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

// name -> real per-game minutes (from mp.txt)
function loadMp() {
  const map = new Map();
  if (!fs.existsSync(DATA_MP)) return map;
  for (const line of fs.readFileSync(DATA_MP, 'utf8').trim().split('\n')) {
    const i = line.lastIndexOf('|');
    if (i < 0) continue;
    map.set(normalize(line.slice(0, i)), parseFloat(line.slice(i + 1)));
  }
  return map;
}

// Fringe players with no MP data — excluded from the player pool entirely.
const DROP_PLAYERS = new Set([
  'jaden springer', 'jules bernard', 'kevon harris', 'jackson rowe',
  'kyle mangas', 'tyreke key', 'malik williams', 'gabe mcglothan',
  'trevon scott', 'thomas sorber', 'tamar bates',
]);

// (Re)build the database from the source data files.
function seedDb() {
  const db = new DatabaseSync(DB_PATH);
  // create tables first (so this works on a fresh DB too), then migrate any
  // pre-existing tables to the current schema, then clear the data.
  db.exec(fs.readFileSync(INIT_PATH, 'utf8'));
  migrate(db);
  db.exec('DELETE FROM team_players; DELETE FROM teams; DELETE FROM roster; DELETE FROM state; DELETE FROM players;');

  // --- load EPM: name -> {age, oepm, depm, epm}
  const epmMap = new Map();
  for (const line of fs.readFileSync(DATA_EPM, 'utf8').trim().split('\n')) {
    const [name, age, oepm, depm, epm] = line.split('|');
    epmMap.set(normalize(name), { age: +age, oepm: +oepm, depm: +depm, epm: +epm });
  }

  // --- load base stats: name -> {age, pts, trb, ast, stl, blk, fgPct, threePct, ftPct}
  const baseMap = new Map();
  for (const file of [DATA_BASE, DATA_BASE_LOW, DATA_BASE_STARS]) {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      const [name, age, pts, trb, ast, stl, blk, fgPct, threePct, ftPct] = line.split('|');
      baseMap.set(normalize(name), { age: +age, pts: +pts, trb: +trb, ast: +ast, stl: +stl, blk: +blk, fgPct: +fgPct, threePct: +threePct, ftPct: +ftPct });
    }
  }

  // --- load MP: name -> real per-game minutes
  const mpMap = loadMp();

  // --- fallback estimates from overall (for players missing from base stats)
  function estimateStats(o) {
    return {
      age: 25,
      pts: +(o - 55) * 0.7,
      trb: +(o - 55) * 0.22,
      ast: +(o - 55) * 0.18,
      stl: +(o - 55) * 0.035,
      blk: +(o - 55) * 0.03,
      fgPct: 0.4 + (o - 60) * 0.0045,
      threePct: 0.28 + (o - 60) * 0.0035,
      ftPct: 0.62 + (o - 60) * 0.004,
    };
  }

  function parsePositions(p) {
    const parts = (p || '').split('/').map(s => s.trim()).filter(Boolean);
    return { primary: parts[0] || 'C', secondary: parts[1] || null };
  }

  const insert = db.prepare(`
    INSERT INTO players
      (name, position, position2, age, overall, epm, oepm, depm, pts, trb, ast, stl, blk, mp, fg_pct, three_pct, ft_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const r2 = (x) => Math.round(x * 100) / 100;

  let count = 0, realEpm = 0, realStats = 0, realAge = 0;
  db.exec('BEGIN');
  for (const line of fs.readFileSync(DATA_2K, 'utf8').trim().split('\n')) {
    const [name, pos, overallStr] = line.split('\t');
    const overall = +overallStr;
    const key = normalize(name);
    if (DROP_PLAYERS.has(key)) continue; // no-MP fringe players

    const epmData = epmMap.get(key);
    if (!epmData) continue; // drop players with no EPM (Free Agents / never played enough)

    const baseData = baseMap.get(key);

    const age = (baseData && baseData.age) || epmData.age;
    const epm = r2(epmData.epm);
    const oepm = r2(epmData.oepm);
    const depm = r2(epmData.depm);

    const s = baseData ? {
      pts: +baseData.pts, trb: +baseData.trb, ast: +baseData.ast, stl: +baseData.stl, blk: +baseData.blk,
      fgPct: +baseData.fgPct, threePct: +baseData.threePct, ftPct: +baseData.ftPct,
    } : estimateStats(overall);

    const { primary, secondary } = parsePositions(pos);
    insert.run(name.trim(), primary, secondary, age, overall, epm, oepm, depm,
      r2(s.pts), r2(s.trb), r2(s.ast), r2(s.stl), r2(s.blk), mpMap.get(key) || 0, r2(s.fgPct), r2(s.threePct), r2(s.ftPct));

    if (epmData) realEpm++;
    if (baseData) realStats++;
    if (baseData || epmData) realAge++;
    count++;
  }
  db.exec('COMMIT');
  db.close();

  console.log(`Seeded ${count} players.`);
  console.log(`  with real EPM: ${realEpm}  (missing ${count - realEpm})`);
  console.log(`  with real base stats: ${realStats}  (estimated ${count - realStats})`);
  console.log(`  with real age: ${realAge}  (defaulted ${count - realAge})`);
}

// Add per-session columns to any database created before sessions were introduced.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('roster', 'session_id')) db.exec("ALTER TABLE roster ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
  if (!has('teams', 'session_id')) db.exec("ALTER TABLE teams ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
  if (!has('trophies', 'session_id')) db.exec("ALTER TABLE trophies ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
  if (!has('state', 'session_id')) {
    db.exec('ALTER TABLE state RENAME TO state_old');
    db.exec("CREATE TABLE state (session_id TEXT NOT NULL DEFAULT 'default', key TEXT NOT NULL, value TEXT, PRIMARY KEY (session_id, key))");
    db.exec("INSERT INTO state (session_id, key, value) SELECT 'default', key, value FROM state_old");
    db.exec('DROP TABLE state_old');
  }
  if (!has('players', 'mp')) db.exec('ALTER TABLE players ADD COLUMN mp REAL NOT NULL DEFAULT 0');
}

// Fill in real MP for any players seeded before the mp column existed.
function backfillMp(db) {
  const mpMap = loadMp();
  const upd = db.prepare('UPDATE players SET mp = ? WHERE id = ?');
  let n = 0;
  for (const p of db.prepare('SELECT id, name FROM players WHERE mp IS NULL OR mp = 0').all()) {
    const mp = mpMap.get(normalize(p.name));
    if (mp != null) { upd.run(mp, p.id); n++; }
  }
  return n;
}

// Seed only if the players table is empty (used on first deploy / fresh volume).
function ensureSeeded() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(INIT_PATH, 'utf8')); // ensure tables exist (idempotent)
  migrate(db);                                // add session_id/mp to any pre-existing tables
  let count = 0;
  try { count = db.prepare('SELECT COUNT(*) c FROM players').get().c; } catch {}
  if (count === 0) { db.close(); seedDb(); }
  else { const n = backfillMp(db); db.close(); if (n) console.log(`Backfilled mp for ${n} players.`); }
}

module.exports = { seedDb, ensureSeeded, normalize };

// run directly (node seed.js) → force a full reseed
if (require.main === module) {
  seedDb();
}
