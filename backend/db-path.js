// Where the SQLite database lives.
// 1. DB_PATH env var (explicit override).
// 2. A mounted /data volume (Railway) — used automatically when present, so no
//    env var is needed on deploy.
// 3. The bundled local database file (development).
//
// Kept in one place because seeding and the running server MUST resolve the same
// file, or a fresh deploy would seed one db and serve an empty one.
const fs = require('fs');
const path = require('path');

const VOLUME_DIR = '/data';

function dbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (fs.existsSync(VOLUME_DIR)) return path.join(VOLUME_DIR, 'app.db');
  return path.join(__dirname, '..', 'database', 'app.db');
}

module.exports = { dbPath, VOLUME_DIR };
