import type {
  LicenseEdition,
  LicenseTerm,
} from '@gestione-casa/shared-sdk/licensing';

export type { LicenseEdition, LicenseTerm };
export type LicenseTermType = LicenseTerm;

export interface LicenseRecord {
  id: string;
  licenseCode: string;
  checksum: string;
  customerId: string;
  deviceId?: string;
  expiresAt?: string;
  generatedAt: string;
  engineVersion: string;
  schemaVersion: number;
  status: 'assigned' | 'revoked' | 'expired' | 'suspended' | string;
  licenseType: string;

  // V2 fields (nullable/optional for backward compatibility with V1)
  edition?: LicenseEdition;
  termType?: LicenseTermType;
  allowOfflineValidation?: boolean;
  maxOfflineDays?: number;
  metadata?: Record<string, unknown>;
}

export type CreateLicenseInput = Partial<LicenseRecord> & {
  id: string;
  licenseCode: string;
  customerId: string;
  generatedAt: string;
  status: LicenseRecord['status'];
};

export interface LicenseRepository {
  findById(id: string): Promise<LicenseRecord | null>;
  findByCode(licenseCode: string, options?: { forUpdate?: boolean }): Promise<LicenseRecord | null>;
  save(license: LicenseRecord | CreateLicenseInput): Promise<LicenseRecord>;
  update(id: string, updates: Partial<LicenseRecord>): Promise<LicenseRecord | null>;
}
