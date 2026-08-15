import type { QueryResultRow } from 'pg';
import crypto from 'node:crypto';
import type { AuditRecord, AuditRepository } from '../interfaces/AuditRepository.js';
import type { DbClient } from '../../database/types.js';
import { getPool } from '../../database/pool.js';

interface AuditRow extends QueryResultRow {
  id: string;
  event_type: string;
  license_id: string | null;
  activation_id: string | null;
  request_id: string | null;
  device_id: string | null;
  metadata: Record<string, any>;
  created_at: Date | string;
}

function mapRowToAuditRecord(row: AuditRow): AuditRecord {
  const meta = row.metadata || {};
  return {
    id: row.id,
    timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    eventType: row.event_type,
    licenseCodeMasked: meta.licenseCodeMasked,
    licenseId: row.license_id || undefined,
    deviceId: row.device_id || undefined,
    requestId: row.request_id || undefined,
    success: Boolean(meta.success),
    statusCode: Number(meta.statusCode || 200),
    details: meta.details,
  };
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(private client?: DbClient) {}

  private get db(): DbClient {
    return this.client || getPool();
  }

  async append(record: Omit<AuditRecord, 'id' | 'timestamp'>): Promise<AuditRecord> {
    const id = `aud_${crypto.randomUUID()}`;
    const metadata = {
      success: record.success,
      statusCode: record.statusCode,
      licenseCodeMasked: record.licenseCodeMasked,
      details: record.details || {},
    };

    const query = `
      INSERT INTO audit_events (
        id, event_type, license_id, request_id, device_id, metadata, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *;
    `;

    const res = await this.db.query<AuditRow>(query, [
      id,
      record.eventType,
      record.licenseId || null,
      record.requestId || null,
      record.deviceId || null,
      JSON.stringify(metadata),
    ]);

    return mapRowToAuditRecord(res.rows[0]);
  }

  async findByCorrelationId(requestId: string): Promise<AuditRecord[]> {
    const query = 'SELECT * FROM audit_events WHERE request_id = $1 ORDER BY created_at ASC';
    const res = await this.db.query<AuditRow>(query, [requestId]);
    return res.rows.map(mapRowToAuditRecord);
  }
}
