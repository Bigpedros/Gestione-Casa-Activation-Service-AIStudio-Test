-- Migration: 002_license_v2_persistence.sql
-- Schema extension for LicenseDocumentV2 persistence and backwards compatibility with V1

ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS edition VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS term_type VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS allow_offline_validation BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS max_offline_days INT NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NULL;

-- Indexes for efficient lookups on V2 license attributes
CREATE INDEX IF NOT EXISTS idx_licenses_edition ON licenses(edition);
CREATE INDEX IF NOT EXISTS idx_licenses_schema_version ON licenses(schema_version);
