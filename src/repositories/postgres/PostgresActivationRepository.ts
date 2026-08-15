import type { QueryResultRow } from 'pg';
import crypto from 'node:crypto';
import type { ActivationRecord, ActivationRepository } from '../interfaces/ActivationRepository.js';
import type { DbClient } from '../../database/types.js';
import { getPool } from '../../database/pool.js';

interface ActivationRow extends QueryResultRow {
  id: string;
  license_id: string;
  device_id: string;
  status: string;
  activated_at: Date | string;
  last_validated_at: Date | string | null;
  deactivated_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  license_code?: string;
}

function mapRowToActivationRecord(row: ActivationRow, defaultCode: string = ''): ActivationRecord {
  return {
    id: row.id,
    licenseId: row.license_id,
    licenseCode: row.license_code || defaultCode,
    deviceId: row.device_id,
    activatedAt: row.activated_at instanceof Date ? row.activated_at.toISOString() : String(row.activated_at),
    lastValidatedAt: row.last_validated_at ? (row.last_validated_at instanceof Date ? row.last_validated_at.toISOString() : String(row.last_validated_at)) : undefined,
    status: row.status as ActivationRecord['status'],
    deactivatedAt: row.deactivated_at ? (row.deactivated_at instanceof Date ? row.deactivated_at.toISOString() : String(row.deactivated_at)) : undefined,
  };
}

export class PostgresActivationRepository implements ActivationRepository {
  constructor(private client?: DbClient) {}

  private get db(): DbClient {
    return this.client || getPool();
  }

  async findActiveByLicenseAndDevice(licenseId: string, deviceId: string, options?: { forUpdate?: boolean }): Promise<ActivationRecord | null> {
    const query = options?.forUpdate
      ? `
      SELECT a.*, l.license_code
      FROM license_activations a
      JOIN licenses l ON l.id = a.license_id
      WHERE a.license_id = $1 AND a.device_id = $2 AND a.status = 'active'
      LIMIT 1 FOR UPDATE OF a;
    `
      : `
      SELECT a.*, l.license_code
      FROM license_activations a
      JOIN licenses l ON l.id = a.license_id
      WHERE a.license_id = $1 AND a.device_id = $2 AND a.status = 'active'
      LIMIT 1;
    `;
    const res = await this.db.query<ActivationRow>(query, [licenseId, deviceId]);
    if (res.rows.length === 0) return null;
    return mapRowToActivationRecord(res.rows[0]);
  }

  async findByLicenseAndDevice(licenseId: string, deviceId: string, options?: { forUpdate?: boolean }): Promise<ActivationRecord | null> {
    const query = options?.forUpdate
      ? `
      SELECT a.*, l.license_code
      FROM license_activations a
      JOIN licenses l ON l.id = a.license_id
      WHERE a.license_id = $1 AND a.device_id = $2
      LIMIT 1 FOR UPDATE OF a;
    `
      : `
      SELECT a.*, l.license_code
      FROM license_activations a
      JOIN licenses l ON l.id = a.license_id
      WHERE a.license_id = $1 AND a.device_id = $2
      LIMIT 1;
    `;
    const res = await this.db.query<ActivationRow>(query, [licenseId, deviceId]);
    if (res.rows.length === 0) return null;
    return mapRowToActivationRecord(res.rows[0]);
  }

  async countActiveByLicense(licenseId: string, _options?: { forUpdate?: boolean }): Promise<number> {
    const query = `
      SELECT COUNT(*)::int as active_count
      FROM license_activations
      WHERE license_id = $1 AND status = 'active';
    `;
    const res = await this.db.query<{ active_count: number }>(query, [licenseId]);
    return res.rows[0]?.active_count || 0;
  }

  async create(activation: Omit<ActivationRecord, 'id'>): Promise<ActivationRecord> {
    const id = `act_${crypto.randomUUID()}`;
    const query = `
      INSERT INTO license_activations (
        id, license_id, device_id, status, activated_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *;
    `;

    const res = await this.db.query<ActivationRow>(query, [
      id,
      activation.licenseId,
      activation.deviceId,
      activation.status || 'active',
      activation.activatedAt || new Date().toISOString(),
    ]);

    return mapRowToActivationRecord(res.rows[0], activation.licenseCode);
  }

  async deactivate(id: string, _reason?: string): Promise<ActivationRecord | null> {
    const query = `
      UPDATE license_activations
      SET status = 'deactivated', deactivated_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const res = await this.db.query<ActivationRow>(query, [id]);
    if (res.rows.length === 0) return null;
    return mapRowToActivationRecord(res.rows[0]);
  }

  async reactivate(id: string, activatedAt?: string): Promise<ActivationRecord | null> {
    const query = `
      UPDATE license_activations
      SET status = 'active', activated_at = COALESCE($2, NOW()), deactivated_at = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const res = await this.db.query<ActivationRow>(query, [id, activatedAt || null]);
    if (res.rows.length === 0) return null;
    return mapRowToActivationRecord(res.rows[0]);
  }

  async touchLastValidated(id: string, lastValidatedAt?: string): Promise<ActivationRecord | null> {
    const query = `
      UPDATE license_activations
      SET last_validated_at = COALESCE($2, NOW()), updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const res = await this.db.query<ActivationRow>(query, [id, lastValidatedAt || null]);
    if (res.rows.length === 0) return null;
    return mapRowToActivationRecord(res.rows[0]);
  }
}
