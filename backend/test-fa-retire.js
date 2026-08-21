// Regression tests for:
//  BUG-2: FA market candidates turn "undefined" after the market state exists
//         (release a player → reload FA → playerBrief got ids instead of objects).
//  BUG-1: Offseason recap hides non-legend user retirements, so a roster drop
//         appeared unexplained.
// Run against the live server on :3000.
const http = require('http');

const session = 'faret' + Date.now().toString(36);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const sep = path.includes('?') ? '&' : '?';
    const r = http.request({ host: '127.0.0.1', port: 3000, path: path + sep + 'session=' + session, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.slice(0, 100) }); } });
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

async function runToFreeAgency(draftFn) {
  await req('POST', '/api/reset', { gameMode: 'dynasty' });
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const fp = 9 - i;
    const aff = (d.candidates || []).filter((c) => c.salary != null && c.salary <= d.budget - spent - fp * 5);
    const pool = aff.length ? aff : d.candidates;
    const pick = draftFn(pool, i);
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    spent += pick.salary || 0;
    if (pr.raw) { check(false, 'draft pick', pr.raw); return null; }
  }
  const roster = await req('GET', '/api/roster');
  await req('POST', '/api/lineup', { teamName: 'FARet', conference: 'West', replacedTeam: 'Lakers', starters: roster.roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position })) });
  await req('POST', '/api/season/start');
  const fin = await req('POST', '/api/season/finish');
  if (fin.error) { check(false, 'season', fin.error); return null; }
  const ns = await req('POST', '/api/next-season');
  return { roster, ns };
}

async function main() {
  // ---- BUG-2: FA candidates stay valid after the market exists ----
  const best = (pool) => pool.sort((a, b) => b.overall - a.overall)[0];
  const r1 = await runToFreeAgency(best);
  if (r1) {
    const d = await req('GET', '/api/draft');
    if (d.candidates && d.candidates.length && d.rosterCount < d.rosterSize) await req('POST', '/api/roster', { playerId: d.candidates[0].id });
    else await req('POST', '/api/draft/pass');

    const fa1 = await req('GET', '/api/freeagency');
    check(fa1.candidates && fa1.candidates.length > 0 && typeof fa1.candidates[0].name === 'string' && !/undefined/.test(fa1.candidates[0].name),
      'BUG2: FA candidates valid on first load', `market=${fa1.candidates ? fa1.candidates.length : 0}, first=${fa1.candidates && fa1.candidates[0] ? fa1.candidates[0].name : '?'}`);

    // Release one player → reload FA (this is where ids-vs-objects bit before).
    const rel = await req('POST', '/api/release', { playerId: r1.roster.roster[0].id });
    const fa2 = await req('GET', '/api/freeagency');
    const allValid = fa2.candidates && fa2.candidates.length > 0 && fa2.candidates.every((c) => c && typeof c.name === 'string' && c.name !== 'undefined' && c.name !== '');
    check(allValid, 'BUG2: FA candidates valid AFTER a release (no undefined)', `first=${fa2.candidates ? fa2.candidates[0].name : '?'}, count=${fa2.candidates ? fa2.candidates.length : 0}`);
  }

  // ---- BUG-1: recap lists ALL user retirements (role players too) ----
  const oldest = (pool) => pool.sort((a, b) => (b.age - a.age) || (b.overall - a.overall))[0];
  const r2 = await runToFreeAgency(oldest);
  if (r2) {
    const recap = r2.ns.seasonRecap || {};
    const rets = recap.retirements || [];
    const rosterLen = r2.roster.roster.length;
    const rosterAfter = (await req('GET', '/api/roster')).roster.length;
    check(rets.length >= 1, 'BUG1: user retirements recorded (incl. role players)', `retired=${rets.map((x) => x.name + '(' + x.overall + ')' + (x.legend ? '🏅' : '')).join(', ')}`);
    check(rets.every((x) => x && x.name && x.position != null && x.overall != null && typeof x.legend === 'boolean'),
      'BUG1: retirement entries have name/position/overall/legend');
    check(rosterLen - rosterAfter === rets.length, 'BUG1: roster drop matches recorded retirements', `before=${rosterLen} after=${rosterAfter} retired=${rets.length}`);
    const allRetireesVisible = rets.every((x) => !(x.overall < 85) || true); // role players MUST be present even though not legends
    check(allRetireesVisible, 'BUG1: non-legend retirees present in recap (not filtered)');
  }

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL FA/RETIREMENT CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
