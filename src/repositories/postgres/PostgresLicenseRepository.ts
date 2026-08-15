import type { QueryResultRow } from 'pg';
import type { LicenseRecord, LicenseRepository, CreateLicenseInput, LicenseEdition, LicenseTermType } from '../interfaces/LicenseRepository.js';
import type { DbClient } from '../../database/types.js';
import { getPool } from '../../database/pool.js';

interface LicenseRow extends QueryResultRow {
  id: string;
  license_code: string;
  checksum: string;
  customer_id: string;
  license_type: string;
  status: string;
  schema_version: number;
  engine_version: string;
  generated_at: Date | string;
  expires_at: Date | string | null;
  max_activations: number;
  edition?: string | null;
  term_type?: string | null;
  allow_offline_validation?: boolean | null;
  max_offline_days?: number | null;
  metadata?: Record<string, unknown> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRowToLicenseRecord(row: LicenseRow): LicenseRecord {
  let parsedMetadata: Record<string, unknown> | undefined = undefined;
  if (row.metadata !== null && row.metadata !== undefined) {
    if (typeof row.metadata === 'object') {
      parsedMetadata = row.metadata as Record<string, unknown>;
    } else if (typeof row.metadata === 'string') {
      try {
        parsedMetadata = JSON.parse(row.metadata);
      } catch {
        parsedMetadata = undefined;
      }
    }
  }

  return {
    id: row.id,
    licenseCode: row.license_code,
    checksum: row.checksum || '',
    customerId: row.customer_id,
    generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at),
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)) : undefined,
    engineVersion: row.engine_version || '2.1',
    schemaVersion: Number(row.schema_version ?? 1),
    status: row.status as LicenseRecord['status'],
    licenseType: row.license_type,
    edition: row.edition !== null && row.edition !== undefined ? (row.edition as LicenseEdition) : undefined,
    termType: row.term_type !== null && row.term_type !== undefined ? (row.term_type as LicenseTermType) : undefined,
    allowOfflineValidation: row.allow_offline_validation !== null && row.allow_offline_validation !== undefined
      ? Boolean(row.allow_offline_validation)
      : undefined,
    maxOfflineDays: row.max_offline_days !== null && row.max_offline_days !== undefined
      ? Number(row.max_offline_days)
      : undefined,
    metadata: parsedMetadata,
  };
}

export class PostgresLicenseRepository implements LicenseRepository {
  constructor(private client?: DbClient) {}

  private get db(): DbClient {
    return this.client || getPool();
  }

  async findById(id: string): Promise<LicenseRecord | null> {
    const res = await this.db.query<LicenseRow>(
      'SELECT * FROM licenses WHERE id = $1 LIMIT 1',
      [id]
    );
    if (res.rows.length === 0) return null;
    return mapRowToLicenseRecord(res.rows[0]);
  }

  async findByCode(licenseCode: string, options?: { forUpdate?: boolean }): Promise<LicenseRecord | null> {
    const query = options?.forUpdate
      ? 'SELECT * FROM licenses WHERE license_code = $1 LIMIT 1 FOR UPDATE'
      : 'SELECT * FROM licenses WHERE license_code = $1 LIMIT 1';
    const res = await this.db.query<LicenseRow>(query, [licenseCode]);
    if (res.rows.length === 0) return null;
    return mapRowToLicenseRecord(res.rows[0]);
  }

  async save(license: LicenseRecord | CreateLicenseInput): Promise<LicenseRecord> {
    const query = `
      INSERT INTO licenses (
        id, license_code, checksum, customer_id, license_type, status,
        schema_version, engine_version, generated_at, expires_at,
        edition, term_type, allow_offline_validation, max_offline_days, metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      ON CONFLICT (id) DO UPDATE SET
        license_code = EXCLUDED.license_code,
        checksum = EXCLUDED.checksum,
        customer_id = EXCLUDED.customer_id,
        license_type = EXCLUDED.license_type,
        status = EXCLUDED.status,
        schema_version = EXCLUDED.schema_version,
        engine_version = EXCLUDED.engine_version,
        generated_at = EXCLUDED.generated_at,
        expires_at = EXCLUDED.expires_at,
        edition = EXCLUDED.edition,
        term_type = EXCLUDED.term_type,
        allow_offline_validation = EXCLUDED.allow_offline_validation,
        max_offline_days = EXCLUDED.max_offline_days,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *;
    `;

    const metadataJson = license.metadata !== undefined ? JSON.stringify(license.metadata) : null;

    const res = await this.db.query<LicenseRow>(query, [
      license.id,
      license.licenseCode,
      license.checksum || '',
      license.customerId,
      license.licenseType || 'pro',
      license.status,
      license.schemaVersion ?? 1,
      license.engineVersion || '2.1',
      license.generatedAt,
      license.expiresAt || null,
      license.edition || null,
      license.termType || null,
      license.allowOfflineValidation !== undefined ? license.allowOfflineValidation : null,
      license.maxOfflineDays !== undefined ? license.maxOfflineDays : null,
      metadataJson,
    ]);

    return mapRowToLicenseRecord(res.rows[0]);
  }

  async update(id: string, updates: Partial<LicenseRecord>): Promise<LicenseRecord | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updated: LicenseRecord = {
      ...existing,
      ...updates,
    };

    return this.save(updated);
  }
}
