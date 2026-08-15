import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { getPool } from './pool.js';
import { withTransaction } from './transaction.js';

export interface MigrationResult {
  version: string;
  name: string;
  status: 'applied' | 'skipped';
}

export async function runMigrations(customPool?: Pool, migrationsDir?: string): Promise<MigrationResult[]> {
  const pool = customPool || getPool();
  const dir = migrationsDir || path.join(process.cwd(), 'src', 'database', 'migrations');

  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  // Ensure schema_migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRes = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version ASC');
  const appliedVersions = new Set(appliedRes.rows.map((r) => r.version));

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const results: MigrationResult[] = [];

  for (const file of files) {
    const version = file.split('_')[0] || file;
    if (appliedVersions.has(version)) {
      results.push({ version, name: file, status: 'skipped' });
      continue;
    }

    const filePath = path.join(dir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())',
        [version, file]
      );
    }, pool);

    results.push({ version, name: file, status: 'applied' });
  }

  return results;
}
