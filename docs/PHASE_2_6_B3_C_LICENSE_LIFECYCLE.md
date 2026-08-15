# Phase 2.6.B3-C: License Lifecycle Engine (Validate, Deactivate & Reactivation)

## 1. Scopo della Fase B3-C
La Fase B3-C completa la gestione del ciclo di vita completo delle licenze software nel servizio di attivazione (`@gestione-casa/activation-service`).
Estende le funzionalità base di attivazione (B3-B) implementando la validazione online del dispositivo (`validate`), la disattivazione (`deactivate`) ed il flusso transazionale di riattivazione dello stesso dispositivo (`reactivation`).

---

## 2. Endpoint Operativi

Gli endpoint HTTP gestiti dal controller `licenseController.ts` e dalle rotte `licenseRoutes.ts` sono:

- `POST /api/licenses/activate`
  - Attiva una licenza per un nuovo dispositivo o esegue la riattivazione se il dispositivo era disattivato.
- `POST /api/licenses/validate`
  - Verifica la validità di un'attivazione esistente e attiva per un determinato dispositivo.
- `POST /api/licenses/deactivate`
  - Disattiva un dispositivo attivo liberando lo slot per una futura attivazione.

Tutti e tre gli endpoint erano già registrati nella struttura base della B2 e sono stati resi pienamente operativi senza introdurre rotte aggiuntive o inventate.

---

## 3. Validate Logic

L'operazione `validate` esegue la verifica dello stato di licenza e dispositivo con i seguenti controlli:
1. Lookup licenza tramite `licenseCode`.
2. Controllo stato licenza: se lo stato non è `assigned` (es. `revoked`), restituisce `LICENSE_REVOKED`.
3. Controllo scadenza: se `expiresAt` è passato, restituisce `LICENSE_EXPIRED`.
4. Lookup dell'attivazione per `(license.id, deviceId)`.
5. Se l'attivazione non esiste o il suo stato non è `active`, restituisce `DEVICE_MISMATCH`.
6. Aggiornamento campo `last_validated_at` con il timestamp corrente.
7. Generazione della firma Ed25519 e restituzione di status `VALID`.

**Invarianti garantiti:**
- `VALIDATE` NON crea nuovi record di attivazione.
- `VALIDATE` NON consuma slot.
- `VALIDATE` NON modifica `activated_at` o `deactivated_at`.
- `VALIDATE` NON modifica le policy di attivazione.

---

## 4. Deactivate Logic

L'operazione `deactivate` consente di disattivare una macchina attiva liberando lo slot:
1. Acquisisce la licenza e l'attivazione attiva per `(license.id, deviceId)`.
2. Se non esiste un'attivazione in stato `active`, restituisce immediatamente `NOT_ACTIVE` con HTTP 200 OK (comportamento idempotente).
3. Se l'attivazione è attiva, aggiorna lo stato in `deactivated` e imposta il timestamp `deactivated_at`.
4. Registra l'evento di audit `DEACTIVATION_SUCCESS`.
5. NON esegue alcuna cancellazione fisica (`DELETE`), preservando la riga nel database per audit e storico.

---

## 5. Reactivation (Requisito Critico)

Nel schema database PostgreSQL esiste il vincolo unico:
```sql
UNIQUE (license_id, device_id)
```

Per rispettare tale vincolo ed evitare violazioni di chiave univoca (`INSERT` duplicati):
1. Quando la richiesta `activate` trova una precedente riga di attivazione disattivata (`status = 'deactivated'`) per lo stesso `(license.id, device_id)`:
   - **NON** esegue un `INSERT`.
   - **Riusa** il record esistente tramite `UPDATE`.
2. **Proprietà del record riattivato:**
   - `id` (Activation ID): **Preservato**
   - `created_at`: **Preservato**
   - `activated_at`: **Reimpostato** al nuovo timestamp di riattivazione
   - `deactivated_at`: **Azzerato** (`null` / `undefined`)
   - `last_validated_at`: **Preservato** come dato storico della validazione precedente
   - `status`: Impostato a `'active'`
3. La riattivazione rioccupa uno slot valido delle attivazioni massime consentite.

---

## 6. Slot Policy

La policy sul numero massimo di attivazioni fa riferimento **esclusivamente ed autorevolmente** a:
```
activation_policies.max_activations
```
Non viene utilizzato alcun campo deprecato in `licenses.max_activations`.

**Scenario di limite su riattivazione:**
- Se `max_activations = 1`, `device-A` viene disattivato (slot libero) e `device-B` si attiva (slot occupato da B).
- Se successivamente si tenta di riattivare `device-A`, il sistema verifica che il numero di attivazioni attive (1 per `device-B`) ha già raggiunto il massimo consentito.
- Esito: la riattivazione di `device-A` viene rifiutata con `ACTIVATION_LIMIT_REACHED`.

---

## 7. Transazioni e Locking

Tutte le operazioni critiche (`activate`, `deactivate`, `reactivate`) sono eseguite in PostgreSQL all'interno di un blocco transazionale unico (`withTransaction`):
- Order di Lock per `deactivate`:
  1. `licenses` (SELECT ... FOR UPDATE)
  2. `license_activations` (SELECT ... FOR UPDATE)
- Order di Lock per `reactivate` / `activate`:
  1. `licenses` (SELECT ... FOR UPDATE)
  2. `activation_policies` (SELECT ... FOR UPDATE)
  3. `license_activations` (SELECT ... FOR UPDATE)

In ambienti di produzione PostgreSQL è l'archivio autorevole e con transazioni ACID isolato. In ambiente senza PostgreSQL viene utilizzato il fallback In-Memory con Lock concorrente applicato al codice della licenza (`executeWithMemoryLock`).

---

## 8. Revoked License

- Ogni richiesta di `activate` o `validate` su una licenza il cui `status` è diverso da `assigned` (es. `revoked` o `suspended`) viene immediatamente rifiutata con lo stato `LICENSE_REVOKED`.
- In B3-C non è stato creato alcun endpoint admin aggiuntivo o non richiesto per la revoca.

---

## 9. Audit Events

Gli eventi registrati nella tabella di audit durante la B3-C sono:
- `VALIDATION_SUCCESS`: Validazione online completata con successo.
- `VALIDATION_REJECTED`: Validazione rifiutata (es. licenza revocata, scaduta, dispositivo errato).
- `DEACTIVATION_SUCCESS`: Disattivazione completata e slot liberato.
- `DEACTIVATION_IDEMPOTENT`: Richiesta di disattivazione su dispositivo già disattivato.
- `DEACTIVATION_REJECTED`: Errore durante la disattivazione.
- `REACTIVATION_SUCCESS`: Riattivazione di un record esistente completata con successo.
- `REACTIVATION_REJECTED_LIMIT`: Tentativo di riattivazione fallito per superamento slot.

**Invarianti di Sicurezza Audit:**
- Codice di licenza oscurato tramite `maskLicenseCode` (es. `ABCD-****-****-1234`).
- Nessun log di chiavi private, stringhe di connessione `DATABASE_URL` o stack trace interni.

---

## 10. Contratti Pubblici e Codici SDK

I codici esposti nelle risposte HTTP e SDK sono rigorosamente conformi allo Shared SDK (`@gestione-casa/shared-sdk`):
- `DEVICE_MISMATCH`: Codice pubblico Shared SDK.
- `NOT_ACTIVE`: Codice pubblico Shared SDK.
- `REACTIVATION_SUCCESS` / `REACTIVATION_REJECTED_LIMIT`: Nomi di eventi audit interni.

Nessun nuovo codice pubblico è stato inventato o aggiunto in modo arbitrario.

---

## 11. Dettagli della Suite di Test

- **Composizione dei 61 test totali:**
  - **11 test** `tests/b2-foundation.test.mjs` (Fase B2)
  - **12 test** `tests/b3a-persistence.test.mjs` (Fase B3-A)
  - **14 test** `tests/b3b-activation-engine.test.mjs` (Fase B3-B)
  - **24 test** `tests/b3c-license-lifecycle.test.mjs` (Fase B3-C)

- **Classificazione Concorrenza:**
  - **REAL POSTGRES CONCURRENCY TEST:** NO (L'ambiente di test esegue il fallback In-Memory Store).
  - **SIMULATED CONCURRENCY TEST:** YES (Test della gestione concorrente tramite `Promise.all` e memory locking per richieste parallele di attivazione e disattivazione).

---

## 12. Limiti e Fuori Scopo

Non sono stati implementati e restano del tutto esclusi dalla presente fase:
- Integrazione con moduli OCR
- Fase 2.6.C (Client SDK Integration)
- Fase 2.6.D (Production Hardening & Operations)
- Nuovi endpoint di amministrazione (es. gestione utenti, revoca manuale UI)
- Interfacce utente o pannelli web aggiuntivi
