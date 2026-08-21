// Regression test for the 3 reported bugs:
//  1. Draft double-pick during lag (backend phase guard + frontend busy flag).
//  2. Mid-season traded player appears on the wrong team in playoffs/standings.
//  3. Trade valuation: ability-gap too large is blocked.
// Run against the live server on :3000.
const http = require('http');

const session = 'bugtest' + Date.now().toString(36);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const sep = path.includes('?') ? '&' : '?';
    const r = http.request({ host: '127.0.0.1', port: 3000, path: path + sep + 'session=' + session, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: { raw: d.slice(0, 120) } }); } });
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

async function draftTen() {
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const fp = 9 - i;
    const aff = (d.body.candidates || []).filter((c) => c.salary != null && c.salary <= d.body.budget - spent - fp * 5);
    const pick = (aff.length ? aff : d.body.candidates).sort((a, b) => b.overall - a.overall)[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    spent += pick.salary || 0;
    if (pr.status !== 200) { check(false, 'draft pick', JSON.stringify(pr.body)); return false; }
  }
  return true;
}

async function main() {
  // ================= BUG 3 (part A): ability-gap too large is blocked =================
  // Do this FIRST in a fresh normal run (no cap, clean state), since it needs a roster.
  await req('POST', '/api/reset', { gameMode: 'normal' });
  if (!(await draftTen())) return;

  const roster = await req('GET', '/api/roster');
  const starters = roster.body.roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position }));
  await req('POST', '/api/lineup', { teamName: 'Bug Test', conference: 'West', replacedTeam: 'Lakers', starters });
  await req('POST', '/api/season/start');

  const pool = await req('GET', '/api/trade/pool');
  const mySorted = [...pool.body.myRoster].sort((a, b) => b.overall - a.overall);
  const aiSorted = [...pool.body.aiPlayers].sort((a, b) => b.overall - a.overall);
  const myLow = mySorted[mySorted.length - 1]; // lowest-OVR of mine
  const aiHigh = aiSorted[0];                   // highest-OVR AI player

  // Absurd gap: give a fringe player for the AI's best star → must be hard-rejected.
  const absurd = await req('POST', '/api/trade', { myPlayerIds: [myLow.id], aiPlayerIds: [aiHigh.id] });
  const gapRejected = absurd.status === 200 && absurd.body.accepted === false && /gap/i.test(absurd.body.message || '');
  check(gapRejected, 'BUG3: absurd ability gap is blocked', `my ${myLow.overall} for AI ${aiHigh.overall} → "${(absurd.body.message || '').slice(0, 60)}"`);

  // ================= BUG 2: traded player lands on the right team =================
  // Fair trade (force so it executes deterministically): myMid ↔ closest AI player.
  const myMid = mySorted[Math.floor(mySorted.length / 2)];
  const closest = [...pool.body.aiPlayers].sort((a, b) => Math.abs(a.overall - myMid.overall) - Math.abs(b.overall - myMid.overall))[0];
  const traded = await req('POST', '/api/trade', { myPlayerIds: [myMid.id], aiPlayerIds: [closest.id], force: true });
  check(traded.status === 200 && traded.body.accepted === true, 'BUG2: fair trade executes', `${myMid.name}(${myMid.overall}) ⇄ ${closest.name}(${closest.overall})@${closest.team}`);

  const rosterAfter = await req('GET', '/api/roster');
  const gotTradedIn = rosterAfter.body.roster.some((p) => p.name === closest.name);
  check(gotTradedIn, 'BUG2: traded-in player is on user roster after trade');

  const season = await req('POST', '/api/season/finish');
  check(!season.body.error, 'BUG2: season finishes', season.body.error || '');
  const me = [...(season.body.east || []), ...(season.body.west || [])].find((t) => t.isUser);
  if (me) {
    const inStandings = (me.roster || []).some((p) => p.name === closest.name);
    check(inStandings, 'BUG2: traded-in player on USER team in final standings', `roster=${(me.roster || []).map((p) => p.name).slice(0, 3).join(',')}...`);
    const onOldTeam = [...(season.body.east || []), ...(season.body.west || [])]
      .filter((t) => !t.isUser && t.name === closest.team)
      .some((t) => (t.roster || []).some((p) => p.name === closest.name));
    check(!onOldTeam, 'BUG2: traded-in player NOT on old AI team in standings', closest.team);
  } else {
    check(false, 'BUG2: user team found in standings', 'not found');
  }

  // ================= BUG 1: second pick after draft phase is rejected =================
  // After the season + trade flow, start a dynasty offseason so we reach a rookie draft,
  // then verify a SECOND pick request after the draft phase ended is rejected.
  await req('POST', '/api/reset', { gameMode: 'dynasty' });
  if (!(await draftTen())) return;
  const r2 = await req('GET', '/api/roster');
  await req('POST', '/api/lineup', { teamName: 'Bug Test', conference: 'West', replacedTeam: 'Lakers', starters: r2.body.roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position })) });
  await req('POST', '/api/season/start');
  await req('POST', '/api/season/finish');
  const ns = await req('POST', '/api/next-season');
  check(ns.status === 200 && ns.body.ok === true, 'BUG1: next-season runs');

  const dd = await req('GET', '/api/draft');
  check(dd.body.offseason === true, 'BUG1: rookie draft active', `board=${dd.body.draftBoard ? dd.body.draftBoard.length : 0}`);
  let pickDone = false;
  if (dd.body.candidates && dd.body.candidates.length && dd.body.rosterCount < dd.body.rosterSize) {
    const pr = await req('POST', '/api/roster', { playerId: dd.body.candidates[0].id });
    pickDone = pr.status === 200 && pr.body.ok === true;
    check(pickDone, 'BUG1: picked a rookie');
  } else {
    const pass = await req('POST', '/api/draft/pass');
    pickDone = pass.status === 200 && pass.body.ok === true;
    check(pickDone, 'BUG1: passed rookie draft (roster full)');
  }

  if (pickDone) {
    // The draft phase has ended (phase is now freeagency). A SECOND pick request that
    // arrives late (double-submit during lag) must be rejected, not silently insert
    // another player.
    const lib = await req('GET', '/api/players?sort=overall&order=desc');
    const second = await req('POST', '/api/roster', { playerId: lib.body.players[0].id });
    const rejected = second.status === 400 && /Draft is not active/i.test(second.body.error || '');
    check(rejected, 'BUG1: late second pick is rejected by phase guard', `status=${second.status} "${(second.body.error || second.body.raw || '').slice(0, 50)}"`);
  }

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL BUG CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
