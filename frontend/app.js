// Championship Run — frontend logic
const $ = (id) => document.getElementById(id);

const state = { mode: 'open', gameMode: 'normal', seasonNumber: 1, replacedTeam: null, conference: null, roster: [], libSort: 'overall', libDir: 'desc', libPos: '', playoffRound: 1, offseasonFlow: false };

// Blind mode hides ALL ability info (overall/EPM/rating/strength) and per-player
// salary (which encodes overall). Position is hidden during the draft but revealed
// from lineup onward (needed to assign slots); real per-game stats (pts/trb/ast)
// stay visible since they're observed performance. Budget (spent/total) stays visible
// — it's the player's own financial state, not scouting info.
const isBlind = () => state.mode === 'blind';

// ---------- Toast notifications (replaces alert) ----------
function toast(msg, type = 'info', duration = 3500) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, duration);
}

// ---------- Progress bar ----------
const PROGRESS_STEPS = ['draft', 'lineup', 'season', 'playoffs', 'result'];
function updateProgress(activeId) {
  const bar = $('progress-bar');
  const inGame = PROGRESS_STEPS.includes(activeId) || activeId === 'recap' || activeId === 'freeagency';
  bar.classList.toggle('active', inGame);
  if (!inGame) return;
  const effective = activeId === 'recap' || activeId === 'freeagency' ? 'draft' : activeId;
  const dots = bar.querySelectorAll('.progress-dot');
  const lines = bar.querySelectorAll('.progress-line');
  const idx = PROGRESS_STEPS.indexOf(effective);
  dots.forEach((dot, i) => {
    dot.classList.toggle('done', i < idx);
    dot.classList.toggle('active', i === idx);
  });
  lines.forEach((line, i) => line.classList.toggle('done', i < idx));
}

function show(id) {
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = true));
  $(id).hidden = false;
  updateProgress(id);
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
const growthBadge = (p) => (p.delta == null ? '' : (p.delta > 0 ? ` <span class="good">▲${p.delta}</span>` : p.delta < 0 ? ` <span class="bad">▼${Math.abs(p.delta)}</span>` : ''));

// ---------- Session ID (view / switch your save) ----------
function initSessionUI() {
  $('session-id').value = SESSION_ID;
  $('copy-session').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(SESSION_ID); $('session-msg').textContent = t('misc.sessionCopied'); }
    catch (e) { $('session-id').select(); $('session-msg').textContent = t('misc.copyFailed'); }
  });
  $('apply-session').addEventListener('click', () => {
    const v = ($('switch-session').value || '').trim().slice(0, 64);
    if (!v) { $('session-msg').textContent = t('misc.pasteFirst'); return; }
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
  const sq = ($('lib-search')?.value || '').trim();
  if (sq) q.set('q', sq);
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
  if (!teams.length) { box.innerHTML = `<span class="muted">${t('misc.noArchive')}</span>`; return; }
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
  const season = (t) => (t.season_number > 0 ? ` <span class="muted">· S${t.season_number}</span>` : '');
  const teamItem = (t) => `<div class="trophy-item">${t.team_name}${season(t)}</div>`;
  const playerItem = (t) => `<div class="trophy-item">${t.player_name} <span class="muted">(${t.team_name})</span>${season(t)}</div>`;
  box.innerHTML =
    group('🏆 ' + t('trophy.champion'), trophies.filter((t) => t.type === 'championship'), teamItem) +
    group('🏆 ' + t('trophy.eastChamp'), trophies.filter((t) => t.type === 'east_champion'), teamItem) +
    group('🏆 ' + t('trophy.westChamp'), trophies.filter((t) => t.type === 'west_champion'), teamItem) +
    group('🏆 ' + t('trophy.mvp'), trophies.filter((t) => t.type === 'season_mvp'), playerItem) +
    group('🛡️ ' + t('trophy.dpoy'), trophies.filter((t) => t.type === 'dpoy'), playerItem) +
    group('🔥 ' + t('trophy.sixMan'), trophies.filter((t) => t.type === 'six_man'), playerItem) +
    group('🌟 ' + t('trophy.allNba'), trophies.filter((t) => t.type === 'all_nba'), playerItem) +
    group('🏅 ' + t('trophy.finalsMvp'), trophies.filter((t) => t.type === 'finals_mvp'), playerItem) +
    group('🏅 ' + t('trophy.eastMvp'), trophies.filter((t) => t.type === 'east_mvp'), playerItem) +
    group('🏅 ' + t('trophy.westMvp'), trophies.filter((t) => t.type === 'west_mvp'), playerItem);
}

async function loadHallOfFame() {
  try {
    const { legends } = await api('/api/halloffame');
    const box = $('hall-of-fame');
    if (!legends.length) { box.innerHTML = `<span class="muted">${t('misc.noHof')}</span>`; return; }
    box.innerHTML = `<div class="chip-list">${legends.map((l) => `<span class="chip">${l.name} <span class="pos">${l.position}</span> <span class="muted">(${l.team} · S${l.season})</span></span>`).join('')}</div>`;
  } catch (e) { /* best-effort */ }
}

async function loadCareer() {
  const c = await api('/api/career');
  $('career').innerHTML = c.runs
    ? `🏆 ${c.championships} championship${c.championships === 1 ? '' : 's'} · ${c.runs} run${c.runs === 1 ? '' : 's'} · ${c.totalWins} career wins · ${c.mvps} MVP${c.mvps === 1 ? '' : 's'}`
    : '<span class="muted">No history yet.</span>';
}

async function goHome() {
  show('home');
  // hide all expandable panels
  ['new-run-panel', 'library-panel', 'matchup-panel-wrap'].forEach((id) => { if ($(id)) $(id).hidden = true; });
  await loadCareer(); await loadSavedTeams(); await loadTrophies(); await loadHallOfFame(); await loadResume();
}

// Home card click handlers
$('new-run-card').addEventListener('click', () => {
  const panel = $('new-run-panel');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('lib-card').addEventListener('click', () => {
  const panel = $('library-panel');
  panel.hidden = false;
  loadLibrary();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('new-draft').addEventListener('click', async () => {
  const gameMode = document.querySelector('input[name=game-mode]:checked').value;
  state.mode = document.querySelector('input[name=mode]:checked').value;
  state.difficulty = document.querySelector('input[name=difficulty]:checked').value;
  await api('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: state.difficulty, mode: state.mode, gameMode }) });
  show('draft');
  await loadDraft();
});

// Dynasty mode forces hard (salary cap) + open (no blind): disable those toggles.
function syncModeNote() {
  const mode = document.querySelector('input[name=game-mode]:checked').value;
  const blindRadio = document.querySelector('input[name=mode][value=blind]');
  const normalDiff = document.querySelector('input[name=difficulty][value=normal]');
  if (mode === 'dynasty') {
    blindRadio.disabled = true;
    normalDiff.disabled = true;
    document.querySelector('input[name=mode][value=open]').checked = true;
    document.querySelector('input[name=difficulty][value=hard]').checked = true;
    $('mode-note').textContent = '王朝模式：强制工资帽、显示评分、最多10个赛季。可随时结束王朝。';
  } else {
    blindRadio.disabled = false;
    normalDiff.disabled = false;
    $('mode-note').textContent = '';
  }
}
document.querySelectorAll('input[name=game-mode]').forEach((r) => r.addEventListener('change', syncModeNote));

$('home-btn').addEventListener('click', () => { goHome(); });

// ---------- Continue last run ----------
async function loadResume() {
  try {
    const r = await api('/api/resume');
    if (!r || r.phase === 'none') { $('continue-panel').hidden = true; return; }
    state.difficulty = r.difficulty;
    state.mode = r.mode;
    state.gameMode = r.gameMode;
    state.seasonNumber = r.seasonNumber;
    $('continue-summary').textContent = resumeLabel(r);
    $('continue-panel').hidden = false;
  } catch (e) { /* resume is best-effort */ }
}

function resumeLabel(r) {
  const name = r.teamName || 'My Team';
  const season = r.seasonLabel ? ` · ${r.seasonLabel}` : '';
  // annual rookie draft (dynasty) is still phase 'draft' but with open picks
  const phase = r.phase === 'draft' && r.offseasonPicks > 0
    ? `Rookie draft (${r.offseasonPicks} pick${r.offseasonPicks > 1 ? 's' : ''} left)`
    : ({
        draft: `${t('resume.draft')} (${r.rosterCount}/${r.rosterSize})`,
        lineup: t('resume.lineup'),
        freeagency: t('resume.freeagency'),
        preseason: t('resume.preseason'),
        midseason: `${t('resume.midseason')} (${r.midseason ? r.midseason.wins + '-' + r.midseason.losses : '?'})`,
        season: t('resume.season'),
        playoffs: `${t('resume.playoffs')} (${r.playoffs ? r.playoffs.round : '?'})`,
        finished: t('resume.finished'),
      }[r.phase] || r.phase);
  return `${name}${season} · ${phase}`;
}

$('continue-run').addEventListener('click', async () => {
  try {
    const r = await api('/api/resume');
    state.mode = r.mode;
    state.difficulty = r.difficulty;
    state.hardMode = r.difficulty === 'hard';
    state.gameMode = r.gameMode;
    state.seasonNumber = r.seasonNumber;
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
  } catch (e) { toast(e.message, 'error'); }
});

function resumePlayoffs(p) {
  if (!p) return show('home');
  show('playoffs');
  const matchups = p.matchups.map((m) => `
    <div class="series${m.a.isUser || m.b.isUser ? ' user' : ''}">
      <div class="series-teams">
        <details><summary>${m.a.isUser ? `<span class="user-team">★ ${m.a.name}</span> (${t('misc.you')})` : m.a.name}</summary><div class="roster">${m.a.roster.map(rosterLine).join('<br>')}</div></details>
        <span class="vs">vs</span>
        <details><summary>${m.b.isUser ? `<span class="user-team">★ ${m.b.name}</span> (${t('misc.you')})` : m.b.name}</summary><div class="roster">${m.b.roster.map(rosterLine).join('<br>')}</div></details>
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
    $('save-msg').textContent = '存档已导出。';
  } catch (e) { $('save-msg').textContent = '导出失败：' + e.message; }
});

$('import-save-btn').addEventListener('click', () => $('import-save').click());
$('import-save').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    $('save-msg').textContent = '存档已恢复。' + (r.skipped && r.skipped.length ? ' 跳过（不在球员池中）：' + r.skipped.join(', ') : '');
    ev.target.value = '';
    await goHome();
  } catch (e) { $('save-msg').textContent = '导入失败：' + e.message; }
});

// ---------- Draft ----------
async function loadDraft() {
  const j = await api('/api/draft');
  $('reroll-count').textContent = j.rerolls;
  $('draft-progress').textContent = `${j.rosterCount} / ${j.rosterSize}`;
  // annual rookie draft (dynasty): full board + draft position + pick log, no re-roll
  $('reroll').hidden = j.offseason;
  if (j.offseason) {
    $('draft-title').firstChild.textContent = t('draft.rookieTitle') + ' ';
    const pos = j.userPosition ? `${t('draft.yourPick')} #${j.userPosition} · ` : '';
    const canPass = j.canPass ? ` · <button id="draft-pass" class="ghost" style="font-size:12px;padding:4px 10px">${t('draft.pass')}</button>` : '';
    $('draft-desc').innerHTML = `${pos}${t('draft.descRookie')}${canPass}`;
    if (j.canPass) {
      $('draft-pass')?.addEventListener('click', async () => {
        await api('/api/draft/pass', { method: 'POST' });
        state.offseasonFlow = false;
        show('freeagency');
        await loadFreeAgency();
      });
    }
    renderDraftPicks(j.picks);
  } else {
    $('draft-title').firstChild.textContent = t('draft.title') + ' ';
    $('draft-desc').textContent = t('draft.desc');
    $('draft-picks').hidden = true;
  }
  state.hardMode = j.hardMode;
  state.budget = j.budget;
  state.spent = j.spent;
  await renderDraftRoster();
  // rookie draft: roster may be full (auto-cut handles it), don't skip to lineup
  if (j.rosterCount >= j.rosterSize && !j.offseason) {
    show('lineup');
    await loadLineup();
    return;
  }
  renderCandidates(j.candidates);
}

function renderDraftPicks(picks) {
  const box = $('draft-picks');
  if (!picks || !picks.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<b>${t('draft.picksSoFar')}</b><div class="draft-picks-list">${picks.map((p) => `<span class="chip">${p.team} → ${p.player} <span class="muted">(${p.position} · OVR ${p.overall})</span></span>`).join('')}</div>`;
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
      <div class="stats">${t('lib.header.age')} ${c.age}</div>
      ${blind
        ? `<div class="stats">评分已隐藏（盲选模式）</div>`
        : `<div class="stats">OVR ${c.overall} · EPM ${c.epm} · <b class="rtg">Rtg ${c.rating}</b></div>
           <div class="stats">${c.pts} ${t('misc.pts')} · ${c.trb} ${t('misc.reb')} · ${c.ast} ${t('misc.ast')}</div>`}
      ${need ? `<div class="need-badge">${t('draft.need')} ${c.position}</div>` : ''}
      ${!blind && state.hardMode ? `<div class="salary">💰 $${c.salary}M</div>` : ''}
      <button data-id="${c.id}">${t('draft.pick')}</button>`;
    card.querySelector('button').addEventListener('click', async () => {
      try {
        const r = await api('/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: +card.querySelector('button').dataset.id }) });
        if (r.error) {
          toast(r.error, 'error');
          if (r.error.includes('Roster full')) {
            toast(t('draft.rosterFull'), 'info');
          }
          return;
        }
        await loadDraft();
      } catch (e) { toast(e.message, 'error'); }
    });
    box.appendChild(card);
  }
}

$('reroll').addEventListener('click', async () => {
  const j = await api('/api/draft/reroll', { method: 'POST' });
  $('reroll-count').textContent = j.rerolls;
  renderCandidates(j.candidates);
});

// ---------- Offseason Free Agency ----------
async function loadFreeAgency() {
  const j = await api('/api/freeagency');
  // info bar: salary + needs
  const info = $('fa-info');
  const salPct = Math.round(j.salTotal / j.salCap * 100);
  const salColor = salPct > 90 ? 'var(--bad)' : salPct > 75 ? 'var(--gold)' : 'var(--good)';
  info.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <span><b>${t('fa.salary')}:</b> $${j.salTotal}M / $${j.salCap}M <span style="color:${salColor}">(${salPct}%)</span></span>
      <span><b>${t('fa.signings')}:</b> ${j.signed}/${j.signLimit}</span>
      ${j.needs && j.needs.length ? `<span><b>${t('fa.needs')}:</b> ${j.needs.map(p => `<span class="pos" style="margin-left:4px">${p}</span>`).join('')}</span>` : ''}
    </div>`;
  const btn = $('fa-refresh');
  btn.textContent = `${t('fa.refresh')} (${j.refreshes})`;
  btn.disabled = j.refreshes <= 0;
  btn.onclick = async () => {
    const r = await api('/api/fa/refresh', { method: 'POST' });
    if (r.error) { toast(r.error, 'error'); return; }
    btn.textContent = `${t('fa.refresh')} (${r.refreshes})`;
    btn.disabled = r.refreshes <= 0;
    renderFACandidates(r.candidates);
  };
  renderFARoster(j.roster);
  renderFACandidates(j.candidates);
}

function renderFARoster(roster) {
  const box = $('fa-roster');
  box.innerHTML = `<b>${t('result.starters')}</b> <span class="muted">(${roster.length}/10)</span>` +
    roster.map((p) => `
      <div class="fa-row">
        <span>${p.name} <span class="pos">${p.position}</span>${p.age != null ? ` <span class="muted">${p.age}岁</span>` : ''} <span class="muted">OVR ${p.overall}</span>${p.contract != null ? ` · <span class="muted">${p.contract}${t('fa.years')}</span>` : ''}</span>
        <button data-id="${p.id}" class="ghost">${t('fa.release')}</button>
      </div>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: +b.dataset.id }) });
      await loadFreeAgency();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

function renderFACandidates(candidates) {
  const box = $('fa-candidates');
  box.innerHTML = '';
  for (const c of candidates) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-top"><strong>${c.name}</strong><span class="pos">${c.position}${c.position2 ? '/' + c.position2 : ''}</span></div>
      <div class="stats">${t('lib.header.age')} ${c.age} · OVR ${c.overall} · EPM ${c.epm} · <b class="rtg">Rtg ${c.rating}</b></div>
      <div class="stats">${c.pts} ${t('misc.pts')} · ${c.trb} ${t('misc.reb')} · ${c.ast} ${t('misc.ast')}</div>
      <button data-id="${c.id}">${t('fa.sign')}</button>`;
    card.querySelector('button').addEventListener('click', async () => {
      try {
        const r = await api('/api/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: +card.querySelector('button').dataset.id }) });
        if (r.accepted === false) { toast(r.message, 'error'); return; }
        await loadFreeAgency();
      } catch (e) { toast(e.message, 'error'); }
    });
    box.appendChild(card);
  }
}

$('fa-done').addEventListener('click', async () => {
  try {
    await api('/api/freeagency/done', { method: 'POST' });
    await loadLineup();
    show('lineup');
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- Offseason Recap ----------
function renderRecap(recap) {
  const box = $('recap-body');
  if (!recap) { box.innerHTML = `<p class="muted">${t('recap.title')}</p>`; return; }
  const champ = recap.champion ? `<p><b>${t('recap.champion')}:</b> ${recap.champion}</p>` : '';
  const mvp = recap.mvp ? `<p><b>${t('recap.mvp')}:</b> ${recap.mvp.player} <span class="muted">(${recap.mvp.team})</span></p>` : '';
  const legends = recap.retiredLegends && recap.retiredLegends.length
    ? `<div class="panel"><b>${t('recap.retired')}:</b><div class="chip-list">${recap.retiredLegends.map((l) => `<span class="chip">${l.name} <span class="pos">${l.position}</span> <span class="muted">(${l.team})</span></span>`).join('')}</div></div>`
    : `<p class="muted">${t('recap.noRetirements')}</p>`;
  const refusals = recap.refused && recap.refused.length
    ? `<div class="panel" style="border-color:var(--bad)"><b>${t('recap.refused')}:</b><div class="chip-list">${recap.refused.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position || ''}</span> <span class="muted">(OVR ${p.overall})</span></span>`).join('')}</div><p class="muted" style="margin-top:6px">${t('recap.refusedDesc')}</p></div>`
    : '';
  const news = recap.news && recap.news.length
    ? `<div class="panel"><b>📰 ${t('recap.news')}</b><ul style="margin:8px 0 0 18px">${recap.news.map((n) => `<li style="margin-bottom:4px">${n}</li>`).join('')}</ul></div>`
    : '';
  box.innerHTML = champ + mvp + news + legends + refusals;
}

$('recap-continue').addEventListener('click', async () => {
  if (state.pendingOffseasonPicks > 0) {
    show('draft');
    await loadDraft();
  } else {
    show('freeagency');
    await loadFreeAgency();
  }
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
      opt.textContent = `${p.name} (${p.position}${p.position2 ? '/' + p.position2 : ''}, ${p.age}岁${blind ? '' : `, OVR ${p.overall}`})`;
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
    bench.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span><span class="muted"> ${p.age}yo</span>${blind ? '' : ` <span class="muted">${p.overall}</span>`}</span>`).join('')
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
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- Season ----------
$('simulate-season').addEventListener('click', async () => {
  if ($('simulate-season').disabled) return;
  $('simulate-season').disabled = true;
  $('simulate-season').textContent = t('misc.simulating');
  $('season-result').innerHTML = `<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line w-80"></div>`;
  try {
    const j = await api('/api/season/start', { method: 'POST' });
    renderMidSeason(j);
  } catch (e) {
    $('simulate-season').disabled = false;
    $('simulate-season').textContent = t('season.simulate');
    toast(e.message, 'error');
  }
});

function awardsHtml(awards) {
  if (!awards) return '';
  const items = [
    [t('season.mvp'), awards.mvp],
    [t('season.dpoy'), awards.dpoy],
    [t('season.sixthMan'), awards.sixMan],
  ];
  const card = (label, a) => (a ? `
      <div class="award${a.isUser ? ' me' : ''}">
        <span class="award-label">${label}</span>
        <span class="award-name">${a.player}</span>
        <span class="award-team muted">${a.team}${a.isUser ? ` (${t('misc.you')})` : ''}</span>
      </div>` : '');
  const firstTeam = (awards.firstTeam || []).filter(Boolean);
  const firstTeamHtml = firstTeam.length ? `
      <div class="award award-ft${firstTeam.some((a) => a.isUser) ? ' me' : ''}">
        <span class="award-label">${t('season.allNba')}</span>
        ${firstTeam.map((a) => `<div class="ft-item"><span class="ft-pos">${a.position}</span> <span class="award-name">${a.player}</span> <span class="award-team muted">${a.team}${a.isUser ? ` (${t('misc.you')})` : ''}</span></div>`).join('')}
      </div>` : '';
  return `
    <h3>${t('season.awards')}</h3>
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
      ${g.streak && Math.abs(g.streak) >= 3 ? `<span class="gl-streak ${g.streak > 0 ? 'hot' : 'cold'}" title="${Math.abs(g.streak)}${t('misc.games')} ${g.streak > 0 ? t('misc.good') : t('misc.bad')}">${g.streak > 0 ? '🔥' : '🥶'}${Math.abs(g.streak)}</span>` : ''}
      ${g.star ? `<span class="gl-star muted">⭐ ${g.star}</span>` : ''}
      ${g.milestone ? `<span class="gl-milestone">${g.milestone}</span>` : ''}
      ${g.injuries && g.injuries.length ? `<span class="gl-injury" title="${g.injuries.map(i => `${i.name} (${i.games} ${t('misc.games')})`).join(' · ')}">🚑 ${g.injuries.map(i => i.name.split(' ').pop()).join(', ')}</span>` : ''}
    </div>`).join('');
  return `
    <h3>${t('season.form')} <span class="muted">· ${streak}${t('misc.games')} ${lastWin ? t('misc.good') : t('misc.bad')} · ${wins}-${losses}</span></h3>
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
  panel.innerHTML = '<div class="skeleton skeleton-line w-80"></div><div class="skeleton skeleton-line w-60"></div><div class="skeleton skeleton-line w-80"></div>';
  api('/api/trade/pool').then(({ myRoster, aiPlayers, remainingPoints, leagueTradeLog }) => {
    tradePool = { myRoster, aiPlayers };
    const teams = [...new Set(aiPlayers.map((p) => p.team))];
    panel.innerHTML = `
      ${tradeNotice ? `<div class="trade-notice">${tradeNotice}</div>` : ''}
      <div class="trade-header muted">${remainingPoints} ${t('trade.pointsRemaining')} · ${t('trade.pointsThis')}</div>
      <div class="trade-help muted">${t('trade.rules')}</div>
      <div class="trade-tabs">
        <button class="trade-tab active" data-tab="propose">${t('trade.propose')}</button>
        <button class="trade-tab" data-tab="shop">${t('trade.shop')}</button>
        <button class="trade-tab" data-tab="incoming">${t('trade.incoming')}</button>
      </div>
      <div id="trade-propose"></div>
      <div id="trade-shop" hidden></div>
      <div id="trade-incoming" hidden></div>
      ${leagueTradeLog && leagueTradeLog.length ? `<details class="trade-log"><summary>${t('trade.leagueLog')} (${leagueTradeLog.length})</summary><div class="trade-log-list">${leagueTradeLog.map((x) => `<div>${x}</div>`).join('')}</div></details>` : ''}`;
    panel.querySelectorAll('.trade-tab').forEach((b) => b.addEventListener('click', () => {
      panel.querySelectorAll('.trade-tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ['propose', 'shop', 'incoming'].forEach((t) => { $('trade-' + t).hidden = t !== b.dataset.tab; });
      if (b.dataset.tab === 'incoming') renderIncoming();
    }));
    renderPropose(myRoster, aiPlayers, teams);
    renderShop(myRoster);
  }).catch((e) => {
    panel.innerHTML = `<p class="bad">${t('trade.rejected')}: ${e.message}</p>`;
  });
}

function renderPropose(myRoster, aiPlayers, teams) {
  const box = $('trade-propose');
  const myList = tradeChecklist(myRoster, t('trade.yourPlayers'));
  const teamSel = document.createElement('select');
  teamSel.innerHTML = teams.map((t) => `<option>${t}</option>`).join('');
  const aiList = document.createElement('div');
  aiList.className = 'trade-checkbox-list';
  const refreshAi = () => {
    const tm = teamSel.value;
    const blind = isBlind();
    aiList.innerHTML = `<label class="trade-label">${tm} ${t('trade.pickSame')}</label>` + aiPlayers.filter((p) => p.team === tm).map((p) => `<label class="trade-check"><input type="checkbox" value="${p.id}"><span>${p.name} <span class="pos">${p.position}</span>${blind ? '' : ` <span class="muted">${p.overall}</span>`}</span></label>`).join('');
  };
  teamSel.addEventListener('change', refreshAi);
  refreshAi();
  const msg = document.createElement('div');
  msg.className = 'muted trade-msg';
  const btn = document.createElement('button');
  btn.textContent = t('trade.proposeBtn');
  btn.className = 'primary';
  btn.addEventListener('click', () => {
    const myIds = myList.checked();
    const aiIds = [...aiList.querySelectorAll('input:checked')].map((c) => +c.value);
    if (!myIds.length || myIds.length !== aiIds.length) { msg.textContent = t('trade.needSame'); msg.className = 'bad trade-msg'; return; }
    doTrade(myIds, aiIds, msg);
  });
  box.innerHTML = '';
  box.append(myList, teamSel, aiList, btn, msg);
}

function renderShop(myRoster) {
  const box = $('trade-shop');
  const myList = tradeChecklist(myRoster, t('trade.pickPlayers'));
  const offersBox = document.createElement('div');
  const msg = document.createElement('div');
  msg.className = 'muted trade-msg';
  const btn = document.createElement('button');
  btn.textContent = t('trade.shopBtn');
  btn.className = 'primary';
  btn.addEventListener('click', async () => {
    const ids = myList.checked();
    if (!ids.length) { msg.textContent = t('trade.needSame'); msg.className = 'bad trade-msg'; return; }
    try {
      const j = await api('/api/trade/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myPlayerIds: ids }) });
      const blind = isBlind();
      offersBox.innerHTML = j.offers.length ? j.offers.map((o) => `
        <div class="trade-offer">
          <div class="trade-offer-head">${o.aiTeam} offers${blind ? '' : ` <span class="muted">(${o.aiTotal} OVR)</span>`}</div>
          <div class="muted">${o.aiPlayers.map((p) => `${p.name}${blind ? '' : ` (${p.overall})`}`).join(', ')}</div>
          <button class="accept" data-my="${JSON.stringify(ids)}" data-ai="${JSON.stringify(o.aiPlayers.map((p) => p.id))}">${t('trade.acceptBtn')}</button>
        </div>`).join('') : `<p class="muted">暂无报价。</p>`;
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
  box.innerHTML = `<p class="muted">${t('misc.loading')}</p>`;
  api('/api/trade/proposals').then(({ proposals }) => {
    const msg = document.createElement('div');
    msg.className = 'muted trade-msg';
    box.innerHTML = '';
    if (!proposals.length) { box.innerHTML = `<p class="muted">暂无收到报价。</p>`; return; }
    for (const p of proposals) {
      const div = document.createElement('div');
      div.className = 'trade-offer';
      const blind = isBlind();
      div.innerHTML = `
        <div class="trade-offer-head">${p.aiTeam} wants <span class="muted">${p.myPlayers.map((x) => `${x.name}${blind ? '' : ` (${x.overall})`}`).join(', ')}</span></div>
        <div class="muted">Offers ${p.aiPlayers.map((x) => `${x.name}${blind ? '' : ` (${x.overall})`}`).join(', ')}</div>
        <button class="accept">${t('trade.acceptBtn')}</button>`;
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
    <h3>${title === 'Eastern' ? t('standings.east') : t('standings.west')}</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th>${blind ? '' : '<th>Str</th>'}</tr></thead>
      <tbody>${teams.map((t, i) => `
        <tr${t.isUser ? ' class="me"' : ''}>
          <td>${i + 1}</td>
          <td>
            <details><summary>${t.name}${t.isUser ? ` (${t('misc.you')})` : ''}</summary>
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
    <h3>${t('season.firstHalf')} (${j.games} ${t('misc.games')})</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th><th>MVP</th><th>FG%</th><th>3P%</th><th>FT%</th></tr></thead>
      <tbody>${j.playerAverages.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}</td><td>${p.position}</td><td>${fmt(p.pts)}</td><td>${fmt(p.trb)}</td><td>${fmt(p.ast)}</td><td>${fmt(p.stl)}</td><td>${fmt(p.blk)}</td><td class="num">${p.mvp || 0}</td><td>${pct(p.fgPct)}</td><td>${pct(p.threePct)}</td><td>${pct(p.ftPct)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  const goalHtml = j.goal ? `<div class="midseason-banner" style="border-left:3px solid var(--gold)">🎯 <b>${t('season.goal')}:</b> ${j.goal.description}</div>` : '';
  $('season-result').innerHTML = `
    <div class="midseason-banner">🏀 ${t('season.midseason')} — <b>${j.wins}-${j.losses}</b> ${t('season.afterGames')} ${j.games} ${t('misc.games')}</div>
    ${goalHtml}
    <div class="midseason-help muted">${t('season.midseasonHelp')}</div>
    <div class="row" style="margin-top:8px">
      <button id="adjust-mid" class="ghost">🎯 ${t('season.adjustLineup')}</button>
      <button id="trade-mid" class="ghost">🔄 ${t('season.tradeWindow')}</button>
      <button id="finish-season" class="primary">▶ ${t('season.simulateSecond')}</button>
    </div>
    <div id="trade-panel" class="trade-panel" hidden></div>
    ${gameLogHtml(j.gameLog)}
    ${avgTable}
    ${standingsHtml(j.east, j.west)}`;
  $('adjust-mid')?.addEventListener('click', () => { show('lineup'); loadLineup(); });
  $('trade-mid')?.addEventListener('click', () => renderTradeUI());
  $('finish-season')?.addEventListener('click', async () => {
    if ($('finish-season').disabled) return;
    $('finish-season').disabled = true;
    $('finish-season').textContent = t('misc.simulating');
    $('season-result').innerHTML = `<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line w-80"></div>`;
    try {
      const j2 = await api('/api/season/finish', { method: 'POST' });
      state.midSeason = null;
      renderSeason(j2);
    } catch (e) {
      // recover: re-enable the button so the user can retry
      $('finish-season').disabled = false;
      $('finish-season').textContent = `▶ ${t('season.simulateSecond')}`;
      $('season-result').innerHTML = `<p class="bad">模拟失败: ${e.message}</p><p class="muted">请检查服务器日志,然后重试。</p>`;
      toast(e.message, 'error');
    }
  });
}

function renderSeason(j) {
  $('simulate-season').hidden = true;
  const blind = isBlind();
  const avgTable = `
    <h3>${t('season.averages')}</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th>${blind ? '' : '<th>EPM</th>'}<th>MVP</th><th>FG%</th><th>3P%</th><th>FT%</th></tr></thead>
      <tbody>${j.playerAverages.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}${halfBadge(p.half)}</td><td>${p.position}</td><td>${fmt(p.pts)}</td><td>${fmt(p.trb)}</td><td>${fmt(p.ast)}</td><td>${fmt(p.stl)}</td><td>${fmt(p.blk)}</td>${blind ? '' : `<td>${fmt(p.epm)}</td>`}<td class="num">${p.mvp || 0}</td><td>${pct(p.fgPct)}</td><td>${pct(p.threePct)}</td><td>${pct(p.ftPct)}</td></tr>`).join('')}</tbody>
    </table></div>`;

  const playoffBtn = j.madePlayoffs
    ? `<button id="go-playoffs" class="primary" style="margin-top:16px">${t('season.toPlayoffs')}</button>`
    : `<p class="muted" style="margin-top:16px">${t('season.missedPlayoffs')}</p>
       <div style="margin-top:12px;display:flex;gap:10px;justify-content:center">
         <button id="go-result-missed" class="primary">查看结果</button>
         <button id="go-home-missed" class="ghost">${t('season.backHome')}</button>
       </div>`;

  const goalResultHtml = j.goal && j.goalResult
    ? `<div class="midseason-banner" style="border-left:3px solid ${j.goalResult.met ? 'var(--good)' : 'var(--bad)'}">
        ${j.goalResult.met ? '✅' : '❌'} <b>${t('season.goal')}:</b> ${j.goal?.description || ''} — ${j.goalResult.reason}
      </div>`
    : j.goal && j.goal.phase === 'playoff'
      ? `<div class="midseason-banner" style="border-left:3px solid var(--gold)">
          🎯 <b>${t('season.goal')}:</b> ${j.goal.description} <span class="muted">（${t('season.goalDeferred')}）</span>
        </div>`
      : '';
  const eventsHtml = j.events && j.events.length ? `<div class="panel"><h3>📢 ${t('season.events')}</h3>${j.events.map(e => `<p>${e.text}</p>`).join('')}</div>` : '';

  $('season-result').innerHTML =
    (blind ? `<p class="muted">${j.teamName} (${j.conference})</p>` : `<p class="muted">${j.teamName} (${j.conference}) · League average strength: ${j.leagueAvg}</p>`) +
    goalResultHtml + eventsHtml +
    gameLogHtml(j.gameLog) +
    awardsHtml(j.awards) +
    standingsHtml(j.east, j.west) + avgTable + playoffBtn;

  $('go-playoffs')?.addEventListener('click', () => startPlayoffs());
  $('go-result-missed')?.addEventListener('click', () => showResult());
  $('go-home-missed')?.addEventListener('click', () => { goHome(); });
}

// ---------- Playoffs ----------
async function startPlayoffs() {
  show('playoffs');
  $('playoffs-body').innerHTML = `<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line w-80"></div>`;
  try {
    const j = await api('/api/playoffs/start', { method: 'POST' });
    state.playoffRound = j.round;
    renderMatchups(j.matchups, j.round);
  } catch (e) {
    $('playoffs-body').innerHTML = `<p class="bad">${e.message}</p><button id="back-home" class="ghost">${t('season.backHome')}</button>`;
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
    <h3>${t('playoffs.round')} ${round}</h3>
    <div class="panel" style="margin-bottom:12px">
      <b>🛡️ 防守策略</b>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <label class="inline"><input type="radio" name="defense" value="man" checked> 人盯人 (默认)</label>
        <label class="inline"><input type="radio" name="defense" value="zone"> 联防 (+1.5 vs三分大队)</label>
        <label class="inline"><input type="radio" name="defense" value="double"> 包夹核心 (+1.0 vs单核球队)</label>
      </div>
    </div>
    <div class="bracket">${matchups.map((m) => `
      <div class="series${m.a.isUser || m.b.isUser ? ' user' : ''}">
        <div class="series-teams">
          <details><summary>${m.a.isUser ? '<span class="user-team">★ ' + m.a.name + '</span> (${t("misc.you")})' : m.a.name}</summary><div class="roster">${m.a.roster.map(rosterLine).join('<br>')}</div></details>
          <span class="vs">vs</span>
          <details><summary>${m.b.isUser ? '<span class="user-team">★ ' + m.b.name + '</span> (${t("misc.you")})' : m.b.name}</summary><div class="roster">${m.b.roster.map(rosterLine).join('<br>')}</div></details>
        </div>
      </div>`).join('')}</div>
    <button id="simulate-round" class="primary">${t('playoffs.simulateRound')} ${round}</button>`;

  const btn = document.getElementById('simulate-round');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = t('misc.simulating');
      try {
        const strategy = document.querySelector('input[name="defense"]:checked')?.value || 'man';
        await api('/api/playoffs/strategy', { method: 'POST', body: { strategy } });
        const j = await api('/api/playoffs/round', { method: 'POST' });
        renderRoundResults(j);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = `${t('playoffs.simulateRound')} ${state.playoffRound || 1}`;
        toast(e.message, 'error');
      }
    });
  }
}

function renderRoundResults(j) {
  const statTable = (stats) => `
    <div class="table-scroll"><table><thead><tr><th>Player</th><th>Pos</th><th class="num">PTS</th><th class="num">TRB</th><th class="num">AST</th><th class="num">STL</th><th class="num">BLK</th><th class="num">EPM</th></tr></thead>
    <tbody>${stats.slice().sort((a, b) => b.pts - a.pts).map((p) => `<tr><td>${p.name}</td><td>${p.position}</td><td class="num">${fmt(p.pts)}</td><td class="num">${fmt(p.trb)}</td><td class="num">${fmt(p.ast)}</td><td class="num">${fmt(p.stl)}</td><td class="num">${fmt(p.blk)}</td><td class="num">${fmt(p.epm)}</td></tr>`).join('')}</tbody></table></div>`;

  const resultsHtml = j.results.map((s) => `
    <div class="series${s.isUserSeries ? ' user' : ''}">
      <div class="series-head"><span class="win">${s.winner}</span> ${t('playoffs.def')} ${s.loser} <strong>${s.wins}</strong>${s.userIsWinner ? ` <span class="good">— ${t('playoffs.youWon')}</span>` : (s.isUserSeries ? ` <span class="bad">— ${t('playoffs.youLost')}</span>` : '')}</div>
      ${s.mvp ? `<div class="mvp-line">${t('playoffs.mvp')}: ${s.mvp}</div>` : ''}
      <div class="games">${s.games.map((g) => `G${g.g}: ${g.aScore}-${g.bScore}`).join(' · ')}</div>
      <details class="roster-details"><summary>${t('playoffs.seriesRosters')}</summary>
        <div class="roster-team">${s.aName}${s.winner === s.aName ? ' 🏆' : ''}<br>${s.aRoster.map(rosterLine).join('<br>')}</div>
        <div class="roster-team">${s.bName}${s.winner === s.bName ? ' 🏆' : ''}<br>${s.bRoster.map(rosterLine).join('<br>')}</div>
      </details>
      ${s.aStats && s.bStats ? `
        <details class="roster-details"><summary>${t('playoffs.playerAverages')}</summary>
          <div class="roster-team"><b>${s.aName}</b>${statTable(s.aStats)}</div>
          <div class="roster-team"><b>${s.bName}</b>${statTable(s.bStats)}</div>
        </details>` : ''}
    </div>`).join('');

  let html = `<h3>${t('playoffs.bracket')}</h3>${renderBracket(j.rounds, j.nextMatchups)}<h3>${t('playoffs.round')} ${j.round} ${t('playoffs.roundResult')}</h3><div class="bracket">${resultsHtml}</div>`;

  if (j.champion) {
    const isUserChamp = j.results[0]?.winnerIsUser;
    html += `<div class="result-banner">${isUserChamp ? `🏆 ${t('playoffs.wonChampionship')}` : `🏆 ${j.champion} ${t('playoffs.wonChampionship')}`}</div>`;
    html += `<button id="to-result" class="primary">${t('playoffs.seeResult')}</button>`;
  } else {
    if (j.userEliminated) {
      html += `<p class="muted eliminated-note">${t('playoffs.eliminated')} ${j.userEliminatedRound} ${t('playoffs.eliminatedEnd')}</p>`;
    }
    html += `<button id="next-round" class="primary">${t('playoffs.simulateRound')} ${j.nextRound}</button>`;
  }

  $('playoffs-body').innerHTML = html;

  $('next-round')?.addEventListener('click', async () => {
    const btn = document.getElementById('next-round');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t('misc.simulating');
    try {
      const r = await api('/api/playoffs/round', { method: 'POST' });
      renderRoundResults(r);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = `${t('playoffs.simulateRound')} ${state.playoffRound + 1}`;
      toast(e.message, 'error');
    }
  });
  $('to-result')?.addEventListener('click', () => showResult(j));
}

function showResult() {
  show('result');
  $('result-body').innerHTML = '<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line w-80"></div><div class="skeleton skeleton-line w-60"></div>';
  api('/api/result').then((r) => {
    const champ = r.playoff ? r.playoff.champion : null;
    const eliminated = r.playoff ? r.playoff.userEliminated : false;
    const isUserChamp = !!champ && !eliminated;
    const banner = isUserChamp ? `🏆 ${t('result.champions')}` : (eliminated ? `${t('result.eliminated')} ${r.playoff.userEliminatedRound} ${t('result.eliminatedRound')}` : `${champ} ${t('result.otherChampOther')}`);
    const sub = isUserChamp ? `${r.teamName} ${t('result.wonTitle')} ${t('result.dynastyMaterial')}` : (eliminated ? t('result.rebuild') : `${champ} ${t('result.otherChampOther')}`);
    const record = r.season ? `${r.season.wins}-${r.season.losses}` : '';
    const myAwards = [];
    if (r.awards) {
      for (const [label, key] of [[t('season.mvp'), 'mvp'], [t('season.dpoy'), 'dpoy'], [t('season.sixthMan'), 'sixMan']]) {
        const a = r.awards[key];
        if (a && a.isUser) myAwards.push(`${label}: ${a.player}`);
      }
      for (const a of (r.awards.firstTeam || [])) if (a && a.isUser) myAwards.push(`${t('season.allNba')}: ${a.player}`);
    }
    const starters = r.roster.filter((p) => p.role === 'starter');
    const bench = r.roster.filter((p) => p.role !== 'starter');
    const top = (r.seasonAverages || []).slice().sort((a, b) => b.pts - a.pts).slice(0, 5);
    const leaderOf = (key) => (r.seasonAverages || []).slice().sort((a, b) => b[key] - a[key])[0];

    // dynasty progress + history
    const isDynasty = r.gameMode === 'dynasty';
    const seasonHeader = isDynasty ? `${r.seasonLabel} · ${r.seasonNumber}/${r.dynastyMax}` : `${r.seasonLabel} ${t('result.season') || 'Season'}`;
    const history = (r.seasonHistory || []);
    const historyHtml = history.length ? `
      <div class="dynasty-history">
        <h3>${t('result.dynastyHistory')}</h3>
        <div class="table-scroll"><table>
          <thead><tr><th>${t('history.season')}</th><th>${t('history.record')}</th><th>${t('history.champion')}</th><th>${t('history.mvp')}</th><th>${t('history.result')}</th></tr></thead>
          <tbody>${history.map((h) => `<tr>
            <td class="num">${h.seasonLabel || h.season}</td>
            <td>${h.wins}-${h.losses}</td>
            <td>${h.champion ? (h.userChampion ? `<b>${h.champion}</b> (${t('misc.you')})` : h.champion) : '—'}</td>
            <td>${h.mvp || '—'}</td>
            <td>${h.result === 'champion' ? t('history.championLabel') : h.result === 'missed_playoffs' ? t('history.missedPlayoffs') : h.result.startsWith('eliminated') ? `${t('history.eliminated')}${h.result.split('_r')[1]}` : t('history.playoffs')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : '';

    // next-season only for dynasty, and only before the cap; end-dynasty always available
    const canNext = isDynasty && r.seasonNumber < r.dynastyMax;
    const actions = `
      ${canNext ? `<button id="next-season" class="primary">▶ ${t('result.nextSeason')}</button>` : (isDynasty ? `<p class="muted">🏆 ${t('result.dynastyComplete')} ${r.dynastyMax} ${t('result.seasons')}</p>` : '')}
      ${isDynasty ? `<button id="end-dynasty" class="ghost">结束王朝</button>` : ''}
      <button id="print-summary" class="primary">🖨️ ${t('result.printSummary')}</button>
      <button id="back-home-final" class="ghost">${t('result.backHome')}</button>`;

    $('result-body').innerHTML = `
      <div class="result-banner">${banner}</div>
      <p class="muted">${sub}</p>
      <div class="result-stats">
        <div class="rs"><span class="rs-v">${record}</span><span class="rs-k">${seasonHeader}</span></div>
        ${isDynasty ? `<div class="rs"><span class="rs-v">${history.filter(h => h.result === 'champion').length}</span><span class="rs-k">${t('result.championships')}</span></div>` : ''}
        ${myAwards.length ? `<div class="rs"><span class="rs-v">${myAwards.length}</span><span class="rs-k">${t('result.awardsWon')}</span></div>` : ''}
      </div>
      ${myAwards.length ? `<div class="result-awards">${myAwards.map((a) => `<span class="chip">${a}</span>`).join('')}</div>` : ''}
      ${historyHtml}
      <div class="result-roster">
        <div><b>${t('result.starters')}</b><div class="chip-list">${starters.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span><span class="muted"> ${p.age}岁</span>${p.contract != null ? ` <span class="muted">· ${p.contract}${t('fa.years')}</span>` : ''}${isBlind() ? '' : ` <span class="muted">${p.overall}</span>`}${growthBadge(p)}</span>`).join('')}</div></div>
        <div><b>${t('result.bench')}</b><div class="chip-list">${bench.map((p) => `<span class="chip">${p.name} <span class="pos">${p.position}</span><span class="muted"> ${p.age}岁</span>${p.contract != null ? ` <span class="muted">· ${p.contract}${t('fa.years')}</span>` : ''}${isBlind() ? '' : ` <span class="muted">${p.overall}</span>`}${growthBadge(p)}</span>`).join('')}</div></div>
      </div>
      ${top.length ? `<div class="result-top"><b>${t('result.topScorers')}</b><div class="chip-list">${top.map((p) => `<span class="chip">${p.name} <span class="muted">${fmt(p.pts)} ${t('misc.pts')}</span></span>`).join('')}</div></div>` : ''}
      ${(r.seasonAverages || []).length ? `<div class="result-leaders"><b>${t('result.teamLeaders')}</b><div class="chip-list">${
        [['pts', 'PTS'], ['trb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK']].map(([k, label]) => {
          const l = leaderOf(k);
          return l ? `<span class="chip">${label}: ${l.name} <span class="muted">${fmt(l[k])}</span></span>` : '';
        }).join('')
      }</div></div>` : ''}
      <div class="row" style="justify-content:center; margin-top:20px">${actions}</div>`;

    $('next-season')?.addEventListener('click', async () => {
      try {
        const j = await api('/api/next-season', { method: 'POST' });
        state.midSeason = null;
        state.offseasonFlow = true;
        state.pendingOffseasonPicks = 1; // always 1 pick in annual draft
        renderRecap(j.seasonRecap);
        show('recap');
      } catch (e) { toast(e.message, 'error'); }
    });
    $('print-summary').addEventListener('click', () => printSummary(r));
    $('end-dynasty')?.addEventListener('click', async () => {
      if (confirm(t('result.endDynastyConfirm'))) {
        await api('/api/reset', { method: 'POST', body: { gameMode: 'normal' } });
        goHome();
      }
    });
    $('back-home-final').addEventListener('click', () => { goHome(); });
  });
}

// Build a self-contained printable HTML summary of the season (normal) or dynasty, and
// download it as a .html file the user can open/print/save as PDF.
function printSummary(r) {
  const isDynasty = r.gameMode === 'dynasty' || r.gameMode === 'short3' || r.gameMode === 'short5';
  const title = isDynasty ? `${r.teamName} — ${t('summary.dynasty')} (${r.seasonNumber}/${r.dynastyMax} · ${r.seasonLabel})` : `${r.teamName} — ${r.seasonLabel} ${t('summary.seasonSummary')}`;
  const history = r.seasonHistory || [];
  const historyRows = history.map((h) => `
    <tr><td>${h.seasonLabel || t('history.season') + ' ' + h.season}</td><td>${h.wins}-${h.losses}</td><td>${h.result === 'champion' ? t('history.championLabel') : h.result === 'missed_playoffs' ? t('history.missedPlayoffs') : h.result.startsWith('eliminated') ? `${t('history.eliminated')}${h.result.split('_r')[1]}` : t('history.playoffs')}</td></tr>`).join('');

  const awards = [];
  if (r.awards) {
    for (const [label, key] of [[t('season.mvp'), 'mvp'], [t('season.dpoy'), 'dpoy'], [t('season.sixthMan'), 'sixMan']]) {
      const a = r.awards[key];
      if (a && a.isUser) awards.push(`${label}: ${a.player}`);
    }
    for (const a of (r.awards.firstTeam || [])) if (a && a.isUser) awards.push(`${t('season.allNba')}: ${a.player}`);
  }
  const starters = (r.roster || []).filter((p) => p.role === 'starter');
  const bench = (r.roster || []).filter((p) => p.role !== 'starter');
  const rosterRow = (p) => `<tr><td>${p.role === 'starter' ? '★ ' : ''}${p.name}</td><td>${p.position}</td><td>${p.age}</td><td>${p.overall}</td></tr>`;
  const leaders = [['pts', 'PTS'], ['trb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK']].map(([k, label]) => {
    const l = (r.seasonAverages || []).slice().sort((a, b) => b[k] - a[k])[0];
    return l ? `<li>${label}: ${l.name} (${l[k]})</li>` : '';
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 40px auto; color: #111; line-height: 1.5; }
    h1 { font-size: 26px; border-bottom: 2px solid #333; padding-bottom: 8px; }
    h2 { font-size: 18px; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
    th { background: #f0f0f0; }
    .meta { color: #555; }
    ul { padding-left: 20px; }
    .footer { margin-top: 32px; font-size: 12px; color: #888; }
  </style></head><body>
    <h1>🏀 ${title}</h1>
    <p class="meta">${isDynasty ? `${t('summary.dynasty')} · ${history.filter(h => h.result === 'champion').length} ${t('summary.championships')}` : (r.season ? `${r.season.wins}-${r.season.losses}` : '')}</p>
    ${historyRows ? `<h2>${t('summary.seasonHistory')}</h2><table><thead><tr><th>${t('history.season')}</th><th>${t('history.record')}</th><th>${t('history.result')}</th></tr></thead><tbody>${historyRows}</tbody></table>` : ''}
    ${awards.length ? `<h2>${t('summary.awards')}</h2><ul>${awards.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}
    ${(r.roster || []).length ? `<h2>${t('summary.roster')}</h2><table><thead><tr><th>Player</th><th>Pos</th><th>Age</th><th>OVR</th></tr></thead><tbody>${[...starters, ...bench].map(rosterRow).join('')}</tbody></table>` : ''}
    ${leaders ? `<h2>${t('summary.teamLeaders')}</h2><ul>${leaders}</ul>` : ''}
    <p class="footer">冠军之路 · ${t('summary.generated')} ${new Date().toLocaleDateString()}</p>
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(r.teamName || 'team').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-summary.html`;
  a.click();
  URL.revokeObjectURL(url);
}

async function renderDraftRoster() {
  const { roster } = await api('/api/roster');
  state.roster = roster;
  const box = $('draft-roster');
  if (!roster.length) { box.innerHTML = `<span class="muted">${t('misc.savesNone')}</span>`; return; }
  const blind = isBlind();
  const posCount = {};
  for (const p of roster) posCount[p.position] = (posCount[p.position] || 0) + 1;
  const needs = ['PG', 'SG', 'SF', 'PF', 'C'].filter((p) => !posCount[p]);
  const strength = computeStrength(roster, [], true);
  box.innerHTML = `
    <div class="roster-head">${t('result.starters')} <span class="muted">(${roster.length}/10)</span>
      ${blind ? '' : `<span class="strength-inline">· 💪 ${strength.toFixed(1)}</span>`}
      ${blind ? '' : (needs.length ? `<span class="needs">· ${t('draft.need')}: ${needs.map((n) => `<b>${n}</b>`).join(' ')}</span>` : `<span class="good">· ✓</span>`)}
      ${state.hardMode ? `<span class="budget">· 💰 $${state.spent}M / $${state.budget}M</span>` : ''}
    </div>
    <div class="chip-list">${roster.map((p) => `<span class="chip">${p.name}${blind ? '' : ` <span class="pos">${p.position}</span> <span class="muted">${p.overall}</span>`}</span>`).join('')}</div>`;
}

// ---------- Matchup Simulator ----------
let matchupPlayers = [];

function buildMatchupTeam(box, prefix, defaultIds) {
  box.innerHTML = '';
  const selected = []; // player ids, in add order

  const title = document.createElement('h3');
  title.textContent = `${prefix.toUpperCase()} 队`;
  box.appendChild(title);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = '搜索球员名字…';
  search.className = 'mm-search';
  box.appendChild(search);

  const results = document.createElement('div');
  results.className = 'mm-results';
  box.appendChild(results);

  const addBtn = document.createElement('button');
  addBtn.textContent = '添加选中';
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
    if (panel) panel.insertAdjacentHTML('afterbegin', `<p class="muted">${t('misc.loading')} ${e.message}</p>`);
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
  $('mm-result').innerHTML = `<p class="muted">${t('misc.loading')}</p>`;
  try {
    const j = await api('/api/matchup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    renderMatchupResult(j);
  } catch (e) { $('mm-result').innerHTML = `<p class="muted">${e.message}</p>`; }
});

function renderMatchupResult(j) {
  const teamTable = (name, stats, wins, losses, avgScore) => `
    <div class="mm-team-result">
      <div class="mm-team-head"><b>${name}</b> <span class="muted">${wins}-${losses} · 场均 ${avgScore} ${t('misc.pts')}</span></div>
      <div class="table-scroll"><table><thead><tr><th>Player</th><th>Pos</th><th>PTS</th><th>TRB</th><th>AST</th><th>STL</th><th>BLK</th></tr></thead>
      <tbody>${stats.slice().sort((a, b) => b.pts - a.pts).map((s) => `<tr><td>${s.name}</td><td>${s.position}</td><td class="num">${fmt(s.pts)}</td><td class="num">${fmt(s.trb)}</td><td class="num">${fmt(s.ast)}</td><td class="num">${fmt(s.stl)}</td><td class="num">${fmt(s.blk)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('mm-result').innerHTML = `
    <h3 style="margin-top:20px">对战结果 <span class="muted">(${j.times} 场 · ${j.mode === 'playoff' ? '季后赛' : '常规赛'})</span></h3>
    <div class="mm-scoreline"><b>A队</b> <span>${j.aWins}</span> — <span>${j.bWins}</span> <b>B队</b></div>
    <div class="mm-result-grid">${teamTable('A队', j.aStats, j.aWins, j.bWins, j.aAvgScore)}${teamTable('B队', j.bStats, j.bWins, j.aWins, j.bAvgScore)}</div>`;
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
  // name search with debounce (avoid a request per keystroke)
  let searchTimer = null;
  $('lib-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadLibrary(), 250);
  });
  $('matchup-card').addEventListener('click', () => {
    const panel = $('matchup-panel-wrap');
    panel.hidden = false;
    if (!matchupPlayers.length) initMatchup();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Apply saved language preference
  applyI18n();
  document.getElementById('lang-btn').addEventListener('click', switchLang);

  // Load initial data (best-effort — a single failure shouldn't break the whole app).
  try { await loadNbaTeams(); } catch (e) { console.error('loadNbaTeams', e); }
  try { await loadLibrary(); } catch (e) { console.error('loadLibrary', e); }
  try { await loadCareer(); } catch (e) { console.error('loadCareer', e); }
  try { await loadSavedTeams(); } catch (e) { console.error('loadSavedTeams', e); }
  try { await loadTrophies(); } catch (e) { console.error('loadTrophies', e); }
  try { await loadResume(); } catch (e) { console.error('loadResume', e); }

  show('home');
})();
