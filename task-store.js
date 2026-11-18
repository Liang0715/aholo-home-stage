const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const hourMs = 60 * 60_000;
const limit = 5;

function openTaskStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      status INTEGER NOT NULL,
      c TEXT,
      m TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS generation_attempts (
      ip_hash TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS attempts_by_time ON generation_attempts(attempted_at);
    CREATE INDEX IF NOT EXISTS attempts_by_ip ON generation_attempts(ip_hash, attempted_at);
  `);

  const taskColumns = 'task_id AS taskId, version, created_at AS createdAt, finished_at AS finishedAt, status, c, m';
  const getTask = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE task_id = ?`);
  const getPending = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status < 3`);
  const addTask = db.prepare('INSERT OR IGNORE INTO tasks (task_id, version, created_at, status) VALUES (?, ?, ?, 0)');
  const updateTask = db.prepare(`
    UPDATE tasks SET status = ?, finished_at = ?, c = ?, m = ?
    WHERE task_id = ? AND status < 3
  `);
  const clearExpired = db.prepare('DELETE FROM generation_attempts WHERE attempted_at <= ?');
  const getAttempts = db.prepare('SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest FROM generation_attempts WHERE ip_hash = ?');
  const addAttempt = db.prepare('INSERT INTO generation_attempts (ip_hash, attempted_at) VALUES (?, ?)');

  return {
    get(id) {
      return getTask.get(id);
    },
    pending() {
      return getPending.all();
    },
    add(id, version, createdAt) {
      addTask.run(id, version, createdAt);
      return getTask.get(id);
    },
    setStatus(id, status, failure) {
      updateTask.run(status, status >= 3 ? Date.now() : null, failure?.c ?? null, failure?.message ?? null, id);
    },
    reserve(ip, now = Date.now()) {
      const hash = createHash('sha256').update(ip).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        clearExpired.run(now - hourMs);
        const { count, oldest } = getAttempts.get(hash);
        const retryAfter = count >= limit ? Math.max(1, Math.ceil((oldest + hourMs - now) / 1000)) : 0;
        if (!retryAfter) addAttempt.run(hash, now);
        db.exec('COMMIT');
        return retryAfter;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openTaskStore };
