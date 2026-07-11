#!/usr/bin/env node
'use strict';

const net = require('net');
const { Pool } = require('pg');

const host = process.env.RADPRO_PG_BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.RADPRO_PG_BRIDGE_PORT || 39471);
const parentPid = Number(process.env.RADPRO_PARENT_PID || 0);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for PostgreSQL mode');
  process.exit(1);
}

const sslDisabled = process.env.PGSSLMODE === 'disable' || process.env.PGSSL === 'false';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 15000),
  allowExitOnIdle: false
});

pool.on('error', (error) => {
  console.error('[pg-bridge] idle client error:', error.message);
});

function reply(socket, payload) {
  try { socket.end(JSON.stringify(payload) + '\n'); } catch (_) { socket.destroy(); }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.setTimeout(Number(process.env.PG_QUERY_TIMEOUT_MS || 30000));
  let buffer = '';

  socket.on('data', async (chunk) => {
    buffer += chunk;
    const idx = buffer.indexOf('\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx);
    buffer = '';
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      return reply(socket, { ok: false, error: `Invalid PostgreSQL bridge payload: ${error.message}` });
    }
    try {
      const result = await pool.query(payload.sql, payload.params || []);
      reply(socket, {
        ok: true,
        rows: result.rows || [],
        rowCount: result.rowCount || 0,
        fields: (result.fields || []).map((field) => field.name)
      });
    } catch (error) {
      reply(socket, {
        ok: false,
        error: error.message,
        code: error.code || '',
        sql: payload.sql
      });
    }
  });

  socket.on('timeout', () => reply(socket, { ok: false, error: 'PostgreSQL query timed out' }));
  socket.on('error', () => {});
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // An already-running bridge belonging to the same Render instance may exist briefly
    // during a restart. The client will use it, so this launcher can exit safely.
    process.exit(0);
  }
  console.error('[pg-bridge] server error:', error.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[pg-bridge] listening on ${host}:${port}`);
});

async function shutdown() {
  server.close(async () => {
    try { await pool.end(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (parentPid > 0) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch (_) { shutdown(); }
  }, 5000).unref();
}
