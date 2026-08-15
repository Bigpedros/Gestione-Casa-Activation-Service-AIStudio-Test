-- Migration: 001_activation_schema.sql
-- Schema version 1 for Gestione Casa Activation Service

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS licenses (
  id VARCHAR(64) PRIMARY KEY,
  license_code VARCHAR(64) NOT NULL UNIQUE,
  checksum VARCHAR(32) NOT NULL DEFAULT '',
  customer_id VARCHAR(128) NOT NULL,
  license_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'assigned',
  schema_version INT NOT NULL DEFAULT 1,
  engine_version VARCHAR(32) NOT NULL DEFAULT '2.1',
  generated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  max_activations INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activation_policies (
  id VARCHAR(64) PRIMARY KEY,
  license_id VARCHAR(64) NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  license_type VARCHAR(64) NOT NULL,
  max_activations INT NOT NULL DEFAULT 1,
  allow_reactivation BOOLEAN NOT NULL DEFAULT true,
  allow_offline_validation BOOLEAN NOT NULL DEFAULT true,
  max_offline_days INT NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_policy_per_license UNIQUE (license_id)
);

CREATE TABLE IF NOT EXISTS license_activations (
  id VARCHAR(64) PRIMARY KEY,
  license_id VARCHAR(64) NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  device_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_validated_at TIMESTAMPTZ NULL,
  deactivated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_license_device UNIQUE (license_id, device_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  license_id VARCHAR(64) NULL REFERENCES licenses(id) ON DELETE SET NULL,
  activation_id VARCHAR(64) NULL REFERENCES license_activations(id) ON DELETE SET NULL,
  request_id VARCHAR(128) NULL,
  device_id VARCHAR(128) NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance and quick lookups
CREATE INDEX IF NOT EXISTS idx_license_activations_license_id ON license_activations(license_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_device_id ON license_activations(device_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_status ON license_activations(status);
CREATE INDEX IF NOT EXISTS idx_audit_events_license_id ON audit_events(license_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
