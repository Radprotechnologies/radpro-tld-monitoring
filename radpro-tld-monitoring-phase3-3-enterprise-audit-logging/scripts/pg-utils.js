const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error('Node.js 22.5+ is required for SQLite migration scripts.');
  process.exit(1);
}

function qIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function sqliteTypeToPg(type, pk) {
  const t = String(type || '').toUpperCase();
  if (pk && t.includes('INT')) return 'BIGINT';
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  return 'TEXT';
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return '';
  const v = String(value).trim();
  if (!v) return '';
  if (/^CURRENT_TIMESTAMP$/i.test(v)) return ' DEFAULT CURRENT_TIMESTAMP';
  if (/^-?\d+(\.\d+)?$/.test(v)) return ` DEFAULT ${v}`;
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return ` DEFAULT ${v}`;
  }
  // Avoid unsupported SQLite-specific expressions in generated PostgreSQL DDL.
  return '';
}

function openSqlite(dbFile) {
  if (!fs.existsSync(dbFile)) {
    throw new Error(`SQLite database not found: ${dbFile}`);
  }
  const db = new DatabaseSync(dbFile);
  return db;
}

function getSqliteTables(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name);
}

function getColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${qIdent(table)})`).all();
}

function createPgPool() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL migration.');
  }
  return new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: 4,
  });
}

function resolveSqliteFile() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return process.env.SQLITE_DB_FILE || process.env.DB_FILE || path.join(dataDir, 'radpro_tld.db');
}

module.exports = {
  qIdent,
  sqliteTypeToPg,
  normalizeDefault,
  openSqlite,
  getSqliteTables,
  getColumns,
  createPgPool,
  resolveSqliteFile,
};
