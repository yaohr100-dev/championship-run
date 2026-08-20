// Full 10-season dynasty regression run (against the live server on :3000).
// Exercises the ENTIRE dynasty loop every season: aging, retirement, re-signing,
// morale, chemistry, rookie draft, free agency, AI offseason trades, season goals.
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const { dbPath } = require('./db-path');
const DB = dbPath();

const session = 'dynasty' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DYNASTY_MAX = 10;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const sep = path.includes('?') ? '&' : '?';
    const p = path + sep + 'session=' + encodeURIComponent(session);
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d, status: res.statusCode }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const fail = { count: 0 };
function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fail.count++;
}

async function runPlayoffs() {
  const start = await req('POST', '/api/playoffs/start');
  if (start.error) return { error: start.error };
  let champ = null, eliminated = false, elimRound = null;
  for (let r = 1; r <= 4; r++) {
    const pr = await req('POST', '/api/playoffs/round');
    if (pr.champion) champ = pr.champion;
    if (pr.userEliminated) { eliminated = true; elimRound = pr.userEliminatedRound; }
  }
  return { champ, eliminated, elimRound };
}

async function doSeason(n) {
  // Half 1
  const h1 = await req('POST', '/api/season/start');
  if (h1.error) return { error: `season/start: ${h1.error}` };
  // Half 2
  const season = await req('POST', '/api/season/finish');
  if (season.error) return { error: `season/finish: ${season.error}` };
  let playoffs = { played: false };
  if (season.madePlayoffs) {
    playoffs = await runPlayoffs();
    if (playoffs.error) return { error: `playoffs: ${playoffs.error}` };
    playoffs.played = true;
  }
  return { h1, season, playoffs };
}

async function doOffseason(n) {
  const ns = await req('POST', '/api/next-season');
  if (ns.error) return { error: `next-season: ${ns.error}` };

  // Annual rookie draft
  const d = await req('GET', '/api/draft');
  let draftAction = 'pass';
  if (d.candidates && d.candidates.length && d.rosterCount < d.rosterSize) {
    const pick = d.candidates[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    draftAction = pr.ok ? `picked ${pick.name} (${pick.overall})` : 'pick-rejected';
  } else {
    await req('POST', '/api/draft/pass');
  }

  // Free agency: make sure the roster is exactly 10 before continuing
  const fa = await req('GET', '/api/freeagency');
  if (fa.error) return { error: `freeagency: ${fa.error}` };
  let rosterCount = fa.roster.length;
  let faSigns = 0;
  // sign the best affordable candidates until the roster is full
  for (const c of (fa.candidates || []).slice().sort((a, b) => b.overall - a.overall)) {
    if (rosterCount >= 10 || faSigns >= fa.signLimit) break;
    if (fa.salTotal + c.salary > fa.salCap) continue;
    const r = await req('POST', '/api/sign', { playerId: c.id });
    if (r.ok) { rosterCount++; faSigns++; fa.salTotal += c.salary; }
  }
  if (rosterCount > 10) {
    // shouldn't happen; release extras
    const roster = await req('GET', '/api/roster');
    for (let i = 10; i < roster.roster.length; i++) {
      await req('POST', '/api/release', { playerId: roster.roster[i].id });
    }
    rosterCount = 10;
  }
  const done = await req('POST', '/api/freeagency/done');
  if (done.error) return { error: `freeagency/done (roster=${rosterCount}): ${done.error}` };

  // Lineup: top 5 by rating at natural position
  const { roster } = await req('GET', '/api/roster');
  if (roster.length !== 10) return { error: `roster size ${roster.length} after FA` };
  const starters = roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position }));
  const lineup = await req('POST', '/api/lineup', { teamName: 'Dynasty Test', conference: 'West', replacedTeam: 'Golden State Warriors', starters });
  if (lineup.error) return { error: `lineup: ${lineup.error}` };

  return { ns, draftAction, rosterCount, faSigns };
}

async function main() {
  let r = await req('POST', '/api/reset', { gameMode: 'dynasty' });
  check(r.gameMode === 'dynasty', 'reset dynasty');

  // ---- Season 1: initial draft (hard mode, $400M cap) ----
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const futurePicks = 9 - i;
    const affordable = (d.candidates || []).filter((c) => c.salary != null && c.salary <= d.budget - spent - futurePicks * 5);
    const pick = (affordable.length ? affordable : d.candidates).sort((a, b) => b.overall - a.overall)[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    spent += pick.salary || 0;
    if (!pr.ok) { check(false, 'draft pick', pr.error); return; }
  }
  const d = await req('GET', '/api/draft');
  check(d.rosterCount === 10, 'season 1 draft fills roster', `count=${d.rosterCount}`);

  const { roster } = await req('GET', '/api/roster');
  const starters = roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position }));
  await req('POST', '/api/lineup', { teamName: 'Dynasty Test', conference: 'West', replacedTeam: 'Golden State Warriors', starters });

  // ---- Run seasons 1..10 ----
  const seasonReports = [];
  for (let s = 1; s <= DYNASTY_MAX; s++) {
    const sres = await doSeason(s);
    if (sres.error) { check(false, `season ${s}`, sres.error); return; }
    const rec = sres.season.west.concat(sres.season.east).find((t) => t.isUser);
    seasonReports.push({ s, wins: rec.wins, losses: rec.losses, madePlayoffs: sres.season.madePlayoffs, champ: sres.playoffs.champ, eliminated: sres.playoffs.eliminated });
    console.log(`  season ${s}: ${rec.wins}-${rec.losses} · playoffs=${sres.season.madePlayoffs ? (sres.playoffs.champ === undefined ? 'sim' : sres.playoffs.champ ? sres.playoffs.champ : '—') : 'missed'}${sres.playoffs.eliminated ? ` (elim R${sres.playoffs.elimRound})` : ''}`);

    if (s === DYNASTY_MAX) break; // no offseason after the final season

    const off = await doOffseason(s);
    if (off.error) { check(false, `offseason after season ${s}`, off.error); return; }
    console.log(`  offseason → S${s + 1}: ${off.draftAction} · roster ${off.rosterCount}/10 · FA signed ${off.faSigns} · retirements=${off.ns.retirements.length} refused=${off.ns.refused.length} aiTrades=${(off.ns.seasonRecap.aiTrades || []).length}`);
  }

  // ---- Verify the dynasty ended correctly ----
  const result = await req('GET', '/api/result');
  check(result.gameMode === 'dynasty', 'result reports dynasty mode');
  check(result.seasonNumber === DYNASTY_MAX, 'reached season 10', `seasonNumber=${result.seasonNumber}`);
  check(result.dynastyMax === DYNASTY_MAX, 'dynastyMax is 10');
  const seasonsPlayed = result.seasonHistory.length;
  check(seasonsPlayed === DYNASTY_MAX, 'history has 10 entries', `history=${seasonsPlayed}`);

  // trophy room sanity
  const trophies = await req('GET', '/api/trophies');
  check(Array.isArray(trophies.trophies), 'trophy room responds');
  console.log(`  trophies earned: ${trophies.trophies.length}`);

  // hall of fame should be populated if any 85+ players retired
  const hof = await req('GET', '/api/halloffame');
  console.log(`  hall of fame legends: ${hof.legends.length}`);

  console.log(`\n=== 10-SEASON DYNASTY RECORD ===`);
  for (const sr of seasonReports) console.log(`  S${sr.s}: ${sr.wins}-${sr.losses} ${sr.eliminated ? '(elim)' : sr.champ ? '(CHAMP)' : sr.madePlayoffs ? '(playoffs)' : '(missed)'}`);

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL DYNASTY CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
