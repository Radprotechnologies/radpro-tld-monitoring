require('dotenv').config();
const { Client } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 15000) });
(async () => { try { await client.connect(); const result = await client.query('SELECT current_database() AS database, current_user AS username, NOW() AS server_time'); console.log(JSON.stringify({ ok: true, driver: 'postgres', ...result.rows[0] }, null, 2)); } catch (error) { console.error('PostgreSQL health check failed:', error.message); process.exitCode = 1; } finally { await client.end().catch(() => {}); } })();
