import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../dist/app.js';
import { LicenseSigningService } from '../dist/services/licenseSigningService.js';
import { buildCanonicalLicensePayloadV1 } from '@gestione-casa/shared-sdk/activation';
import { LicenseEngine } from '@gestione-casa/shared-sdk/licensing';
import { maskLicenseCode } from '../dist/utils/maskLicenseCode.js';

const app = createApp();
const validSdkCode = LicenseEngine.generateCode();

test('1. GET /health returns 200 OK with status "ok"', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'gestione-casa-activation-service');
  assert.ok(res.headers['x-request-id']);
});

test('2. POST /api/licenses/activate with invalid payload returns 400', async () => {
  const res = await request(app).post('/api/licenses/activate').send({ invalid: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.code, 'INVALID_ACTIVATION_REQUEST');
});

test('3. POST /api/licenses/activate with valid payload returns 200 OK ActivationResponse', async () => {
  const validPayload = {
    deviceId: 'DEV-1234-5678-9012',
    productId: 'gestione-casa-ocr',
    licenseCode: validSdkCode,
    appVersion: '1.0.0',
  };
  const res = await request(app).post('/api/licenses/activate').send(validPayload);
  assert.equal(res.status, 200);
  assert.ok(res.body.status);
  assert.ok(res.body.serverTime);
});

test('4. POST /api/licenses/validate with invalid payload returns 400', async () => {
  const res = await request(app).post('/api/licenses/validate').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_VALIDATION_REQUEST');
});

test('5. POST /api/licenses/validate with valid payload returns 200', async () => {
  const validPayload = {
    licenseCode: validSdkCode,
    deviceId: 'DEV-1234-5678-9012',
    productId: 'gestione-casa-ocr',
  };
  const res = await request(app).post('/api/licenses/validate').send(validPayload);
  assert.equal(res.status, 200);
  assert.ok(res.body.status);
});

test('6. POST /api/licenses/deactivate with invalid payload returns 400', async () => {
  const res = await request(app).post('/api/licenses/deactivate').send({ deviceId: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_DEACTIVATION_REQUEST');
});

test('7. POST /api/licenses/deactivate with valid payload returns 200', async () => {
  const validPayload = {
    licenseCode: validSdkCode,
    deviceId: 'DEV-1234-5678-9012',
    productId: 'gestione-casa-ocr',
  };
  const res = await request(app).post('/api/licenses/deactivate').send(validPayload);
  assert.equal(res.status, 200);
  assert.ok(res.body.status);
});

test('8. Ed25519 LicenseSigningService sign & verify success', () => {
  const { publicKey, privateKey } = LicenseSigningService.generateKeyPair();
  const document = {
    id: 'LIC-TEST-001',
    licenseCode: validSdkCode,
    checksum: '7',
    customerId: 'CUST-001',
    deviceId: 'DEV-001',
    expiresAt: '2027-12-31T23:59:59.000Z',
    generatedAt: '2026-01-01T00:00:00.000Z',
    engineVersion: '2.1',
    schemaVersion: 1,
    status: 'assigned',
    licenseType: 'BETA_TESTER',
  };

  const signed = LicenseSigningService.signLicense(document, privateKey, 'test-key-1');
  assert.ok(signed.signature);

  const isValid = LicenseSigningService.verifySignedLicense(signed, publicKey);
  assert.equal(isValid, true);
});

test('9. Tampered payload fails verification', () => {
  const { publicKey, privateKey } = LicenseSigningService.generateKeyPair();
  const document = {
    id: 'LIC-TEST-001',
    licenseCode: validSdkCode,
    checksum: '7',
    customerId: 'CUST-001',
    deviceId: 'DEV-001',
    expiresAt: '2027-12-31T23:59:59.000Z',
    generatedAt: '2026-01-01T00:00:00.000Z',
    engineVersion: '2.1',
    schemaVersion: 1,
    status: 'assigned',
    licenseType: 'BETA_TESTER',
  };

  const signed = LicenseSigningService.signLicense(document, privateKey, 'test-key-1');
  // Tamper document
  signed.license.customerId = 'CUST-TAMPERED';

  const isValid = LicenseSigningService.verifySignedLicense(signed, publicKey);
  assert.equal(isValid, false);
});

test('10. Golden Vector A PASS', () => {
  const vectorA = {
    id: 'LIC-GOLDEN-001',
    licenseCode: 'A1B2-C3D4-E5F6-G7H8',
    checksum: '8',
    customerId: 'CUS-GOLDEN-001',
    deviceId: 'DEV-GOLDEN-001',
    expiresAt: '2027-12-31T23:59:59.000Z',
    generatedAt: '2026-01-01T10:00:00.000Z',
    engineVersion: '2.1',
    schemaVersion: 1,
    status: 'assigned',
    licenseType: 'Professional',
  };

  const expectedCanonical = '{"checksum":"8","customerId":"CUS-GOLDEN-001","deviceId":"DEV-GOLDEN-001","engineVersion":"2.1","expiresAt":"2027-12-31T23:59:59.000Z","generatedAt":"2026-01-01T10:00:00.000Z","id":"LIC-GOLDEN-001","licenseCode":"A1B2-C3D4-E5F6-G7H8","licenseType":"Professional","schemaVersion":1,"status":"assigned"}';
  const canonical = buildCanonicalLicensePayloadV1(vectorA);
  assert.equal(canonical, expectedCanonical);

  const sha256 = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  assert.equal(sha256, '072d4bf56f2f468ab719279224c14f2ebb3369847082a23e40c36d21a525e24f');
});

test('11. maskLicenseCode behavior', () => {
  assert.equal(maskLicenseCode('FB68-PB71-2026-3107'), 'FB68-****-****-3107');
  assert.equal(maskLicenseCode('ABC-DEF'), '****-****');
  assert.equal(maskLicenseCode(null), '');
});
