// Per-request session context, shared by sim.js and server.js.
// Uses AsyncLocalStorage so every DB query can scope by the current session
// without threading a session id through every function call.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// The active session id (or 'default' when none, e.g. during seeding).
function currentSession() {
  return (als.getStore() || {}).session || 'default';
}

module.exports = { als, currentSession };
