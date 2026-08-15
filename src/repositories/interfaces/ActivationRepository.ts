export interface ActivationRecord {
  id: string;
  licenseId: string;
  licenseCode: string;
  deviceId: string;
  activatedAt: string;
  lastValidatedAt?: string;
  status: 'active' | 'deactivated';
  deactivatedAt?: string;
  deactivationReason?: string;
  requestCorrelationId?: string;
}

export interface ActivationRepository {
  findActiveByLicenseAndDevice(licenseId: string, deviceId: string, options?: { forUpdate?: boolean }): Promise<ActivationRecord | null>;
  findByLicenseAndDevice(licenseId: string, deviceId: string, options?: { forUpdate?: boolean }): Promise<ActivationRecord | null>;
  countActiveByLicense(licenseId: string, options?: { forUpdate?: boolean }): Promise<number>;
  create(activation: Omit<ActivationRecord, 'id'>): Promise<ActivationRecord>;
  deactivate(id: string, reason?: string): Promise<ActivationRecord | null>;
  reactivate(id: string, activatedAt?: string): Promise<ActivationRecord | null>;
  touchLastValidated(id: string, lastValidatedAt?: string): Promise<ActivationRecord | null>;
}
