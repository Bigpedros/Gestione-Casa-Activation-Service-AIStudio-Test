export interface ActivationPolicyRecord {
  id: string;
  licenseType: string;
  maxActivations: number;
  allowOfflineValidation: boolean;
  maxOfflineDays: number;
}

export interface ActivationPolicyRepository {
  findByLicenseType(licenseType: string, options?: { forUpdate?: boolean }): Promise<ActivationPolicyRecord | null>;
  findById(id: string): Promise<ActivationPolicyRecord | null>;
  findByLicenseId?(licenseId: string, options?: { forUpdate?: boolean }): Promise<ActivationPolicyRecord | null>;
}
