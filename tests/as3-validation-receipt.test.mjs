import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ActivationService } from '../dist/services/activationService.js';
import { LicenseSigningService } from '../dist/services/licenseSigningService.js';
import { createApp } from '../dist/app.js';
import {
  ActivationValidator,
  validateValidationReceiptBinding,
  computeLicensePayloadHashV2,
} from '@gestione-casa/shared-sdk/activation';
import { LicenseEngine } from '@gestione-casa/shared-sdk/licensing';

// Helper Memory Repositories for deterministic test isolation
class MemoryLicenseRepo {
  constructor(licenses = []) {
    this.licenses = new Map(licenses.map((l) => [l.licenseCode, { ...l }]));
  }
  async findById(id) {
    for (const l of this.licenses.values()) {
      if (l.id === id) return { ...l };
    }
    return null;
  }
  async findByCode(code) {
    const l = this.licenses.get(code);
    return l ? { ...l } : null;
  }
  async save(license) {
    this.licenses.set(license.licenseCode, { ...license });
    return { ...license };
  }
  async update(id, updates) {
    for (const [code, l] of this.licenses.entries()) {
      if (l.id === id) {
        const updated = { ...l, ...updates };
        this.licenses.set(code, updated);
        return { ...updated };
      }
    }
    return null;
  }
}

class MemoryActivationRepo {
  constructor(activations = []) {
    this.activations = activations.map((a) => ({ ...a }));
  }
  async findActiveByLicenseAndDevice(licenseId, deviceId) {
    const found = this.activations.find(
      (a) => a.licenseId === licenseId && a.deviceId === deviceId && a.status === 'active'
    );
    return found ? { ...found } : null;
  }
  async findByLicenseAndDevice(licenseId, deviceId) {
    const found = this.activations.find(
      (a) => a.licenseId === licenseId && a.deviceId === deviceId
    );
    return found ? { ...found } : null;
  }
  async countActiveByLicense(licenseId) {
    return this.activations.filter(
      (a) => a.licenseId === licenseId && a.status === 'active'
    ).length;
  }
  async create(activation) {
    const record = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      ...activation,
    };
    this.activations.push(record);
    return { ...record };
  }
  async deactivate(id, _reason) {
    const found = this.activations.find((a) => a.id === id);
    if (found) {
      found.status = 'deactivated';
      found.deactivatedAt = new Date().toISOString();
      return { ...found };
    }
    return null;
  }
  async reactivate(id, activatedAt) {
    const found = this.activations.find((a) => a.id === id);
    if (found) {
      found.status = 'active';
      found.activatedAt = activatedAt || new Date().toISOString();
      found.deactivatedAt = undefined;
      return { ...found };
    }
    return null;
  }
  async touchLastValidated(id, lastValidatedAt) {
    const found = this.activations.find((a) => a.id === id);
    if (found) {
      found.lastValidatedAt = lastValidatedAt || new Date().toISOString();
      return { ...found };
    }
    return null;
  }
}

class MemoryPolicyRepo {
  constructor(policies = []) {
    this.policies = policies.map((p) => ({ ...p }));
  }
  async findByLicenseId(licenseId) {
    const found = this.policies.find((p) => p.licenseId === licenseId);
    return found ? { ...found } : null;
  }
  async findByLicenseType(licenseType) {
    const found = this.policies.find((p) => p.licenseType === licenseType);
    return found ? { ...found } : { id: 'default', licenseType, maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  }
  async findById(id) {
    const found = this.policies.find((p) => p.id === id);
    return found ? { ...found } : null;
  }
}

class MemoryAuditRepo {
  constructor() {
    this.events = [];
  }
  async append(record) {
    const entry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...record,
    };
    this.events.push(entry);
    return entry;
  }
}

function createV2LicenseRecord(overrides = {}) {
  const code = LicenseEngine.generateCode();
  return {
    id: `lic_v2_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    licenseCode: code,
    checksum: 'chk_v2_auto',
    customerId: 'cust_v2_100',
    generatedAt: new Date().toISOString(),
    engineVersion: '2.1',
    schemaVersion: 2,
    status: 'assigned',
    licenseType: 'pro',
    edition: 'professional',
    termType: 'annual',
    allowOfflineValidation: true,
    maxOfflineDays: 30,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    metadata: { owner: 'cust_v2_100', plan: 'pro_annual' },
    ...overrides,
  };
}

function createV1LicenseRecord(overrides = {}) {
  const code = LicenseEngine.generateCode();
  return {
    id: `lic_v1_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    licenseCode: code,
    checksum: 'chk_v1_auto',
    customerId: 'cust_v1_100',
    generatedAt: new Date().toISOString(),
    engineVersion: '2.1',
    schemaVersion: 1,
    status: 'assigned',
    licenseType: 'standard',
    ...overrides,
  };
}

function createTestEnvironment(initialLicenses = [], initialActivations = [], initialPolicies = []) {
  const licenseRepo = new MemoryLicenseRepo(initialLicenses);
  const activationRepo = new MemoryActivationRepo(initialActivations);
  const policyRepo = new MemoryPolicyRepo(initialPolicies);
  const auditRepo = new MemoryAuditRepo();
  const service = new ActivationService(licenseRepo, activationRepo, policyRepo, auditRepo);
  return { licenseRepo, activationRepo, policyRepo, auditRepo, service };
}

// Convert a LicenseRecord to canonical LicenseDocumentV2 for binding validation test
function toLicenseDocumentV2(license, deviceId) {
  return {
    id: license.id,
    licenseCode: license.licenseCode,
    checksum: license.checksum || 'default_checksum',
    edition: license.edition || 'standard',
    term: license.termType || 'perpetual',
    status: license.status,
    owner: license.metadata?.owner || license.customerId || 'default_customer',
    customerId: license.customerId || null,
    deviceId,
    generatedAt: license.generatedAt,
    assignedAt: null,
    sentAt: null,
    activatedAt: null,
    suspendedAt: null,
    revokedAt: null,
    expiresAt: license.expiresAt || null,
    engineVersion: license.engineVersion || '2.1',
    schemaVersion: 2,
    offlinePolicy: {
      allowed: license.allowOfflineValidation ?? true,
      maxDays: license.allowOfflineValidation === false ? 0 : (license.maxOfflineDays ?? 30),
    },
    metadata: license.metadata || {},
  };
}

// 1. Nuova activate V2 -> receipt presente
test('AS-3: 1. Nuova activate V2 -> receipt presente', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const deviceId = 'dev_as3_test_01';

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_as3_1'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt, 'Receipt must be present on V2 activate');
  assert.ok(res.receipt.receipt, 'Receipt payload must be present');
});

// 2. Validate V2 -> receipt presente
test('AS-3: 2. Validate V2 -> receipt presente', async () => {
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_as3_test_02';
  const initialAct = {
    id: 'act_existing_02',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId,
    status: 'active',
    activatedAt: new Date().toISOString(),
  };
  const env = createTestEnvironment([lic], [initialAct]);

  const res = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_as3_2'
  );

  assert.equal(res.status, 'VALID');
  assert.ok(res.receipt, 'Receipt must be present on V2 validate');
  assert.equal(res.receipt.receipt.licenseId, lic.id);
});

// 3. Activate idempotente V2 -> receipt presente
test('AS-3: 3. Activate idempotente V2 -> receipt presente', async () => {
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_as3_test_03';
  const initialAct = {
    id: 'act_existing_03',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId,
    status: 'active',
    activatedAt: new Date(Date.now() - 3600000).toISOString(),
  };
  const env = createTestEnvironment([lic], [initialAct]);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_as3_3'
  );

  assert.equal(res.status, 'ALREADY_ACTIVE');
  assert.ok(res.receipt, 'Receipt must be present on V2 idempotent activate');
  assert.equal(res.receipt.receipt.licenseId, lic.id);
  assert.equal(res.receipt.receipt.deviceId, deviceId);
});

// 4. Riattivazione V2 -> receipt presente
test('AS-3: 4. Riattivazione V2 -> receipt presente', async () => {
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_as3_test_04';
  const initialDeact = {
    id: 'act_existing_04',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId,
    status: 'deactivated',
    activatedAt: new Date(Date.now() - 7200000).toISOString(),
    deactivatedAt: new Date(Date.now() - 3600000).toISOString(),
  };
  const env = createTestEnvironment([lic], [initialDeact]);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_as3_4'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt, 'Receipt must be present on V2 reactivation');
  assert.equal(res.receipt.receipt.licenseId, lic.id);
});

// 5. receiptVersion === 1
test('AS-3: 5. receiptVersion === 1', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_v1_check', productId: 'gestione-casa' },
    'req_5'
  );
  assert.equal(res.receipt.receipt.receiptVersion, 1);
});

// 6. licenseSchemaVersion === 2
test('AS-3: 6. licenseSchemaVersion === 2', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_v2_check', productId: 'gestione-casa' },
    'req_6'
  );
  assert.equal(res.receipt.receipt.licenseSchemaVersion, 2);
});

// 7. licenseId corretto
test('AS-3: 7. licenseId corretto', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_lic_check', productId: 'gestione-casa' },
    'req_7'
  );
  assert.equal(res.receipt.receipt.licenseId, lic.id);
});

// 8. deviceId corretto
test('AS-3: 8. deviceId corretto', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const deviceId = 'dev_explicit_id_08';
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_8'
  );
  assert.equal(res.receipt.receipt.deviceId, deviceId);
});

// 9. validatedAt ISO valido
test('AS-3: 9. validatedAt ISO valido', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_iso_check', productId: 'gestione-casa' },
    'req_9'
  );
  const validatedAt = res.receipt.receipt.validatedAt;
  assert.ok(!isNaN(Date.parse(validatedAt)), 'validatedAt must be a valid ISO 8601 string');
});

// 10. offlineValidUntil === null quando offline non consentito
test('AS-3: 10. offlineValidUntil === null quando offlinePolicy.allowed è false', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: false, maxOfflineDays: 0 });
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_off_null', productId: 'gestione-casa' },
    'req_10'
  );
  assert.equal(res.receipt.receipt.offlineValidUntil, null);
});

// 11. licenseExpiresAt corretto/null
test('AS-3: 11. licenseExpiresAt corretto / null', async () => {
  const expiresAt = '2028-12-31T23:59:59.000Z';
  const licWithExp = createV2LicenseRecord({ expiresAt });
  const licNoExp = createV2LicenseRecord({ expiresAt: null, termType: 'perpetual' });
  const env = createTestEnvironment([licWithExp, licNoExp]);

  const resWith = await env.service.activate(
    { licenseCode: licWithExp.licenseCode, deviceId: 'dev_exp_1', productId: 'gestione-casa' },
    'req_11a'
  );
  assert.equal(resWith.receipt.receipt.licenseExpiresAt, expiresAt);

  const resNo = await env.service.activate(
    { licenseCode: licNoExp.licenseCode, deviceId: 'dev_exp_2', productId: 'gestione-casa' },
    'req_11b'
  );
  assert.equal(resNo.receipt.receipt.licenseExpiresAt, null);
});

// 12. licensePayloadHash SHA-256 valido
test('AS-3: 12. licensePayloadHash SHA-256 valido (64 caratteri hex minuscoli)', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_hash_check', productId: 'gestione-casa' },
    'req_12'
  );
  assert.match(res.receipt.receipt.licensePayloadHash, /^[a-f0-9]{64}$/);
});

// 13. signatureAlgorithm === 'Ed25519'
test('AS-3: 13. signatureAlgorithm === "Ed25519"', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_alg_check', productId: 'gestione-casa' },
    'req_13'
  );
  assert.equal(res.receipt.signatureAlgorithm, 'Ed25519');
});

// 14. signatureVersion === 1
test('AS-3: 14. signatureVersion === 1', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_sigver_check', productId: 'gestione-casa' },
    'req_14'
  );
  assert.equal(res.receipt.signatureVersion, 1);
});

// 15. keyId valorizzato
test('AS-3: 15. keyId valorizzato non vuoto', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_keyid_check', productId: 'gestione-casa' },
    'req_15'
  );
  assert.ok(typeof res.receipt.keyId === 'string' && res.receipt.keyId.trim().length > 0);
});

// 16. firma Base64
test('AS-3: 16. firma codificata in Base64', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_b64_check', productId: 'gestione-casa' },
    'req_16'
  );
  assert.match(res.receipt.signature, /^[A-Za-z0-9+/=]+$/);
});

// 17. firma Ed25519 verificabile con public key
test('AS-3: 17. firma Ed25519 verificabile con public key', async () => {
  const keyPair = LicenseSigningService.generateKeyPair();
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_verify_crypto';

  const receipt = {
    receiptVersion: 1,
    receiptId: 'rcpt_verify_test_17',
    licenseId: lic.id,
    deviceId,
    licenseSchemaVersion: 2,
    validatedAt: new Date().toISOString(),
    offlineValidUntil: null,
    licenseExpiresAt: null,
    licensePayloadHash: computeLicensePayloadHashV2(toLicenseDocumentV2(lic, deviceId)),
  };

  const signed = LicenseSigningService.signValidationReceipt(receipt, keyPair.privateKey, 'key-2026-test');
  const isVerified = LicenseSigningService.verifySignedValidationReceipt(signed, keyPair.publicKey);
  assert.equal(isVerified, true, 'Signature must be verified using Ed25519 public key');
});

// 18. ActivationValidator.validateSignedValidationReceiptV1 PASS
test('AS-3: 18. ActivationValidator.validateSignedValidationReceiptV1 PASS', async () => {
  const lic = createV2LicenseRecord();
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_val_sdk', productId: 'gestione-casa' },
    'req_18'
  );

  const validation = ActivationValidator.validateSignedValidationReceiptV1(res.receipt);
  assert.equal(validation.isValid, true, `SDK Validation failed: ${JSON.stringify(validation.issues)}`);
  assert.equal(validation.issues.length, 0);
});

// 19. validateValidationReceiptBinding PASS
test('AS-3: 19. validateValidationReceiptBinding PASS con LicenseDocumentV2', async () => {
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_binding_19';
  const env = createTestEnvironment([lic]);
  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_19'
  );

  const licenseDoc = toLicenseDocumentV2(lic, deviceId);
  const bindingResult = validateValidationReceiptBinding(res.receipt.receipt, licenseDoc, deviceId);
  assert.equal(bindingResult.isValid, true, `Binding failed: ${JSON.stringify(bindingResult.issues)}`);
  assert.equal(bindingResult.issues.length, 0);
});

// 20. modifica/tampering della receipt -> verifica firma/binding fallisce
test('AS-3: 20. modifica/tampering della receipt -> verifica firma/binding fallisce', async () => {
  const keyPair = LicenseSigningService.generateKeyPair();
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_tamper_20';

  const receipt = {
    receiptVersion: 1,
    receiptId: 'rcpt_tamper_20',
    licenseId: lic.id,
    deviceId,
    licenseSchemaVersion: 2,
    validatedAt: new Date().toISOString(),
    offlineValidUntil: null,
    licenseExpiresAt: null,
    licensePayloadHash: computeLicensePayloadHashV2(toLicenseDocumentV2(lic, deviceId)),
  };

  const signed = LicenseSigningService.signValidationReceipt(receipt, keyPair.privateKey, 'test-key');

  // Tamper payload
  const tampered = {
    ...signed,
    receipt: {
      ...signed.receipt,
      licenseId: 'tampered_lic_id',
    },
  };

  const isVerified = LicenseSigningService.verifySignedValidationReceipt(tampered, keyPair.publicKey);
  assert.equal(isVerified, false, 'Tampered receipt must fail cryptographic verification');

  const licenseDoc = toLicenseDocumentV2(lic, deviceId);
  const bindingResult = validateValidationReceiptBinding(tampered.receipt, licenseDoc, deviceId);
  assert.equal(bindingResult.isValid, false, 'Tampered receipt must fail binding validation');
});

// 21. V1 activate continua a funzionare senza receipt V2
test('AS-3: 21. V1 activate continua a funzionare senza receipt V2', async () => {
  const lic = createV1LicenseRecord();
  const deviceId = 'dev_v1_act_21';
  const env = createTestEnvironment([lic]);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_21'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.signedLicense, 'V1 signed license must be present');
  assert.equal(res.receipt, undefined, 'V1 activate must NOT include receipt');
});

// 22. V1 validate continua a funzionare senza receipt V2
test('AS-3: 22. V1 validate continua a funzionare senza receipt V2', async () => {
  const lic = createV1LicenseRecord();
  const deviceId = 'dev_v1_val_22';
  const initialAct = {
    id: 'act_v1_22',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId,
    status: 'active',
    activatedAt: new Date().toISOString(),
  };
  const env = createTestEnvironment([lic], [initialAct]);

  const res = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_22'
  );

  assert.equal(res.status, 'VALID');
  assert.ok(res.signedLicense, 'V1 signed license must be present');
  assert.equal(res.receipt, undefined, 'V1 validate must NOT include receipt');
});

// 23. validazione V2 fallita non produce receipt
test('AS-3: 23. validazione V2 fallita non produce receipt', async () => {
  const licRevoked = createV2LicenseRecord({ status: 'revoked' });
  const licExpired = createV2LicenseRecord({
    status: 'assigned',
    expiresAt: new Date(Date.now() - 3600000).toISOString(),
  });
  const env = createTestEnvironment([licRevoked, licExpired]);

  const resRevoked = await env.service.validate(
    { licenseCode: licRevoked.licenseCode, deviceId: 'dev_rev', productId: 'gestione-casa' },
    'req_23a'
  );
  assert.equal(resRevoked.status, 'LICENSE_REVOKED');
  assert.equal(resRevoked.receipt, undefined);

  const resExpired = await env.service.validate(
    { licenseCode: licExpired.licenseCode, deviceId: 'dev_exp', productId: 'gestione-casa' },
    'req_23b'
  );
  assert.equal(resExpired.status, 'LICENSE_EXPIRED');
  assert.equal(resExpired.receipt, undefined);

  const resNotFound = await env.service.validate(
    { licenseCode: 'NON-EXISTENT-CODE-9999', deviceId: 'dev_nf', productId: 'gestione-casa' },
    'req_23c'
  );
  assert.equal(resNotFound.status, 'LICENSE_NOT_FOUND');
  assert.equal(resNotFound.receipt, undefined);
});

// 24. nessuna regressione sui precedenti flussi activate/validate/deactivate
test('AS-3: 24. nessuna regressione sui precedenti flussi activate/validate/deactivate', async () => {
  const lic = createV2LicenseRecord();
  const deviceId = 'dev_lifecycle_24';
  const env = createTestEnvironment([lic], [], [{ licenseId: lic.id, licenseType: 'pro', maxActivations: 1, allowOfflineValidation: true, maxOfflineDays: 30 }]);

  // 1. Activate
  const actRes = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_life_1'
  );
  assert.equal(actRes.status, 'ACTIVATED');
  assert.ok(actRes.receipt);

  // 2. Validate
  const valRes = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_life_2'
  );
  assert.equal(valRes.status, 'VALID');
  assert.ok(valRes.receipt);

  // 3. Deactivate
  const deactRes = await env.service.deactivate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_life_3'
  );
  assert.equal(deactRes.status, 'DEACTIVATED');

  // 4. Validate after deactivation -> DEVICE_MISMATCH without receipt
  const valFail = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_life_4'
  );
  assert.equal(valFail.status, 'DEVICE_MISMATCH');
  assert.equal(valFail.receipt, undefined);

  // 5. Reactivate
  const reactRes = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId, productId: 'gestione-casa' },
    'req_life_5'
  );
  assert.equal(reactRes.status, 'ACTIVATED');
  assert.ok(reactRes.receipt);
});

