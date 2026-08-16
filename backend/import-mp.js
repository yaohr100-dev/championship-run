// Import MP from database/mp_raw.txt (name|team|mp) into database/mp.txt.
// Merge rule: 2TM/3TM/4TM combined row is authoritative; otherwise average.
// Reports coverage + flags players with conflicting non-multi-TM rows.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { dbPath } = require('./db-path');

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/&#?[a-z0-9]+;/gi, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

const rawPath = path.join(__dirname, '..', 'database', 'mp_raw.txt');
const rows = fs.readFileSync(rawPath, 'utf8').split('\n').filter(Boolean);
// name-spelling mismatches between the MP source and the DB (fixed via alias)
const ALIASES = {
  'egor dmin': 'Egor Demin',        // source has "Dёmin" (Cyrillic ё)
  'ron holland': 'Ronald Holland',  // source has "Ron", DB has "Ronald Holland II"
  'adamaalpha bal': 'Adama Bal',    // source has "Adama-Alpha Bal"
};
const byKey = new Map();
let parseFails = 0;
for (const line of rows) {
  const parts = line.split('|');
  if (parts.length !== 3) { parseFails++; continue; }
  let name = parts[0];
  const team = parts[1];
  const mp = parseFloat(parts[2]);
  if (!name || isNaN(mp)) { parseFails++; continue; }
  const canon = ALIASES[normalize(name)];
  if (canon) name = canon;
  const key = normalize(name);
  if (!byKey.has(key)) byKey.set(key, { name: name.trim(), rows: [] });
  byKey.get(key).rows.push({ team: team.trim(), mp });
}

const out = [];
let multiTm = 0, averaged = 0, single = 0;
const sameTeam = [], diffTeam = [];
for (const [key, v] of byKey) {
  const combined = v.rows.find((r) => /^\d+TM$/.test(r.team));
  let mp;
  if (combined) { mp = combined.mp; multiTm++; }
  else if (v.rows.length > 1) {
    mp = v.rows.reduce((a, b) => a + b.mp, 0) / v.rows.length; averaged++;
    const teams = new Set(v.rows.map((r) => r.team));
    (teams.size === 1 ? sameTeam : diffTeam).push({ name: v.name, stints: v.rows.map((r) => r.team + ' ' + r.mp) });
  }
  else { mp = v.rows[0].mp; single++; }
  out.push(v.name + '|' + mp.toFixed(1));
}
out.sort();
fs.writeFileSync(path.join(__dirname, '..', 'database', 'mp.txt'), out.join('\n') + '\n');

console.log('rows:', rows.length, '| parse fails:', parseFails, '| unique:', byKey.size);
console.log('merge: multi-TM =', multiTm, '| averaged =', averaged, '| single =', single);
console.log('  -> averaged: same-team (two values) =', sameTeam.length, '| different-team (traded) =', diffTeam.length);

// coverage
const db = new DatabaseSync(dbPath());
const players = db.prepare('SELECT name, overall, epm FROM players').all();
const rating = (p) => p.overall + p.epm * 0.5;
const mpByName = new Map();
for (const [key, v] of byKey) {
  const combined = v.rows.find((r) => /^\d+TM$/.test(r.team));
  mpByName.set(key, combined ? combined.mp : (v.rows.reduce((a, b) => a + b.mp, 0) / v.rows.length));
}
let matched = 0; const unmatched = [];
const buckets = {};
for (const p of players) {
  const mp = mpByName.get(normalize(p.name));
  if (mp === undefined) { unmatched.push(p.name); continue; }
  matched++;
  const b = Math.floor(rating(p) / 5) * 5;
  (buckets[b] ||= []).push(mp);
}
console.log('coverage:', matched, '/', players.length, '=', (matched / players.length * 100).toFixed(1) + '%');
console.log('missing:', unmatched.length, '->', unmatched.join(', '));
console.log('\navg MP by rating bucket:');
for (const b of Object.keys(buckets).map(Number).sort((a, b) => a - b)) {
  const arr = buckets[b];
  console.log('  ' + String(b).padStart(2) + '-' + (b + 4) + ':', (arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(1) + ' min (n=' + arr.length + ')');
}
db.close();
