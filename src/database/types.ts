import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface DatabaseConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface SqlQueryRunner {
  query<R extends QueryResultRow = any, I extends any[] = any[]>(
    text: string,
    params?: I
  ): Promise<QueryResult<R>>;
}

export type DbClient = Pool | PoolClient;

export interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
}
