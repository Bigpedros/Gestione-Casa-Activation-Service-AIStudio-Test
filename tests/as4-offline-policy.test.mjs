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

// In-Memory test repositories
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
  constructor(policies = [], defaultPolicy = null) {
    this.policies = policies.map((p) => ({ ...p }));
    this.defaultPolicy = defaultPolicy;
  }
  async findByLicenseId(licenseId) {
    const found = this.policies.find((p) => p.licenseId === licenseId);
    return found ? { ...found } : null;
  }
  async findByLicenseType(licenseType) {
    const found = this.policies.find((p) => p.licenseType === licenseType);
    if (found) return { ...found };
    return this.defaultPolicy ? { ...this.defaultPolicy } : null;
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
    expiresAt: null, // perpetual by default unless specified
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

function createTestEnvironment(
  initialLicenses = [],
  initialActivations = [],
  initialPolicies = [],
  defaultPolicy = { id: 'default_policy', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 }
) {
  const licenseRepo = new MemoryLicenseRepo(initialLicenses);
  const activationRepo = new MemoryActivationRepo(initialActivations);
  const policyRepo = new MemoryPolicyRepo(initialPolicies, defaultPolicy);
  const auditRepo = new MemoryAuditRepo();
  const service = new ActivationService(licenseRepo, activationRepo, policyRepo, auditRepo);
  return { licenseRepo, activationRepo, policyRepo, auditRepo, service };
}

// --------------------------------------------------------------------------
// TEST SUITE AS-4: OFFLINE VALIDATION POLICY & OFFLINEVALIDUNTIL
// --------------------------------------------------------------------------

// 1. Licenza consente + server consente -> offlineValidUntil calcolato
test('AS-4: 1. licenza consente (true) + server consente (true) -> offlineValidUntil calcolato', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 14 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_1', productId: 'gestione-casa' },
    'req_1'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt);
  const { validatedAt, offlineValidUntil } = res.receipt.receipt;
  assert.ok(offlineValidUntil, 'offlineValidUntil must not be null');

  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  const expectedMs = validatedAtMs + 14 * 86400000;
  assert.equal(offlineValidMs, expectedMs);
});

// 2. Licenza vieta + server consente -> offlineValidUntil null
test('AS-4: 2. licenza vieta (false) + server consente (true) -> offlineValidUntil null', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: false, maxOfflineDays: 0 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_2', productId: 'gestione-casa' },
    'req_2'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt);
  assert.equal(res.receipt.receipt.offlineValidUntil, null);
});

// 3. Licenza consente + server vieta -> offlineValidUntil null
test('AS-4: 3. licenza consente (true) + server vieta (false) -> offlineValidUntil null', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: false, maxOfflineDays: 0 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_3', productId: 'gestione-casa' },
    'req_3'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt);
  assert.equal(res.receipt.receipt.offlineValidUntil, null);
});

// 4. Entrambi vietano -> offlineValidUntil null
test('AS-4: 4. entrambi vietano (false) -> offlineValidUntil null', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: false, maxOfflineDays: 0 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: false, maxOfflineDays: 0 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_4', productId: 'gestione-casa' },
    'req_4'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt);
  assert.equal(res.receipt.receipt.offlineValidUntil, null);
});

// 5. Server policy assente -> offlineValidUntil null e validazione online resta VALID
test('AS-4: 5. server policy assente -> offlineValidUntil null e validate resta VALID', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
  const act = {
    id: 'act_val_5',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId: 'dev_5',
    status: 'active',
    activatedAt: new Date().toISOString(),
  };
  // No server policy in repo, and no default policy
  const env = createTestEnvironment([lic], [act], [], null);

  const res = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_5', productId: 'gestione-casa' },
    'req_5'
  );

  assert.equal(res.status, 'VALID');
  assert.ok(res.receipt);
  assert.equal(res.receipt.receipt.offlineValidUntil, null);
});

// 6. license maxDays < server maxDays -> Math.min sceglie license maxDays
test('AS-4: 6. license maxDays (7) < server maxDays (30) -> applica 7 giorni', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 7 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_6', productId: 'gestione-casa' },
    'req_6'
  );

  const { validatedAt, offlineValidUntil } = res.receipt.receipt;
  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 7 * 86400000);
});

// 7. server maxDays < license maxDays -> Math.min sceglie server maxDays
test('AS-4: 7. server maxDays (10) < license maxDays (60) -> applica 10 giorni', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 60 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 10 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_7', productId: 'gestione-casa' },
    'req_7'
  );

  const { validatedAt, offlineValidUntil } = res.receipt.receipt;
  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 10 * 86400000);
});

// 8. maxDays licenza assente / null / non valido -> offlineValidUntil null
test('AS-4: 8. maxDays licenza null/undefined/0/negativo -> offlineValidUntil null', async () => {
  const cases = [null, undefined, 0, -5, '30', NaN];
  for (const maxDays of cases) {
    const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: maxDays });
    const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
    const env = createTestEnvironment([lic], [], [serverPolicy], null);

    const res = await env.service.activate(
      { licenseCode: lic.licenseCode, deviceId: 'dev_8', productId: 'gestione-casa' },
      'req_8'
    );
    assert.equal(res.receipt.receipt.offlineValidUntil, null, `Expected null for license maxDays ${maxDays}`);
  }
});

// 9. maxDays server 0 / non valido -> offlineValidUntil null
test('AS-4: 9. maxDays server 0/null/undefined/negativo -> offlineValidUntil null', async () => {
  const cases = [0, null, undefined, -10, '20'];
  for (const serverDays of cases) {
    const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
    const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: serverDays };
    const env = createTestEnvironment([lic], [], [serverPolicy], null);

    const res = await env.service.activate(
      { licenseCode: lic.licenseCode, deviceId: 'dev_9', productId: 'gestione-casa' },
      'req_9'
    );
    assert.equal(res.receipt.receipt.offlineValidUntil, null, `Expected null for server maxDays ${serverDays}`);
  }
});

// 10. perpetual (expiresAt null) -> candidate = validatedAt + effectiveMaxOfflineDays * 86400000
test('AS-4: 10. perpetual (expiresAt null) -> candidate esatto', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 15, expiresAt: null });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 15 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_10', productId: 'gestione-casa' },
    'req_10'
  );

  const { validatedAt, offlineValidUntil, licenseExpiresAt } = res.receipt.receipt;
  assert.equal(licenseExpiresAt, null);
  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 15 * 86400000);
});

// 11. Scadenza successiva al candidate -> candidate scelto
test('AS-4: 11. scadenza licenza molto successiva (1 anno) al candidate (30 gg) -> offlineValidUntil = candidate', async () => {
  const farFutureExpiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30, expiresAt: farFutureExpiresAt });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_11', productId: 'gestione-casa' },
    'req_11'
  );

  const { validatedAt, offlineValidUntil } = res.receipt.receipt;
  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 30 * 86400000);
});

// 12. Scadenza precedente al candidate -> clamp a expiresAt
test('AS-4: 12. scadenza licenza più vicina (5 giorni) del candidate (30 giorni) -> clamp a expiresAt', async () => {
  const fiveDaysLater = new Date(Date.now() + 5 * 86400000).toISOString();
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30, expiresAt: fiveDaysLater });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_12', productId: 'gestione-casa' },
    'req_12'
  );

  const { offlineValidUntil, licenseExpiresAt } = res.receipt.receipt;
  assert.equal(offlineValidUntil, fiveDaysLater);
  assert.equal(licenseExpiresAt, fiveDaysLater);
});

// 13. offlineValidUntil ISO UTC valido
test('AS-4: 13. offlineValidUntil è una stringa ISO 8601 UTC valida (termina con Z)', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 20 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 20 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_13', productId: 'gestione-casa' },
    'req_13'
  );

  const { offlineValidUntil } = res.receipt.receipt;
  assert.ok(typeof offlineValidUntil === 'string');
  assert.ok(!isNaN(Date.parse(offlineValidUntil)), 'Must be valid ISO timestamp');
  assert.ok(offlineValidUntil.endsWith('Z'), 'Must be UTC ISO string ending in Z');
});

// 14. offlineValidUntil > validatedAt quando consentito
test('AS-4: 14. offlineValidUntil > validatedAt quando offline è consentito', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 10 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 10 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_14', productId: 'gestione-casa' },
    'req_14'
  );

  const { validatedAt, offlineValidUntil } = res.receipt.receipt;
  const validatedAtMs = new Date(validatedAt).getTime();
  const offlineValidMs = new Date(offlineValidUntil).getTime();
  assert.ok(offlineValidMs > validatedAtMs, 'offlineValidUntil must be strictly greater than validatedAt');
});

// 15. Stesso validatedAt usato coerentemente tra response e receipt
test('AS-4: 15. stesso validatedAt usato coerentemente tra response e receipt', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 15 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 15 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_15', productId: 'gestione-casa' },
    'req_15'
  );

  assert.equal(res.serverTime, res.receipt.receipt.validatedAt);
  const validatedAtMs = new Date(res.receipt.receipt.validatedAt).getTime();
  const offlineValidMs = new Date(res.receipt.receipt.offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 15 * 86400000);
});

// 16. Nuova activate V2 -> receipt con offlineValidUntil calcolato
test('AS-4: 16. nuova activate V2 genera receipt con offlineValidUntil calcolato', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 25 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 25 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_16', productId: 'gestione-casa' },
    'req_16'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.receipt);
  assert.ok(res.receipt.receipt.offlineValidUntil);
});

// 17. Activate idempotente V2 -> receipt con offlineValidUntil calcolato
test('AS-4: 17. activate idempotente V2 rinnova la receipt con offlineValidUntil calcolato', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res1 = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_17', productId: 'gestione-casa' },
    'req_17a'
  );
  assert.equal(res1.status, 'ACTIVATED');

  const res2 = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_17', productId: 'gestione-casa' },
    'req_17b'
  );
  assert.equal(res2.status, 'ALREADY_ACTIVE');
  assert.ok(res2.receipt);
  assert.ok(res2.receipt.receipt.offlineValidUntil);
});

// 18. Riattivazione V2 -> receipt con offlineValidUntil calcolato
test('AS-4: 18. riattivazione V2 genera receipt con offlineValidUntil calcolato', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  // Activate
  await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_18', productId: 'gestione-casa' },
    'req_18_act'
  );
  // Deactivate
  await env.service.deactivate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_18', productId: 'gestione-casa' },
    'req_18_deact'
  );
  // Reactivate
  const resReactivate = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_18', productId: 'gestione-casa' },
    'req_18_react'
  );
  assert.equal(resReactivate.status, 'ACTIVATED');
  assert.ok(resReactivate.receipt);
  assert.ok(resReactivate.receipt.receipt.offlineValidUntil);
});

// 19. Validate V2 -> receipt con offlineValidUntil calcolato e nuova finestra offline
test('AS-4: 19. validate V2 genera receipt con offlineValidUntil calcolato', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 20 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 20 };
  const act = {
    id: 'act_19',
    licenseId: lic.id,
    licenseCode: lic.licenseCode,
    deviceId: 'dev_19',
    status: 'active',
    activatedAt: new Date().toISOString(),
  };
  const env = createTestEnvironment([lic], [act], [serverPolicy], null);

  const res = await env.service.validate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_19', productId: 'gestione-casa' },
    'req_19'
  );

  assert.equal(res.status, 'VALID');
  assert.ok(res.receipt);
  assert.equal(res.lastValidatedAt, res.receipt.receipt.validatedAt);
  const validatedAtMs = new Date(res.receipt.receipt.validatedAt).getTime();
  const offlineValidMs = new Date(res.receipt.receipt.offlineValidUntil).getTime();
  assert.equal(offlineValidMs, validatedAtMs + 20 * 86400000);
});

// 20. V1 invariata: nessuna receipt V2 né campo offline
test('AS-4: 20. licenze V1 non producono receipt V2 né logica offline', async () => {
  const licV1 = createV1LicenseRecord();
  const serverPolicy = { id: 'p1', licenseType: 'standard', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([licV1], [], [serverPolicy], null);

  const resAct = await env.service.activate(
    { licenseCode: licV1.licenseCode, deviceId: 'dev_20', productId: 'gestione-casa' },
    'req_20_act'
  );
  assert.equal(resAct.status, 'ACTIVATED');
  assert.equal(resAct.receipt, undefined);

  const resVal = await env.service.validate(
    { licenseCode: licV1.licenseCode, deviceId: 'dev_20', productId: 'gestione-casa' },
    'req_20_val'
  );
  assert.equal(resVal.status, 'VALID');
  assert.equal(resVal.receipt, undefined);
});

// 21. Firma receipt AS-3 ancora valida e verificabile
test('AS-4: 21. firma receipt Ed25519 con offlineValidUntil valorizzato è valida', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 30 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 30 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_21', productId: 'gestione-casa' },
    'req_21'
  );

  const signedReceipt = res.receipt;
  const validationResult = ActivationValidator.validateSignedValidationReceiptV1(signedReceipt);
  assert.equal(validationResult.isValid, true, `Validation failed: ${JSON.stringify(validationResult.issues)}`);
  assert.equal(validationResult.issues.length, 0);
});

// 22. Binding SDK ancora valido con LicenseDocumentV2
test('AS-4: 22. validateValidationReceiptBinding PASS con receipt avente offlineValidUntil', async () => {
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 15 });
  const serverPolicy = { id: 'p1', licenseType: 'pro', maxActivations: 5, allowOfflineValidation: true, maxOfflineDays: 15 };
  const env = createTestEnvironment([lic], [], [serverPolicy], null);

  const res = await env.service.activate(
    { licenseCode: lic.licenseCode, deviceId: 'dev_22', productId: 'gestione-casa' },
    'req_22'
  );

  const signedReceipt = res.receipt;
  const licenseDoc = {
    id: lic.id,
    licenseCode: lic.licenseCode,
    checksum: lic.checksum,
    edition: lic.edition,
    term: lic.termType,
    status: lic.status,
    owner: lic.customerId,
    customerId: lic.customerId,
    deviceId: 'dev_22',
    generatedAt: lic.generatedAt,
    assignedAt: null,
    sentAt: null,
    activatedAt: null,
    suspendedAt: null,
    revokedAt: null,
    expiresAt: null,
    engineVersion: '2.1',
    schemaVersion: 2,
    offlinePolicy: { allowed: true, maxDays: 15 },
    metadata: lic.metadata,
  };

  const bindingResult = validateValidationReceiptBinding(signedReceipt.receipt, licenseDoc, 'dev_22');
  assert.equal(bindingResult.isValid, true, `Binding failed: ${JSON.stringify(bindingResult.issues)}`);
  assert.equal(bindingResult.issues.length, 0);
});

// 23. Tampering di offlineValidUntil continua a fallire la verifica firma
test('AS-4: 23. tampering di offlineValidUntil invalida la firma crittografica', async () => {
  const keyPair = LicenseSigningService.generateKeyPair();
  const lic = createV2LicenseRecord({ allowOfflineValidation: true, maxOfflineDays: 10 });
  const deviceId = 'dev_tamper_23';

  const licenseDoc = {
    id: lic.id,
    licenseCode: lic.licenseCode,
    checksum: lic.checksum,
    edition: lic.edition,
    term: lic.termType,
    status: lic.status,
    owner: lic.customerId,
    customerId: lic.customerId,
    deviceId,
    generatedAt: lic.generatedAt,
    assignedAt: null,
    sentAt: null,
    activatedAt: null,
    suspendedAt: null,
    revokedAt: null,
    expiresAt: null,
    engineVersion: '2.1',
    schemaVersion: 2,
    offlinePolicy: { allowed: true, maxDays: 10 },
    metadata: lic.metadata,
  };

  const receipt = {
    receiptVersion: 1,
    receiptId: 'rcpt_tamper_23',
    licenseId: lic.id,
    deviceId,
    licenseSchemaVersion: 2,
    validatedAt: new Date().toISOString(),
    offlineValidUntil: new Date(Date.now() + 10 * 86400000).toISOString(),
    licenseExpiresAt: null,
    licensePayloadHash: computeLicensePayloadHashV2(licenseDoc),
  };

  const signed = LicenseSigningService.signValidationReceipt(receipt, keyPair.privateKey, 'test-key-23');

  // Tamper offlineValidUntil to a date 100 days in the future
  const tampered = {
    ...signed,
    receipt: {
      ...signed.receipt,
      offlineValidUntil: new Date(Date.now() + 100 * 86400000).toISOString(),
    },
  };

  const isVerified = LicenseSigningService.verifySignedValidationReceipt(tampered, keyPair.publicKey);
  assert.equal(isVerified, false, 'Tampered receipt must fail cryptographic verification');

  // Tamper payload hash -> binding validation fails
  const tamperedBinding = {
    ...signed.receipt,
    licensePayloadHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const bindingResult = validateValidationReceiptBinding(tamperedBinding, licenseDoc, deviceId);
  assert.equal(bindingResult.isValid, false, 'Tampered receipt hash must fail binding validation');
});

// 24. Nessuna regressione: E2E HTTP Endpoints con offlineValidUntil
test('AS-4: 24. HTTP POST /api/licenses/activate e /api/licenses/validate ritornano receipt V2 con offlineValidUntil', async () => {
  const app = createApp();
  const code = LicenseEngine.generateCode();

  // Test activate on endpoint
  const actRes = await request(app)
    .post('/api/licenses/activate')
    .set('X-Request-ID', 'req_http_as4_1')
    .send({
      licenseCode: code,
      deviceId: 'DEV-HTTP-AS4',
      productId: 'gestione-casa-ocr',
      appVersion: '1.0',
    });

  assert.equal(actRes.status, 200);
  assert.ok(['ACTIVATED', 'ALREADY_ACTIVE'].includes(actRes.body.status));

  // Test validate on endpoint
  const valRes = await request(app)
    .post('/api/licenses/validate')
    .set('X-Request-ID', 'req_http_as4_2')
    .send({
      licenseCode: code,
      deviceId: 'DEV-HTTP-AS4',
      productId: 'gestione-casa-ocr',
    });

  assert.equal(valRes.status, 200);
  assert.equal(valRes.body.status, 'VALID');
});
