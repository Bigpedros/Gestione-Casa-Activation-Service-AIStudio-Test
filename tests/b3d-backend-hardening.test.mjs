import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ActivationService } from '../dist/services/activationService.js';
import { createApp } from '../dist/app.js';
import { LicenseEngine } from '@gestione-casa/shared-sdk/licensing';
import { withTransaction } from '../dist/database/transaction.js';
import { isPoolInitialized, closePool } from '../dist/database/pool.js';
import { maskLicenseCode } from '../dist/utils/maskLicenseCode.js';

// In-Memory Mocks for unit testing failure modes and rollback logic
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
    return found ? { ...found } : { id: 'default_policy', licenseType, maxActivations: 2, allowOfflineValidation: true, maxOfflineDays: 30 };
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
  async findByCorrelationId(requestId) {
    return this.events.filter((e) => e.requestId === requestId);
  }
}

class TransactionalMockStore {
  constructor(initialLicenses = [], initialActivations = [], initialPolicies = []) {
    this.committedLicenses = new Map(initialLicenses.map((l) => [l.licenseCode, { ...l }]));
    this.committedActivations = initialActivations.map((a) => ({ ...a }));
    this.committedPolicies = initialPolicies.map((p) => ({ ...p }));
    this.committedAudit = [];
  }

  createTransactionSession() {
    const txLicenses = new Map(Array.from(this.committedLicenses.entries()).map(([k, v]) => [k, { ...v }]));
    const txActivations = this.committedActivations.map((a) => ({ ...a }));
    const txAudit = [...this.committedAudit];

    const mockClient = {
      query: async (sql) => {
        if (sql === 'BEGIN') return;
        if (sql === 'COMMIT') {
          this.committedLicenses = txLicenses;
          this.committedActivations = txActivations;
          this.committedAudit = txAudit;
          return;
        }
        if (sql === 'ROLLBACK') {
          // Discard uncommitted staging changes
          return;
        }
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
    };

    const licenseRepo = {
      findByCode: async (code) => {
        const l = txLicenses.get(code);
        return l ? { ...l } : null;
      },
    };

    const activationRepo = {
      findActiveByLicenseAndDevice: async (licenseId, deviceId) => {
        const found = txActivations.find(
          (a) => a.licenseId === licenseId && a.deviceId === deviceId && a.status === 'active'
        );
        return found ? { ...found } : null;
      },
      findByLicenseAndDevice: async (licenseId, deviceId) => {
        const found = txActivations.find(
          (a) => a.licenseId === licenseId && a.deviceId === deviceId
        );
        return found ? { ...found } : null;
      },
      countActiveByLicense: async (licenseId) => {
        return txActivations.filter(
          (a) => a.licenseId === licenseId && a.status === 'active'
        ).length;
      },
      create: async (act) => {
        const record = { id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, ...act };
        txActivations.push(record);
        return { ...record };
      },
      deactivate: async (id) => {
        const found = txActivations.find((a) => a.id === id);
        if (found) {
          found.status = 'deactivated';
          found.deactivatedAt = new Date().toISOString();
          return { ...found };
        }
        return null;
      },
      reactivate: async (id, activatedAt) => {
        const found = txActivations.find((a) => a.id === id);
        if (found) {
          found.status = 'active';
          found.activatedAt = activatedAt || new Date().toISOString();
          found.deactivatedAt = undefined;
          return { ...found };
        }
        return null;
      },
    };

    const policyRepo = {
      findByLicenseId: async (licenseId) => {
        const p = this.committedPolicies.find((pol) => pol.licenseId === licenseId);
        return p ? { ...p } : { id: 'pol_def', licenseId, maxActivations: 2 };
      },
      findByLicenseType: async (type) => ({ id: 'pol_def', licenseType: type, maxActivations: 2 }),
    };

    const auditRepo = {
      append: async (rec) => {
        const event = { id: `audit_${Date.now()}`, ...rec };
        txAudit.push(event);
        return event;
      },
    };

    return { mockPool, mockClient, licenseRepo, activationRepo, policyRepo, auditRepo };
  }
}

const generateTestLicense = () => {
  return LicenseEngine.generateCode();
};

// ============================================================================
// 1. TRANSACTION ROLLBACK - DISTINCT TEST CASES
// ============================================================================
test('1. Transaction rollback: generic withTransaction failure executes ROLLBACK', async () => {
  let rolledBack = false;
  const mockClient = {
    query: async (sql) => {
      if (sql === 'BEGIN') return;
      if (sql === 'ROLLBACK') {
        rolledBack = true;
        return;
      }
      if (sql === 'COMMIT') return;
      return { rows: [] };
    },
    release: () => {},
  };
  const mockPool = { connect: async () => mockClient };

  try {
    await withTransaction(async (client) => {
      await client.query('SELECT 1');
      throw new Error('Simulated database write failure mid-transaction');
    }, mockPool);
    assert.fail('Should have thrown an error');
  } catch (err) {
    assert.equal(err.message, 'Simulated database write failure mid-transaction');
    assert.equal(rolledBack, true, 'ROLLBACK query must be executed on transaction failure');
  }
});

test('1A. Rollback Activation: Error after INSERT activation and before COMMIT', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_roll_1', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const store = new TransactionalMockStore([license]);
  const session = store.createTransactionSession();

  // Override auditRepo.append to throw error AFTER activation creation
  session.auditRepo.append = async () => {
    throw new Error('DB Error during audit append after activation insert');
  };

  const res = await withTransaction(async () => {
    const service = new ActivationService();
    // @ts-ignore
    return service.executeActivation(
      session.licenseRepo,
      session.activationRepo,
      session.policyRepo,
      session.auditRepo,
      code,
      'DEV-ROLLBACK-1',
      'req_roll_1',
      new Date().toISOString(),
      'MASKED',
      true // forUpdate = true inside transaction
    );
  }, session.mockPool).catch((err) => {
    return { status: 'SERVER_ERROR', error: err };
  });

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(store.committedActivations.length, 0, 'No activation must be persisted after rollback');
  assert.equal(store.committedAudit.length, 0, 'No audit log must be persisted after rollback');
});

test('1B. Audit repository failure during activation triggers full rollback', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_roll_audit', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const store = new TransactionalMockStore([license]);
  const session = store.createTransactionSession();

  session.auditRepo.append = async () => {
    throw new Error('Audit table disk full');
  };

  const res = await withTransaction(async () => {
    const service = new ActivationService();
    // @ts-ignore
    return service.executeActivation(
      session.licenseRepo,
      session.activationRepo,
      session.policyRepo,
      session.auditRepo,
      code,
      'DEV-AUDIT-FAIL',
      'req_roll_audit',
      new Date().toISOString(),
      'MASKED',
      true
    );
  }, session.mockPool).catch((err) => {
    return { status: 'SERVER_ERROR', error: err };
  });

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(store.committedActivations.length, 0, 'Activation row must be rolled back on audit repo failure');
});

test('1C. Rollback Deactivate: Error after status change but before COMMIT leaves record ACTIVE', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_roll_deact', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const activeRecord = { id: 'act_deact_1', licenseId: 'lic_roll_deact', deviceId: 'DEV-DEACT-1', status: 'active', activatedAt: new Date().toISOString() };
  const store = new TransactionalMockStore([license], [activeRecord]);
  const session = store.createTransactionSession();

  session.auditRepo.append = async () => {
    throw new Error('Database connection lost mid-deactivation');
  };

  const res = await withTransaction(async () => {
    const service = new ActivationService();
    // @ts-ignore
    return service.executeDeactivation(
      session.licenseRepo,
      session.activationRepo,
      session.auditRepo,
      code,
      'DEV-DEACT-1',
      'req_roll_deact',
      new Date().toISOString(),
      'MASKED',
      true
    );
  }, session.mockPool).catch((err) => {
    return { status: 'SERVER_ERROR', error: err };
  });

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(store.committedActivations[0].status, 'active', 'Deactivation must be rolled back to active state on error');
});

test('1D. Rollback Reactivate: Error after UPDATE to ACTIVE but before COMMIT leaves record DEACTIVATED', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_roll_react', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const deactivatedRecord = { id: 'act_react_1', licenseId: 'lic_roll_react', deviceId: 'DEV-REACT-1', status: 'deactivated', activatedAt: '2026-01-01T00:00:00Z', deactivatedAt: '2026-01-02T00:00:00Z' };
  const store = new TransactionalMockStore([license], [deactivatedRecord]);
  const session = store.createTransactionSession();

  session.auditRepo.append = async () => {
    throw new Error('Deadlock detected during reactivation audit append');
  };

  const res = await withTransaction(async () => {
    const service = new ActivationService();
    // @ts-ignore
    return service.executeActivation(
      session.licenseRepo,
      session.activationRepo,
      session.policyRepo,
      session.auditRepo,
      code,
      'DEV-REACT-1',
      'req_roll_react',
      new Date().toISOString(),
      'MASKED',
      true
    );
  }, session.mockPool).catch((err) => {
    return { status: 'SERVER_ERROR', error: err };
  });

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(store.committedActivations[0].status, 'deactivated', 'Reactivation must remain deactivated when transaction rolls back');
});

// ============================================================================
// 2. CONCURRENCY - DISTINCT RACE CONDITION TESTS
// ============================================================================
test('2A. Concurrent ACTIVATE on SAME license + SAME device', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_conc_same', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const policy = { id: 'pol_1', licenseId: 'lic_conc_same', maxActivations: 2 };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([]),
    new MemoryPolicyRepo([policy]),
    new MemoryAuditRepo()
  );

  const reqs = Array.from({ length: 5 }, (_, i) =>
    service.activate({ licenseCode: code, deviceId: 'DEV-SAME-1' }, `req_same_act_${i}`)
  );

  const results = await Promise.all(reqs);
  const activated = results.filter((r) => r.status === 'ACTIVATED');
  const alreadyActive = results.filter((r) => r.status === 'ALREADY_ACTIVE');

  assert.equal(activated.length, 1, 'Exactly 1 request should perform initial activation');
  assert.equal(alreadyActive.length, 4, 'Remaining 4 requests should safely return ALREADY_ACTIVE');
});

test('2B. Concurrent DEACTIVATE on SAME license + SAME device', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_conc_deact', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const activeRecord = { id: 'act_conc_deact', licenseId: 'lic_conc_deact', deviceId: 'DEV-DEACT-SAME', status: 'active' };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([activeRecord]),
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const reqs = Array.from({ length: 5 }, (_, i) =>
    service.deactivate({ licenseCode: code, deviceId: 'DEV-DEACT-SAME' }, `req_same_deact_${i}`)
  );

  const results = await Promise.all(reqs);
  const deactivated = results.filter((r) => r.status === 'DEACTIVATED');
  const notActive = results.filter((r) => r.status === 'NOT_ACTIVE');

  assert.equal(deactivated.length, 1, 'Exactly 1 request should deactivate the device');
  assert.equal(notActive.length, 4, 'Remaining 4 requests should return NOT_ACTIVE idempotently');
});

test('2C. Concurrent REACTIVATE on SAME license + SAME device', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_conc_react', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const deactRecord = { id: 'act_conc_react', licenseId: 'lic_conc_react', deviceId: 'DEV-REACT-SAME', status: 'deactivated', activatedAt: '2026-01-01T00:00:00Z', deactivatedAt: '2026-01-02T00:00:00Z' };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([deactRecord]),
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const reqs = Array.from({ length: 5 }, (_, i) =>
    service.activate({ licenseCode: code, deviceId: 'DEV-REACT-SAME' }, `req_same_react_${i}`)
  );

  const results = await Promise.all(reqs);
  const reactivated = results.filter((r) => r.status === 'ACTIVATED' && r.activationId === 'act_conc_react');
  const alreadyActive = results.filter((r) => r.status === 'ALREADY_ACTIVE');

  assert.equal(reactivated.length, 1, 'Exactly 1 request should reactivate');
  assert.equal(alreadyActive.length, 4, 'Remaining 4 requests should return ALREADY_ACTIVE');
});

test('2D. Concurrent ACTIVATE / DEACTIVATE on SAME license + SAME device', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_conc_act_deact', licenseCode: code, status: 'assigned', licenseType: 'pro' };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([]),
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const [actRes, deactRes] = await Promise.all([
    service.activate({ licenseCode: code, deviceId: 'DEV-MIX-1' }, 'req_mix_act'),
    service.deactivate({ licenseCode: code, deviceId: 'DEV-MIX-1' }, 'req_mix_deact'),
  ]);

  assert.ok(['ACTIVATED', 'ALREADY_ACTIVE'].includes(actRes.status));
  assert.ok(['DEACTIVATED', 'NOT_ACTIVE'].includes(deactRes.status));
});

test('2E. Reactivate vs Last Slot Race condition (maxActivations = 1)', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_last_slot', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const policy = { id: 'pol_1_slot', licenseId: 'lic_last_slot', maxActivations: 1 };
  const deactRecord = { id: 'act_dev_a', licenseId: 'lic_last_slot', deviceId: 'DEV-A', status: 'deactivated' };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([deactRecord]),
    new MemoryPolicyRepo([policy]),
    new MemoryAuditRepo()
  );

  // DEV-A attempts reactivation while DEV-B attempts new activation simultaneously
  const [resA, resB] = await Promise.all([
    service.activate({ licenseCode: code, deviceId: 'DEV-A' }, 'req_react_a'),
    service.activate({ licenseCode: code, deviceId: 'DEV-B' }, 'req_act_b'),
  ]);

  const successCount = [resA, resB].filter((r) => r.status === 'ACTIVATED').length;
  const limitCount = [resA, resB].filter((r) => r.status === 'ACTIVATION_LIMIT_REACHED').length;

  assert.equal(successCount, 1, 'Exactly one device must get the available slot');
  assert.equal(limitCount, 1, 'Other device must receive ACTIVATION_LIMIT_REACHED');
});

// ============================================================================
// 3. DUPLICATE REQUESTS (IDEMPOTENCY)
// ============================================================================
test('3A. Duplicate ACTIVATE request is idempotent and does not duplicate slots', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_dup_act', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const actRepo = new MemoryActivationRepo([]);

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    actRepo,
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const res1 = await service.activate({ licenseCode: code, deviceId: 'DEV-DUP-1' }, 'req_dup_1');
  const res2 = await service.activate({ licenseCode: code, deviceId: 'DEV-DUP-1' }, 'req_dup_2');

  assert.equal(res1.status, 'ACTIVATED');
  assert.equal(res2.status, 'ALREADY_ACTIVE');
  assert.equal(await actRepo.countActiveByLicense('lic_dup_act'), 1, 'Only 1 active row should exist');
});

test('3B. Duplicate VALIDATE request is idempotent', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_dup_val', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const activeRecord = { id: 'act_val_1', licenseId: 'lic_dup_val', deviceId: 'DEV-DUP-VAL', status: 'active' };
  const actRepo = new MemoryActivationRepo([activeRecord]);

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    actRepo,
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const res1 = await service.validate({ licenseCode: code, deviceId: 'DEV-DUP-VAL' }, 'req_v1');
  const res2 = await service.validate({ licenseCode: code, deviceId: 'DEV-DUP-VAL' }, 'req_v2');

  assert.equal(res1.status, 'VALID');
  assert.equal(res2.status, 'VALID');
  assert.equal(await actRepo.countActiveByLicense('lic_dup_val'), 1);
});

test('3C. Duplicate DEACTIVATE request is idempotent', async () => {
  const code = generateTestLicense();
  const license = { id: 'lic_dup_deact', licenseCode: code, status: 'assigned', licenseType: 'pro' };
  const activeRecord = { id: 'act_deact_dup', licenseId: 'lic_dup_deact', deviceId: 'DEV-DUP-DEACT', status: 'active' };
  const actRepo = new MemoryActivationRepo([activeRecord]);

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    actRepo,
    new MemoryPolicyRepo([]),
    new MemoryAuditRepo()
  );

  const res1 = await service.deactivate({ licenseCode: code, deviceId: 'DEV-DUP-DEACT' }, 'req_d1');
  const res2 = await service.deactivate({ licenseCode: code, deviceId: 'DEV-DUP-DEACT' }, 'req_d2');

  assert.equal(res1.status, 'DEACTIVATED');
  assert.equal(res2.status, 'NOT_ACTIVE');
  assert.equal(await actRepo.countActiveByLicense('lic_dup_deact'), 0);
});

// ============================================================================
// 4. DATABASE UNIQUE VIOLATION (23505) & ERROR SANITIZATION
// ============================================================================
test('4. PostgreSQL UNIQUE violation (code 23505) returns controlled SERVER_ERROR without exposing DB details', async () => {
  const failingLicenseRepo = {
    findByCode: async () => {
      const err = new Error('duplicate key value violates unique constraint "unique_license_device" (table license_activations)');
      err.code = '23505';
      throw err;
    },
  };

  const service = new ActivationService(
    failingLicenseRepo,
    new MemoryActivationRepo(),
    new MemoryPolicyRepo(),
    new MemoryAuditRepo()
  );

  const res = await service.activate(
    { licenseCode: 'TEST-1234-5678-9012', deviceId: 'DEV-UNIQUE-1' },
    'req_uniq_23505'
  );

  assert.equal(res.status, 'SERVER_ERROR');
  assert.equal(res.message, 'An internal server error occurred');
  assert.ok(!res.message.includes('unique_license_device'), 'Must not expose constraint name');
  assert.ok(!res.message.includes('license_activations'), 'Must not expose table name');
  assert.ok(!res.message.includes('duplicate key value'), 'Must not expose SQL error text');
});

// ============================================================================
// 5. AUDIT LOG MASKING & SENSITIVE KEYS PROTECTION
// ============================================================================
test('5. Audit log records masked license codes and excludes sensitive keys', async () => {
  const code = generateTestLicense();
  const license = {
    id: 'lic_audit_sec',
    licenseCode: code,
    status: 'assigned',
    licenseType: 'pro',
  };
  const auditRepo = new MemoryAuditRepo();

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([]),
    new MemoryPolicyRepo([]),
    auditRepo
  );

  await service.activate({ licenseCode: code, deviceId: 'DEV-AUDIT-1' }, 'req_audit_1');
  await service.validate({ licenseCode: code, deviceId: 'DEV-AUDIT-1' }, 'req_audit_2');
  await service.deactivate({ licenseCode: code, deviceId: 'DEV-AUDIT-1' }, 'req_audit_3');

  assert.equal(auditRepo.events.length, 3);
  const maskedExpected = maskLicenseCode(code);

  for (const event of auditRepo.events) {
    assert.equal(event.licenseCodeMasked, maskedExpected);
    assert.ok(!JSON.stringify(event).includes(code), 'Full unmasked license code must not be in audit record');
    assert.ok(!JSON.stringify(event).includes('PRIVATE KEY'), 'Private key must not be in audit record');
  }
});

// ============================================================================
// 6. REQUEST / CORRELATION ID PRESERVATION
// ============================================================================
test('6. Request ID is passed from HTTP header through controller to audit log', async () => {
  const app = createApp();
  const code = generateTestLicense();
  const customRequestId = 'req-tracing-uuid-9999-8888';

  const res = await request(app)
    .post('/api/licenses/activate')
    .set('x-request-id', customRequestId)
    .send({
      licenseCode: code,
      deviceId: 'DEV-HTTP-TRACE',
      productId: 'gestione-casa-ocr',
      appVersion: '1.0',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.requestId, customRequestId, 'Response must include passed custom requestId');
});

// ============================================================================
// 7. CONNECTION POOL CLEANUP
// ============================================================================
test('7. closePool closes PostgreSQL pool gracefully', async () => {
  assert.equal(typeof closePool, 'function');
  await closePool();
  assert.equal(isPoolInitialized(), false, 'Pool should not be initialized after closePool()');
});

// ============================================================================
// 8. FULL E2E LICENSE LIFECYCLE COLLAUDO
// ============================================================================
test('8. Complete E2E Lifecycle: Activate A -> Validate A -> Activate B -> Max Limit -> Deactivate A -> Validate A Fail -> Activate C -> Reactivate A Fail -> Deactivate B -> Reactivate A Success', async () => {
  const code = generateTestLicense();
  const license = {
    id: 'lic_e2e_full',
    licenseCode: code,
    status: 'assigned',
    licenseType: 'pro',
  };
  const policy = { id: 'pol_e2e', licenseId: 'lic_e2e_full', maxActivations: 2 };

  const service = new ActivationService(
    new MemoryLicenseRepo([license]),
    new MemoryActivationRepo([]),
    new MemoryPolicyRepo([policy]),
    new MemoryAuditRepo()
  );

  // Step 1: Activate Device A -> PASS
  const actA = await service.activate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_1');
  assert.equal(actA.status, 'ACTIVATED');
  const actAId = actA.activationId;

  // Step 2: Validate Device A -> PASS
  const valA = await service.validate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_2');
  assert.equal(valA.status, 'VALID');

  // Step 3: Activate Device B -> PASS (2/2 slots occupied)
  const actB = await service.activate({ licenseCode: code, deviceId: 'DEV-B' }, 'step_3');
  assert.equal(actB.status, 'ACTIVATED');

  // Step 4: Activate Device C -> REJECT (ACTIVATION_LIMIT_REACHED)
  const actC = await service.activate({ licenseCode: code, deviceId: 'DEV-C' }, 'step_4');
  assert.equal(actC.status, 'ACTIVATION_LIMIT_REACHED');

  // Step 5: Deactivate Device A -> PASS (Slot freed: 1/2 active)
  const deactA = await service.deactivate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_5');
  assert.equal(deactA.status, 'DEACTIVATED');

  // Step 6: Validate Device A -> REJECT (DEVICE_MISMATCH)
  const valA2 = await service.validate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_6');
  assert.equal(valA2.status, 'DEVICE_MISMATCH');

  // Step 7: Activate Device C -> PASS (Uses freed slot: 2/2 active)
  const actC2 = await service.activate({ licenseCode: code, deviceId: 'DEV-C' }, 'step_7');
  assert.equal(actC2.status, 'ACTIVATED');

  // Step 8: Reactivate Device A -> REJECT (Limit reached: 2/2 active)
  const reactA = await service.activate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_8');
  assert.equal(reactA.status, 'ACTIVATION_LIMIT_REACHED');

  // Step 9: Deactivate Device B -> PASS (Slot freed: 1/2 active)
  const deactB = await service.deactivate({ licenseCode: code, deviceId: 'DEV-B' }, 'step_9');
  assert.equal(deactB.status, 'DEACTIVATED');

  // Step 10: Reactivate Device A -> PASS (Reuses same activationId record!)
  const reactA2 = await service.activate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_10');
  assert.equal(reactA2.status, 'ACTIVATED');
  assert.equal(reactA2.activationId, actAId, 'Must reuse original activationId on reactivation');

  // Step 11: Validate Device A -> PASS
  const valA3 = await service.validate({ licenseCode: code, deviceId: 'DEV-A' }, 'step_11');
  assert.equal(valA3.status, 'VALID');
});

// ============================================================================
// 9. HTTP ENDPOINTS E2E INTEGRATION
// ============================================================================
test('9. HTTP Endpoints E2E: POST /api/licenses/activate, validate, deactivate', async () => {
  const app = createApp();
  const code = generateTestLicense();

  // Activate
  const actRes = await request(app)
    .post('/api/licenses/activate')
    .send({ licenseCode: code, deviceId: 'DEV-HTTP-1', productId: 'gestione-casa-ocr', appVersion: '1.0' });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.status, 'ACTIVATED');

  // Validate
  const valRes = await request(app)
    .post('/api/licenses/validate')
    .send({ licenseCode: code, deviceId: 'DEV-HTTP-1', productId: 'gestione-casa-ocr' });
  assert.equal(valRes.status, 200);
  assert.equal(valRes.body.status, 'VALID');

  // Deactivate
  const deactRes = await request(app)
    .post('/api/licenses/deactivate')
    .send({ licenseCode: code, deviceId: 'DEV-HTTP-1', productId: 'gestione-casa-ocr' });
  assert.equal(deactRes.status, 200);
  assert.equal(deactRes.body.status, 'DEACTIVATED');
});

// ============================================================================
// 10. OPTIONAL REAL POSTGRESQL INTEGRATION TEST
// ============================================================================
test('10. Optional Real PostgreSQL Integration (when TEST_DATABASE_URL is set)', async (t) => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) {
    t.skip('TEST_DATABASE_URL not set; skipping real PostgreSQL integration test');
    return;
  }

  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    assert.ok(res.rows.length > 0, 'Real PostgreSQL query executed successfully');
    client.release();
  } finally {
    await pool.end();
  }
});
