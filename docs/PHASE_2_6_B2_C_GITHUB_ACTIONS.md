# PHASE 2.6.B2-C: GITHUB ACTIONS / CI DOCUMENTATION
## `@gestione-casa/activation-service` (v0.1.0)

### 1. Scopo della CI
La workflow GitHub Actions definita in `.github/workflows/ci.yml` garantisce la validazione automatica ed esaustiva della foundation backend Node.js / TypeScript dell'Activation Service ad ogni proposta di modifica o integrazione nel ramo principale `main`.

### 2. Trigger di Esecuzione
La pipeline si attiva automaticamente nei seguenti casi:
- **`push`** sul ramo `main`
- **`pull_request`** verso il ramo `main`

### 3. Ambiente di Esecuzione e Runtime
- **OS**: `ubuntu-latest`
- **Runtime**: Node.js `22` (configurato tramite `actions/setup-node@v4`)
- **Gestore Pacchetti & Cache**: `npm` con caching automatico attivo (`cache: 'npm'`)
- **Variabili d'Ambiente CI**: `NODE_ENV=test`

### 4. Installazione Dipendenze
La CI utilizza in modo vincolante il comando:
```bash
npm ci
```
Questo garantisce la riproducibilità deterministica partendo dal file `package-lock.json` versionato, senza alterare la risoluzione dei pacchetti né installare versioni non autorizzate.

### 5. Quality Gate Sequenziale
La pipeline esegue la seguente sequenza bloccante di controlli di qualità:
1. **Typecheck (`npm run typecheck`)**: Verifica l'assenza di errori di tipo TypeScript (`tsc --noEmit`).
2. **Lint (`npm run lint`)**: Garantisce la conformità stilistica e l'integrità sintattica.
3. **Test Suite (`npm test`)**: Esegue la suite di test nativa Node.js (`node --test tests/*.test.mjs`), testando:
   - Endpoint HTTP (`GET /health` -> 200, endpoints `/api/licenses/*` -> 400/501)
   - Firma e verifica crittografica Ed25519 (`LicenseSigningService`)
   - Fallimento rilevamento manomissione (Tampering Detection)
   - Validazione vettoriale V1 (**Golden Vector A** SHA-256: `072d4bf56f2f468ab719279224c14f2ebb3369847082a23e40c36d21a525e24f`)
   - Mascheramento codici di licenza (`maskLicenseCode`)
4. **Build (`npm run build`)**: Compila il progetto TypeScript generando i file JS/d.ts in `dist/`.

Se un qualsiasi step della sequenza fallisce, l'esecuzione della CI viene immediatamente interrotta segnale esito negativo.

### 6. Isolamento e Sicurezza dei Secret
- **Nessun Secret di Produzione Richiesto**: La suite di test genera chiavi Ed25519 effimere esclusivamente in memoria a runtime.
- **Nessuna Chiave Hardcoded**: Nessun secret o private key reale è contenuto nel codice o nei file della CI.
- **Ambiente Dev/Test Sicuro**: Non sono necessarie variabili d'ambiente riservate (`LICENSE_PRIVATE_KEY`, etc.) per far passare la CI.

### 7. Binding con lo Shared SDK Locale
La pipeline fa affidamento esclusivamente sul pacchetto locale:
```
@gestione-casa/shared-sdk: file:vendor/shared-sdk-0.4.0
```
La directory `vendor/shared-sdk-0.4.0/` è versionata all'interno del repository ed è consumata direttamente da `npm ci`, senza invocare repository npm remoti esterni o versioni legacy (0.3.0).

### 8. Criteri di Successo
Un'esecuzione CI è considerata **VALIDATA (PASS)** quando:
- Dipendenze installate correttamente con `npm ci`
- `0` errori di compilazione/typecheck
- `11/11` test eseguiti con esito PASS
- Artefatto di build `dist/` generato con successo
