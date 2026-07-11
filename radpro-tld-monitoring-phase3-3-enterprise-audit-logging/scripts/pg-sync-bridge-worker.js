#!/usr/bin/env node
const { Client } = require('pg');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

(async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'Invalid worker payload: ' + e.message }));
    process.exit(0);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }) });
  try {
    await client.connect();
    const result = await client.query(payload.sql, payload.params || []);
    console.log(JSON.stringify({ ok: true, rows: result.rows || [], rowCount: result.rowCount || 0, fields: (result.fields || []).map(f => f.name) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message, code: e.code || '', sql: payload.sql }));
  } finally {
    try { await client.end(); } catch (_) {}
  }
})();
