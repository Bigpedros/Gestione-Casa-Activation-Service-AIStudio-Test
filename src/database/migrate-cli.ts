import { runMigrations } from './migrator.js';
import { closePool } from './pool.js';

async function main() {
  try {
    console.log('[Migration CLI] Starting database migrations...');
    const results = await runMigrations();
    for (const r of results) {
      console.log(`[Migration CLI] ${r.version} (${r.name}): ${r.status}`);
    }
    console.log('[Migration CLI] Migrations complete.');
  } catch (err) {
    console.error('[Migration CLI Error]', err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
