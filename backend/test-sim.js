// Direct engine test — no HTTP, no spawn. Exercises sim.js functions.
const sim = require('./sim');
const db = sim.openDb();

db.prepare('DELETE FROM roster').run();
db.prepare('DELETE FROM state').run();

// 1. draft
const candidates = sim.draftCandidates(db);
console.log('draft candidates:', candidates.length, '| positions:', [...new Set(candidates.map(c => c.position))].join(','));
console.log('  sample:', candidates.slice(0, 3).map(c => `${c.name} (ovr${c.overall})`).join(', '));

// 2. draft 10 (pick first candidate each round)
for (let i = 0; i < 10; i++) {
  const c = sim.draftCandidates(db);
  db.prepare('INSERT INTO roster (player_id, role, slot) VALUES (?,?,?)').run(c[0].id, 'bench', null);
}
console.log('drafted 10 players');

// 3. lineup: 5 starters at natural position
const roster = db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id').all();
db.prepare("UPDATE roster SET role='bench', slot=NULL").run();
for (let i = 0; i < 5; i++) {
  db.prepare("UPDATE roster SET role='starter', slot=? WHERE player_id=?").run(roster[i].position, roster[i].id);
}
const lineup = db.prepare('SELECT p.*, r.role, r.slot FROM roster r JOIN players p ON p.id = r.player_id').all();
console.log('team strength:', sim.teamStrength(lineup).toFixed(1));

// 4. position discount check
console.log('pos discount PG@PG=', sim.positionDiscount('PG', 'PG'), 'PG@SG=', sim.positionDiscount('PG', 'SG'), 'PG@C=', sim.positionDiscount('PG', 'C'));

// 5. season
let t = Date.now();
const season = sim.simulateSeason(db, lineup);
console.log(`season in ${Date.now() - t}ms | leagueAvg ${season.leagueAvg.toFixed(1)}`);
const all = season.east.concat(season.west);
const me = all.find(x => x.isUser);
console.log(`  your team: ${me.wins}-${me.losses} (strength ${me.strength.toFixed(1)}) in ${me.conf}`);
console.log('  east top3:', season.east.slice(0, 3).map(x => `${x.name} ${x.wins}-${x.losses}`).join(', '));

// 6. one-game stat allocation
const stats = sim.simulateSeasonGame(lineup, sim.teamStrength(lineup));
const totalPts = stats.reduce((a, s) => a + s.pts, 0);
console.log('one-game stats (top5):', stats.slice(0, 5).map(s => `${s.name} ${s.pts}pts`).join(', '));
console.log('  total pts allocated:', totalPts);

db.close();
console.log('ENGINE OK');
