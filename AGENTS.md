# Goal

This is a small local full-stack learning project: an NBA championship roster-building game ("Championship Run").

The user should understand how frontend, backend, database and APIs work together.

# Structure

- frontend/: browser UI
- backend/: Node.js / Express server
- database/: SQLite database and SQL files

# Tech Stack

- HTML
- CSS
- Vanilla JavaScript
- Node.js
- Express
- SQLite

# Development Rules

- Keep the architecture simple.
- Do not introduce React, Vue, Next.js, TypeScript, Docker or ORM.
- Keep frontend, backend and database clearly separated.
- Keep the UI and all data in English.
- Keep SQL visible.
- Prefer understandable code over production-level abstraction.
- Before introducing a new technology or dependency, explain why it is needed.

# Game Design (Championship Run)

## Data
- Core entity: player.
- Store full per-game stats from the base table.
- Profile display: name/position/age + MP, FG%, 3P%, 2P%, FT%, TRB, AST, STL, BLK, TOV, PF, PTS + OEPM/DEPM/EPM + 2K overall.
- Simulated-series display: only PTS, TRB, AST, STL, BLK, FG%, 3P%, FT%.
- Ability reference: 2K27 overall (primary) + EPM (adjustment). Per-game stats do NOT affect ability (display + scoring share only).
- Merge traded players into one row (keep the 2TM/3TM/4TM combined row). Ignore team.

## Roster
- 10 players per team.

## Saved teams
- After drafting + setting the lineup, the player can save the team (a named snapshot).
- Saved teams are for viewing history/reference only (record + season/playoff averages); they cannot be re-loaded to start a run.
- Stored in SQLite: teams (id, name) + team_players (team_id, player_id, role, slot).

## Draft
- Each round shows 5 random players; the player picks 1; repeat until 10 are filled.
- 5 re-roll chances per draft (discard the current 5 and draw a new 5).
- Each round guarantees position diversity: at least 4 of the 5 positions appear among the 5.
- The draft UI shows which positions the roster still needs (a soft hint, not a hard requirement).
- Draft mode chosen at "New Run": open (show full ratings/stats) or blind (show only name/position/age; ratings are hidden until the player is picked).
- The picked player is added to the roster and excluded from future rounds; the other 9 return to the pool.

## Difficulty (Hard Mode)
- Chosen at "New Run" (Normal / Hard).
- Hard mode adds a **salary cap**: each player costs `salary = (overall-55)^2 / 20` (min 1), and the team has a `$400M` budget. Picks that exceed the budget are rejected.
- The draft always guarantees an affordable candidate (reserving the pool's minimum salary per remaining pick), so you can never soft-lock.
- Hard mode can also give AI teams a strength bonus (`HARD_AI_BONUS`, currently `0` = off).

## Lineup & strength model
- Player manually picks 5 starters and assigns each to a position slot (PG/SG/SF/PF/C).
- The remaining 5 players are bench. Playing time is NOT fixed by role: minutes are ability-driven (see Formulas), so a high-ability bench player earns starter-like minutes — but bench players play at a reduced share (BENCH_MINUTES_RATIO = 0.75), so who you start vs bench does move team strength.
- Position mismatch discount (starter's natural position vs slot):
  - same position: 100%
  - 1 step off (e.g. PG->SG, SG->SF): 97.5%
  - 2 steps off (e.g. PG->SF, C->SF): 95%
  - 3+ steps off (e.g. PG->C): 90%
- The mismatch discount (min 90%) is smaller than the bench penalty (75%), so starting an out-of-position star is a real trade-off: a 1-step misfit (97.5%) beats benching them (75%), but a 3-step misfit may not.
- Strength = overall + EPM; per-game stats do not affect winning.

## League & teams
- 30 teams: 15 East + 15 West (real NBA team names).
- The player names their team and replaces one real team (this picks their conference).
- The other 29 teams are AI: auto-generated, with strengths uniformly spread from weak to strong.
- Each AI team has a generated 10-player roster (sampled from the pool, excluding the player's drafted players, position-balanced).
- The AI strength range is bounded by the player pool's actual talent (a 95-strength team needs enough ~95 players to exist); the exact range is calibrated from the data.

## Regular season
- 82 games per team, simulated game-by-game, without specific opponents (only win/loss + the player team's scoring).
- Win/loss randomness is larger than in the playoffs: a flatter win-probability curve (strength matters less per game) plus single-game variance.
- Output: all 30 records, the player team's 10-player 82-game averages, and full East/West standings.

## Playoffs
- Top 8 per conference by record; seeding 1v8, 4v5, 2v7, 3v6.
- 4 rounds (first round -> conference semis -> conference finals -> NBA finals), best-of-7 each.
- Opponents are the existing AI teams from the regular season (no per-round generation); the starting 5 is revealed.
- Simulate per-player per-game averages for each series; each game has a random factor.
- The full 16-team bracket is simulated (all 15 series, for outcomes), but detailed player stats are generated only for the player's own series; other series show only "X beat Y 4-2".

## Simulation engine
- Simulated game-by-game: each game's stats are integers; the season/series averages are computed from the games.
- Per game, each player draws an INDEPENDENT form factor f_i (0.5-1.5, centered 1.0, age-dependent variance; playoffs widen it 1.5x so individual stat lines swing more). There is no single team-wide form draw.
- Team form F = minutes-weighted average of the 10 f_i (an aggregate, NOT amplified in playoffs — so playoff upsets don't grow). A separate team-level "any given night" luck factor (±12%) applies to the REGULAR season only; playoffs are more deterministic.
- Opponent factor o = a deterministic team-level multiplier from opponent strength: a strong team suppresses everyone (o < 1), a weak team boosts everyone (o > 1). o is shared by all players, so it shifts the total score, not the distribution.
- Effective team strength = team strength x F; team output (score) = f(effective strength) x o.
- Regular season: win prob = logistic((eff_strength - league_avg) / scale_RS) with a flat curve; team score = f(eff_strength), no opponent.
- Playoffs: win prob = logistic((your_eff - opp_eff) / scale_PO) with a steeper curve; score margin = g(strength diff) + noise; the winner scores more (upsets stay close, blowouts are big).
- Points are allocated to the 10 players proportional to expectedPts(overall) x (real_pts/expectedPts)^usage_exp x f_i x position_factor, where expectedPts = 0.072*(overall-55)^1.60 is a power-law ability anchor fitted to the real data (so a 72-ovr fringe player ~7 ppg and a 98-ovr superstar ~30 ppg, keeping weak players from ballooning to 25+ ppg) and the usage ratio is a mild "usage tendency" correction. usage_exp = 0.4 regular season, 0.6 playoffs (stars carry more usage). No separate bench penalty. Rounded so the sum matches the team score. This separates team-level form (affects the total) from individual form (affects the distribution).
- Minutes and shots are a zero-sum resource: team score is bounded with diminishing returns, so a stacked roster compresses individual numbers.
- Counting stats (TRB/AST/STL/BLK) each sum to a realistic team total, then split among players proportional to their real per-game number; percentages (FG%/3P%/FT%) use small additive deltas.
- Team per-game score range: 90-140, concentrated in 105-125. Team counting-stat totals (main concentration, ~90%, soft Gaussian tails — NOT hard clamps): TRB 38-50, AST 22-32, STL 6-12, BLK 3-7. Only simulate/display PTS, TRB, AST, STL, BLK, FG%, 3P%, FT%.
- 实力值 (Rating) drives winning; real_PTS drives scoring share, so a defensive star (high EPM, low PTS) wins games without big stat lines.
- Simulated stats do not affect later rounds.

## Formulas (structure; coefficients calibrated once 2K data arrives)
- Player power rating (实力值) = 2K overall (primary) + EPM x 0.5 (adjustment), kept on a 0-99 scale. Per-game stats do NOT affect winning.
- Terminology: "Overall" = 2K rating; "Rating" = 实力值 (computed); "Strength" = team-level average.
- Minutes weight w_i = max(0, 实力值_i - 55) (ability-driven, not a fixed starter/bench split); minutes_i = 240 x w_i / sum(w_i). Bench players' minutes are scaled by BENCH_MINUTES_RATIO (0.75), so starters carry more weight.
- Team strength = sum(实力值_i x position_discount_i x w_i) / sum(w_i) (a minutes-weighted average).
- Per-game win probability = 1 / (1 + 10^((opponent - you)/scale)); the regular season uses a flatter curve (larger scale) than the playoffs.
- Team score = f(team strength), a curve with diminishing returns; range 90-140, concentrated 105-125; the winner scores more than the loser.

## UI flow
1. Home / New Run: name your team, pick which real team to replace (conference), choose blind/open draft.
2. Draft (10 rounds): 5 candidate cards + Re-roll (5 per run) + Pick; progress X/10.
3. Set Lineup: assign 5 starters to PG/SG/SF/PF/C slots; rest are bench.
4. Regular season: "Simulate season"; show East/West standings + your team's 82-game player averages.
5. Playoffs: bracket from standings; "Simulate" each round; show scores and both teams' series averages.
6. Result: champion, eliminated (round), or missed the playoffs, with roster recap.

## Data cleaning
- Normalize positions to PG/SG/SF/PF/C (EPM uses G/F/C, F-C, G-F, etc.).
- Match the three sources by player name (normalize diacritics: Doncic/Dončić, Sengun/Şengün).
- 2K data is the backbone (player pool); base stats and EPM are joined by name.

# Learning Goal

The user should understand the flow:

Browser
→ Frontend
→ HTTP API
→ Backend
→ SQL
→ Database
