// Regression test: dynasty offseason trade window + shared trade points + FA limits.
// Run against the live server on :3000.
const http = require('http');
const session = 'offseas' + Date.now().toString(36);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const sep = path.includes('?') ? '&' : '?';
    const r = http.request({ host: '127.0.0.1', port: 3000, path: path + sep + 'session=' + session, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: { raw: d.slice(0, 100) } }); } });
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

async function draftAndLineup(gameMode) {
  await req('POST', '/api/reset', { gameMode });
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const fp = 9 - i;
    const aff = (d.body.candidates || []).filter((c) => c.salary != null && c.salary <= (d.body.budget || 99999) - spent - fp * 5);
    const pick = (aff.length ? aff : d.body.candidates).sort((a, b) => b.overall - a.overall)[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    spent += pick.salary || 0;
    if (pr.status !== 200) return null;
  }
  const ro = await req('GET', '/api/roster');
  await req('POST', '/api/lineup', { teamName: 'Offseason', conference: 'West', replacedTeam: 'Lakers', starters: ro.body.roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position })) });
  return ro;
}

async function doFairTrade(force) {
  const pool = await req('GET', '/api/trade/pool');
  const mySorted = [...pool.body.myRoster].sort((a, b) => b.overall - a.overall);
  const myMid = mySorted[Math.floor(mySorted.length / 2)];
  const closest = [...pool.body.aiPlayers].sort((a, b) => Math.abs(a.overall - myMid.overall) - Math.abs(b.overall - myMid.overall))[0];
  const tr = await req('POST', '/api/trade', { myPlayerIds: [myMid.id], aiPlayerIds: [closest.id], force });
  return { pool, myMid, closest, tr };
}

async function main() {
  // ===== PART A: offseason (pre-season) trade + shared trade points =====
  const ro = await draftAndLineup('dynasty');
  if (!ro) { check(false, 'draft/lineup'); return; }

  // Offseason trade window (before season 1): pool builds the league on demand.
  const pool1 = await req('GET', '/api/trade/pool');
  check(pool1.status === 200 && pool1.body.myRoster.length === 10, 'A: offseason trade pool works', `my=${pool1.body.myRoster ? pool1.body.myRoster.length : '?'}`);
  check(pool1.body.remainingPoints === 3, 'A: fresh 3 trade points in offseason', `remaining=${pool1.body.remainingPoints}`);

  // Do one trade in the offseason.
  const t1 = await doFairTrade(true);
  check(t1.tr.status === 200 && t1.tr.body.accepted === true, 'A: offseason trade executes', `${t1.myMid.name} ⇄ ${t1.closest.name}`);
  const pool2 = await req('GET', '/api/trade/pool');
  check(pool2.body.remainingPoints === 2, 'A: 1 point spent in offseason, 2 left', `remaining=${pool2.body.remainingPoints}`);
  const tradedIn = t1.closest.name;

  // Start season 1 — trade points must NOT reset (shared with mid-season).
  const start = await req('POST', '/api/season/start');
  check(start.status === 200, 'A: season 1 starts', start.body.error || '');
  const pool3 = await req('GET', '/api/trade/pool');
  check(pool3.body.remainingPoints === 2, 'A: mid-season inherits offseason points (not reset)', `remaining=${pool3.body.remainingPoints}`);

  const finish = await req('POST', '/api/season/finish');
  check(finish.status === 200, 'A: season 1 finishes', finish.body.error || '');

  // Season summary champion + playoffs
  if (finish.body.madePlayoffs) {
    await req('POST', '/api/playoffs/start');
    for (let r = 1; r <= 4; r++) await req('POST', '/api/playoffs/round');
  }

  // ===== PART B: FA limits (season 2) =====
  const ns = await req('POST', '/api/next-season');
  check(ns.status === 200, 'B: next-season runs');
  const d = await req('GET', '/api/draft');
  if (d.body.candidates && d.body.candidates.length && d.body.rosterCount < d.body.rosterSize) await req('POST', '/api/roster', { playerId: d.body.candidates[0].id });
  else await req('POST', '/api/draft/pass');

  // Release 2 to make room, then check FA limits.
  const ro2 = await req('GET', '/api/roster');
  if (ro2.body.roster.length >= 10) {
    await req('POST', '/api/release', { playerId: ro2.body.roster[0].id });
    await req('POST', '/api/release', { playerId: ro2.body.roster[1].id });
  }
  const fa = await req('GET', '/api/freeagency');
  check(fa.body.signLimit === 2, 'B: FA sign limit is 2', `signLimit=${fa.body.signLimit}`);
  check(fa.body.refreshes === 1, 'B: FA refresh count is 1', `refreshes=${fa.body.refreshes}`);
  // Refresh once OK, twice rejected.
  const ref1 = await req('POST', '/api/fa/refresh');
  check(ref1.status === 200 && ref1.body.refreshes === 0, 'B: first FA refresh OK (0 left)');
  const ref2 = await req('POST', '/api/fa/refresh');
  check(ref2.status === 400, 'B: second FA refresh rejected', ref2.body.error || '');
  // Sign up to 2.
  const fa2 = await req('GET', '/api/freeagency');
  let signed = 0;
  for (const c of fa2.body.candidates || []) {
    if (signed >= fa.body.signLimit) break;
    const s = await req('POST', '/api/sign', { playerId: c.id });
    if (s.status === 200 && s.body.ok) signed++;
  }
  check(signed === 2, 'B: can sign exactly 2 FAs', `signed=${signed}`);
  const fa3 = await req('GET', '/api/freeagency');
  check(fa3.body.signed === 2, 'B: signed counter shows 2', `signed=${fa3.body.signed}`);
  if (fa3.body.candidates && fa3.body.candidates[0]) {
    const extra = await req('POST', '/api/sign', { playerId: fa3.body.candidates[0].id });
    check(extra.status === 400 || extra.body.accepted === false, 'B: 3rd FA signing rejected');
  }

  // ===== PART C: season summary shows champion each season =====
  const result = await req('GET', '/api/result');
  const hist = result.body.seasonHistory || [];
  check(hist.length >= 1, 'C: dynasty history has entries', `history=${hist.length}`);
  if (hist.length) {
    check(hist.every((h) => h.champion !== undefined), 'C: each season records a champion (or null)', hist.map((h) => `${h.season}:${h.champion || 'null'}`).join(', '));
    check(hist.every((h) => typeof h.wins === 'number'), 'C: each season records record', hist.map((h) => h.wins).join(','));
  }

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL OFFSEASON/FA CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
