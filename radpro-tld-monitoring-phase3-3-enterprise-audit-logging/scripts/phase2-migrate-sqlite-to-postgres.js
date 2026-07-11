require('dotenv').config();
const {
  qIdent,
  openSqlite,
  getSqliteTables,
  getColumns,
  createPgPool,
  resolveSqliteFile,
} = require('./pg-utils');

const BATCH_SIZE = Number(process.env.PG_MIGRATION_BATCH_SIZE || 200);

function getPkColumns(columns) {
  return columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

async function insertBatch(client, table, columns, rows) {
  if (!rows.length) return;
  const colNames = columns.map(c => c.name);
  const pkCols = getPkColumns(columns);
  const quotedCols = colNames.map(qIdent).join(', ');
  const values = [];
  const groups = [];
  rows.forEach((row, rowIndex) => {
    const placeholders = [];
    colNames.forEach((col, colIndex) => {
      values.push(row[col]);
      placeholders.push(`$${rowIndex * colNames.length + colIndex + 1}`);
    });
    groups.push(`(${placeholders.join(', ')})`);
  });

  let conflict = '';
  if (pkCols.length) {
    const conflictCols = pkCols.map(qIdent).join(', ');
    const updateCols = colNames.filter(c => !pkCols.includes(c));
    if (updateCols.length) {
      const update = updateCols.map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`).join(', ');
      conflict = ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${update}`;
    } else {
      conflict = ` ON CONFLICT (${conflictCols}) DO NOTHING`;
    }
  }

  const sql = `INSERT INTO ${qIdent(table)} (${quotedCols}) VALUES ${groups.join(', ')}${conflict}`;
  await client.query(sql, values);
}

async function main() {
  const sqliteFile = resolveSqliteFile();
  const sqlite = openSqlite(sqliteFile);
  const pool = createPgPool();
  const client = await pool.connect();

  try {
    const tables = getSqliteTables(sqlite);
    console.log(`SQLite source: ${sqliteFile}`);
    console.log(`Migrating ${tables.length} tables to PostgreSQL...`);

    await client.query('BEGIN');

    for (const table of tables) {
      const columns = getColumns(sqlite, table);
      if (!columns.length) continue;
      const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${qIdent(table)}`).get();
      const total = countRow ? Number(countRow.n || 0) : 0;
      if (!total) {
        console.log(`- ${table}: 0 rows`);
        continue;
      }
      let migrated = 0;
      for (let offset = 0; offset < total; offset += BATCH_SIZE) {
        const rows = sqlite.prepare(`SELECT * FROM ${qIdent(table)} LIMIT ? OFFSET ?`).all(BATCH_SIZE, offset);
        await insertBatch(client, table, columns, rows);
        migrated += rows.length;
      }
      console.log(`✓ ${table}: ${migrated}/${total} rows`);
    }

    await client.query('COMMIT');
    console.log('SQLite → PostgreSQL data migration completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('SQLite → PostgreSQL migration failed:', error.message || error);
  process.exit(1);
});
