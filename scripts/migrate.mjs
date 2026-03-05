import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) {
  console.error('DATABASE_URL is required for migrations.');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists tr_schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query('select version from tr_schema_migrations');
  return new Set(result.rows.map((row) => row.version));
}

async function getMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.startsWith('._'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function run() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = await getMigrationFiles();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip ${file} (already applied)`);
        continue;
      }

      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, 'utf8');

      console.log(`apply ${file}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into tr_schema_migrations (version) values ($1)',
          [file]
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    console.log('migrations complete');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('migration failed:', error.message);
  process.exit(1);
});
