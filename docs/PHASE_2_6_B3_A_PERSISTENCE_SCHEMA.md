# Phase 2.6.B3-A: Persistenza Autorevole e Schema Dati Activation Service

## 1. Obiettivo
Predisporre la base di persistenza autorevole e lo schema dati relazionale per il servizio **Gestione Casa Activation Service**. La soluzione fornisce il supporto per la concorrenza, le transazioni atomiche, i vincoli di unicità e la futura gestione multi-istanza, senza affidarsi a ORM e senza richiedere un database esterno attivo durante i test della CI standard.

## 2. Scelta Tecnologica
- **Database Engine**: PostgreSQL (scelto per robustezza relazionale, transazioni ACID e vincoli di concorrenza).
- **Driver Node.js**: `pg` (driver ufficiale PostgreSQL senza ORM pesante come Prisma, TypeORM o Sequelize).
- **Controllo Tipi**: `@types/pg` per la massima type-safety TypeScript.

## 3. Configurazione Environment & Sicurezza
- `DATABASE_URL` aggiunto a `AppConfig` (`src/config/env.ts`) e documentato in `.env.example`.
- **Sviluppo / Test**: `DATABASE_URL` può essere omesso; l'applicazione si avvia normalmente per test e sviluppo locale senza connessione obbligatoria.
- **Produzione**: `DATABASE_URL` è obbligatorio; l'avvio dell'applicazione fallisce in modo esplicito se non configurato.
- **Mascheramento & Logging**: Nessuna stringa di connessione o credenziale viene stampata nei log. Le query dinamiche usano esclusivamente parametri posizionali (`$1`, `$2`, ...).

## 4. Schema Autorevole V1 (`001_activation_schema.sql`)

### Tabelle e Responsabilità

1. `schema_migrations`
   - Registro delle migrazioni applicate (`version`, `name`, `applied_at`).
2. `licenses`
   - Stato autorevole delle licenze emesse (`id`, `license_code` UNIQUE, `checksum`, `customer_id`, `license_type`, `status`, `schema_version`, `engine_version`, `generated_at`, `expires_at`, `max_activations`, `created_at`, `updated_at`).
3. `activation_policies`
   - Policy di attivazione applicata ad una licenza (`id`, `license_id` REFERENCES `licenses(id)` UNIQUE, `license_type`, `max_activations`, `allow_reactivation`, `allow_offline_validation`, `max_offline_days`, `created_at`, `updated_at`).
4. `license_activations`
   - Registro dei dispositivi attivati per licenza (`id`, `license_id` REFERENCES `licenses(id)`, `device_id`, `status`, `activated_at`, `last_validated_at`, `deactivated_at`, `created_at`, `updated_at`).
   - **Vincolo di unicità**: `UNIQUE (license_id, device_id)`.
5. `audit_events`
   - Tracciamento auditable delle operazioni di sistema (`id`, `event_type`, `license_id`, `activation_id`, `request_id`, `device_id`, `metadata` JSONB, `created_at`).

### Indici Ottimizzati
- `licenses.license_code` (creato implicitamente dal vincolo UNIQUE)
- `idx_license_activations_license_id`
- `idx_license_activations_device_id`
- `idx_license_activations_status`
- `idx_audit_events_license_id`
- `idx_audit_events_request_id`
- `idx_audit_events_created_at`

## 5. Migration Strategy
- Migration runner custom in `src/database/migrator.ts`.
- Esegue le migrazioni SQL in ordine versionato alfabetico all'interno di una transazione dedicata.
- Script CLI eseguibile tramite:
  ```bash
  npm run db:migrate
  ```
- Non viene eseguito automaticamente all'importazione dei moduli o all'avvio dell'applicazione in CI/test.

## 6. Transaction Strategy
- Helper `withTransaction` in `src/database/transaction.ts`.
- Gestisce la sequenza `BEGIN` -> callback -> `COMMIT` / `ROLLBACK` su un singolo client PostgreSQL dedicato, evitando `pool.query` separate e garantendo l'isolamento acido.

## 7. Repositories PostgreSQL
In `src/repositories/postgres/`:
- `PostgresLicenseRepository` (implementa `LicenseRepository`)
- `PostgresActivationRepository` (implementa `ActivationRepository`)
- `PostgresActivationPolicyRepository` (implementa `ActivationPolicyRepository`)
- `PostgresAuditRepository` (implementa `AuditRepository`)

Supportano l'iniezione opzionale di un `DbClient` per l'esecuzione guidata all'interno di transazioni.

## 8. Stato e Confine con B3-B

### Cosa è implementato in B3-A:
- Schema relazionale V1.
- Gestione pool, migrator e transazioni.
- Adapter repository PostgreSQL.
- Test di configurazione, schema, export e sicurezza (23 test totali PASS).

### Cosa NON è implementato in B3-A:
- Assegnazione effettiva degli slot Beta Tester (fino a 32 dispositivi).
- Logica di business ed elaborazione completa degli endpoint `/activate`, `/validate`, `/deactivate`.
- **Gli endpoint trasversali con payload valido restituiscono ancora `501 NOT_IMPLEMENTED`**.

### Confine con B3-B:
- La sottofase **B3-B** implementerà la logica transazionale di attivazione, validazione e disattivazione, collegando le repository PostgreSQL agli endpoint Express.
