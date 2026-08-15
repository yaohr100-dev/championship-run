// End-to-end backend test: spawns server.js, drives the full flow via fetch.
const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'inherit', 'inherit'] });
const BASE = 'http://127.0.0.1:3001';

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server not ready');
}

async function main() {
  await waitReady();
  await fetch(BASE + '/api/reset', { method: 'POST' });

  // draft 10 (pick the first candidate each round)
  for (let round = 0; round < 10; round++) {
    const j = await (await fetch(BASE + '/api/draft')).json();
    const pick = j.candidates[0];
    await fetch(BASE + '/api/roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: pick.id }),
    });
  }
  console.log('drafted 10 players');

  const { roster } = await (await fetch(BASE + '/api/roster')).json();
  console.log('roster:', roster.map(p => `${p.name}(${p.position}/ovr${p.overall})`).join(', '));

  // 5 starters at their natural positions
  const starters = roster.slice(0, 5).map(p => ({ playerId: p.id, slot: p.position }));
  await fetch(BASE + '/api/lineup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName: 'Test Team', conference: 'West', starters }),
  });
  console.log('lineup set (5 starters)');

  let t = Date.now();
  const season = await (await fetch(BASE + '/api/season', { method: 'POST' })).json();
  console.log(`season done in ${Date.now() - t}ms, leagueAvg=${season.leagueAvg}`);
  const all = season.east.concat(season.west);
  const me = all.find(x => x.isUser);
  console.log(`your team: ${me.name} ${me.wins}-${me.losses} (strength ${me.strength}) in ${me.conf}`);
  console.log('east top3:', season.east.slice(0, 3).map(x => `${x.name} ${x.wins}-${x.losses}`).join(', '));
  console.log('player averages:', season.playerAverages.slice(0, 5).map(p => `${p.name} ${p.pts}pts`).join(', '));

  t = Date.now();
  await fetch(BASE + '/api/playoffs/start', { method: 'POST' });
  let champion = null;
  for (let r = 1; r <= 4; r++) {
    const res = await (await fetch(BASE + '/api/playoffs/round', { method: 'POST' })).json();
    if (res.champion) champion = res.champion;
  }
  console.log(`playoffs done in ${Date.now() - t}ms`);
  console.log(`champion: ${champion}`);

  server.kill();
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); server.kill(); process.exit(1); });
