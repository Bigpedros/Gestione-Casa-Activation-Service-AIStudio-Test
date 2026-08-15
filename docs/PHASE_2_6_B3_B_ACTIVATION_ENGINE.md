# Phase 2.6.B3-B Documentation - Real Activation Engine & Atomic Slot Management

## Overview
Phase 2.6.B3-B implements the online activation engine for **Gestione Casa Activation Service**. It makes `POST /api/licenses/activate` fully operational, managing device slots atomically with row-level PostgreSQL transactions and Ed25519 payload signing.

---

## 1. Activation Flow

```
                  +-----------------------------------+
                  | POST /api/licenses/activate       |
                  +-----------------------------------+
                                    |
                       [1. Validate Request Payload]
                        (ActivationValidator from SDK)
                                    |
                   +----------------+----------------+
                   | Invalid                         | Valid
                   v                                 v
        [400 Bad Request]                 [Start DB Transaction]
                                           (withTransaction)
                                                     |
                                         [2. Lock & Find License]
                                         (SELECT ... FOR UPDATE)
                                                     |
                                   +-----------------+-----------------+
                                   | Not Found / Revoked / Expired     | Active
                                   v                                   v
                      [Log Audit & Return Status]          [3. Lock & Find Policy]
                      LICENSE_NOT_FOUND                    (SELECT ... FOR UPDATE)
                      LICENSE_REVOKED                                  |
                      LICENSE_EXPIRED                      [4. Check Idempotency]
                                                           (Is device already active?)
                                                                       |
                                                    +------------------+------------------+
                                                    | Already Active                      | New Device
                                                    v                                     v
                                        [Log Audit: IDEMPOTENT]               [5. Check Active Count]
                                       Return ALREADY_ACTIVE +                vs policy.maxActivations
                                           Signed License                                 |
                                                                       +------------------+------------------+
                                                                       | Count >= Limit                      | Count < Limit
                                                                       v                                     v
                                                           [Log Audit: REJECTED]                 [6. Insert Activation]
                                                      Return ACTIVATION_LIMIT_REACHED            [7. Sign License Document]
                                                                                                 [8. Log Audit: SUCCESS]
                                                                                                 Return ACTIVATED +
                                                                                                   Signed License
```

---

## 2. Locking Strategy & Concurrency Protection

### PostgreSQL Row-Level Locking (`FOR UPDATE`)
To prevent race conditions during concurrent activation attempts for the same license code across multiple threads or app instances:
1. Every activation request executes inside a PostgreSQL transaction managed by `withTransaction`.
2. The license row is locked using `SELECT * FROM licenses WHERE license_code = $1 FOR UPDATE`.
3. The policy row is locked using `SELECT * FROM activation_policies WHERE license_id = $1 FOR UPDATE`.
4. Existing activations for `(license_id, device_id)` are queried with `FOR UPDATE`.
5. Any concurrent transaction attempting to activate the same license waits until the first transaction completes (commits or rolls back).
6. Once unlocked, subsequent transactions read the updated `COUNT(*)` of active slots, strictly guaranteeing atomic slot allocation without over-subscription.

### In-Memory Lock Fallback (CI / Local Unit Tests)
When running in environments without PostgreSQL, `ActivationService` uses an asynchronous key-based lock (`executeWithMemoryLock`) per `licenseCode` to serialize execution in the event loop, replicating the database locking behavior deterministically.

---

## 3. Response Models & Status Mapping

All responses conform to the Shared SDK `ActivationResponse` specification:

```typescript
export interface ActivationResponse {
  status: ActivationStatus;
  signedLicense?: SignedLicenseDocument | null;
  activationId?: string | null;
  message?: string | null;
  serverTime: string;
  requestId: string;
}
```

### Supported Status Outcomes:
- `ACTIVATED`: License slot successfully acquired and active activation created.
- `ALREADY_ACTIVE`: Idempotent call — this device already holds an active activation on this license. No slot re-consumed.
- `ACTIVATION_LIMIT_REACHED`: All slots defined by `activation_policies.max_activations` are occupied.
- `LICENSE_NOT_FOUND`: License code does not exist.
- `LICENSE_REVOKED`: License is revoked, suspended, or not assigned.
- `LICENSE_EXPIRED`: Expiration timestamp has passed.
- `SERVER_ERROR`: Internal server or database connection error.

---

## 4. Audit Trail Strategy

Every activation attempt records a structured event into `audit_events` via `PostgresAuditRepository` (or `MemoryAuditRepo` fallback):

### Audit Event Types:
- `ACTIVATION_SUCCESS`: New slot assigned successfully.
- `ACTIVATION_IDEMPOTENT`: Re-request from an already active device.
- `ACTIVATION_REJECTED_LIMIT_REACHED`: Rejected due to slot capacity limit.
- `ACTIVATION_REJECTED_INVALID_LICENSE`: License not found, revoked, or suspended.
- `ACTIVATION_REJECTED_EXPIRED`: License past expiration date.
- `ACTIVATION_REJECTED_NO_POLICY`: No valid policy record configured.

### Data Privacy & Security:
- Full license codes are **never** stored in audit logs.
- All code logging uses `maskLicenseCode(code)` (e.g. `XXXX-****-****-YYYY`).

---

## 5. Running the B3-B Test Suite

To run the complete test suite (37 tests including B2 foundation, B3-A persistence, and B3-B activation engine):

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

### Running B3-B Activation Tests Specifically:
```bash
node --test tests/b3b-activation-engine.test.mjs
```

### With Integration Database (Optional):
```bash
DATABASE_URL="postgres://user:pass@localhost:5432/gestione_casa_db" npm test
```
