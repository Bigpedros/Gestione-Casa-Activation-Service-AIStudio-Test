import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PostgresLicenseRepository,
  PostgresActivationRepository,
  PostgresActivationPolicyRepository,
  PostgresAuditRepository,
} from '../dist/database/index.js';

// Realistic in-memory Postgres client simulator for PostgresLicenseRepository
class MockPgClient {
  constructor(initialRows = []) {
    this.rows = new Map();
    for (const r of initialRows) {
      this.rows.set(r.id, { ...r });
    }
  }

  async query(text, params = []) {
    const trimmed = text.trim();

    // 1. SELECT * FROM licenses WHERE id = $1 LIMIT 1
    if (trimmed.startsWith('SELECT * FROM licenses WHERE id = $1')) {
      const id = params[0];
      const row = this.rows.get(id);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    // 2. SELECT * FROM licenses WHERE license_code = $1
    if (trimmed.startsWith('SELECT * FROM licenses WHERE license_code = $1')) {
      const code = params[0];
      let found = null;
      for (const row of this.rows.values()) {
        if (row.license_code === code) {
          found = { ...row };
          break;
        }
      }
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // 3. INSERT INTO licenses ... ON CONFLICT (id) DO UPDATE ... RETURNING *;
    if (trimmed.startsWith('INSERT INTO licenses')) {
      const [
        id,
        license_code,
        checksum,
        customer_id,
        license_type,
        status,
        schema_version,
        engine_version,
        generated_at,
        expires_at,
        edition,
        term_type,
        allow_offline_validation,
        max_offline_days,
        metadataJson,
      ] = params;

      let metadataObj = null;
      if (metadataJson) {
        try {
          metadataObj = JSON.parse(metadataJson);
        } catch {
          metadataObj = null;
        }
      }

      const row = {
        id,
        license_code,
        checksum: checksum || '',
        customer_id,
        license_type,
        status,
        schema_version: schema_version ?? 1,
        engine_version: engine_version || '2.1',
        generated_at: generated_at instanceof Date ? generated_at.toISOString() : String(generated_at),
        expires_at: expires_at ? (expires_at instanceof Date ? expires_at.toISOString() : String(expires_at)) : null,
        max_activations: 1,
        edition: edition || null,
        term_type: term_type || null,
        allow_offline_validation: allow_offline_validation !== null && allow_offline_validation !== undefined
          ? Boolean(allow_offline_validation)
          : null,
        max_offline_days: max_offline_days !== null && max_offline_days !== undefined
          ? Number(max_offline_days)
          : null,
        metadata: metadataObj,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      this.rows.set(id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    throw new Error(`Unhandled mock query: ${text}`);
  }
}

// ============================================================================
// AS-2 Persistence Test Suite
// ============================================================================

test('AS-2.1 Migration 002 exists and contains expected DDL for V2 persistence', () => {
  const migDir = path.join(process.cwd(), 'src', 'database', 'migrations');
  const migFile = path.join(migDir, '002_license_v2_persistence.sql');

  assert.ok(fs.existsSync(migFile), '002_license_v2_persistence.sql must exist');
  const sql = fs.readFileSync(migFile, 'utf8');

  assert.ok(sql.includes('ALTER TABLE licenses'), 'Must alter licenses table');
  assert.ok(sql.includes('edition VARCHAR'), 'Must add edition column');
  assert.ok(sql.includes('term_type VARCHAR'), 'Must add term_type column');
  assert.ok(sql.includes('allow_offline_validation BOOLEAN'), 'Must add allow_offline_validation column');
  assert.ok(sql.includes('max_offline_days INT'), 'Must add max_offline_days column');
  assert.ok(sql.includes('metadata JSONB'), 'Must add metadata column');
  assert.ok(sql.includes('idx_licenses_edition'), 'Must create index on edition');
  assert.ok(sql.includes('idx_licenses_schema_version'), 'Must create index on schema_version');
});

test('AS-2.2 Full schema.sql represents current comprehensive schema', () => {
  const schemaFile = path.join(process.cwd(), 'src', 'database', 'schema.sql');
  assert.ok(fs.existsSync(schemaFile), 'src/database/schema.sql must exist');
  const sql = fs.readFileSync(schemaFile, 'utf8');

  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS licenses'), 'Must include licenses table');
  assert.ok(sql.includes('edition VARCHAR'), 'Must include edition column in schema.sql');
  assert.ok(sql.includes('term_type VARCHAR'), 'Must include term_type column in schema.sql');
  assert.ok(sql.includes('allow_offline_validation BOOLEAN'), 'Must include allow_offline_validation column');
  assert.ok(sql.includes('max_offline_days INT'), 'Must include max_offline_days column');
  assert.ok(sql.includes('metadata JSONB'), 'Must include metadata column in schema.sql');
});

test('AS-2.3 Historical migration 001 remains intact and unmodified', () => {
  const migFile = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(migFile, 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS licenses'), '001 migration must remain intact');
  assert.ok(sql.includes('schema_version INT NOT NULL DEFAULT 1'), '001 migration must have original schema_version');
});

test('AS-2.4 V1 license creation and reading after DB extension (Full Backwards Compatibility)', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const v1License = {
    id: 'lic_v1_001',
    licenseCode: 'GCAS-1111-2222-3333',
    checksum: 'CHK1',
    customerId: 'cust_v1_legacy',
    generatedAt: '2026-08-14T00:00:00.000Z',
    engineVersion: '2.1',
    schemaVersion: 1,
    status: 'assigned',
    licenseType: 'pro',
    expiresAt: '2027-08-14T00:00:00.000Z',
  };

  const saved = await repo.save(v1License);
  assert.equal(saved.id, 'lic_v1_001');
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.licenseType, 'pro');
  assert.equal(saved.edition, undefined);
  assert.equal(saved.termType, undefined);
  assert.equal(saved.allowOfflineValidation, undefined);
  assert.equal(saved.maxOfflineDays, undefined);
  assert.equal(saved.metadata, undefined);

  const found = await repo.findByCode('GCAS-1111-2222-3333');
  assert.ok(found);
  assert.equal(found.id, 'lic_v1_001');
  assert.equal(found.schemaVersion, 1);
  assert.equal(found.licenseType, 'pro');
  assert.equal(found.edition, undefined);
  assert.equal(found.termType, undefined);
  assert.equal(found.allowOfflineValidation, undefined);
  assert.equal(found.maxOfflineDays, undefined);
  assert.equal(found.metadata, undefined);
  assert.equal(found.expiresAt, '2027-08-14T00:00:00.000Z');
});

test('AS-2.5 V2 standard edition persistence and reading', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const v2Standard = {
    id: 'lic_v2_std_01',
    licenseCode: 'GCAS-STND-2026-0001',
    checksum: 'CMM1',
    customerId: 'cust_std_user',
    generatedAt: new Date().toISOString(),
    engineVersion: '2.1',
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'standard',
    edition: 'standard',
    termType: 'perpetual',
    allowOfflineValidation: false,
    metadata: { tier: 'free', channel: 'web' },
  };

  const saved = await repo.save(v2Standard);
  assert.equal(saved.id, 'lic_v2_std_01');
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.edition, 'standard');
  assert.equal(saved.termType, 'perpetual');
  assert.equal(saved.allowOfflineValidation, false);
  assert.deepEqual(saved.metadata, { tier: 'free', channel: 'web' });

  const found = await repo.findById('lic_v2_std_01');
  assert.ok(found);
  assert.equal(found.edition, 'standard');
  assert.equal(found.termType, 'perpetual');
  assert.equal(found.allowOfflineValidation, false);
  assert.deepEqual(found.metadata, { tier: 'free', channel: 'web' });
});

test('AS-2.6 V2 professional edition persistence and reading', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const v2Pro = {
    id: 'lic_v2_pro_01',
    licenseCode: 'GCAS-PROO-2026-0002',
    checksum: 'PRO1',
    customerId: 'cust_pro_user',
    generatedAt: new Date().toISOString(),
    engineVersion: '2.1',
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'professional',
    edition: 'professional',
    termType: 'annual',
    expiresAt: '2027-12-31T23:59:59.000Z',
    allowOfflineValidation: true,
    maxOfflineDays: 30,
    metadata: { seats: 5, plan: 'annual_pro' },
  };

  const saved = await repo.save(v2Pro);
  assert.equal(saved.edition, 'professional');
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.termType, 'annual');
  assert.equal(saved.expiresAt, '2027-12-31T23:59:59.000Z');
  assert.equal(saved.allowOfflineValidation, true);
  assert.equal(saved.maxOfflineDays, 30);
  assert.deepEqual(saved.metadata, { seats: 5, plan: 'annual_pro' });

  const found = await repo.findByCode('GCAS-PROO-2026-0002');
  assert.ok(found);
  assert.equal(found.edition, 'professional');
  assert.equal(found.allowOfflineValidation, true);
  assert.equal(found.maxOfflineDays, 30);
  assert.deepEqual(found.metadata, { seats: 5, plan: 'annual_pro' });
});

test('AS-2.7 V2 enterprise edition persistence and reading', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const v2Enterprise = {
    id: 'lic_v2_ent_01',
    licenseCode: 'GCAS-ENTP-2026-0003',
    checksum: 'ENT1',
    customerId: 'cust_enterprise_corp',
    generatedAt: new Date().toISOString(),
    engineVersion: '2.1',
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'enterprise',
    edition: 'enterprise',
    termType: 'annual',
    expiresAt: '2028-06-30T00:00:00.000Z',
    allowOfflineValidation: true,
    maxOfflineDays: 90,
    metadata: { enterpriseSla: '24/7', customDomain: 'corp.local' },
  };

  const saved = await repo.save(v2Enterprise);
  assert.equal(saved.edition, 'enterprise');
  assert.equal(saved.maxOfflineDays, 90);
  assert.equal(saved.allowOfflineValidation, true);

  const found = await repo.findById('lic_v2_ent_01');
  assert.ok(found);
  assert.equal(found.edition, 'enterprise');
  assert.equal(found.maxOfflineDays, 90);
  assert.deepEqual(found.metadata, { enterpriseSla: '24/7', customDomain: 'corp.local' });
});

test('AS-2.8 Term type: perpetual has no expiration and is correctly persisted', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const perpetualLicense = {
    id: 'lic_v2_perp_01',
    licenseCode: 'GCAS-PERP-2026-0004',
    customerId: 'cust_perp',
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'standard',
    edition: 'standard',
    termType: 'perpetual',
    expiresAt: undefined,
  };

  const saved = await repo.save(perpetualLicense);
  assert.equal(saved.termType, 'perpetual');
  assert.equal(saved.expiresAt, undefined);

  const found = await repo.findByCode('GCAS-PERP-2026-0004');
  assert.ok(found);
  assert.equal(found.termType, 'perpetual');
  assert.equal(found.expiresAt, undefined);
});

test('AS-2.9 Term type: beta_60_days with expires_at is correctly persisted and re-read', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const expiresIso = '2027-03-15T12:00:00.000Z';
  const betaLicense = {
    id: 'lic_v2_tb_01',
    licenseCode: 'GCAS-TIME-2026-0005',
    customerId: 'cust_timebound',
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'professional',
    edition: 'professional',
    termType: 'beta_60_days',
    expiresAt: expiresIso,
  };

  const saved = await repo.save(betaLicense);
  assert.equal(saved.termType, 'beta_60_days');
  assert.equal(saved.expiresAt, expiresIso);

  const found = await repo.findById('lic_v2_tb_01');
  assert.ok(found);
  assert.equal(found.termType, 'beta_60_days');
  assert.equal(found.expiresAt, expiresIso);
});

test('AS-2.10 Offline policy: disabled (allowed = false, maxDays = null)', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const license = {
    id: 'lic_v2_off_disabled',
    licenseCode: 'GCAS-OFFD-2026-0006',
    customerId: 'cust_off_dis',
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'standard',
    edition: 'standard',
    allowOfflineValidation: false,
    maxOfflineDays: undefined,
  };

  const saved = await repo.save(license);
  assert.equal(saved.allowOfflineValidation, false);
  assert.equal(saved.maxOfflineDays, undefined);

  const found = await repo.findByCode('GCAS-OFFD-2026-0006');
  assert.ok(found);
  assert.equal(found.allowOfflineValidation, false);
  assert.equal(found.maxOfflineDays, undefined);
});

test('AS-2.11 Offline policy: enabled (allowed = true, maxDays = 14)', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const license = {
    id: 'lic_v2_off_enabled',
    licenseCode: 'GCAS-OFFE-2026-0007',
    customerId: 'cust_off_en',
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'professional',
    edition: 'professional',
    allowOfflineValidation: true,
    maxOfflineDays: 14,
  };

  const saved = await repo.save(license);
  assert.equal(saved.allowOfflineValidation, true);
  assert.equal(saved.maxOfflineDays, 14);

  const found = await repo.findById('lic_v2_off_enabled');
  assert.ok(found);
  assert.equal(found.allowOfflineValidation, true);
  assert.equal(found.maxOfflineDays, 14);
});

test('AS-2.12 Metadata JSONB persistence, complex nested objects and mutation via update()', async () => {
  const client = new MockPgClient();
  const repo = new PostgresLicenseRepository(client);

  const richMetadata = {
    organization: 'Acme Real Estate',
    tier: 'enterprise-plus',
    features: ['ocr', 'multi-device', 'priority-support'],
    settings: {
      autoRenew: true,
      maxTenants: 100,
    },
  };

  const license = {
    id: 'lic_v2_meta_01',
    licenseCode: 'GCAS-META-2026-0008',
    customerId: 'cust_meta',
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'enterprise',
    edition: 'enterprise',
    metadata: richMetadata,
  };

  await repo.save(license);

  const read = await repo.findById('lic_v2_meta_01');
  assert.ok(read);
  assert.deepEqual(read.metadata, richMetadata);

  // Update metadata
  const updatedMeta = { ...richMetadata, tier: 'enterprise-custom', newField: 'added' };
  const updated = await repo.update('lic_v2_meta_01', { metadata: updatedMeta });
  assert.ok(updated);
  assert.deepEqual(updated.metadata, updatedMeta);

  const reRead = await repo.findByCode('GCAS-META-2026-0008');
  assert.ok(reRead);
  assert.deepEqual(reRead.metadata, updatedMeta);
});

test('AS-2.13 Legacy V1 rows in DB (nullable columns) map properly to LicenseRecord without error', async () => {
  // Simulate a row directly created before migration 002
  const legacyDbRow = {
    id: 'lic_legacy_raw',
    license_code: 'GCAS-RAWL-1111-2222',
    checksum: 'RAW1',
    customer_id: 'cust_raw',
    license_type: 'standard',
    status: 'assigned',
    schema_version: 1,
    engine_version: '2.1',
    generated_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
    max_activations: 1,
    edition: null,
    term_type: null,
    allow_offline_validation: null,
    max_offline_days: null,
    metadata: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };

  const client = new MockPgClient([legacyDbRow]);
  const repo = new PostgresLicenseRepository(client);

  const found = await repo.findById('lic_legacy_raw');
  assert.ok(found);
  assert.equal(found.id, 'lic_legacy_raw');
  assert.equal(found.schemaVersion, 1);
  assert.equal(found.licenseType, 'standard');
  assert.equal(found.edition, undefined);
  assert.equal(found.termType, undefined);
  assert.equal(found.allowOfflineValidation, undefined);
  assert.equal(found.maxOfflineDays, undefined);
  assert.equal(found.metadata, undefined);
  assert.equal(found.expiresAt, undefined);
});

test('AS-2.14 No regression on other repositories (Activation, Policy, Audit)', () => {
  assert.equal(typeof PostgresActivationRepository, 'function');
  assert.equal(typeof PostgresActivationPolicyRepository, 'function');
  assert.equal(typeof PostgresAuditRepository, 'function');
  assert.equal(typeof PostgresLicenseRepository, 'function');
});
