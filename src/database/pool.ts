import pg from 'pg';
import type { Pool, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool } = pg;

let poolInstance: Pool | null = null;

export function isPoolInitialized(): boolean {
  return poolInstance !== null;
}

export function getPool(connectionString?: string): Pool {
  if (poolInstance) {
    return poolInstance;
  }

  const connStr = connectionString || process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error('DATABASE_URL is not set. Cannot initialize PostgreSQL connection pool.');
  }

  poolInstance = new PgPool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  poolInstance.on('error', (err) => {
    // Log error securely without exposing DATABASE_URL or credentials
    console.error('[Database Pool Error]', err.message);
  });

  return poolInstance;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    const p = poolInstance;
    poolInstance = null;
    await p.end();
  }
}

export async function dbQuery<R extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<R>> {
  const pool = getPool();
  return pool.query<R>(text, params);
}
