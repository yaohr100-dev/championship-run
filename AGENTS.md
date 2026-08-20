# Goal

This is a small local full-stack learning project: an NBA championship roster-building game ("Championship Run" / 冠军之路).

The user should understand how frontend, backend, database and APIs work together.

# Structure

- frontend/: browser UI
- backend/: Node.js / Express server
- database/: SQLite database and SQL files
- DEPLOY.md: Railway deployment + persistence notes (separate doc)

Helper scripts (backend/ + root):
- backend/seed.js — rebuilds `players` from the source data files
- backend/import-mp.js — regenerates `database/mp.txt` from `mp_raw.txt`
- backend/merge-session.js — merges one session's archive/trophies into another
- reconcile.js — ad-hoc data-coverage report (2K vs EPM vs base stats)
- backend/test*.js — quick test scripts that exercise the sim engine

# Tech Stack

- HTML
- CSS
- Vanilla JavaScript
- Node.js (>= 23.4.0, uses `node:sqlite`'s `DatabaseSync`)
- Express 5
- SQLite

# Development Rules

- Keep the architecture simple.
- Do not introduce React, Vue, Next.js, TypeScript, Docker or ORM.
- Keep frontend, backend and database clearly separated.
- The UI is bilingual (English + 中文) via `frontend/lang.js`. Player names, team names, and position/stat abbreviations stay in English. Backend data (names, positions, stat keys) is English.
- Keep SQL visible.
- Prefer understandable code over production-level abstraction.
- Before introducing a new technology or dependency, explain why it is needed.

# Running

- Local: `cd backend && node server.js`, then open http://127.0.0.1:3000
- The server listens on a fixed port 3000 and serves the frontend statically (same origin, no CORS).
- The DB path resolves via `backend/db-path.js`: `DB_PATH` env var → `/data` volume (Railway) → local `database/app.db`.

# Data & persistence

- Everything lives in one SQLite file (`database/app.db`).
- Schema in `database/init.sql`: `players`, `roster`, `league_teams`, `teams`, `team_players`, `trophies`, `state`.
- **Sessions**: every table (except `players`) is scoped by `session_id`. The frontend generates a random session id (stored in `localStorage`) and sends it as `?session=` on every request; the backend binds it via `AsyncLocalStorage` (`backend/session.js`) so a single DB serves multiple isolated saves. `players` is global (the seed), plus session-scoped generated rookies (`players.session_id`).
- **Seeding**: `ensureSeeded()` is idempotent — it only rebuilds `players` when the table is empty, and snapshots/restores user teams + roster by player NAME so a reseed survives shifting auto-increment ids. Missing-from-source players fall back to estimates from `overall`.
- **Backup / restore**: `/api/export` and `/api/import` move a save as JSON, referencing players by NAME. Exposed in the Home "Save & Backup" panel.

# Game Design (Championship Run)

## Game modes (chosen at "New Run")
- **Normal**: one season (2025-26).
- **Dynasty**: up to 10 seasons. Forces Hard difficulty + Open draft. Adds aging, retirement, an annual rookie draft, contracts, morale, chemistry, free agency, season goals, a Hall of Fame, and a dynasty history.

## Data
- Core entity: player.
- A player stores: name, primary + secondary position, age, 2K overall, OEPM/DEPM/EPM, per-game PTS/TRB/AST/STL/BLK, real MP, FG%/3P%/FT%.
- There is NO TOV, PF or 2P% — the sim only produces PTS/TRB/AST/STL/BLK + FG%/3P%/FT% (+ simulated EPM/DEPM).
- Ability reference: 2K overall (primary) + EPM (adjustment). Per-game stats do NOT affect ability (display + scoring share only).

## Roster
- 10 players per team.

## Saved teams
- After drafting + setting the lineup, the team is auto-saved as a named snapshot (`upsertCurrentTeam`, matched by exact roster so re-saving updates rather than duplicates).
- Saved teams are for viewing history/reference only; they cannot be re-loaded to start a run.
- Stored in SQLite: `teams` (id, name, results_json) + `team_players` (team_id, player_id, role, slot).

## Initial draft
- Each round shows 5 random players; the player picks 1; repeat until 10 are filled.
- 5 re-roll chances per draft.
- Each round guarantees position diversity: at least 4 of the 5 positions appear among the 5.
- The draft UI shows which positions the roster still needs (a soft hint).
- Draft mode chosen at "New Run": open (show full ratings/stats) or blind (show only name/age; ratings/position/EPM/salary hidden until picked). Dynasty forces open.
- The picked player is added to the roster and excluded from future rounds; the others return to the pool.

## Difficulty (Hard Mode)
- Chosen at "New Run" (Normal / Hard). Dynasty forces Hard.
- Hard mode adds a **salary cap**: `salary = max(1, round((rating-55)^2 / 20))` where `rating = overall + EPM*0.5`. Team budget is `$400M`. Picks that would exceed the budget (reserving the pool's minimum salary per remaining pick) are rejected.
- The draft always guarantees an affordable candidate, so you can never soft-lock.
- `HARD_AI_BONUS` gives AI teams a strength bonus (currently `0` = off).

## Lineup & strength model
- Player manually picks 5 starters and assigns each to a position slot (PG/SG/SF/PF/C).
- The remaining 5 players are bench. Playing time is ability-driven (sigmoid minutes, see Formulas), and bench players play at a reduced share (`BENCH_MINUTES_RATIO = 0.75`).
- Position mismatch discount (starter's natural position vs slot):
  - same position (or secondary position): 100%
  - 1 step off (e.g. PG->SG): 97.5%
  - 2 steps off (e.g. PG->SF): 95%
  - 3+ steps off (e.g. PG->C): 90%
- The mismatch discount (min 90%) is smaller than the bench penalty (75%), so starting an out-of-position star is a real trade-off.
- Strength (球队实力) = overall + EPM; per-game stats do not affect winning.

## League & teams
- 30 teams: 15 East + 15 West (real NBA team names).
- The player names their team and replaces one real team (this picks their conference).
- The other 29 teams are AI: auto-generated from the player pool, exclusive rosters, position-balanced, with a hard-coded strength spread of ~74–86 (strongest teams draft the best players first).
- AI team generation is weighted toward a target strength (`weightedSampleByRating`, `AI_TEAM_BAND = 8`).
- In dynasty mode the AI league persists in `league_teams` and develops across seasons (aging, retirement, rookie draft, AI offseason trades).

## Regular season
- 82 games per team, split into two 41-game halves (so the mid-season trade window sits between them).
- Head-to-head against specific opponents with a real schedule: a double round-robin (29×2) plus 12 extra intra-conference home-and-homes. Home/away matters.
- Win probability uses a flatter curve (`SCALE_RS = 11`) plus single-game variance.
- Each game: home-court boost (`HOME_ADV = 1.5`), team-level "any given night" luck (±12%), momentum from streaks (±1%/game, capped ±6%), ~15% back-to-back fatigue (-3%), and injuries.
- Injuries: ~2.5% per game per player (age-weighted: veterans brittle, young/prime durable); a new injury lasts mostly 1 game, occasionally more (up to ~12).
- The user team gets a full game log (opponent, home/away, score, star of the game, milestones, injuries, streak).
- Output: all 30 records, the user team's 10-player 82-game averages, East/West standings, awards, and a season goal evaluation.

## Mid-season trade window
- After the first half, the player may adjust the lineup and/or make trades before simulating the second half.
- Trades are n-for-n (1–3 players). Each trade costs n "trade points"; `MAX_TRADE_POINTS = 3` per season.
- AI evaluates trades by total value (overall, with a mild age curve in dynasty): a trade that favours the player beyond `TRADE_ACCEPT_MARGIN` (3 OVR/player) is rejected; within the margin the acceptance probability scales with how fair it is.
- Three tabs: **Propose** (pick both sides), **Shop** (get up to 15 seeded offers for your players), **Incoming** (15 fixed AI proposals generated at season start).
- Accepting a trade also triggers league-wide AI-to-AI trades (`LEAGUE_TRADE_MULTIPLIER = 10` per point spent), logged in a "league trade log".

## Playoffs
- Top 8 per conference by record; seeding 1v8, 4v5, 2v7, 3v6.
- 4 rounds (first round → conference semis → conference finals → NBA finals), best-of-7 each.
- Opponents are the existing AI teams from the regular season (no per-round generation).
- 2-2-1-1-1 home court (better record hosts games 1,2,5,7).
- A defensive strategy is chosen each round (man / zone / double); both the user and AI get a small bonus, with the user's explicit strategy adding a small edge.
- The full 16-team bracket is simulated (all 15 series for outcomes); detailed player stats are generated only for the user's own series. Other series show winner/loser, series score, and per-game scores.
- Per-player per-game averages for each series, with a series MVP for each winner.
- Playoffs use a steeper win curve (`SCALE_PO = 8`), top-heavy minutes, and no "any given night" team luck (more deterministic), but per-player form variance is widened 1.5x so individual stat lines swing more.

## Awards (regular season)
- MVP, DPOY, Sixth Man, and All-NBA First Team, computed from simulated stats + team wins + simulated EPM/DEPM, weighted by games played (below ~29 games a player is ineligible).
- Only the user team's awards are added to the trophy room; AI awards are shown in the standings.

## Dynasty mode (multi-season)
- **Aging / development**: every player ages +1 per offseason. A per-player dev factor (0.70–1.30) is rolled once per run and scales growth (not decline). Effective overall = base overall + age curve, with elite players peaking higher and declining slower (`effectiveOverall`).
- **Retirement**: `retireAge(overall)` — 90+→40, 84+→39, 78+→38, 72+→37, 66+→36, else 34. Retirees with overall ≥85 are enshrined in the Hall of Fame.
- **Rookie draft**: 30 rookies generated every year; realistic overall distribution (15% franchise 80–86, 20% lottery 74–79, 25% first-round 68–73, 40% second-round 58–67). The user picks 1 (or passes); AI teams auto-pick by draft order. Draft order = lottery for the 14 non-playoff teams (weighted by record) + reverse playoff order.
- **Free agency** (offseason): release players and sign from a market of 15 candidates (3 refreshes, ≤3 signings), under a tighter `$450M` cap. Position-needs are hinted.
- **Contracts**: rookies 4 years, veterans 2–4, FA signings 1–2. Expired deals roll a re-sign willingness (base 12%, scaled by overall/morale/team record/age, clamped 3%–45%); a refusal makes the player a free agent.
- **Morale** (per player, -5..5): settled each offseason from role + team record (±0.5 OVR per point). **Chemistry** (+0.5 OVR per season together, capped +3) rewards continuity.
- **Season goal**: generated from team strength vs league (champion / conference finals / make playoffs / win N games); failure applies a -1 morale penalty.
- **AI offseason trades**: up to 5 balanced positional swaps between AI teams.
- **League news + dynasty history** are recorded each offseason.

## Simulation engine
- Simulated game-by-game: each game's stats are integers; season/series averages are computed from the games.
- Per game, each player draws an INDEPENDENT form factor f_i (0.5–1.5, centered 1.0, age-dependent variance; playoffs widen it 1.5x). No single team-wide form draw.
- Team form F = minutes-weighted average of the 10 f_i (an aggregate, NOT amplified in playoffs). A separate team-level "any given night" luck factor (±12%) applies to the REGULAR season only.
- Effective team strength = team strength × F; team score = f(effective strength) × opponent factor o (a strong opponent suppresses everyone, a weak one boosts everyone; o is shared by all players so it shifts the total, not the distribution).
- Points are allocated to the 10 players proportional to `expectedPts(overall) × (real_pts/expectedPts)^usage_exp × f_i × position_factor`, where `expectedPts = 0.04*(overall-55)^1.95` is a power-law ability anchor (relative, so weak players stay low) and the usage ratio is a mild "usage tendency" correction. `usage_exp = 0.5` regular season, `0.7` playoffs. Every player gets ≥1 point. Rounded so the sum matches the team score.
- Minutes are a zero-sum resource; counting stats (TRB/AST/STL/BLK) each sum to a realistic team total, then split among players proportional to their real per-game number scaled by simulated-vs-real minutes. Percentages use small additive deltas.
- 实力值 (Rating) drives winning; real_PTS drives scoring share, so a defensive star (high EPM, low PTS) wins games without big stat lines.
- Simulated stats do not affect later rounds.

## Formulas (calibrated constants in sim.js)
- Player rating (实力值) = 2K overall + EPM × 0.5, kept on a 0–99 scale.
- Terminology: "Overall" = 2K rating; "Rating" = 实力值 (computed); "Strength" = team-level average.
- Minutes weight is a sigmoid fitted to real MP: `w(rating) = MP_A + (MP_B - MP_A) / (1 + exp(-(rating - MP_MU)/s))` with `MP_A=7.5, MP_B=33.5, MP_MU=76.5`, `s=4` (regular) / `s=3` (playoffs, top-heavy). Bench minutes scaled by `BENCH_MINUTES_RATIO = 0.75`.
- Team strength = minutes-weighted average of (实力值 × position discount).
- Per-game win probability = `1 / (1 + 10^(-diff/scale))`; `scale = 11` (regular, flatter) or `8` (playoffs, steeper).
- Team score = `clamp(112 + (strength-80)*1.0 + gaussian*8, 90, 140)`; winner always scores more than the loser.
- Team counting-stat totals (Gaussian, ~90% concentration): TRB 44±3.9, AST 27±3.3, STL 9±1.5, BLK 5±0.8.
- Hard-mode salary = `max(1, round((rating-55)^2/20))`, `rating = overall + EPM*0.5`.

## UI flow
1. Home / New Run: pick game mode (normal/dynasty), name your team, pick which real team to replace (conference), choose blind/open draft + difficulty.
2. Draft (10 rounds): 5 candidate cards + Re-roll (5 per run) + Pick; progress X/10. (Dynasty forces open + hard.)
3. (Dynasty offseason only) Free Agency: release/sign, then continue.
4. Set Lineup: assign 5 starters to PG/SG/SF/PF/C slots; live team-strength readout.
5. Regular season: "Simulate season" → mid-season break (adjust lineup / trade window) → simulate 2nd half → full season results.
6. Playoffs: bracket; choose defensive strategy; simulate each round; series stats + MVP.
7. Result: champion / eliminated (round) / missed playoffs, roster recap, awards, dynasty history.
8. (Dynasty) Offseason recap → rookie draft → free agency → next season (up to 10).

Also on Home: Player Library (search/sort), Simulate Matchup (build two 10-man teams and simulate head-to-head), Trophy Room, Hall of Fame, Save & Backup.

## i18n
- `frontend/lang.js` holds an `LANG` map with `en` and `zh` keys; the UI toggles via a header button and persists the choice in `localStorage`.
- Player/team names, positions, and stat abbreviations stay English in both languages.

## Data cleaning
- Three sources joined by normalized player name (normalize diacritics: Doncic/Dončić, Sengun/Şengün):
  1. `2k27_players.txt` (tab-separated: name, "POS1 / POS2", overall) — the player pool (backbone).
  2. `epm.txt` (pipe: name, age, OEPM, DEPM, EPM) — rating adjustment + age.
  3. `base_stats*.txt` (pipe: name, age, pts, trb, ast, stl, blk, fg%, 3p%, ft%) — real per-game stats; split into stars / main / low files.
- `mp.txt` (name, mp) is generated from `mp_raw.txt` by `import-mp.js`; traded players' combined "2TM/3TM/4TM" row is authoritative.
- Positions come directly from the 2K file as primary/secondary (`parsePositions`); there is no G/F/C mapping in code.
- Players with no EPM entry (free agents / never played enough) and a small `DROP_PLAYERS` list of no-MP fringe players are excluded from the pool.

# Learning Goal

The user should understand the flow:

Browser
→ Frontend
→ HTTP API
→ Backend
→ SQL
→ Database
