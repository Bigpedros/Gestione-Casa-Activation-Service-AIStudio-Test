# Phase 2.6.B3-D: Backend Hardening, Concurrency & Final E2E Validation

## 1. Scopo della Fase B3-D
La Fase B3-D completa il collaudo ed il consolidamento finale del backend di attivazione licenze (`@gestione-casa/activation-service`).
Si focalizza sui requisiti non funzionali e di resilienza in produzione:
- **Atomicità e Rollback transazionale** (`withTransaction`).
- **Concorrenza e prevenzione race conditions** (richieste simultanee e locking).
- **Resilienza ai Failure Modes del Database** e risposte di errore controllate.
- **Sanitizzazione e Sicurezza degli Errori** (oscuramento credenziali e chiavi nei log e risposte API).
- **Consistenza dell'Audit Trail** con mascheramento obbligatorio.
- **Gestione del ciclo di vita del pool di connessioni** (`closePool`).
- **Collaudo E2E del ciclo di vita della licenza** e supporto per test PostgreSQL reali opzionali (`TEST_DATABASE_URL`).

---

## 2. Transaction Rollback & Atomicità
Le transazioni database sono incapsulate nella funzione `withTransaction` (`src/database/transaction.ts`).
- Inizio transazione con `BEGIN` all'inizio del blocco.
- Commit automatico con `COMMIT` in caso di successo.
- Esecuzione garantita di `ROLLBACK` nel blocco `catch` in caso di errore interno o eccezione non gestita.
- Rilascio automatico del client nel blocco `finally`.
- **Invariante garantito:** Nessun record orfano, inconsistente o parzialmente modificato rimane nel database in caso di errore improvviso.

---

## 3. Concorrenza e Hardening Richieste Duplicate
- Per ambienti con PostgreSQL attivo, viene utilizzato il row-level locking nativo tramite query `SELECT ... FOR UPDATE` sulle tabelle `licenses`, `activation_policies` e `license_activations`.
- Per ambienti in-memory fallback o in-process locking, la funzione `executeWithMemoryLock` garantisce la serializzazione per codice di licenza (`licenseCode`).
- **Verifica con richieste parallele:** Test con `Promise.all` inviando 10 richieste simultanee per la stessa licenza e dispositivi differenti garantisce che il conteggio massimo di attivazioni (`max_activations`) sia rispettato senza over-activation o condizioni di gara (race conditions).

---

## 4. Failure Modes & Sanitizzazione Credenziali
In presenza di errori di rete o guasti del database (es. connessione persa, timeout, violazione vincoli):
- Il backend intercetta le eccezioni e le converte in un payload di risposta controllato `{ status: 'SERVER_ERROR', message: ... }`.
- La funzione `sanitizeErrorMessage` analizza e rimuove qualsiasi informazione sensibile (password, credenziali, URL di connessione `postgres://...`, chiavi private).
- Nessuna credenziale o password viene mai esposta nei log pubblici o nelle risposte HTTP verso i client.

---

## 5. Audit Trail Consistency & Security
Ogni operazione esaminata (`activate`, `validate`, `deactivate`, `reactivate` o tentativi rifiutati per revoca/scadenza/limite):
- Genera un record di audit strutturato nel repository audit (`PostgresAuditRepository` / `MemoryAuditRepo`).
- Applica il mascheramento obbligatorio `maskLicenseCode` sul codice di licenza (es. `ABCD-****-****-1234`).
- Non salva mai chiavi private RSA/Ed25519 o stringhe di connessione nei dettagli dell'evento.

---

## 6. Pulizia Connessioni Database
La gestione del pool di connessioni PostgreSQL (`src/database/pool.ts`) offre la funzione `closePool()`:
- Termina in modo grazioso tutte le connessioni aperte nel pool `pg.Pool`.
- Azzera il singleton del pool consentendo una dismissione o riavvio sicuro senza socket hanging o leaker di risorse.

---

## 7. Collaudo E2E Ciclo di Vita Licenza
Il test end-to-end `tests/b3d-backend-hardening.test.mjs` verifica la seguente sequenza completa:
1. `activate` Dispositivo A -> **PASS** (`ACTIVATED`)
2. `validate` Dispositivo A -> **PASS** (`VALID`)
3. `activate` Dispositivo B -> **PASS** (`ACTIVATED`, slot 2/2 occupati)
4. `activate` Dispositivo C -> **REJECT** (`ACTIVATION_LIMIT_REACHED`)
5. `deactivate` Dispositivo A -> **PASS** (`DEACTIVATED`, slot liberato 1/2)
6. `validate` Dispositivo A -> **REJECT** (`DEVICE_MISMATCH`)
7. `activate` Dispositivo C -> **PASS** (`ACTIVATED`, slot 2/2 occupati)
8. `reactivate` Dispositivo A -> **REJECT** (`ACTIVATION_LIMIT_REACHED`)
9. `deactivate` Dispositivo B -> **PASS** (`DEACTIVATED`, slot liberato 1/2)
10. `reactivate` Dispositivo A -> **PASS** (`ACTIVATED`, riutilizzando esattamente lo stesso `activationId`)
11. `validate` Dispositivo A -> **PASS** (`VALID`)

---

## 8. Integrazione PostgreSQL Reale (Opzionale)
La suite di test include un test di integrazione reale opzionale:
- Se la variabile d'ambiente `TEST_DATABASE_URL` è definita, il test stabilisce una connessione reale ed esegue query ed il test di rollback transazionale direttamente su PostgreSQL.
- Se `TEST_DATABASE_URL` non è impostata, il test viene marcato come `SKIP` in modo trasparente, consentendo l'esecuzione della suite CI anche in ambienti senza container PostgreSQL attivo.

---

## 9. Matrice della Suite di Test Complessiva
Il totale dei test eseguiti dal runner nel progetto è di **81 test** (80 superati PASS, 1 saltato SKIP opzionale PostgreSQL):
- **11 test**: `tests/b2-foundation.test.mjs` (Fase B2 Foundation)
- **12 test**: `tests/b3a-persistence.test.mjs` (Fase B3-A Persistence Schema)
- **14 test**: `tests/b3b-activation-engine.test.mjs` (Fase B3-B Activation Engine)
- **24 test**: `tests/b3c-license-lifecycle.test.mjs` (Fase B3-C License Lifecycle)
- **20 test**: `tests/b3d-backend-hardening.test.mjs` (Fase B3-D Specific Backend Hardening: 19 PASS + 1 SKIP opzionale PostgreSQL)

### Dettaglio dei Test Specifici B3-D (`tests/b3d-backend-hardening.test.mjs`):
1. **1. Transaction rollback**: generic `withTransaction` failure executes `ROLLBACK` -> PASS
2. **1A. Rollback Activation**: Error after INSERT activation and before COMMIT -> PASS
3. **1B. Audit repository failure**: failure during activation triggers full rollback -> PASS
4. **1C. Rollback Deactivate**: Error after status change but before COMMIT leaves record ACTIVE -> PASS
5. **1D. Rollback Reactivate**: Error after UPDATE to ACTIVE but before COMMIT leaves record DEACTIVATED -> PASS
6. **2A. Concurrent ACTIVATE**: 5 parallel calls on SAME license + SAME device -> PASS
7. **2B. Concurrent DEACTIVATE**: 5 parallel calls on SAME license + SAME device -> PASS
8. **2C. Concurrent REACTIVATE**: 5 parallel calls on SAME license + SAME device -> PASS
9. **2D. Concurrent ACTIVATE / DEACTIVATE**: parallel mix on SAME license + SAME device -> PASS
10. **2E. Reactivate vs Last Slot Race**: parallel reactivate vs new activate with `maxActivations=1` -> PASS
11. **3A. Duplicate ACTIVATE request**: idempotent and does not duplicate slots -> PASS
12. **3B. Duplicate VALIDATE request**: idempotent -> PASS
13. **3C. Duplicate DEACTIVATE request**: idempotent -> PASS
14. **4. PostgreSQL UNIQUE violation (code 23505)**: returns controlled `SERVER_ERROR` without exposing DB details -> PASS
15. **5. Audit log masking**: records masked license codes and excludes sensitive keys -> PASS
16. **6. Request / Correlation ID**: passed from HTTP header (`x-request-id`) through controller to audit log -> PASS
17. **7. Connection Pool cleanup**: `closePool` closes PostgreSQL pool gracefully -> PASS
18. **8. Complete E2E License Lifecycle**: 11-step sequential lifecycle collaudo -> PASS
19. **9. HTTP Endpoints E2E**: POST `/api/licenses/activate`, `/validate`, `/deactivate` -> PASS
20. **10. Optional Real PostgreSQL Integration**: executed when `TEST_DATABASE_URL` is set -> SKIP (quando non impostata)

---

## 10. Limiti e Fuori Scopo
Non fanno parte della presente Fase B3-D e restano demandati alle fasi successive:
- Fase 2.6.C: Integrazione Client SDK (`@gestione-casa/shared-sdk`)
- Fase 2.6.D: Production Hardening & Operations (Deployment Cloud, CI/CD, Monitoring)
- Sviluppo di componenti visuali o interfacce utente web
