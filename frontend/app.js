// Championship Run — frontend logic
const $ = (id) => document.getElementById(id);

const state = { mode: 'open', replacedTeam: null, conference: null, roster: [], libSort: 'overall', libDir: 'desc', libPos: '', playoffRound: 1 };

// Blind mode hides ALL ability info (overall/EPM/rating/strength) and per-player
// salary (which encodes overall). Position is hidden during the draft but revealed
// from lineup onward (needed to assign slots); real per-game stats (pts/trb/ast)
// stay visible since they're observed performance. Budget (spent/total) stays visible
// — it's the player's own financial state, not scouting info.
const isBlind = () => state.mode === 'blind';

function show(id) {
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = true));
  $(id).hidden = false;
  window.scrollTo(0, 0);
}

let SESSION_ID = localStorage.getItem('championship_session');
if (!SESSION_ID) { SESSION_ID = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('championship_session', SESSION_ID); }

async function api(path, options) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(path + sep + 'session=' + encodeURIComponent(SESSION_ID), options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : n);
const pct = (n) => (typeof n === 'number' ? (n * 100).toFixed(1) + '%' : '—');
const halfBadge = (half) => (half === 'first' ? ' <span class="half-badge first">1st half only</span>' : (half === 'second' ? ' <span class="half-badge second">2nd half only</span>' : ''));

// ---------- Session ID (view / switch your save) ----------
function initSessionUI() {
  $('session-id').value = SESSION_ID;
  $('copy-session').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(SESSION_ID); $('session-msg').textContent = 'Session ID copied.'; }
    catch (e) { $('session-id').select(); $('session-msg').textContent = 'Copy failed — select and copy it manually.'; }
  });
  $('apply-session').addEventListener('click', () => {
    const v = ($('switch-session').value || '').trim().slice(0, 64);
    if (!v) { $('session-msg').textContent = 'Paste a session ID first.'; return; }
    localStorage.setItem('championship_session', v);
    SESSION_ID = v;
    location.reload();
  });
}

// ---------- Home ----------
async function loadNbaTeams() {
  const { teams } = await api('/api/nba-teams');
  const sel = $('replace-team');
  const byName = (a, b) => a.name.localeCompare(b.name);
  const east = teams.filter((t) => t.conf === 'East').sort(byName);
  const west = teams.filter((t) => t.conf === 'West').sort(byName);
  const group = (label, list) => {
    const og = document.createElement('optgroup');
    og.label = `${label} Conference`;
    for (const t of list) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      og.appendChild(o);
    }
    return og;
  };
  sel.appendChild(group('Eastern', east));
  sel.appendChild(group('Western', west));
  state.replacedTeam = sel.value;
  state.conference = east.some((t) => t.name === sel.value) ? 'East' : 'West';
  sel.addEventListener('change', () => {
    state.replacedTeam = sel.value;
    state.conference = teams.find((t) => t.name === sel.value).conf;
  });
}

async function loadLibrary() {
  const q = new URLSearchParams({ sort: state.libSort, order: state.libDir });
  if (state.libPos) q.set('pos', state.libPos);
  const { players } = await api(`/api/players?${q}`);
  renderLibrary(players);
}

function renderLibrary(players) {
  const tbody = $('library').querySelector('tbody');
  const blind = isBlind();
  // Blind mode: the library is a scouting cheat sheet — hide every ability/stat
  // column so it can't be used to look up players before drafting. Only name+position.
  // Hide the matching header columns too, so the table doesn't misalign.
  const visibleCols = blind ? ['name', 'position'] : null;
  $('library').querySelectorAll('th[data-sort]').forEach((th) => {
    th.hidden = visibleCols ? !visibleCols.includes(th.dataset.sort) : false;
  });
  if (blind) {
    tbody.innerHTML = players.map((p) => `
      <tr><td>${p.name}</td><td>${p.position}${p.position2 ? '/' + p.position2 : ''}</td></tr>`).join('');
    return;
  }
  tbody.innerHTML = players.map((p) => `
    <tr>
      <td>${p.name}</td><td>${p.position}${p.position2 ? '/' + p.position2 : ''}</td><td class="num">${p.overall}</td><td class="num">${p.rating}</td>
      <td class="num">${p.pts}</td><td class="num">${p.trb}</td><td class="num">${p.ast}</td>
      <td class="num">${p.stl}</td><td class="num">${p.blk}</td>
      <td class="num">${p.oepm.toFixed(1)}</td><td class="num">${p.depm.toFixed(1)}</td><td class="num">${p.epm.toFixed(1)}</td>
    </tr>`).join('');
}

async function loadSavedTeams() {
  const { teams } = await api('/api/teams');
  const box = $('saved-teams');
  if (!teams.length) { box.innerHTML = '<span class="muted">No saved teams yet.</span>'; return; }
  box.innerHTML = '';
  for (const t of teams) {
    const div = document.createElement('div');
    div.className = 'saved-team';
    div.innerHTML = `<div class="saved-team-head"><span>${t.name}</span></div>${savedResultsHtml(t.results)}`;

    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'ghost';
    del.addEventListener('click', async () => { await api(`/api/teams/${t.id}`, { method: 'DELETE' }); loadSavedTeams(); });
    div.querySelector('.saved-team-head').append(del);
    box.appendChild(div);
  }
}

function savedResultsHtml(r) {
  if (!r) return '';
  const parts = [];
  if (r.season) parts.push(`Season ${r.season.wins}-${r.season.losses} (${r.season.conference})`);
  if (r.playoff) parts.push(r.playoff.userEliminated ? `Eliminated round ${r.playoff.userEliminatedRound}` : '🏆 Champion');
  const head = parts.length ? `<div class="saved-record muted">${parts.join(' · ')}</div>` : '';
  const standingsTable = r.seasonStandings ? `<details class="saved-avgs"><summary>Season standings</summary>${standingsHtml(r.seasonStandings.east, r.seasonStandings.west)}</details>` : '';
  const bracket = r.playoffBracket && r.playoffBracket.length ? `<details class="saved-avgs"><summary>Playoff bracket</summary>${renderBracket(r.playoffBracket, [])}</details>` : '';
  const seasonTable = r.seasonAverages ? `<details class="saved-avgs"><summary>Your season averages</summary>${avgTableHtml(r.seasonAverages)}</details>` : '';
  const playoffTable = r.playoffAverages ? `<details class="saved-avgs"><summary>Playoff averages</summary>${avgTableHtml(r.playoffAverages, false)}</details>` : '';
  const tradeLog = r.leagueTradeLog && r.leagueTradeLog.length ? `<details class="saved-avgs"><summary>League trades (${r.leagueTradeLog.length})</summary><div class="trade-log-list">${r.leagueTradeLog.map((x) => `<div>${x}</div>`).join('')}</div></details>` : '';
  return head + standingsTable + bracket + seasonTable + playoffTable + tradeLog;
}

function avgTableHtml(avgs, showPct = true) {
  const pctHead = showPct ? '<th>FG%</th><th>3P%</th><th>FT%</th>' : '';
  const pctCells = (p) => (showPct ? `<td>${pct(p.fgPct)}</td><td>${pct(p.threePct)}</td><td>${pct(p.ftPct)}</td>` : '');
  return `<div class="table-scroll"><table><thead><tr><th>Player</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th>${pctHead}</tr></thead><tbody>${
    avgs.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}${halfBadge(p.half)}</td><td>${fmt(p.pts)}</td><td>${fmt(p.trb)}</td><td>${fmt(p.ast)}</td><td>${fmt(p.stl)}</td><td>${fmt(p.blk)}</td>${pctCells(p)}</tr>`).join('')
  }</tbody></table></div>`;
}

async function loadTrophies() {
  const { trophies } = await api('/api/trophies');
  renderTrophies(trophies);
}

function renderTrophies(trophies) {
  const box = $('trophy-room');
  if (!trophies.length) { box.innerHTML = '<span class="muted">No trophies yet. Win a championship!</span>'; return; }
  const group = (title, list, item) => list.length
    ? `<div class="trophy-group"><div class="trophy-title">${title} × ${list.length}</div>${list.map(item).join('')}</div>`
    : '';
  box.innerHTML =
    group('🏆 NBA Championship', trophies.filter((t) => t.type === 'championship'), (t) => `<div class="trophy-item">${t.team_name}</div>`) +
    group('🏆 Eastern Conference Champion', trophies.filter((t) => t.type === 'east_champion'), (t) => `<div class="trophy-item">${t.team_name}</div>`) +
    group('🏆 Western Conference Champion', trophies.filter((t) => t.type === 'west_champion'), (t) => `<div class="trophy-item">${t.team_name}</div>`) +
    group('🏆 Regular Season MVP', trophies.filter((t) => t.type === 'season_mvp'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🛡️ Defensive Player', trophies.filter((t) => t.type === 'dpoy'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🔥 Sixth Man', trophies.filter((t) => t.type === 'six_man'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🌟 All-NBA First Team', trophies.filter((t) => t.type === 'all_nba'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🏅 Finals MVP', trophies.filter((t) => t.type === 'finals_mvp'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🏅 Eastern Conference Finals MVP', trophies.filter((t) => t.type === 'east_mvp'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`) +
    group('🏅 Western Conference Finals MVP', trophies.filter((t) => t.type === 'west_mvp'), (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span></div>`);
}

async function loadCareer() {
  const c = await api('/api/career');
  $('career').innerHTML = c.runs
    ? `🏆 ${c.championships} championship${c.championships === 1 ? '' : 's'} · ${c.runs} run${c.runs === 1 ? '' : 's'} · ${c.totalWins} career wins · ${c.mvps} MVP${c.mvps === 1 ? '' : 's'}`
    : '<span class="muted">No history yet.</span>';
}

async function goHome() { show('home'); await loadCareer(); await loadSavedTeams(); await loadTrophies(); await loadResume(); }

$('new-draft').addEventListener('click', async () => {
  state.mode = document.querySelector('input[name=mode]:checked').value;
  state.difficulty = document.querySelector('input[name=difficulty]:checked').value;
  await api('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: state.difficulty, mode: state.mode }) });
  show('draft');
  await loadDraft();
});

$('home-btn').addEventListener('click', () => { goHome(); });

// ---------- Continue last run ----------
async function loadResume() {
  try {
    const r = await api('/api/resume');
    if (!r || r.phase === 'none') { $('continue-panel').hidden = true; return; }
    state.difficulty = r.difficulty;
    state.mode = r.mode;
    $('continue-summary').textContent = resumeLabel(r);
    $('continue-panel').hidden = false;
  } catch (e) { /* resume is best-effort */ }
}

function resumeLabel(r) {
  const name = r.teamName || 'My Team';
  switch (r.phase) {
    case 'draft': return `${name} · Draft (${r.rosterCount}/${r.rosterSize} picked)`;
    case 'lineup': return `${name} · Set your starting 5`;
    case 'preseason': return `${name} · Ready for the regular season`;
    case 'midseason': return `${name} · Mid-season (${r.midseason ? r.midseason.wins + '-' + r.midseason.losses : '?'})`;
    case 'season': return `${name} · Season complete`;
    case 'playoffs': return `${name} · Playoffs (round ${r.playoffs ? r.playoffs.round : '?'})`;
    case 'finished': return `${name} · Season over — view result`;
    default: return name;
  }
}

$('continue-run').addEventListener('click', async () => {
  try {
    const r = await api('/api/resume');
    state.mode = r.mode;
    state.difficulty = r.difficulty;
    state.hardMode = r.difficulty === 'hard';
    if (r.conference) state.conference = r.conference;
    if (r.replacedTeam) state.replacedTeam = r.replacedTeam;
    switch (r.phase) {
      case 'draft': show('draft'); await loadDraft(); break;
      case 'lineup': show('lineup'); await loadLineup(); break;
      case 'preseason': $('simulate-season').hidden = false; $('season-result').innerHTML = ''; show('season'); break;
      case 'midseason': show('season'); renderMidSeason(r.midseason); break;
      case 'season': show('season'); renderSeason(r.season); break;
      case 'playoffs': resumePlayoffs(r.playoffs); break;
      case 'finished': showResult(); break;
      default: show('home');
    }
  } catch (e) { alert(e.message); }
});

function resumePlayoffs(p) {
  if (!p) return show('home');
  show('playoffs');
  const matchups = p.matchups.map((m) => `
    <div class="series${m.a.isUser || m.b.isUser ? ' user' : ''}">
      <div class="series-teams">
        <details><summary>${m.a.isUser ? '<span class="user-team">★ ' + m.a.name + '</span> (you)' : m.a.name}</summary><div class="roster">${m.a.roster.map(rosterLine).join('<br>')}</div></details>
        <span class="vs">vs</span>
        <details><summary>${m.b.isUser ? '<span class="user-team">★ ' + m.b.name + '</span> (you)' : m.b.name}</summary><div class="roster">${m.b.roster.map(rosterLine).join('<br>')}</div></details>
      </div>
    </div>`).join('');
  let html = `<h3>Playoff Bracket</h3>${renderBracket(p.rounds, p.nextMatchups)}`;
  if (p.userEliminated) html += `<p class="muted eliminated-note">You were eliminated in round ${p.userEliminatedRound}. The playoffs continue without you.</p>`;
  html += `<h3>Round ${p.round}</h3><div class="bracket">${matchups}</div><button id="simulate-round" class="primary">Simulate Round ${p.round}</button>`;
  $('playoffs-body').innerHTML = html;
  $('simulate-round').addEventListener('click', async () => {
    const j = await api('/api/playoffs/round', { method: 'POST' });
    renderRoundResults(j);
  });
}

// ---------- Back up / restore ----------
$('export-save').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'championship-run-save.json';
    a.click();
    URL.revokeObjectURL(url);
    $('save-msg').textContent = 'Save exported.';
  } catch (e) { $('save-msg').textContent = 'Export failed: ' + e.message; }
});

$('import-save-btn').addEventListener('click', () => $('import-save').click());
$('import-save').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    $('save-msg').textContent = 'Save restored.' + (r.skipped && r.skipped.length ? ' Skipped (not in player pool): ' + r.skipped.join(', ') : '');
    ev.target.value = '';
    await goHome();
  } catch (e) { $('save-msg').textContent = 'Import failed: ' + e.message; }
});

// ---------- Draft ----------
async function loadDraft() {
  const j = await api('/api/draft');
  $('reroll-count').textContent = j.rerolls;
  $('draft-progress').textContent = `${j.rosterCount} / ${j.rosterSize} picked`;
  state.hardMode = j.hardMode;
  state.budget = j.budget;
  state.spent = j.spent;
  await renderDraftRoster();
  if (j.rosterCount >= j.rosterSize) { show('lineup'); await loadLineup(); return; }
  renderCandidates(j.candidates);
}

function renderCandidates(candidates) {
  const box = $('candidates');
  box.innerHTML = '';
  const blind = isBlind();
  // positions the roster still needs (for the "need" badge) — hidden in blind mode
  const posCount = {};
  for (const p of state.roster) posCount[p.position] = (posCount[p.position] || 0) + 1;
  const needed = new Set(['PG', 'SG', 'SF', 'PF', 'C'].filter((p) => !posCount[p]));
  for (const c of candidates) {
    const card = document.createElement('div');
    card.className = 'card';
    const need = !blind && needed.has(c.position);
    card.innerHTML = `
      <div class="card-top">
        <strong>${c.name}</strong>
        ${blind ? '' : `<span class="pos">${c.position}${c.position2 ? '/' + c.position2 : ''}</span>`}
      </div>
      <div class="stats">Age ${c.age}</div>
      ${blind
        ? '<div class="stats">Ratings hidden (blind draft)</div>'
        : `<div class="stats">OVR ${c.overall} · EPM ${c.epm} · <b class="rtg">Rtg ${c.rating}</b></div>
           <div class="stats">${c.pts} pts · ${c.trb} reb · ${c.ast} ast</div>`}
      ${need ? '<div class="need-badge">Need ' + c.position + '</div>' : ''}
      ${!blind && state.hardMode ? `<div class="salary">💰 $${c.salary}M</div>` : ''}
      <button data-id="${c.id}">Pick</button>`;
    card.querySelector('button').addEventListener('click', async () => {
      try {
        await api('/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: +card.querySelector('button').dataset.id }) });
        await loadDraft();
      } catch (e) { alert(e.message); }
    });
    box.appendChild(card);
  }
}

$('reroll').addEventListener('click', async () => {
  const j = await api('/api/draft/reroll', { method: 'POST' });
  $('reroll-count').textContent = j.rerolls;
  renderCandidates(j.candidates);
});

// ---------- Lineup ----------
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

function positionDistance(a, b) {
  return Math.abs(POSITIONS.indexOf(a) - POSITIONS.indexOf(b));
}
function positionDiscount(natural, slot, secondary) {
  if (slot === natural || slot === secondary) return 1.0;
  const d = positionDistance(natural, slot);
  if (d === 1) return 0.975;
  if (d === 2) return 0.95;
  return 0.9;
}
// Sigmoid minutes model (mirrors the backend sim.js minutesWeight, regular season).
const MP_A = 7.5, MP_B = 33.5, MP_MU = 76.5, MP_S = 4;
const BENCH_MINUTES_RATIO = 0.75; // mirrors backend sim.js
function minutesWeight(rating) {
  return MP_A + (MP_B - MP_A) / (1 + Math.exp(-(rating - MP_MU) / MP_S));
}
// Compute team strength (mirrors the backend teamStrength formula) from a roster
// and the current starter/slot assignments, so the lineup screen can show it live.
// `ignoreBench` (draft preview) treats everyone as a starter, since no lineup is set.
function computeStrength(roster, starters, ignoreBench = false) {
  let num = 0, den = 0;
  for (const p of roster) {
    const r = p.overall + p.epm * 0.5;
    let w = minutesWeight(r);
    let disc = 1.0;
    const s = starters.find((x) => x.playerId === p.id);
    if (s) disc = positionDiscount(p.position, s.slot, p.position2);
    else if (!ignoreBench) w *= BENCH_MINUTES_RATIO;
    num += r * disc * w;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

async function loadLineup() {
  const j = await api('/api/roster');
  state.roster = j.roster.sort((a, b) => b.rating - a.rating);
  // hide the live team-strength banner in blind mode (ability info)
  $('strength-banner').hidden = isBlind();
  renderLineup();
}

function renderLineup() {
  const box = $('slots');
  box.innerHTML = '';
  const used = new Set();
  for (const pos of POSITIONS) {
    // Prefer the player's actual current starter assignment (the slot they were
    // set to at season start / last lineup save), then fall back to natural-position
    // matching only for the initial setup right after the draft (nothing assigned yet).
    const match = state.roster.find((p) => p.role === 'starter' && p.slot === pos && !used.has(p.id)) ||
      state.roster.find((p) => p.position === pos && !used.has(p.id)) ||
      state.roster.find((p) => !used.has(p.id));
    if (match) used.add(match.id);
    const row = document.createElement('div');
    row.className = 'slot-row';
    const select = document.createElement('select');
    const blind = isBlind();
    for (const p of state.roster) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.position}${p.position2 ? '/' + p.position2 : ''}${blind ? '' : `, OVR ${p.overall}`})`;
      if (match && p.id === match.id) opt.selected = true;
      select.appendChild(opt);
    }
    row.innerHTML = `<span class="slot-label">${pos}</span>`;
    row.appendChild(select);
    const badge = document.createElement('span');
    badge.className = 'penalty-badge';
    row.appendChild(badge);
    box.appendChild(row);
  }
  updateBench();
  box.querySelectorAll('select').forEach((s) => s.addEventListener('change', updateBench));
}

function updateBench() {
  const selects = $('slots').querySelectorAll('select');
  const selected = new Set([...selects].map((s) => +s.value));
  const bench = state.roster.filter((p) => !selected.has(p.id));
  const blind = isBlind();
  $('bench').innerHTML = `<h3>Bench <span class="muted">(${bench.length})</span></h3><div class="chip-list">${
    bench.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span>${blind ? '' : ` <span class="muted">${p.overall}</span>`}</span>`).join('')
  }</div>`;

  // live strength + per-slot position-mismatch penalty (hidden in blind mode)
  const starters = POSITIONS.map((pos, i) => ({ playerId: +selects[i].value, slot: pos }));
  if (!blind) $('strength-value').textContent = computeStrength(state.roster, starters).toFixed(1);
  selects.forEach((sel, i) => {
    const p = state.roster.find((x) => x.id === +sel.value);
    const disc = positionDiscount(p.position, POSITIONS[i], p.position2);
    const badge = sel.parentElement.querySelector('.penalty-badge');
    if (disc === 1.0) { badge.textContent = '✓'; badge.className = 'penalty-badge ok'; }
    else {
      const pct = (1 - disc) * 100;
      badge.textContent = '-' + (pct % 1 === 0 ? pct : pct.toFixed(1)) + '%';
      badge.className = 'penalty-badge warn';
    }
  });
}

function readStarters() {
  const selects = $('slots').querySelectorAll('select');
  return POSITIONS.map((pos, i) => ({ playerId: +selects[i].value, slot: pos }));
}

async function postLineup() {
  const starters = readStarters();
  if (new Set(starters.map((s) => s.playerId)).size !== 5) throw new Error('Each starter must be a different player.');
  await api('/api/lineup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName: $('team-name').value || state.replacedTeam || 'My Team', conference: state.conference, replacedTeam: state.replacedTeam, starters }),
  });
}

$('confirm-lineup').addEventListener('click', async () => {
  try {
    await postLineup();
    if (state.midSeason) {
      show('season');
      renderMidSeason(state.midSeason);
    } else {
      $('simulate-season').hidden = false;
      $('season-result').innerHTML = '';
      show('season');
    }
  } catch (e) { alert(e.message); }
});

// ---------- Season ----------
$('simulate-season').addEventListener('click', async () => {
  $('season-result').innerHTML = '<p class="muted">Simulating the first half…</p>';
  const j = await api('/api/season/start', { method: 'POST' });
  renderMidSeason(j);
});

function awardsHtml(awards) {
  if (!awards) return '';
  const items = [
    ['🏆 MVP', awards.mvp],
    ['🛡️ Defensive Player', awards.dpoy],
    ['🔥 Sixth Man', awards.sixMan],
  ];
  const card = (label, a) => (a ? `
      <div class="award${a.isUser ? ' me' : ''}">
        <span class="award-label">${label}</span>
        <span class="award-name">${a.player}</span>
        <span class="award-team muted">${a.team}${a.isUser ? ' (you)' : ''}</span>
      </div>` : '');
  const firstTeam = (awards.firstTeam || []).filter(Boolean);
  const firstTeamHtml = firstTeam.length ? `
      <div class="award award-ft${firstTeam.some((a) => a.isUser) ? ' me' : ''}">
        <span class="award-label">🌟 All-NBA First Team</span>
        ${firstTeam.map((a) => `<div class="ft-item"><span class="ft-pos">${a.position}</span> <span class="award-name">${a.player}</span> <span class="award-team muted">${a.team}${a.isUser ? ' (you)' : ''}</span></div>`).join('')}
      </div>` : '';
  return `
    <h3>Regular Season Awards</h3>
    <div class="awards-grid">${items.map(([label, a]) => card(label, a)).join('')}${firstTeamHtml}</div>`;
}

function gameLogHtml(games) {
  if (!games || !games.length) return '';
  // current streak (most recent consecutive W or L); games are { opp, home, win, score, oppScore, star }
  const lastWin = games[games.length - 1].win;
  let streak = 0;
  for (let i = games.length - 1; i >= 0 && games[i].win === lastWin; i--) streak++;
  const wins = games.filter((g) => g.win).length;
  const losses = games.length - wins;
  const rows = games.slice().reverse().map((g) => `
    <div class="gl-row ${g.win ? 'gl-win' : 'gl-loss'}">
      <span class="gl-result ${g.win ? 'good' : 'bad'}">${g.win ? 'W' : 'L'}</span>
      <span class="gl-vs muted">${g.home ? 'vs' : '@'}</span>
      <span class="gl-opp">${g.opp}</span>
      <span class="gl-score">${g.score}–${g.oppScore}</span>
      ${g.star ? `<span class="gl-star muted">⭐ ${g.star}</span>` : ''}
      ${g.milestone ? `<span class="gl-milestone">${g.milestone}</span>` : ''}
      ${g.injuries && g.injuries.length ? `<span class="gl-injury" title="${g.injuries.map(i => `${i.name} (${i.games} games)`).join(' · ')}">🚑 ${g.injuries.map(i => i.name.split(' ').pop()).join(', ')}</span>` : ''}
    </div>`).join('');
  return `
    <h3>Season Form <span class="muted">· ${streak}-game ${lastWin ? 'win' : 'loss'} streak · ${wins}-${losses}</span></h3>
    <div class="game-log-list">${rows}</div>`;
}

let tradePool = null;
let tradeNotice = '';

// Render a checkbox list of players; returns the checked ids.
function tradeChecklist(players, label) {
  const box = document.createElement('div');
  box.className = 'trade-checkbox-list';
  const blind = isBlind();
  box.innerHTML = `<label class="trade-label">${label}</label>` + players.map((p) => `
    <label class="trade-check"><input type="checkbox" value="${p.id}"><span>${p.name} <span class="pos">${p.position}</span>${blind ? '' : ` <span class="muted">${p.overall}</span>`}${p.team ? ` <span class="muted">· ${p.team}</span>` : ''}</span></label>`).join('');
  box.checked = () => [...box.querySelectorAll('input:checked')].map((c) => +c.value);
  return box;
}

async function doTrade(myPlayerIds, aiPlayerIds, msgEl, force = false) {
  try {
    const r = await api('/api/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myPlayerIds, aiPlayerIds, force }) });
    if (r.accepted) tradeNotice = '✅ ' + r.message;
    msgEl.textContent = r.message || r.error;
    msgEl.className = (r.accepted ? 'good' : 'bad') + ' trade-msg';
    if (r.accepted) renderTradeUI();
  } catch (e) {
    // Surface backend rejections (e.g. "Not enough trade points") instead of letting
    // the promise fail silently — that made the button look unresponsive.
    msgEl.textContent = e.message;
    msgEl.className = 'bad trade-msg';
  }
}

function renderTradeUI() {
  const panel = $('trade-panel');
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Loading…</p>';
  api('/api/trade/pool').then(({ myRoster, aiPlayers, remainingPoints, leagueTradeLog }) => {
    tradePool = { myRoster, aiPlayers };
    const teams = [...new Set(aiPlayers.map((p) => p.team))];
    panel.innerHTML = `
      ${tradeNotice ? `<div class="trade-notice">${tradeNotice}</div>` : ''}
      <div class="trade-header muted">${remainingPoints} trade point${remainingPoints === 1 ? '' : 's'} remaining this season</div>
      <div class="trade-help muted">Rules: 1-for-1 costs 1 point · 2-for-2 costs 2 · 3-for-3 costs 3. You have 3 points total this season.</div>
      <div class="trade-tabs">
        <button class="trade-tab active" data-tab="propose">Propose</button>
        <button class="trade-tab" data-tab="shop">Shop my players</button>
        <button class="trade-tab" data-tab="incoming">Incoming offers</button>
      </div>
      <div id="trade-propose"></div>
      <div id="trade-shop" hidden></div>
      <div id="trade-incoming" hidden></div>
      ${leagueTradeLog && leagueTradeLog.length ? `<details class="trade-log"><summary>League trade log (${leagueTradeLog.length})</summary><div class="trade-log-list">${leagueTradeLog.map((x) => `<div>${x}</div>`).join('')}</div></details>` : ''}`;
    panel.querySelectorAll('.trade-tab').forEach((b) => b.addEventListener('click', () => {
      panel.querySelectorAll('.trade-tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ['propose', 'shop', 'incoming'].forEach((t) => { $('trade-' + t).hidden = t !== b.dataset.tab; });
      if (b.dataset.tab === 'incoming') renderIncoming();
    }));
    renderPropose(myRoster, aiPlayers, teams);
    renderShop(myRoster);
  }).catch((e) => {
    panel.innerHTML = `<p class="bad">Trade window failed to load: ${e.message}</p>`;
  });
}

function renderPropose(myRoster, aiPlayers, teams) {
  const box = $('trade-propose');
  const myList = tradeChecklist(myRoster, 'Your players (1-3)');
  const teamSel = document.createElement('select');
  teamSel.innerHTML = teams.map((t) => `<option>${t}</option>`).join('');
  const aiList = document.createElement('div');
  aiList.className = 'trade-checkbox-list';
  const refreshAi = () => {
    const tm = teamSel.value;
    const blind = isBlind();
    aiList.innerHTML = `<label class="trade-label">${tm} players (pick same count)</label>` + aiPlayers.filter((p) => p.team === tm).map((p) => `<label class="trade-check"><input type="checkbox" value="${p.id}"><span>${p.name} <span class="pos">${p.position}</span>${blind ? '' : ` <span class="muted">${p.overall}</span>`}</span></label>`).join('');
  };
  teamSel.addEventListener('change', refreshAi);
  refreshAi();
  const msg = document.createElement('div');
  msg.className = 'muted trade-msg';
  const btn = document.createElement('button');
  btn.textContent = 'Propose trade';
  btn.className = 'primary';
  btn.addEventListener('click', () => {
    const myIds = myList.checked();
    const aiIds = [...aiList.querySelectorAll('input:checked')].map((c) => +c.value);
    if (!myIds.length || myIds.length !== aiIds.length) { msg.textContent = 'Pick the same number (1-3) on both sides.'; msg.className = 'bad trade-msg'; return; }
    doTrade(myIds, aiIds, msg);
  });
  box.innerHTML = '';
  box.append(myList, teamSel, aiList, btn, msg);
}

function renderShop(myRoster) {
  const box = $('trade-shop');
  const myList = tradeChecklist(myRoster, 'Shop these players (1-3)');
  const offersBox = document.createElement('div');
  const msg = document.createElement('div');
  msg.className = 'muted trade-msg';
  const btn = document.createElement('button');
  btn.textContent = 'Get offers';
  btn.className = 'primary';
  btn.addEventListener('click', async () => {
    const ids = myList.checked();
    if (!ids.length) { msg.textContent = 'Pick 1-3 players first.'; msg.className = 'bad trade-msg'; return; }
    try {
      const j = await api('/api/trade/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myPlayerIds: ids }) });
      const blind = isBlind();
      offersBox.innerHTML = j.offers.length ? j.offers.map((o) => `
        <div class="trade-offer">
          <div class="trade-offer-head">${o.aiTeam} offers${blind ? '' : ` <span class="muted">(${o.aiTotal} OVR)</span>`}</div>
          <div class="muted">${o.aiPlayers.map((p) => `${p.name}${blind ? '' : ` (${p.overall})`}`).join(', ')}</div>
          <button class="accept" data-my="${JSON.stringify(ids)}" data-ai="${JSON.stringify(o.aiPlayers.map((p) => p.id))}">Accept</button>
        </div>`).join('') : '<p class="muted">No offers.</p>';
      offersBox.querySelectorAll('.accept').forEach((b) => b.addEventListener('click', () => {
        doTrade(JSON.parse(b.dataset.my), JSON.parse(b.dataset.ai), msg, true);
      }));
    } catch (e) {
      msg.textContent = e.message;
      msg.className = 'bad trade-msg';
    }
  });
  box.innerHTML = '';
  box.append(myList, btn, offersBox, msg);
}

function renderIncoming() {
  const box = $('trade-incoming');
  box.innerHTML = '<p class="muted">Loading…</p>';
  api('/api/trade/proposals').then(({ proposals }) => {
    const msg = document.createElement('div');
    msg.className = 'muted trade-msg';
    box.innerHTML = '';
    if (!proposals.length) { box.innerHTML = '<p class="muted">No incoming proposals.</p>'; return; }
    for (const p of proposals) {
      const div = document.createElement('div');
      div.className = 'trade-offer';
      const blind = isBlind();
      div.innerHTML = `
        <div class="trade-offer-head">${p.aiTeam} wants <span class="muted">${p.myPlayers.map((x) => `${x.name}${blind ? '' : ` (${x.overall})`}`).join(', ')}</span></div>
        <div class="muted">Offers ${p.aiPlayers.map((x) => `${x.name}${blind ? '' : ` (${x.overall})`}`).join(', ')}</div>
        <button class="accept">Accept</button>`;
      div.querySelector('.accept').addEventListener('click', () => {
        doTrade(p.myPlayers.map((x) => x.id), p.aiPlayers.map((x) => x.id), msg, true);
      });
      box.appendChild(div);
    }
    box.appendChild(msg);
  }).catch((e) => {
    box.innerHTML = `<p class="bad">Failed to load proposals: ${e.message}</p>`;
  });
}

// A single roster line ("Name (PG, 82)"); overall hidden in blind mode.
function rosterLine(p) {
  return `${p.role === 'starter' ? '★ ' : ''}${p.name} (${p.position}${isBlind() ? '' : `, ${p.overall}`})`;
}

function teamRosterHtml(t) {
  const list = t.roster || t.starters || [];
  return list.map(rosterLine).join('<br>');
}

function standingsHtml(east, west) {
  const blind = isBlind();
  const confTable = (title, teams) => `
    <h3>${title} Conference</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th>${blind ? '' : '<th>Str</th>'}</tr></thead>
      <tbody>${teams.map((t, i) => `
        <tr${t.isUser ? ' class="me"' : ''}>
          <td>${i + 1}</td>
          <td>
            <details><summary>${t.name}${t.isUser ? ' (you)' : ''}</summary>
              <div class="roster">${teamRosterHtml(t)}</div>
            </details>
          </td>
          <td class="w">${t.wins}</td><td class="l">${t.losses}</td>${blind ? '' : `<td>${t.strength}</td>`}
        </tr>`).join('')}</tbody>
    </table></div>`;
  return confTable('Eastern', east) + confTable('Western', west);
}

function renderMidSeason(j) {
  state.midSeason = j;
  const avgTable = `
    <h3>Your team's first-half averages (${j.games} games)</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th><th>MVP</th><th>FG%</th><th>3P%</th><th>FT%</th></tr></thead>
      <tbody>${j.playerAverages.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}</td><td>${p.position}</td><td>${fmt(p.pts)}</td><td>${fmt(p.trb)}</td><td>${fmt(p.ast)}</td><td>${fmt(p.stl)}</td><td>${fmt(p.blk)}</td><td class="num">${p.mvp || 0}</td><td>${pct(p.fgPct)}</td><td>${pct(p.threePct)}</td><td>${pct(p.ftPct)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  $('season-result').innerHTML = `
    <div class="midseason-banner">🏀 Mid-season break — <b>${j.wins}-${j.losses}</b> after ${j.games} games</div>
    <div class="midseason-help muted">You can now adjust your lineup, make trades, then simulate the second half.</div>
    <div class="row" style="margin-top:8px">
      <button id="adjust-mid" class="ghost">🎯 Adjust lineup</button>
      <button id="trade-mid" class="ghost">🔄 Trade window</button>
      <button id="finish-season" class="primary">▶ Simulate 2nd half</button>
    </div>
    <div id="trade-panel" class="trade-panel" hidden></div>
    ${gameLogHtml(j.gameLog)}
    ${avgTable}
    ${standingsHtml(j.east, j.west)}`;
  $('adjust-mid')?.addEventListener('click', () => { show('lineup'); loadLineup(); });
  $('trade-mid')?.addEventListener('click', () => renderTradeUI());
  $('finish-season')?.addEventListener('click', async () => {
    $('season-result').innerHTML = '<p class="muted">Simulating the second half…</p>';
    const j2 = await api('/api/season/finish', { method: 'POST' });
    state.midSeason = null;
    renderSeason(j2);
  });
}

function renderSeason(j) {
  $('simulate-season').hidden = true;
  const blind = isBlind();
  const avgTable = `
    <h3>Your team's 82-game averages</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th>${blind ? '' : '<th>EPM</th>'}<th>MVP</th><th>FG%</th><th>3P%</th><th>FT%</th></tr></thead>
      <tbody>${j.playerAverages.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}${halfBadge(p.half)}</td><td>${p.position}</td><td>${fmt(p.pts)}</td><td>${fmt(p.trb)}</td><td>${fmt(p.ast)}</td><td>${fmt(p.stl)}</td><td>${fmt(p.blk)}</td>${blind ? '' : `<td>${fmt(p.epm)}</td>`}<td class="num">${p.mvp || 0}</td><td>${pct(p.fgPct)}</td><td>${pct(p.threePct)}</td><td>${pct(p.ftPct)}</td></tr>`).join('')}</tbody>
    </table></div>`;

  const playoffBtn = j.madePlayoffs
    ? `<button id="go-playoffs" class="primary" style="margin-top:16px">Continue to Playoffs</button>`
    : `<p class="muted" style="margin-top:16px">You missed the playoffs. <button id="go-home-missed" class="ghost">Back to Home</button></p>`;

  $('season-result').innerHTML =
    (blind ? `<p class="muted">${j.teamName} (${j.conference})</p>` : `<p class="muted">${j.teamName} (${j.conference}) · League average strength: ${j.leagueAvg}</p>`) +
    gameLogHtml(j.gameLog) +
    awardsHtml(j.awards) +
    standingsHtml(j.east, j.west) + avgTable + playoffBtn;

  $('go-playoffs')?.addEventListener('click', () => startPlayoffs());
  $('go-home-missed')?.addEventListener('click', () => { goHome(); });
}

// ---------- Playoffs ----------
async function startPlayoffs() {
  show('playoffs');
  $('playoffs-body').innerHTML = '<p class="muted">Setting up the bracket…</p>';
  try {
    const j = await api('/api/playoffs/start', { method: 'POST' });
    state.playoffRound = j.round;
    renderMatchups(j.matchups, j.round);
  } catch (e) {
    $('playoffs-body').innerHTML = `<p class="muted">${e.message}</p><button id="back-home" class="ghost">Back to Home</button>`;
    $('back-home').addEventListener('click', () => { goHome(); });
  }
}

function bracketSeriesCell(s, played) {
  if (played) {
    const [w, l] = s.wins.split('-');
    return `<div class="bracket-series${s.isUserSeries ? ' user' : ''}">
      <div class="b-w">${s.winnerIsUser ? '★ ' : ''}${s.winner} <span class="muted">(${w})</span></div>
      <div class="b-l">${s.loserIsUser ? '★ ' : ''}${s.loser} <span class="muted">(${l})</span></div>
    </div>`;
  }
  return `<div class="bracket-series${s.a.isUser || s.b.isUser ? ' user' : ''}">
    <div class="b-t">${s.a.isUser ? '★ ' : ''}${s.a.name}</div>
    <div class="b-t muted">${s.b.isUser ? '★ ' : ''}${s.b.name}</div>
  </div>`;
}

function renderBracket(rounds, nextMatchups) {
  const labels = ['Round 1', 'Round 2', 'Conf Finals', 'Finals'];
  const cols = rounds.map((series, r) => `
    <div class="bracket-col">
      <div class="bracket-round">${labels[r] || 'Round ' + (r + 1)}</div>
      ${series.map((s) => bracketSeriesCell(s, true)).join('')}
    </div>`).join('');
  const nextCol = (nextMatchups && nextMatchups.length)
    ? `<div class="bracket-col"><div class="bracket-round">Next</div>${nextMatchups.map((s) => bracketSeriesCell(s, false)).join('')}</div>`
    : '';
  return `<div class="bracket-grid">${cols}${nextCol}</div>`;
}

function renderMatchups(matchups, round) {
  $('playoffs-body').innerHTML = `
    <h3>Round ${round}</h3>
    <div class="bracket">${matchups.map((m) => `
      <div class="series${m.a.isUser || m.b.isUser ? ' user' : ''}">
        <div class="series-teams">
          <details><summary>${m.a.isUser ? '<span class="user-team">★ ' + m.a.name + '</span> (you)' : m.a.name}</summary><div class="roster">${m.a.roster.map(rosterLine).join('<br>')}</div></details>
          <span class="vs">vs</span>
          <details><summary>${m.b.isUser ? '<span class="user-team">★ ' + m.b.name + '</span> (you)' : m.b.name}</summary><div class="roster">${m.b.roster.map(rosterLine).join('<br>')}</div></details>
        </div>
      </div>`).join('')}</div>
    <button id="simulate-round" class="primary">Simulate Round ${round}</button>`;

  $('simulate-round').addEventListener('click', async () => {
    const j = await api('/api/playoffs/round', { method: 'POST' });
    renderRoundResults(j);
  });
}

function renderRoundResults(j) {
  const statTable = (stats) => `
    <div class="table-scroll"><table><thead><tr><th>Player</th><th>Pos</th><th class="num">PTS</th><th class="num">TRB</th><th class="num">AST</th><th class="num">STL</th><th class="num">BLK</th><th class="num">EPM</th></tr></thead>
    <tbody>${stats.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}</td><td>${p.position}</td><td class="num">${fmt(p.pts)}</td><td class="num">${fmt(p.trb)}</td><td class="num">${fmt(p.ast)}</td><td class="num">${fmt(p.stl)}</td><td class="num">${fmt(p.blk)}</td><td class="num">${fmt(p.epm)}</td></tr>`).join('')}</tbody></table></div>`;

  const resultsHtml = j.results.map((s) => `
    <div class="series${s.isUserSeries ? ' user' : ''}">
      <div class="series-head"><span class="win">${s.winner}</span> def. ${s.loser} <strong>${s.wins}</strong>${s.userIsWinner ? ' <span class="good">— YOU WON</span>' : (s.isUserSeries ? ' <span class="bad">— you lost</span>' : '')}</div>
      ${s.mvp ? `<div class="mvp-line">🏅 MVP: ${s.mvp}</div>` : ''}
      <div class="games">${s.games.map((g) => `G${g.g}: ${g.aScore}-${g.bScore}`).join(' · ')}</div>
      <details class="roster-details"><summary>Team rosters (10 each)</summary>
        <div class="roster-team">${s.aName}${s.winner === s.aName ? ' 🏆' : ''}<br>${s.aRoster.map(rosterLine).join('<br>')}</div>
        <div class="roster-team">${s.bName}${s.winner === s.bName ? ' 🏆' : ''}<br>${s.bRoster.map(rosterLine).join('<br>')}</div>
      </details>
      ${s.aStats && s.bStats ? `
        <details class="roster-details"><summary>Player averages (series)</summary>
          <div class="roster-team"><b>${s.aName}</b>${statTable(s.aStats)}</div>
          <div class="roster-team"><b>${s.bName}</b>${statTable(s.bStats)}</div>
        </details>` : ''}
    </div>`).join('');

  let html = `<h3>Playoff Bracket</h3>${renderBracket(j.rounds, j.nextMatchups)}<h3>Round ${j.round} Results</h3><div class="bracket">${resultsHtml}</div>`;

  if (j.champion) {
    const isUserChamp = j.results[0]?.winnerIsUser;
    html += `<div class="result-banner">${isUserChamp ? '🏆 You won the championship!' : `🏆 ${j.champion} won the championship`}</div>`;
    html += `<button id="to-result" class="primary">See Result</button>`;
  } else {
    if (j.userEliminated) {
      html += `<p class="muted eliminated-note">You were eliminated in round ${j.userEliminatedRound}. The playoffs continue without you.</p>`;
    }
    html += `<button id="next-round" class="primary">Simulate Round ${j.nextRound}</button>`;
  }

  $('playoffs-body').innerHTML = html;

  $('next-round')?.addEventListener('click', async () => {
    const r = await api('/api/playoffs/round', { method: 'POST' });
    renderRoundResults(r);
  });
  $('to-result')?.addEventListener('click', () => showResult(j));
}

function showResult() {
  show('result');
  $('result-body').innerHTML = '<p class="muted">Loading…</p>';
  api('/api/result').then((r) => {
    const champ = r.playoff ? r.playoff.champion : null;
    const eliminated = r.playoff ? r.playoff.userEliminated : false;
    const isUserChamp = !!champ && !eliminated;
    const banner = isUserChamp ? '🏆 CHAMPIONS!' : (eliminated ? `Eliminated in round ${r.playoff.userEliminatedRound}` : `${champ} won the championship`);
    const sub = isUserChamp ? `${r.teamName} won the NBA Finals. Dynasty material.` : (eliminated ? 'Your run ended. Rebuild and try again.' : `${champ} are the champions.`);
    const record = r.season ? `${r.season.wins}-${r.season.losses}` : '';
    const myAwards = [];
    if (r.awards) {
      for (const [label, key] of [['MVP', 'mvp'], ['DPOY', 'dpoy'], ['Sixth Man', 'sixMan']]) {
        const a = r.awards[key];
        if (a && a.isUser) myAwards.push(`${label}: ${a.player}`);
      }
      for (const a of (r.awards.firstTeam || [])) if (a && a.isUser) myAwards.push(`All-NBA: ${a.player}`);
    }
    const starters = r.roster.filter((p) => p.role === 'starter');
    const bench = r.roster.filter((p) => p.role !== 'starter');
    const top = (r.seasonAverages || []).slice().sort((a, b) => b.pts - a.pts).slice(0, 5);
    const leaderOf = (key) => (r.seasonAverages || []).slice().sort((a, b) => b[key] - a[key])[0];

    $('result-body').innerHTML = `
      <div class="result-banner">${banner}</div>
      <p class="muted">${sub}</p>
      <div class="result-stats">
        <div class="rs"><span class="rs-v">${record}</span><span class="rs-k">Regular season</span></div>
        ${myAwards.length ? `<div class="rs"><span class="rs-v">${myAwards.length}</span><span class="rs-k">Awards won</span></div>` : ''}
      </div>
      ${myAwards.length ? `<div class="result-awards">${myAwards.map((a) => `<span class="chip">${a}</span>`).join('')}</div>` : ''}
      <div class="result-roster">
        <div><b>Starters</b><div class="chip-list">${starters.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span>${isBlind() ? '' : ` <span class="muted">${p.overall}</span>`}</span>`).join('')}</div></div>
        <div><b>Bench</b><div class="chip-list">${bench.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span>${isBlind() ? '' : ` <span class="muted">${p.overall}</span>`}</span>`).join('')}</div></div>
      </div>
      ${top.length ? `<div class="result-top"><b>Top scorers</b><div class="chip-list">${top.map((p) => `<span class="chip">${p.name} <span class="muted">${fmt(p.pts)} pts</span></span>`).join('')}</div></div>` : ''}
      ${(r.seasonAverages || []).length ? `<div class="result-leaders"><b>Team leaders</b><div class="chip-list">${
        [['pts', 'PTS'], ['trb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK']].map(([k, label]) => {
          const l = leaderOf(k);
          return l ? `<span class="chip">${label}: ${l.name} <span class="muted">${fmt(l[k])}</span></span>` : '';
        }).join('')
      }</div></div>` : ''}
      <div class="row" style="justify-content:center; margin-top:20px">
        <button id="back-home-final" class="primary">Back to Home</button>
      </div>`;
    $('back-home-final').addEventListener('click', () => { goHome(); });
  });
}

async function renderDraftRoster() {
  const { roster } = await api('/api/roster');
  state.roster = roster;
  const box = $('draft-roster');
  if (!roster.length) { box.innerHTML = '<span class="muted">No players drafted yet.</span>'; return; }
  const blind = isBlind();
  const posCount = {};
  for (const p of roster) posCount[p.position] = (posCount[p.position] || 0) + 1;
  const needs = ['PG', 'SG', 'SF', 'PF', 'C'].filter((p) => !posCount[p]);
  const strength = computeStrength(roster, [], true);
  box.innerHTML = `
    <div class="roster-head">Your roster <span class="muted">(${roster.length}/10)</span>
      ${blind ? '' : `<span class="strength-inline">· 💪 ${strength.toFixed(1)}</span>`}
      ${blind ? '' : (needs.length ? `<span class="needs">· Need: ${needs.map((n) => `<b>${n}</b>`).join(' ')}</span>` : '<span class="good">· Positions covered ✓</span>')}
      ${state.hardMode ? `<span class="budget">· 💰 $${state.spent}M / $${state.budget}M spent</span>` : ''}
    </div>
    <div class="chip-list">${roster.map((p) => `<span class="chip">${p.name}${blind ? '' : ` <span class="pos">${p.position}</span> <span class="muted">${p.overall}</span>`}</span>`).join('')}</div>`;
}

// ---------- Matchup Simulator ----------
let matchupPlayers = [];

function buildMatchupTeam(box, prefix, defaultIds) {
  box.innerHTML = '';
  const selected = []; // player ids, in add order

  const title = document.createElement('h3');
  title.textContent = `Team ${prefix.toUpperCase()}`;
  box.appendChild(title);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search player name…';
  search.className = 'mm-search';
  box.appendChild(search);

  const results = document.createElement('div');
  results.className = 'mm-results';
  box.appendChild(results);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add selected';
  addBtn.className = 'ghost';
  box.appendChild(addBtn);

  const selectedBox = document.createElement('div');
  selectedBox.className = 'mm-selected';
  box.appendChild(selectedBox);

  const startersBox = document.createElement('div');
  startersBox.className = 'mm-starters';
  const starterSelects = [];
  for (const pos of POSITIONS) {
    const label = document.createElement('span');
    label.className = 'mm-pos-label';
    label.textContent = pos;
    startersBox.appendChild(label);
    const sel = document.createElement('select');
    sel.className = 'mm-starter';
    sel.dataset.pos = pos;
    startersBox.appendChild(sel);
    starterSelects.push(sel);
  }
  box.appendChild(startersBox);

  const renderResults = () => {
    const q = search.value.trim().toLowerCase();
    const matches = matchupPlayers
      .filter((p) => !selected.includes(p.id) && (!q || p.name.toLowerCase().includes(q)))
      .slice(0, 30);
    results.innerHTML = matches.length
      ? matches.map((p) => `<label class="mm-result"><input type="checkbox" value="${p.id}"><span>${p.name} <span class="pos">${p.position}${p.position2 ? '/' + p.position2 : ''}</span>${isBlind() ? '' : ` <span class="muted">OVR ${p.overall} · ${p.pts} pts</span>`}</span></label>`).join('')
      : '<span class="muted">No matching players.</span>';
  };

  const renderSelected = () => {
    selectedBox.innerHTML = `<div class="mm-count muted">${selected.length}/10 selected</div><div class="chip-list">${
      selected.map((id) => {
        const p = matchupPlayers.find((x) => x.id === id);
        return `<span class="chip mm-chip" data-id="${id}">${p.name} <span class="pos">${p.position}</span> <button class="chip-x" data-id="${id}">×</button></span>`;
      }).join('')
    }</div>`;
    selectedBox.querySelectorAll('.chip-x').forEach((b) => b.addEventListener('click', () => {
      const i = selected.indexOf(+b.dataset.id);
      if (i >= 0) selected.splice(i, 1);
      renderSelected(); renderResults(); renderStarters();
    }));
  };

  const renderStarters = () => {
    for (const sel of starterSelects) {
      const pos = sel.dataset.pos;
      const prev = sel.value;
      sel.innerHTML = '';
      for (const id of selected) {
        const p = matchupPlayers.find((x) => x.id === id);
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.position})`;
        sel.appendChild(opt);
      }
      if (selected.includes(+prev)) sel.value = prev;
      else {
        const nat = selected.find((id) => matchupPlayers.find((x) => x.id === id)?.position === pos);
        sel.value = nat != null ? nat : (selected.length ? selected[0] : '');
      }
    }
  };

  search.addEventListener('input', renderResults);
  addBtn.addEventListener('click', () => {
    for (const cb of results.querySelectorAll('input:checked')) {
      const id = +cb.value;
      if (selected.length < 10 && !selected.includes(id)) selected.push(id);
    }
    renderResults(); renderSelected(); renderStarters();
  });

  for (const id of defaultIds) if (selected.length < 10 && !selected.includes(id)) selected.push(id);
  renderResults(); renderSelected(); renderStarters();
}

async function initMatchup() {
  try {
    const { players } = await api('/api/players?sort=rating&order=desc');
    matchupPlayers = players;
    buildMatchupTeam($('mm-team-a'), 'a', players.slice(0, 10).map((p) => p.id));
    buildMatchupTeam($('mm-team-b'), 'b', players.slice(10, 20).map((p) => p.id));
  } catch (e) {
    console.error('initMatchup failed:', e);
    const panel = $('matchup-panel');
    if (panel) panel.insertAdjacentHTML('afterbegin', `<p class="muted">Failed to load players: ${e.message}</p>`);
  }
}

function readMatchupTeam(prefix) {
  const box = $(`mm-team-${prefix}`);
  const players = [...box.querySelectorAll('.mm-chip')].map((c) => +c.dataset.id);
  const starters = [...box.querySelectorAll('.mm-starter')].map((s) => ({ playerId: +s.value, slot: s.dataset.pos }));
  return { players, starters };
}

$('mm-simulate').addEventListener('click', async () => {
  const body = {
    teamA: readMatchupTeam('a'),
    teamB: readMatchupTeam('b'),
    mode: $('mm-mode').value,
    times: +$('mm-times').value,
  };
  $('mm-result').innerHTML = '<p class="muted">Simulating…</p>';
  try {
    const j = await api('/api/matchup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    renderMatchupResult(j);
  } catch (e) { $('mm-result').innerHTML = `<p class="muted">${e.message}</p>`; }
});

function renderMatchupResult(j) {
  const teamTable = (name, stats, wins, losses, avgScore) => `
    <div class="mm-team-result">
      <div class="mm-team-head"><b>${name}</b> <span class="muted">${wins}-${losses} · avg ${avgScore} pts</span></div>
      <div class="table-scroll"><table><thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th></tr></thead>
      <tbody>${stats.slice().sort((a, b) => b.pts - a.pts).map((s) => `<tr><td>${s.name}</td><td>${s.position}</td><td class="num">${fmt(s.pts)}</td><td class="num">${fmt(s.trb)}</td><td class="num">${fmt(s.ast)}</td><td class="num">${fmt(s.stl)}</td><td class="num">${fmt(s.blk)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('mm-result').innerHTML = `
    <h3 style="margin-top:20px">Matchup Result <span class="muted">(${j.times} games · ${j.mode} mode)</span></h3>
    <div class="mm-scoreline"><b>Team A</b> <span>${j.aWins}</span> — <span>${j.bWins}</span> <b>Team B</b></div>
    <div class="mm-result-grid">${teamTable('Team A', j.aStats, j.aWins, j.bWins, j.aAvgScore)}${teamTable('Team B', j.bStats, j.bWins, j.aWins, j.bAvgScore)}</div>`;
}

// ---------- init ----------
(async () => {
  // Register event listeners synchronously (before any async work), so they're
  // always available even if an initial fetch below fails.
  initSessionUI();
  $('library').querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.libSort === col) state.libDir = state.libDir === 'desc' ? 'asc' : 'desc';
      else { state.libSort = col; state.libDir = 'desc'; }
      loadLibrary();
    });
  });
  $('lib-pos').addEventListener('change', (e) => { state.libPos = e.target.value; loadLibrary(); });
  $('matchup-details').addEventListener('toggle', () => {
    if ($('matchup-details').open && !matchupPlayers.length) initMatchup();
  });

  // Load initial data (best-effort — a single failure shouldn't break the whole app).
  try { await loadNbaTeams(); } catch (e) { console.error('loadNbaTeams', e); }
  try { await loadLibrary(); } catch (e) { console.error('loadLibrary', e); }
  try { await loadCareer(); } catch (e) { console.error('loadCareer', e); }
  try { await loadSavedTeams(); } catch (e) { console.error('loadSavedTeams', e); }
  try { await loadTrophies(); } catch (e) { console.error('loadTrophies', e); }
  try { await loadResume(); } catch (e) { console.error('loadResume', e); }

  show('home');
})();
