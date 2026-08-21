// Regression test for the bug-fix batch (run against the live server on :3000).
// Covers: dynasty flow, FA refresh counter, rookie draft destination, draft order,
// and reset clearing stale league/rookie data.
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const { dbPath } = require('./db-path');
const DB = dbPath();

const session = 'fixtest' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

function stateValue(key) {
  const db = new DatabaseSync(DB);
  const v = db.prepare('SELECT value FROM state WHERE session_id = ? AND key = ?').get(session, key);
  db.close();
  return v ? v.value : null;
}
function countTable(table) {
  const db = new DatabaseSync(DB);
  const c = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE session_id = ?`).get(session).c;
  db.close();
  return c;
}
function pass(fail, label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fail.count++;
}
const fail = { count: 0 };

async function main() {
  // ---- 1. Dynasty run ----
  let r = await req('POST', '/api/reset', { gameMode: 'dynasty' });
  pass(fail, 'reset dynasty', r.gameMode === 'dynasty');

  // Dynasty forces hard mode ($400M cap): pick the best candidate that keeps the
  // remaining picks affordable. The backend reserves the pool's actual minimum
  // salary ($5M) per future pick, so mirror that.
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const futurePicks = 9 - i;
    const affordable = (d.candidates || []).filter((c) => c.salary != null && c.salary <= d.budget - spent - futurePicks * 5);
    const pick = (affordable.length ? affordable : d.candidates).sort((a, b) => b.overall - a.overall)[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    spent += (pick.salary || 0);
    if (!pr.ok && pr.error) { console.log('  (pick rejected:', pr.error + ')'); break; }
  }
  const d2 = await req('GET', '/api/draft');
  pass(fail, 'draft 10 → roster full', d2.rosterCount === 10, `count=${d2.rosterCount}`);

  const { roster } = await req('GET', '/api/roster');
  const starters = roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position }));
  await req('POST', '/api/lineup', { teamName: 'Testerz', conference: 'West', replacedTeam: 'Golden State Warriors', starters });

  const half1 = await req('POST', '/api/season/start');
  pass(fail, 'season half 1 simulated', typeof half1.wins === 'number');
  await req('GET', '/api/trade/pool'); // must not error

  const season = await req('POST', '/api/season/finish');
  pass(fail, 'season finished', season.madePlayoffs !== undefined, `madePlayoffs=${season.madePlayoffs}`);

  if (season.madePlayoffs) {
    await req('POST', '/api/playoffs/start');
    let champ = null;
    for (let rr = 1; rr <= 4; rr++) {
      const pr = await req('POST', '/api/playoffs/round');
      if (pr.champion) champ = pr.champion;
    }
    pass(fail, 'playoffs completed', !!champ, `champ=${champ}`);
  }

  // Capture the season standings BEFORE next-season (next-season wipes transient
  // season state, so the draft order must be verified against a saved copy).
  const standingsRaw = stateValue('season_standings');

  // ---- 2. Next season: draft order + FA refresh ----
  const ns = await req('POST', '/api/next-season');
  pass(fail, 'next season runs', ns.ok === true && ns.seasonNumber === 2, `season=${ns.seasonNumber}`);
  pass(fail, 'offseasonPicks is always 1', ns.offseasonPicks === 1, `got=${ns.offseasonPicks}`);

  // draft order: playoff teams must be ascending by wins (best record picks LAST)
  const orderRaw = stateValue('draft_order');
  if (orderRaw && standingsRaw) {
    const order = JSON.parse(orderRaw);
    const st = JSON.parse(standingsRaw);
    const all = [...st.east, ...st.west];
    const winsOf = (n) => { const t = all.find((x) => x.name === n); return t ? t.wins : null; };
    const playoffSeg = order.slice(14); // after the 14 lottery teams
    const segWins = playoffSeg.map(winsOf);
    const ascending = segWins.every((w, i) => w != null && (i === 0 || segWins[i - 1] <= w));
    pass(fail, 'draft order: playoff segment ascending (best picks last)', ascending, `wins=${segWins.join(',')}`);
  } else {
    pass(fail, 'draft order state present', false, `draft_order=${!!orderRaw}, standings=${!!standingsRaw}`);
  }

  // rookie draft should be active (offseason)
  const dd = await req('GET', '/api/draft');
  pass(fail, 'rookie draft active', dd.offseason === true && dd.canPass === true, `board=${dd.draftBoard ? dd.draftBoard.length : 0}, pos=${dd.userPosition}`);

  // pick a rookie (roster should have room only if someone retired; otherwise pass)
  if (dd.candidates && dd.candidates.length && dd.rosterCount < dd.rosterSize) {
    const pick = dd.candidates[0];
    await req('POST', '/api/roster', { playerId: pick.id });
    const resume = await req('GET', '/api/resume');
    pass(fail, 'after rookie pick → phase is freeagency', resume.phase === 'freeagency', `phase=${resume.phase}`);
  } else {
    const passRes = await req('POST', '/api/draft/pass');
    pass(fail, 'passed rookie draft (roster full / no candidates)', passRes.ok === true);
  }

  // ---- 3. FA refresh counter (only 1 refresh per offseason now) ----
  const fa = await req('GET', '/api/freeagency');
  pass(fail, 'FA market present', fa.candidates.length > 0, `market=${fa.candidates.length}`);
  const r1 = await req('POST', '/api/fa/refresh');
  const fa2 = await req('GET', '/api/freeagency');
  pass(fail, 'refresh1 leaves 0', r1.refreshes === 0 && fa2.refreshes === 0, `r=${r1.refreshes}, persisted=${fa2.refreshes}`);
  const r2 = await req('POST', '/api/fa/refresh');
  pass(fail, 'refresh2 rejected (no refreshes left)', r2.status === 400 || (r2.error && /no refreshes/i.test(r2.error)), JSON.stringify(r2).slice(0, 80));

  // finish FA
  const done = await req('POST', '/api/freeagency/done');
  pass(fail, 'freeagency done → lineup', done.ok === true);

  // ---- 4. Reset must clear stale league + session rookies ----
  const ltBefore = countTable('league_teams');
  const rookiesBefore = countTable('players');
  await req('POST', '/api/reset', { gameMode: 'normal' });
  const ltAfter = countTable('league_teams');
  const rookiesAfter = countTable('players');
  pass(fail, 'reset clears league_teams', ltBefore > 0 && ltAfter === 0, `before=${ltBefore} after=${ltAfter}`);
  pass(fail, 'reset clears session rookies', rookiesBefore > 0 && rookiesAfter === 0, `before=${rookiesBefore} after=${rookiesAfter}`);

  // fresh run in same session must work end-to-end (normal mode)
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const pick = [...d.candidates].sort((a, b) => b.overall - a.overall)[0];
    await req('POST', '/api/roster', { playerId: pick.id });
  }
  const r3 = await req('GET', '/api/roster');
  pass(fail, 'fresh normal run drafts 10 cleanly', r3.roster.length === 10, `roster=${r3.roster.length}`);

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
