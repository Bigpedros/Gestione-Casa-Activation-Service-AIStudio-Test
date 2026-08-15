import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/config/env.js';
import {
  isPoolInitialized,
  PostgresLicenseRepository,
  PostgresActivationRepository,
  PostgresActivationPolicyRepository,
  PostgresAuditRepository,
} from '../dist/database/index.js';

test('1. Development config without DATABASE_URL loads fine', () => {
  const oldEnv = process.env.NODE_ENV;
  const oldDb = process.env.DATABASE_URL;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
    const config = loadConfig();
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.databaseUrl, undefined);
  } finally {
    process.env.NODE_ENV = oldEnv;
    if (oldDb) process.env.DATABASE_URL = oldDb;
  }
});

test('2. Production config rejects missing DATABASE_URL', () => {
  const oldEnv = process.env.NODE_ENV;
  const oldDb = process.env.DATABASE_URL;
  const oldKey = process.env.LICENSE_PRIVATE_KEY;
  try {
    process.env.NODE_ENV = 'production';
    process.env.LICENSE_PRIVATE_KEY = 'dummy-key';
    delete process.env.DATABASE_URL;
    assert.throws(
      () => loadConfig(),
      /FATAL: DATABASE_URL environment variable is required in production/
    );
  } finally {
    process.env.NODE_ENV = oldEnv;
    if (oldDb) process.env.DATABASE_URL = oldDb;
    if (oldKey) process.env.LICENSE_PRIVATE_KEY = oldKey;
    else delete process.env.LICENSE_PRIVATE_KEY;
  }
});

test('3. Migration files present and ordered', () => {
  const dir = path.join(process.cwd(), 'src', 'database', 'migrations');
  assert.ok(fs.existsSync(dir), 'Migrations directory must exist');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'At least 1 SQL migration must exist');
  assert.ok(files.includes('001_activation_schema.sql'), '001_activation_schema.sql must exist');
});

test('4. Schema contains required tables', () => {
  const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations'), 'Must create schema_migrations');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS licenses'), 'Must create licenses');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS activation_policies'), 'Must create activation_policies');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS license_activations'), 'Must create license_activations');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS audit_events'), 'Must create audit_events');
});

test('5. Schema contains UNIQUE license_code', () => {
  const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.includes('license_code VARCHAR(64) NOT NULL UNIQUE'), 'licenses.license_code must be UNIQUE');
});

test('6. Schema contains UNIQUE (license_id, device_id)', () => {
  const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.includes('UNIQUE (license_id, device_id)'), 'license_activations must have UNIQUE (license_id, device_id)');
});

test('7. Schema contains schema_migrations', () => {
  const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.includes('version VARCHAR(64) PRIMARY KEY'), 'schema_migrations version must be PRIMARY KEY');
});

test('8. Postgres repositories exported correctly', () => {
  assert.equal(typeof PostgresLicenseRepository, 'function');
  assert.equal(typeof PostgresActivationRepository, 'function');
  assert.equal(typeof PostgresActivationPolicyRepository, 'function');
  assert.equal(typeof PostgresAuditRepository, 'function');
});

test('9. Pool not created automatically on import', () => {
  assert.equal(isPoolInitialized(), false, 'Pool must not be created on module import');
});

test('10. No hardcoded secrets in source files', () => {
  const srcDir = path.join(process.cwd(), 'src');
  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.sql'))) {
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.ok(!content.includes('postgres://postgres:'), `File ${entry.name} contains hardcoded postgres URL`);
        assert.ok(!content.includes('BEGIN PRIVATE KEY'), `File ${entry.name} contains hardcoded private key`);
      }
    }
  }
  scanDir(srcDir);
});

test('11. Beta tester code FB68-PB71-2026-3107 NOT present in schema/logic', () => {
  const targetCode = 'FB68-PB71-2026-3107';
  const srcDir = path.join(process.cwd(), 'src');
  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.ok(!content.includes(targetCode), `File ${entry.name} contains hardcoded beta tester code ${targetCode}`);
      }
    }
  }
  scanDir(srcDir);
});

test('12. Structure prepared for maxActivations data-driven', () => {
  const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', '001_activation_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.includes('max_activations INT NOT NULL DEFAULT 1'), 'Schema must have max_activations column');
});
