// Regression test: elimination round must be recorded on the round it happens and
// NOT overwritten by later AI-only playoff rounds (was reporting round 4 for a
// round-1 exit, and also corrupted the "reach conference finals" season goal).
// Run against the live server on :3000.
const http = require('http');

const session = 'elim' + Date.now().toString(36);

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

async function draftTargeted(target) {
  for (let i = 0; i < 10; i++) {
    const d = await req('GET', '/api/draft');
    const pick = [...d.body.candidates].sort((a, b) => Math.abs(a.overall - target) - Math.abs(b.overall - target))[0];
    const pr = await req('POST', '/api/roster', { playerId: pick.id });
    if (pr.status !== 200) return false;
  }
  return true;
}

async function runPlayoffRoundChecks() {
  // Track the round the user is eliminated in (from the round responses), then
  // assert later rounds keep reporting the SAME round.
  let elimRound = null;
  for (let r = 1; r <= 4; r++) {
    const pr = await req('POST', '/api/playoffs/round');
    if (pr.status !== 200) { check(false, `playoff round ${r}`, pr.body.error || 'non-200'); return; }
    if (pr.body.userEliminated && elimRound === null) {
      elimRound = r;
      check(pr.body.userEliminatedRound === r, `elimination reported in round ${r}`, `userEliminatedRound=${pr.body.userEliminatedRound}`);
    }
    // Once eliminated, later AI-only rounds must NOT change the reported round.
    if (elimRound !== null && pr.body.userEliminatedRound !== undefined) {
      check(pr.body.userEliminatedRound === elimRound, `round ${r} keeps elimination round ${elimRound}`, `got ${pr.body.userEliminatedRound}`);
    }
  }
  if (elimRound === null) console.log('  (user won the championship in this sample — elimination-round checks skipped)');
  else {
    // Cross-check the persisted result used by the result screen / dynasty history.
    const result = await req('GET', '/api/result');
    const po = result.body.playoff || {};
    check(po.userEliminatedRound === elimRound, 'persisted playoff_result round matches', `persisted=${po.userEliminatedRound}`);
  }
}

async function main() {
  await req('POST', '/api/reset', { gameMode: 'normal' });
  if (!(await draftTargeted(78))) { check(false, 'draft'); return; }
  const roster = await req('GET', '/api/roster');
  await req('POST', '/api/lineup', { teamName: 'Elim Test', conference: 'West', replacedTeam: 'Lakers', starters: roster.body.roster.slice(0, 5).map((p) => ({ playerId: p.id, slot: p.position })) });
  await req('POST', '/api/season/start');
  const fin = await req('POST', '/api/season/finish');
  if (!fin.body.madePlayoffs) { console.log('  (team missed playoffs — cannot exercise elimination round; check skipped)'); return; }
  await req('POST', '/api/playoffs/start');
  await runPlayoffRoundChecks();

  console.log(fail.count ? `\n${fail.count} CHECK(S) FAILED` : '\nALL ELIMINATION-ROUND CHECKS PASSED');
  process.exit(fail.count ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
