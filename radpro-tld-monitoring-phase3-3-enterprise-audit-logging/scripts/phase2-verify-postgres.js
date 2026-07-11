require('dotenv').config();
const {
  qIdent,
  openSqlite,
  getSqliteTables,
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
    console.log('Table row count verification');
    console.log('SQLite source:', sqliteFile);
    let mismatch = 0;
    for (const table of tables) {
      const sqliteCount = Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${qIdent(table)}`).get().n || 0);
      let pgCount = 0;
      try {
        const result = await client.query(`SELECT COUNT(*)::int AS n FROM ${qIdent(table)}`);
        pgCount = Number(result.rows[0].n || 0);
      } catch (error) {
        console.log(`✗ ${table}: PostgreSQL table missing or unreadable (${error.message})`);
        mismatch++;
        continue;
      }
      const ok = sqliteCount === pgCount ? '✓' : '✗';
      if (sqliteCount !== pgCount) mismatch++;
      console.log(`${ok} ${table}: SQLite=${sqliteCount} PostgreSQL=${pgCount}`);
    }
    if (mismatch) {
      console.error(`Verification completed with ${mismatch} mismatch(es).`);
      process.exit(2);
    }
    console.log('Verification passed: row counts match.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('PostgreSQL verification failed:', error.message || error);
  process.exit(1);
});
