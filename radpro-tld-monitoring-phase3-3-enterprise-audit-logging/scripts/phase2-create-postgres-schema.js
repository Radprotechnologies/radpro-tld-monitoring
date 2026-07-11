require('dotenv').config();
const {
  qIdent,
  sqliteTypeToPg,
  normalizeDefault,
  openSqlite,
  getSqliteTables,
  getColumns,
  createPgPool,
  resolveSqliteFile,
} = require('./pg-utils');

async function main() {
  const sqliteFile = resolveSqliteFile();
  const sqlite = openSqlite(sqliteFile);
  const pool = createPgPool();
  const client = await pool.connect();

  try {
    const tables = getSqliteTables(sqlite);
    console.log(`SQLite source: ${sqliteFile}`);
    console.log(`Creating PostgreSQL schema for ${tables.length} tables...`);

    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    for (const table of tables) {
      const cols = getColumns(sqlite, table);
      if (!cols.length) continue;
      const columnDefs = cols.map((col) => {
        const type = sqliteTypeToPg(col.type, col.pk);
        const pk = col.pk ? ' PRIMARY KEY' : '';
        const notNull = col.notnull && !col.pk ? ' NOT NULL' : '';
        const def = col.pk ? '' : normalizeDefault(col.dflt_value);
        return `${qIdent(col.name)} ${type}${pk}${notNull}${def}`;
      });
      const sql = `CREATE TABLE IF NOT EXISTS ${qIdent(table)} (\n  ${columnDefs.join(',\n  ')}\n)`;
      await client.query(sql);
      console.log(`✓ ${table}`);
    }

    // Create pragmatic indexes for tenant and common lookup fields where those columns exist.
    for (const table of tables) {
      const colNames = getColumns(sqlite, table).map(c => c.name);
      for (const col of ['organizationId', 'hospitalId', 'employeeId', 'quarter', 'username', 'tldNumber', 'createdAt']) {
        if (colNames.includes(col)) {
          const indexName = `idx_${table}_${col}`.replace(/[^a-zA-Z0-9_]/g, '_');
          await client.query(`CREATE INDEX IF NOT EXISTS ${qIdent(indexName)} ON ${qIdent(table)} (${qIdent(col)})`);
        }
      }
    }

    await client.query('COMMIT');
    console.log('PostgreSQL schema creation completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('PostgreSQL schema creation failed:', error.message || error);
  process.exit(1);
});
