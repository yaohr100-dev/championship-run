# Deployment & Persistence

Championship Run stores everything in a single SQLite file (`database/app.db`). On
Railway's free tier that file lives on an **ephemeral disk**, so it is wiped on every
redeploy / restart. To keep your saves (teams, trophies, career history) across
deploys, use one of the two options below.

## Option A — Railway persistent volume (recommended, automatic)

The server auto-detects a mounted `/data` volume and puts the database there
(`backend/db-path.js`), and seeds idempotently (it only rebuilds `players` when the
table is empty). So this is a zero-code, zero-env-var fix:

1. In the Railway dashboard, open your service → **Settings** → **Volumes**.
2. **Add Volume**: mount path `/data` (name it anything, e.g. `data`).
3. Redeploy.

The first deploy seeds `/data/app.db`; every deploy after that reuses the same file,
so your saves persist. (You can still override the location with a `DB_PATH` env var
if you ever want to point it elsewhere. Volumes are a paid feature on Railway's
current plans.)

## Option B — Back up / Restore (free, manual)

The app has a built-in **💾 Back up / Restore Save** panel on the Home page:

- **Export save (.json)** downloads your current session's roster, run state, saved
  teams, and trophies as a single JSON file.
- **Import save** restores that file (into whatever browser you're using), resolving
  players by name so it survives a reseed that shifts auto-increment ids.

Use this before a redeploy that would wipe the disk, or to move a save between
devices. It works on any host with no extra setup.

## Deploy notes

- The root `package.json` has `"start": "cd backend && node server.js"` — Railway
  auto-detects it via Nixpacks.
- Node `>=23.4.0` is required (`node:sqlite`'s `DatabaseSync`).
- The server listens on a fixed port `3000` (Railway's `PORT` target must match; the
  current deploy hard-codes it in `server.js`).
