// Full-flow test via raw http module (bypasses fetch's proxy quirk on this machine).
const http = require('http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3001, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  await req('POST', '/api/reset');

  // draft 10 (always pick the first candidate)
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    await req('POST', '/api/roster', { playerId: d.candidates[0].id });
  }
  console.log('1. drafted 10 players');

  // lineup: top 5 by rating, at their natural position
  const { roster } = await req('GET', '/api/roster');
  const starters = roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position }));
  await req('POST', '/api/lineup', { teamName: 'Test Team', conference: 'West', starters });
  console.log('2. lineup set:', starters.map((s) => s.slot).join('/'));

  // season
  const season = await req('POST', '/api/season');
  const me = season.east.concat(season.west).find((t) => t.isUser);
  console.log(`3. season: your team ${me.wins}-${me.losses}, ${season.playerAverages.length} player averages`);

  // playoffs (round-by-round)
  await req('POST', '/api/playoffs/start');
  let champion = null;
  for (let r = 1; r <= 4; r++) {
    const res = await req('POST', '/api/playoffs/round');
    if (res.champion) champion = res.champion;
  }
  console.log(`4. playoffs: FINALS ${champion}`);

  console.log('FULL FLOW OK');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
