-- Championship Run database schema

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position TEXT NOT NULL,       -- primary position: PG/SG/SF/PF/C
  position2 TEXT,               -- secondary position (may be null)
  age INTEGER NOT NULL,
  overall INTEGER NOT NULL,     -- 2K rating (primary ability reference)
  epm REAL NOT NULL DEFAULT 0,  -- total EPM (impact adjustment)
  oepm REAL NOT NULL DEFAULT 0,
  depm REAL NOT NULL DEFAULT 0,
  pts REAL NOT NULL,            -- per-game points (scoring share + display)
  trb REAL NOT NULL,
  ast REAL NOT NULL,
  stl REAL NOT NULL,
  blk REAL NOT NULL,
  mp REAL NOT NULL DEFAULT 0,   -- real per-game minutes (from mp.txt); 0 = estimate
  fg_pct REAL NOT NULL,
  three_pct REAL NOT NULL,
  ft_pct REAL NOT NULL
);

-- The current run's drafted roster (max 10), scoped per session
CREATE TABLE IF NOT EXISTS roster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT 'default',
  player_id INTEGER NOT NULL REFERENCES players(id),
  role TEXT NOT NULL DEFAULT 'bench',  -- 'starter' | 'bench'
  slot TEXT                            -- PG/SG/SF/PF/C for starters, NULL for bench
);

-- Persisted AI league rosters (29 teams x 10 players), scoped per session.
-- Built on dynasty season 1, then carried across seasons (players age, retire,
-- and are replaced by rookies) so the AI league develops alongside the player.
CREATE TABLE IF NOT EXISTS league_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT 'default',
  team_name TEXT NOT NULL,
  conf TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  role TEXT NOT NULL DEFAULT 'bench',
  slot TEXT
);

-- Saved teams (a named snapshot of a 10-man roster), scoped per session
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  results_json TEXT
);

CREATE TABLE IF NOT EXISTS team_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  role TEXT NOT NULL,
  slot TEXT
);

-- Trophy room, scoped per session
CREATE TABLE IF NOT EXISTS trophies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- 'championship' | 'east_mvp' | 'west_mvp' | 'finals_mvp'
  player_name TEXT,             -- for MVP awards
  team_name TEXT,
  season_number INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Current run state (key/value), scoped per session
CREATE TABLE IF NOT EXISTS state (
  session_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (session_id, key)
);
