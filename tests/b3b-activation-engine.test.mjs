import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ActivationService } from '../dist/services/activationService.js';
import { createApp } from '../dist/app.js';
import { LicenseSigningService } from '../dist/services/licenseSigningService.js';
import { LicenseEngine } from '@gestione-casa/shared-sdk/licensing';

// Helper Memory Repositories
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
  async deactivate(id, reason) {
    const found = this.activations.find((a) => a.id === id);
    if (found) {
      found.status = 'deactivated';
      found.deactivatedAt = new Date().toISOString();
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
    return found ? { ...found } : null;
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
    const event = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...record,
    };
    this.events.push(event);
    return event;
  }
}

const mockKeyPair = LicenseSigningService.generateKeyPair();

function createTestSetup(customMaxActivations = 1, customPolicyOverride = undefined) {
  const code = LicenseEngine.generateCode();
  const license = {
    id: 'lic_test_100',
    licenseCode: code,
    checksum: '7',
    customerId: 'cust_001',
    licenseType: 'STANDARD_TYPE',
    status: 'assigned',
    schemaVersion: 1,
    engineVersion: '2.1',
    generatedAt: new Date().toISOString(),
    expiresAt: null,
    maxActivations: 999, // MUST BE IGNORED in favor of policy!
  };

  let policy = null;
  if (customPolicyOverride === 'NO_POLICY') {
    policy = null;
  } else if (customPolicyOverride !== undefined) {
    policy = customPolicyOverride;
  } else {
    policy = {
      id: 'pol_test_100',
      licenseId: license.id,
      licenseType: license.licenseType,
      maxActivations: customMaxActivations, // AUTHORITATIVE SOURCE!
      allowReactivation: true,
      allowOfflineValidation: true,
      maxOfflineDays: 30,
    };
  }

  const licenseRepo = new MemoryLicenseRepo([license]);
  const activationRepo = new MemoryActivationRepo([]);
  const policyRepo = new MemoryPolicyRepo(policy ? [policy] : []);
  const auditRepo = new MemoryAuditRepo();

  const service = new ActivationService(licenseRepo, activationRepo, policyRepo, auditRepo);

  return { code, license, policy, licenseRepo, activationRepo, policyRepo, auditRepo, service };
}

test('1. Valid license + slot available -> PASS (ACTIVATED)', async () => {
  const { code, service, auditRepo } = createTestSetup(1);
  const res = await service.activate(
    {
      licenseCode: code,
      deviceId: 'DEV-1111-2222',
      productId: 'gestione-casa-ocr',
      appVersion: '1.0.0',
    },
    'req-1'
  );

  assert.equal(res.status, 'ACTIVATED');
  assert.ok(res.activationId);
  assert.ok(res.signedLicense);
  assert.equal(res.signedLicense.license.deviceId, 'DEV-1111-2222');
  assert.equal(res.signedLicense.license.licenseCode, code);

  // Check audit
  assert.equal(auditRepo.events.length, 1);
  assert.equal(auditRepo.events[0].eventType, 'ACTIVATION_SUCCESS');
  assert.equal(auditRepo.events[0].success, true);
});

test('2. Same license + same device -> Idempotent (ALREADY_ACTIVE)', async () => {
  const { code, service, activationRepo, auditRepo } = createTestSetup(1);
  const payload = {
    licenseCode: code,
    deviceId: 'DEV-1111-2222',
    productId: 'gestione-casa-ocr',
    appVersion: '1.0.0',
  };

  const res1 = await service.activate(payload, 'req-1');
  assert.equal(res1.status, 'ACTIVATED');

  const countBefore = await activationRepo.countActiveByLicense('lic_test_100');
  assert.equal(countBefore, 1);

  // Second request from SAME device
  const res2 = await service.activate(payload, 'req-2');
  assert.equal(res2.status, 'ALREADY_ACTIVE');
  assert.equal(res2.activationId, res1.activationId);

  const countAfter = await activationRepo.countActiveByLicense('lic_test_100');
  assert.equal(countAfter, 1); // Slot NOT re-consumed!

  assert.equal(auditRepo.events.length, 2);
  assert.equal(auditRepo.events[1].eventType, 'ACTIVATION_IDEMPOTENT');
});

test('3. Max activations reached -> Reject (ACTIVATION_LIMIT_REACHED)', async () => {
  const { code, service, auditRepo } = createTestSetup(1);
  await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  // Request from second device when maxActivations = 1
  const res2 = await service.activate(
    { licenseCode: code, deviceId: 'DEV-3333-4444', productId: 'gestione-casa-ocr' },
    'req-2'
  );

  assert.equal(res2.status, 'ACTIVATION_LIMIT_REACHED');
  assert.equal(res2.signedLicense, undefined);

  assert.equal(auditRepo.events.length, 2);
  assert.equal(auditRepo.events[1].eventType, 'ACTIVATION_REJECTED_LIMIT_REACHED');
});

test('4. License inesistente -> Reject (LICENSE_NOT_FOUND)', async () => {
  const { service, auditRepo } = createTestSetup(1);
  const res = await service.activate(
    { licenseCode: 'XXXX-YYYY-ZZZZ-WWWW', deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(res.status, 'LICENSE_NOT_FOUND');
  assert.equal(auditRepo.events.length, 1);
  assert.equal(auditRepo.events[0].eventType, 'ACTIVATION_REJECTED_INVALID_LICENSE');
});

test('5. License scaduta -> Reject (LICENSE_EXPIRED)', async () => {
  const { code, licenseRepo, service, auditRepo } = createTestSetup(1);
  const license = await licenseRepo.findByCode(code);
  license.expiresAt = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
  await licenseRepo.save(license);

  const res = await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(res.status, 'LICENSE_EXPIRED');
  assert.equal(auditRepo.events.length, 1);
  assert.equal(auditRepo.events[0].eventType, 'ACTIVATION_REJECTED_EXPIRED');
});

test('6. Policy assente -> Reject', async () => {
  const { code, service, auditRepo } = createTestSetup(1, 'NO_POLICY'); // No policy
  const res = await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(res.status, 'ACTIVATION_LIMIT_REACHED');
  assert.equal(auditRepo.events.length, 1);
  assert.equal(auditRepo.events[0].eventType, 'ACTIVATION_REJECTED_NO_POLICY');
});

test('7. Policy max_activations non valida -> Reject', async () => {
  const customPolicy = {
    id: 'pol_invalid',
    licenseId: 'lic_test_100',
    licenseType: 'STANDARD_TYPE',
    maxActivations: 0, // Invalid limit!
  };
  const { code, service, auditRepo } = createTestSetup(1, customPolicy);
  const res = await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(res.status, 'ACTIVATION_LIMIT_REACHED');
  assert.equal(auditRepo.events.length, 1);
  assert.equal(auditRepo.events[0].eventType, 'ACTIVATION_REJECTED_NO_POLICY');
});

test('8. Due device entro limite -> PASS', async () => {
  const { code, service, activationRepo } = createTestSetup(2); // Limit = 2

  const res1 = await service.activate(
    { licenseCode: code, deviceId: 'DEV-DEVICE-A', productId: 'gestione-casa-ocr' },
    'req-1'
  );
  assert.equal(res1.status, 'ACTIVATED');

  const res2 = await service.activate(
    { licenseCode: code, deviceId: 'DEV-DEVICE-B', productId: 'gestione-casa-ocr' },
    'req-2'
  );
  assert.equal(res2.status, 'ACTIVATED');

  const count = await activationRepo.countActiveByLicense('lic_test_100');
  assert.equal(count, 2);
});

test('9. Richiesta successiva oltre limite -> Reject', async () => {
  const { code, service } = createTestSetup(2); // Limit = 2

  await service.activate(
    { licenseCode: code, deviceId: 'DEV-DEVICE-A', productId: 'gestione-casa-ocr' },
    'req-1'
  );
  await service.activate(
    { licenseCode: code, deviceId: 'DEV-DEVICE-B', productId: 'gestione-casa-ocr' },
    'req-2'
  );

  // 3rd device beyond limit 2
  const res3 = await service.activate(
    { licenseCode: code, deviceId: 'DEV-DEVICE-C', productId: 'gestione-casa-ocr' },
    'req-3'
  );
  assert.equal(res3.status, 'ACTIVATION_LIMIT_REACHED');
});

test('10. Errore repository -> Gestione controllata (SERVER_ERROR)', async () => {
  const { code } = createTestSetup(1);
  const faultyRepo = {
    async findByCode() {
      throw new Error('Database connection lost');
    },
  };
  const service = new ActivationService(faultyRepo, new MemoryActivationRepo(), new MemoryPolicyRepo(), new MemoryAuditRepo());

  const res = await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(res.message, 'An internal server error occurred');
});

test('11. Audit log successo registrato correttamente', async () => {
  const { code, service, auditRepo } = createTestSetup(1);
  await service.activate(
    { licenseCode: code, deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(auditRepo.events.length, 1);
  const event = auditRepo.events[0];
  assert.equal(event.eventType, 'ACTIVATION_SUCCESS');
  assert.equal(event.requestId, 'req-1');
  assert.equal(event.deviceId, 'DEV-1111-2222');
  assert.ok(event.licenseCodeMasked.includes('****'));
});

test('12. Audit log rifiuto registrato correttamente', async () => {
  const { service, auditRepo } = createTestSetup(1);
  await service.activate(
    { licenseCode: 'INVALID-CODE-0000', deviceId: 'DEV-1111-2222', productId: 'gestione-casa-ocr' },
    'req-1'
  );

  assert.equal(auditRepo.events.length, 1);
  const event = auditRepo.events[0];
  assert.equal(event.eventType, 'ACTIVATION_REJECTED_INVALID_LICENSE');
  assert.equal(event.success, false);
});

test('13. Concurrency protection - parallel activation requests within limit', async () => {
  const { code, service, activationRepo } = createTestSetup(1); // max_activations = 1

  // Fire 2 concurrent activation requests for DIFFERENT devices at the exact same time
  const [res1, res2] = await Promise.all([
    service.activate({ licenseCode: code, deviceId: 'DEV-PARALLEL-1', productId: 'gestione-casa-ocr' }, 'req-p1'),
    service.activate({ licenseCode: code, deviceId: 'DEV-PARALLEL-2', productId: 'gestione-casa-ocr' }, 'req-p2'),
  ]);

  const statuses = [res1.status, res2.status].sort();
  // Exactly 1 MUST succeed and 1 MUST be rejected with ACTIVATION_LIMIT_REACHED
  assert.deepEqual(statuses, ['ACTIVATED', 'ACTIVATION_LIMIT_REACHED']);

  const activeCount = await activationRepo.countActiveByLicense('lic_test_100');
  assert.equal(activeCount, 1);
});

test('14. End-to-end HTTP POST /api/licenses/activate returns valid ActivationResponse', async () => {
  const app = createApp();
  const validCode = LicenseEngine.generateCode();

  const payload = {
    licenseCode: validCode,
    deviceId: 'DEV-HTTP-1234',
    productId: 'gestione-casa-ocr',
    appVersion: '1.0.0',
  };

  const res = await request(app).post('/api/licenses/activate').send(payload);

  assert.equal(res.status, 200);
  assert.ok(res.body.status);
  assert.ok(res.body.serverTime);
  assert.ok(res.headers['x-request-id']);
});
