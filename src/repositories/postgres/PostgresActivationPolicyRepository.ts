import type { QueryResultRow } from 'pg';
import type { ActivationPolicyRecord, ActivationPolicyRepository } from '../interfaces/ActivationPolicyRepository.js';
import type { DbClient } from '../../database/types.js';
import { getPool } from '../../database/pool.js';

interface PolicyRow extends QueryResultRow {
  id: string;
  license_id: string;
  license_type: string;
  max_activations: number;
  allow_reactivation: boolean;
  allow_offline_validation: boolean;
  max_offline_days: number;
}

function mapRowToPolicyRecord(row: PolicyRow): ActivationPolicyRecord {
  return {
    id: row.id,
    licenseType: row.license_type,
    maxActivations: Number(row.max_activations),
    allowOfflineValidation: Boolean(row.allow_offline_validation),
    maxOfflineDays: Number(row.max_offline_days),
  };
}

export class PostgresActivationPolicyRepository implements ActivationPolicyRepository {
  constructor(private client?: DbClient) {}

  private get db(): DbClient {
    return this.client || getPool();
  }

  async findByLicenseType(licenseType: string, options?: { forUpdate?: boolean }): Promise<ActivationPolicyRecord | null> {
    const query = options?.forUpdate
      ? 'SELECT * FROM activation_policies WHERE license_type = $1 LIMIT 1 FOR UPDATE'
      : 'SELECT * FROM activation_policies WHERE license_type = $1 LIMIT 1';
    const res = await this.db.query<PolicyRow>(query, [licenseType]);
    if (res.rows.length === 0) return null;
    return mapRowToPolicyRecord(res.rows[0]);
  }

  async findById(id: string): Promise<ActivationPolicyRecord | null> {
    const query = 'SELECT * FROM activation_policies WHERE id = $1 LIMIT 1';
    const res = await this.db.query<PolicyRow>(query, [id]);
    if (res.rows.length === 0) return null;
    return mapRowToPolicyRecord(res.rows[0]);
  }

  async findByLicenseId(licenseId: string, options?: { forUpdate?: boolean }): Promise<ActivationPolicyRecord | null> {
    const query = options?.forUpdate
      ? 'SELECT * FROM activation_policies WHERE license_id = $1 LIMIT 1 FOR UPDATE'
      : 'SELECT * FROM activation_policies WHERE license_id = $1 LIMIT 1';
    const res = await this.db.query<PolicyRow>(query, [licenseId]);
    if (res.rows.length === 0) return null;
    return mapRowToPolicyRecord(res.rows[0]);
  }
}
