// Merge one session's archive + trophies into another session. Adds only — it never
// deletes anything in the target. Player references are remapped by NAME, so it also
// survives a reseed that shifted auto-increment ids.
//
// Recover data from before per-session isolation (the legacy 'default' session):
//   node backend/merge-session.js default <your-session-id>
//
// Your session id is shown in the Home page "Back up / Restore Save" panel.
const { DatabaseSync } = require('node:sqlite');
const { dbPath } = require('./db-path');
const { normalize } = require('./seed');

const src = (process.argv[2] || '').trim();
const target = (process.argv[3] || '').trim();
if (!src || !target) {
  console.error('Usage: node backend/merge-session.js <source-session> <target-session>');
  console.error('  e.g. node backend/merge-session.js default a1b2c3d4');
  process.exit(1);
}
if (src === target) { console.error('Source and target are the same session.'); process.exit(1); }

const db = new DatabaseSync(dbPath());

const existsTrophy = db.prepare(
  "SELECT 1 FROM trophies WHERE session_id = ? AND type = ? AND COALESCE(player_name,'') = COALESCE(?,'') AND COALESCE(team_name,'') = COALESCE(?,'')"
);
const insTrophy = db.prepare('INSERT INTO trophies (session_id, type, player_name, team_name) VALUES (?, ?, ?, ?)');
const insTeam = db.prepare('INSERT INTO teams (session_id, name, created_at, results_json) VALUES (?, ?, ?, ?)');
const insTP = db.prepare('INSERT INTO team_players (team_id, player_id, role, slot) VALUES (?, ?, ?, ?)');

const byName = new Map(db.prepare('SELECT id, name FROM players').all().map((p) => [normalize(p.name), p.id]));

const trophies = db.prepare('SELECT type, player_name, team_name FROM trophies WHERE session_id = ?').all(src);
const teams = db.prepare('SELECT id, name, created_at, results_json FROM teams WHERE session_id = ?').all(src);

let trophiesAdded = 0, teamsAdded = 0, playersAdded = 0, skipped = 0;
db.exec('BEGIN');
for (const t of trophies) {
  if (existsTrophy.get(target, t.type, t.player_name, t.team_name)) continue;
  insTrophy.run(target, t.type, t.player_name, t.team_name);
  trophiesAdded++;
}
for (const t of teams) {
  const newId = insTeam.run(target, t.name, t.created_at, t.results_json).lastInsertRowid;
  teamsAdded++;
  const tps = db.prepare('SELECT tp.role, tp.slot, p.name AS pname FROM team_players tp JOIN players p ON p.id = tp.player_id WHERE tp.team_id = ?').all(t.id);
  for (const tp of tps) {
    const pid = byName.get(normalize(tp.pname));
    if (pid == null) { skipped++; continue; }
    insTP.run(newId, pid, tp.role, tp.slot);
    playersAdded++;
  }
}
db.exec('COMMIT');
db.close();

console.log(`Merged '${src}' -> '${target}': ${trophiesAdded} trophies, ${teamsAdded} team(s) (${playersAdded} player rows)${skipped ? `, skipped ${skipped} missing player(s)` : ''}.`);
