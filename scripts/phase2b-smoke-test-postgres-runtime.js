require('dotenv').config();
const { createPostgresSyncBridge } = require('./pg-sync-bridge');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for PostgreSQL runtime smoke test.');
  process.exit(1);
}
const db = createPostgresSyncBridge();
try {
  db.exec(`CREATE TABLE IF NOT EXISTS phase2b_smoke_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare(`INSERT OR REPLACE INTO phase2b_smoke_test (id, value) VALUES (?, ?)`).run('ok', 'Phase 2B PostgreSQL runtime bridge is working');
  const row = db.prepare(`SELECT * FROM phase2b_smoke_test WHERE id=?`).get('ok');
  console.log(JSON.stringify({ ok: true, dbDriver: 'postgres', row }, null, 2));
} catch (e) {
  console.error('Phase 2B PostgreSQL runtime smoke test failed:', e.message);
  process.exit(1);
}
