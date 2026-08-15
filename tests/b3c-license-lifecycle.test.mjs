import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ActivationService } from '../dist/services/activationService.js';
import { createApp } from '../dist/app.js';
import { LicenseEngine } from '@gestione-casa/shared-sdk/licensing';

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
      id: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
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

function createSetup(overrides = {}) {
  const code = overrides.license?.licenseCode || LicenseEngine.generateCode();
  const license = {
    id: 'lic_100',
    licenseCode: code,
    status: 'assigned',
    licenseType: 'pro',
    checksum: 'abc123chk',
    customerId: 'cust_100',
    generatedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides.license,
  };

  const policy = {
    id: 'pol_100',
    licenseId: 'lic_100',
    licenseType: 'pro',
    maxActivations: 1,
    allowDeactivation: true,
    ...overrides.policy,
  };

  const licenseRepo = new MemoryLicenseRepo([license]);
  const activationRepo = new MemoryActivationRepo(overrides.activations || []);
  const policyRepo = new MemoryPolicyRepo([policy]);
  const auditRepo = new MemoryAuditRepo();

  const service = new ActivationService(licenseRepo, activationRepo, policyRepo, auditRepo);

  return { service, licenseRepo, activationRepo, policyRepo, auditRepo, license, policy, code };
}

// 1. validate su activation ACTIVE valida -> PASS
test('1. validate on valid ACTIVE activation -> PASS (VALID)', async () => {
  const { service, activationRepo, code } = createSetup();
  const actRes = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_val_1'
  );
  assert.equal(actRes.status, 'ACTIVATED');

  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_2'
  );

  assert.equal(valRes.status, 'VALID');
  assert.ok(valRes.signedLicense);
  assert.ok(valRes.lastValidatedAt);
  assert.equal(valRes.requestId, 'req_val_2');

  const record = await activationRepo.findActiveByLicenseAndDevice('lic_100', 'dev_A');
  assert.ok(record.lastValidatedAt);
});

// 2. validate su activation inesistente -> reject
test('2. validate on non-existent activation -> reject (DEVICE_MISMATCH)', async () => {
  const { service, code } = createSetup();
  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_UNKNOWN', productId: 'gestione-casa-ocr' },
    'req_val_3'
  );
  assert.equal(valRes.status, 'DEVICE_MISMATCH');
});

// 3. validate su activation disattivata -> reject
test('3. validate on deactivated activation -> reject (DEVICE_MISMATCH)', async () => {
  const { service, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );

  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_4'
  );
  assert.equal(valRes.status, 'DEVICE_MISMATCH');
});

// 4. validate su licenza scaduta -> reject
test('4. validate on expired license -> reject (LICENSE_EXPIRED)', async () => {
  const expiredDate = new Date(Date.now() - 3600000).toISOString();
  const { service, code } = createSetup({ license: { expiresAt: expiredDate } });

  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_5'
  );
  assert.equal(valRes.status, 'LICENSE_EXPIRED');
});

// 5. validate su licenza revoked -> reject
test('5. validate on revoked license -> reject (LICENSE_REVOKED)', async () => {
  const { service, licenseRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  // Revoke license
  await licenseRepo.update('lic_100', { status: 'revoked' });

  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_6'
  );
  assert.equal(valRes.status, 'LICENSE_REVOKED');
});

// 6. successful validate aggiorna last_validated_at
test('6. successful validate updates last_validated_at', async () => {
  const { service, activationRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  const valRes1 = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_7'
  );
  const time1 = valRes1.lastValidatedAt;
  assert.ok(time1);

  const valRes2 = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_8'
  );
  assert.ok(valRes2.lastValidatedAt);
  const record = await activationRepo.findActiveByLicenseAndDevice('lic_100', 'dev_A');
  assert.equal(record.lastValidatedAt, valRes2.lastValidatedAt);
});

// 7. validate NON modifica active count
test('7. validate does NOT modify active count or slot usage', async () => {
  const { service, activationRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  const countBefore = await activationRepo.countActiveByLicense('lic_100');
  assert.equal(countBefore, 1);

  await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_9'
  );

  const countAfter = await activationRepo.countActiveByLicense('lic_100');
  assert.equal(countAfter, 1);
});

// 8. deactivate ACTIVE -> PASS
test('8. deactivate ACTIVE -> PASS (DEACTIVATED)', async () => {
  const { service, activationRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  const deactRes = await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_1'
  );

  assert.equal(deactRes.status, 'DEACTIVATED');
  assert.ok(deactRes.deactivatedAt);

  const activeRec = await activationRepo.findActiveByLicenseAndDevice('lic_100', 'dev_A');
  assert.equal(activeRec, null);

  const allRec = await activationRepo.findByLicenseAndDevice('lic_100', 'dev_A');
  assert.equal(allRec.status, 'deactivated');
  assert.ok(allRec.deactivatedAt);
});

// 9. secondo deactivate -> idempotente
test('9. second deactivate -> idempotent (NOT_ACTIVE)', async () => {
  const { service, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_1'
  );

  const secondDeact = await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_2'
  );

  assert.equal(secondDeact.status, 'NOT_ACTIVE');
  assert.ok(secondDeact.deactivatedAt);
});

// 10. deactivate libera uno slot
test('10. deactivate frees a slot', async () => {
  const { service, activationRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );
  assert.equal(await activationRepo.countActiveByLicense('lic_100'), 1);

  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );
  assert.equal(await activationRepo.countActiveByLicense('lic_100'), 0);
});

// 11. activate stesso device dopo deactivate -> REACTIVATION
test('11. activate same device after deactivate -> REACTIVATION (ACTIVATED)', async () => {
  const { service, activationRepo, code } = createSetup();
  const act1 = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  const initialActId = act1.activationId;

  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );

  const act2 = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_2'
  );

  assert.equal(act2.status, 'ACTIVATED');
  assert.equal(act2.activationId, initialActId);

  const record = await activationRepo.findActiveByLicenseAndDevice('lic_100', 'dev_A');
  assert.equal(record.status, 'active');
  assert.equal(record.deactivatedAt, undefined);
});

// 12. reactivation NON crea seconda riga
test('12. reactivation does NOT create second row', async () => {
  const { service, activationRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_2'
  );

  assert.equal(activationRepo.activations.length, 1);
});

// 13. reactivation riusa activationId/record coerentemente
test('13. reactivation reuses activationId and record coherently', async () => {
  const { service, activationRepo, code } = createSetup();
  const act1 = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );
  const react = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_2'
  );

  assert.equal(react.activationId, act1.activationId);
  const rec = await activationRepo.findByLicenseAndDevice('lic_100', 'dev_A');
  assert.equal(rec.id, act1.activationId);
  assert.equal(rec.status, 'active');
});

// 14. reactivation entro limite -> PASS
test('14. reactivation within limit -> PASS', async () => {
  const { service, code } = createSetup({ policy: { maxActivations: 2 } });
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_1'
  );

  const reactRes = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_react'
  );

  assert.equal(reactRes.status, 'ACTIVATED');
});

// 15. reactivation oltre limite -> reject
test('15. reactivation beyond limit -> reject (ACTIVATION_LIMIT_REACHED)', async () => {
  const { service, code } = createSetup({ policy: { maxActivations: 1 } });
  // Activate dev_A
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  // Deactivate dev_A (slot freed)
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_1'
  );
  // Activate dev_B (slot taken by dev_B)
  await service.activate(
    { licenseCode: code, deviceId: 'dev_B', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_2'
  );

  // Attempt reactivation of dev_A while slot is taken by dev_B
  const reactRes = await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_react_failed'
  );

  assert.equal(reactRes.status, 'ACTIVATION_LIMIT_REACHED');
});

// 16. nuovo device può usare slot liberato
test('16. new device can use slot freed by deactivation', async () => {
  const { service, code } = createSetup({ policy: { maxActivations: 1 } });
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_1'
  );

  const devBRes = await service.activate(
    { licenseCode: code, deviceId: 'dev_B', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_2'
  );

  assert.equal(devBRes.status, 'ACTIVATED');
});

// 17. audit validation scritto
test('17. audit validation recorded', async () => {
  const { service, auditRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_val_aud'
  );

  const events = await auditRepo.findByCorrelationId('req_val_aud');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'VALIDATION_SUCCESS');
  assert.ok(events[0].licenseCodeMasked.includes('****'));
});

// 18. audit deactivation scritto
test('18. audit deactivation recorded', async () => {
  const { service, auditRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact_aud'
  );

  const events = await auditRepo.findByCorrelationId('req_deact_aud');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'DEACTIVATION_SUCCESS');
  assert.ok(events[0].licenseCodeMasked.includes('****'));
});

// 19. audit reactivation scritto
test('19. audit reactivation recorded', async () => {
  const { service, auditRepo, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_deact'
  );
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_react_aud'
  );

  const events = await auditRepo.findByCorrelationId('req_react_aud');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'REACTIVATION_SUCCESS');
  assert.ok(events[0].licenseCodeMasked.includes('****'));
});

// 20. repository/database error -> gestione controllata
test('20. repository/database error -> controlled handling (SERVER_ERROR)', async () => {
  const { service, licenseRepo, code } = createSetup();
  licenseRepo.findByCode = async () => {
    throw new Error('Database connection lost');
  };

  const valRes = await service.validate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_err_1'
  );
  assert.equal(valRes.status, 'SERVER_ERROR');

  const deactRes = await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_err_2'
  );
  assert.equal(deactRes.status, 'SERVER_ERROR');
});

// 21. HTTP POST /api/licenses/validate operativo
test('21. HTTP POST /api/licenses/validate returns valid response', async () => {
  const app = createApp();
  const validCode = LicenseEngine.generateCode();

  // First activate via HTTP
  const actHttp = await request(app)
    .post('/api/licenses/activate')
    .send({ licenseCode: validCode, deviceId: 'dev_HTTP', productId: 'gestione-casa-ocr', appVersion: '1.0' });

  assert.equal(actHttp.status, 200);
  assert.equal(actHttp.body.status, 'ACTIVATED');

  const res = await request(app)
    .post('/api/licenses/validate')
    .send({
      licenseCode: validCode,
      deviceId: 'dev_HTTP',
      productId: 'gestione-casa-ocr',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'VALID');
  assert.ok(res.body.lastValidatedAt);
  assert.ok(res.body.serverTime);
});

// 22. HTTP POST /api/licenses/deactivate operativo
test('22. HTTP POST /api/licenses/deactivate returns valid response', async () => {
  const app = createApp();
  const validCode = LicenseEngine.generateCode();

  const actHttp = await request(app)
    .post('/api/licenses/activate')
    .send({ licenseCode: validCode, deviceId: 'dev_HTTP2', productId: 'gestione-casa-ocr', appVersion: '1.0' });

  assert.equal(actHttp.status, 200);
  assert.equal(actHttp.body.status, 'ACTIVATED');

  const res = await request(app)
    .post('/api/licenses/deactivate')
    .send({
      licenseCode: validCode,
      deviceId: 'dev_HTTP2',
      productId: 'gestione-casa-ocr',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'DEACTIVATED');
  assert.ok(res.body.deactivatedAt);
});

// 23. simulazione concurrency deactivate/deactivate
test('23. simulated concurrency - parallel deactivate requests', async () => {
  const { service, code } = createSetup();
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_act'
  );

  const [res1, res2] = await Promise.all([
    service.deactivate(
      { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
      'req_par_1'
    ),
    service.deactivate(
      { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
      'req_par_2'
    ),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, ['DEACTIVATED', 'NOT_ACTIVE']);
});

// 24. simulazione concurrency reactivate/activate
test('24. simulated concurrency - parallel reactivate/activate across devices with maxActivations=1', async () => {
  const { service, code } = createSetup({ policy: { maxActivations: 1 } });
  // Activate dev_A, then deactivate dev_A
  await service.activate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
    'req_setup_1'
  );
  await service.deactivate(
    { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr' },
    'req_setup_2'
  );

  // Parallel reactivate dev_A and new activate dev_B
  const [resA, resB] = await Promise.all([
    service.activate(
      { licenseCode: code, deviceId: 'dev_A', productId: 'gestione-casa-ocr', appVersion: '1.0' },
      'req_par_A'
    ),
    service.activate(
      { licenseCode: code, deviceId: 'dev_B', productId: 'gestione-casa-ocr', appVersion: '1.0' },
      'req_par_B'
    ),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, ['ACTIVATED', 'ACTIVATION_LIMIT_REACHED']);
});
