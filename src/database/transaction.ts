import type { Pool, PoolClient } from 'pg';
import { getPool } from './pool.js';

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  existingClientOrPool?: PoolClient | Pool
): Promise<T> {
  let client: PoolClient;
  let isNewClient = false;

  if (existingClientOrPool && 'connect' in existingClientOrPool && typeof existingClientOrPool.connect === 'function' && !('release' in existingClientOrPool)) {
    // It's a Pool
    client = await (existingClientOrPool as Pool).connect();
    isNewClient = true;
  } else if (existingClientOrPool && 'release' in existingClientOrPool) {
    // It's an existing PoolClient
    client = existingClientOrPool as PoolClient;
    isNewClient = false;
  } else {
    // No client/pool passed, get global pool
    const pool = getPool();
    client = await pool.connect();
    isNewClient = true;
  }

  try {
    if (isNewClient) {
      await client.query('BEGIN');
    }
    const result = await callback(client);
    if (isNewClient) {
      await client.query('COMMIT');
    }
    return result;
  } catch (error) {
    if (isNewClient) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[Transaction Rollback Error]', rollbackErr);
      }
    }
    throw error;
  } finally {
    if (isNewClient) {
      client.release();
    }
  }
}
