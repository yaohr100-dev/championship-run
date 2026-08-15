// Test new backend endpoints via raw http module.
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
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // meta
  const nba = await req('GET', '/api/nba-teams');
  console.log('1. nba-teams:', nba.teams.length, 'teams, e.g.', nba.teams[0].name, '/', nba.teams[15].name);

  // library
  const lib = await req('GET', '/api/players?sort=pts&order=desc&pos=PG');
  console.log('2. library (PG by pts desc):', lib.players.length, 'players, top:', lib.players[0].name, lib.players[0].pts, 'pts');

  await req('POST', '/api/reset');

  // draft 10 (pick the best candidate each round)
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const best = [...d.candidates].sort((a, b) => b.overall - a.overall)[0];
    await req('POST', '/api/roster', { playerId: best.id });
  }
  console.log('3. drafted 10');

  // lineup with replace team
  const { roster } = await req('GET', '/api/roster');
  const starters = roster.slice(0, 5).map(p => ({ playerId: p.id, slot: p.position }));
  await req('POST', '/api/lineup', { teamName: 'My Squad', conference: 'West', replacedTeam: 'Golden State Warriors', starters });
  console.log('4. lineup set (replaced Warriors)');

  // season
  const season = await req('POST', '/api/season');
  const myTeam = season.west.find(t => t.isUser);
  console.log('5. season:', myTeam.name, myTeam.wins + '-' + myTeam.losses, '| leagueAvg', season.leagueAvg);
  console.log('   sample team starters:', JSON.stringify(season.west[1].name + ': ' + season.west[1].starters.map(s => s.name).join(', ')));
  console.log('   madePlayoffs:', season.madePlayoffs);
  console.log('   my player avg:', season.playerAverages[0].name, season.playerAverages[0].pts, 'pts');

  // save
  await req('POST', '/api/save', { name: 'Test Save' });
  const teams = await req('GET', '/api/teams');
  console.log('6. saved teams:', teams.teams.length, '->', teams.teams[0].name);

  // playoffs
  const start = await req('POST', '/api/playoffs/start');
  console.log('7. playoffs start: round', start.round, 'matchups', start.matchups.length);
  console.log('   matchup[0]:', start.matchups[0].conf, start.matchups[0].a.name, 'vs', start.matchups[0].b.name, '| a roster size:', start.matchups[0].a.roster.length);

  for (let r = 1; r <= 4; r++) {
    const result = await req('POST', '/api/playoffs/round');
    console.log(`8. round ${result.round}: ${result.results.length} series, champion=${result.champion}, userEliminated=${result.userEliminated}`);
    const userSeries = result.results.find(s => s.isUserSeries);
    if (userSeries) console.log('   user series:', userSeries.winner, 'def', userSeries.loser, userSeries.wins, '| userStats:', userSeries.userStats?.[0]?.name, userSeries.userStats?.[0]?.pts, 'pts');
  }

  // save after playoffs + verify results captured
  await req('POST', '/api/save', { name: 'Full Run Save' });
  const teamsAfter = await req('GET', '/api/teams');
  const saved = teamsAfter.teams[0];
  console.log('9. saved results:', JSON.stringify({ season: saved.results.season, playoff: saved.results.playoff, seasonAvg: saved.results.seasonAverages?.length, playoffAvg: saved.results.playoffAverages?.length }));

  console.log('ALL NEW ENDPOINTS OK');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
