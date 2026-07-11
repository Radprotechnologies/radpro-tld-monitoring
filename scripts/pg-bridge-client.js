#!/usr/bin/env node
'use strict';

const net = require('net');
const host = process.env.RADPRO_PG_BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.RADPRO_PG_BRIDGE_PORT || 39471);
const timeoutMs = Number(process.env.PG_BRIDGE_CLIENT_TIMEOUT_MS || 35000);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => connectWithRetry(Date.now()));

function connectWithRetry(startedAt) {
  const socket = net.createConnection({ host, port });
  let response = '';
  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs);
  socket.on('connect', () => socket.write(input.trim() + '\n'));
  socket.on('data', (chunk) => { response += chunk; });
  socket.on('end', () => {
    process.stdout.write(response.trim() || JSON.stringify({ ok: false, error: 'Empty PostgreSQL bridge response' }));
  });
  socket.on('timeout', () => {
    socket.destroy();
    process.stdout.write(JSON.stringify({ ok: false, error: 'PostgreSQL bridge request timed out' }));
  });
  socket.on('error', (error) => {
    socket.destroy();
    if (Date.now() - startedAt < 5000 && ['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) {
      return setTimeout(() => connectWithRetry(startedAt), 100);
    }
    process.stdout.write(JSON.stringify({ ok: false, error: `PostgreSQL bridge unavailable: ${error.message}` }));
  });
}
