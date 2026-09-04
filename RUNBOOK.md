# RUNBOOK d'incidente — WA Cruscotto (AB STUDIO)

Servizio: `wa-cruscotto-v2` su Railway · prod `https://wa-cruscotto-v2-production.up.railway.app`
Diagnostica rapida: `GET /api/health` · `GET /api/version` · `GET /api/bot/monitor` ·
`GET /api/bot/flow-health` · `GET /api/bot/zapi-info` · `GET /api/selftest` · `GET /api/bot/agenda/today`.

> **INVARIANTE DI SICUREZZA (non negoziabile):** in autonomia partono SOLO cortesia +
> flusso appuntamenti; **merito e urgenze SEMPRE bozza** (WhatsApp ED email). Nessun
> intervento del runbook deve allentarlo.

---

## 1) Sessione Z-API caduta (WhatsApp non riceve/invia)
**Sintomi:** alert email "🔴 WhatsApp/Z-API disconnesso"; `/api/bot/monitor` → `zapiState: down`;
`/api/bot/zapi-info` → `status.connected=false` o `smartphoneConnected=false`; nessun messaggio in arrivo.
**Cause tipiche:** telefono spento/offline, sessione WhatsApp scaduta, QR da riscansionare.
**Azioni:**
1. Verifica `GET /api/bot/zapi-info` (campo `status`).
2. Apri la dashboard Z-API → riconnetti la sessione (riscansiona il **QR** col telefono dello studio).
3. Assicura il telefono online e con WhatsApp aperto.
4. Ri-registra il webhook: `POST /api/bot/repair-webhook` (idempotente, `notifySentByMe:true`).
5. Conferma il ripristino: `POST /api/bot/monitor/check` → `healthy:true` (arriva anche email "✅ ripristinato").
**Nota:** gli alert di caduta usano l'EMAIL (Brevo), affidabile perché il canale WhatsApp è proprio quello rotto.

## 2) Deploy fallito / servizio down
**Sintomi:** `GET /api/health` non risponde o `/api/version` mostra una versione vecchia; deploy Railway in errore.
**Azioni:**
1. `railway logs` (progetto `wa-cruscotto-studio-branca`, service `wa-cruscotto-v2`) → leggi l'errore.
2. Ricostruisci in locale prima di ripubblicare: **`npm run predeploy`** (test + typecheck + build). Deploy SOLO a verde.
3. Rideploy: `railway up` dal repo. Verifica `GET /api/health` = ok e `/api/version` = versione attesa.
4. Rollback se serve: `railway` → deployments → *Redeploy* dell'ultimo deploy sano (oppure `git revert` + `railway up`).
5. Il servizio si auto-ripara all'avvio (webhook Z-API) e nel tick (watchdog + monitor).

## 3) Invio errato a un cliente (merito/urgenza partito, o testo sbagliato)
**Sintomi:** un cliente ha ricevuto una risposta che doveva restare bozza, o con contenuto errato.
**Contenimento immediato:**
1. **Ferma l'auto-invio:** `POST /api/bot/config {"autoSend": false}` (misura temporanea).
   Ricorda: gli **appuntamenti** hanno un toggle separato (`bot_auto_appointments`); per fermare tutto anche quelli, disattivalo.
2. Verifica cosa è partito da solo: `GET /api/bot/sent` (WhatsApp) e `GET /api/email/sent` (email) —
   compaiono SOLO `appointment`/`courtesy` (WA) o `appointment`/`reply-approved` (email). Il **merito non deve mai** comparire come autonomo.
**Diagnosi:**
3. Se è comparso merito autonomo → **regressione dell'invariante**: controlla `server/autosend.ts`
   (`decideWorkAutoSend`) e i punti d'invio in `server/routes.ts`/`server/email.ts`. Il merito deve → BOZZA.
4. Se è un leak di ragionamento/nome-tool → guardrail `server/sanitize.ts`.
**Ripristino:** dopo il fix (test verdi + deploy), riporta `autoSend` a ON:
`POST /api/bot/config {"autoSend": true}`.

## 4) Backlog bozze / scadenze / appuntamenti
- Bozze ferme: `GET /api/bot/drafts/aging`; digest urgenze al controllo: `POST /api/bot/jobs/aging/run`.
- Proposte appuntamento scadute (slot fantasma): `POST /api/bot/jobs/cleanup/run`.
- Scadenze imminenti: `GET /api/bot/deadlines?imminent=7`; promemoria: `POST /api/bot/jobs/deadlines/run`.
- Briefing del mattino (anteprima): `GET /api/bot/briefing`; invio: `POST /api/bot/jobs/briefing/run` (va al controllo).

## 6) Notifiche d'agenda a Mariano — DIGEST 08:00 + REMINDER T-10 (v2.18.0)
Due notifiche automatiche verso il numero di controllo (393762547718), mai ai clienti, mai dal flusso bozze.
- **Digest 08:00** (Europe/Rome, ogni giorno incl. weekend): elenco totale appuntamenti di oggi (ora inizio–fine, oggetto, controparte, luogo/LINK udienza telematica, nota) + conteggio; se vuoto invia comunque "nessun appuntamento" (prova di vita).
- **Reminder T-10**: 10 min prima di ogni appuntamento, uno per appuntamento, una volta (dedup `rem:<id>@<startISO>` → segue gli spostamenti; il cancellato non parte).
- **Fonte reale**: Google Calendar diretto (`GOOGLE_*`) + merge `bot_appointments` non specchiati; NIENTE Make. Fallback su `bot_appointments` se Google non disponibile.
- **Anteprima/fonte**: `GET /api/bot/agenda/today` (sola lettura, mostra `source`, `googleConfigured/googleOk`, conteggi).
- **Trigger manuali**: `POST /api/bot/jobs/agenda-digest/run` (invio reale ora), `…/agenda-digest-test/run` (UN messaggio di PROVA etichettato col contenuto reale di oggi — vale anche da digest odierno), `…/agenda-reminders/run`.
- **Salute (anti "verde ma morto")**: `GET /api/bot/flow-health` e `GET /api/selftest` → campo `agendaJobs` con `agendaDigest`/`agendaReminder`; verde solo se lo scheduler è vivo (heartbeat `agenda_tick_last_at` < 3 min), altrimenti `error`.
- **Toggle DB** (`app_settings`, senza redeploy): `agenda_digest` (1), `agenda_reminders` (1), `agenda_digest_hour` (8), `agenda_digest_weekends` (1 = anche sab/dom; feriali → 0), `agenda_reminder_lead_min` (10), `agenda_digest_catchup_h` (4).
- **Idempotenza/stato**: setting `agenda_digest_last_sent_date` + tabella `agenda_notify_log` (chiave UNIQUE) sul volume `/data`. Backoff Z-API su invio fallito; ogni invio loggato.
- **Se il digest 08:00 non arriva**: verifica `GET /api/bot/flow-health` → `agendaJobs.reminders.lastTickAt` (loop vivo?), `agendaJobs.digest.lastStatus`; controlla `GET /api/bot/agenda/today` (`googleOk`); forza con `POST /api/bot/jobs/agenda-digest/run`.

## Contatti tecnici / riferimenti
- Numero di controllo (notifiche a Mariano): `393762547718`. Device Z-API (linea studio): `393457050479`.
- Env chiave: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ZAPI_*`, `GOOGLE_*`, `BREVO_API_KEY`, `ALERT_EMAIL`,
  `EMAIL_TISCALI_PASS`, `EMAIL_ICLOUD_PASS`. (Per SMS in futuro: `SMS_PROVIDER`, `SKEBBY_*`.)

## 5) Data sbagliata in un messaggio appuntamento / leak di ragionamento (incidente 13/07)
**Sintomi:** il bot scrive al cliente un giorno/data diverso da quello registrato in agenda
("giovedì 16" nel testo, evento al 17), oppure nel messaggio compare la deliberazione interna
del modello prima del vero testo.
**Difese attive (v2.16.2):**
1. `propose_booking` rifiuta slot non presenti nell'ultimo `get_availability` (stessa generazione).
2. I tool restituiscono la data con giorno-settimana calcolato dal server (`formatDateFullIT`)
   e obbligo di copiarla nel testo.
3. `server/date_guard.ts`: testo incoerente con la data registrata → NIENTE auto-invio, bozza
   (log `[DateGuard]` nei log Railway). Vale per WhatsApp ed email.
4. `server/sanitize.ts`: regola del saluto (paragrafi prima di "Buongiorno/Gentile/…" = preambolo
   rimosso) + marcatori meta (log `[Sanitizer]`).
**Se ricapita:** cercare `[DateGuard]`/`[Sanitizer]` in `railway logs`; aggiungere il caso reale a
`scripts/test_date_guard.ts` / `scripts/test_sanitize.ts` (riprodurre PRIMA, poi fixare);
se serve fermare subito il flusso autonomo: `POST /api/bot/config {"autoAppointments": false}`.


---

## Manutenzione 2026-07-25 (check completo sistema)

**Ambiente di sviluppo locale — gate `predeploy` ripristinato.**
Il `node` di default della macchina è passato a **v26**: `better-sqlite3@9.6.0` (binario
`NODE_MODULE_VERSION 115`) non carica sotto Node 26 e **non compila** su Node 26 →
`npm run test:all`, `typecheck` e `build` erano rotti in locale (`ERR_DLOPEN_FAILED`,
poi `tsc/vite: command not found` perché il `node_modules` era `--omit=dev`).

Correzione applicata (verificata):
- usare **Node 20** in locale per questo repo (aggiunto `.nvmrc` = `20`);
  `export PATH="/opt/homebrew/opt/node@20/bin:$PATH"`;
- `npm rebuild better-sqlite3 --build-from-source` (sotto Node 20) + `npm install --include=dev`;
- esito: `test:all` **25/25 OK**, `typecheck` **exit 0**, `build:local` **exit 0**.
- Produzione NON impattata: il deploy usa `Dockerfile` `node:18-alpine` + `dist/` pre-compilata
  (build locale = artefatto). Il mismatch era solo locale.

**⚠️ Disallineamento deploy (da sanare con redeploy controllato).**
Gli endpoint del SITO (`/api/site/*`, v2.16) e di MAKE (`/api/integrations/make/*`, v2.17)
rispondono **404 in produzione**, pur essendo presenti nel codice committato (branch
`feat/chatbot-conversazionale-agenda` @ `a6cab39`, anche su origin) e nel `dist/` committato,
con `test:all`/`typecheck`/`build` verdi. Le rotte core (`/api/health`, `/api/version`,
`/api/bot/*`, `/api/selftest`) rispondono 200. Diagnosi: **la produzione esegue un bundle
precedente alle feature Sito+Make** (il servizio Railway non è allineato all'ultimo commit del
branch). `GET /api/version` NON è probante: `version` è la stringa hardcoded `'2.17.0'` e
`built` è `new Date()` a runtime.
→ **Azione (gate umano, è il bot live coi clienti):** redeploy Railway del commit corrente
(`railway up` dal repo oppure allineare il branch/deploy del servizio `wa-cruscotto-v2`) e
riverificare `GET /api/integrations/make/status` = 200 e `/api/site/*`. Da fare in finestra
controllata per non disturbare le ~23 bozze pending e le sessioni WhatsApp attive.

**Invarianti di sicurezza verificati in produzione (25/07):** `autoSend:true` (regola
01/07/2026, non riportare a OFF), `waCommands:false`, `decideWorkAutoSend` (merito/urgenze →
sempre bozza), sanitizer anti-leak, anti-overbooking fail-safe — tutti integri; `/api/selftest` OK.

**Facebook:** il monitor (ultimo run 21/07) segnalava `data_access_expires_at = 2026-07-25 10:08`.
Il rinnovo richiede **re-autorizzazione Meta** (login OAuth con barriere di verifica) → **azione
manuale di Mariano**, non automatizzabile da qui.

---

## Manutenzione 2026-07-26 (v2.18.0 — notifiche d'agenda a Mariano)

**Nuova funzione (sezione 6).** Aggiunti DUE job verso il numero di controllo: **digest 08:00**
(elenco totale appuntamenti di oggi) e **reminder T-10** (10 min prima di ogni appuntamento).
Fonte reale = **Google Calendar diretto** (verificato in produzione: `googleConfigured:true`,
`googleOk:true`, agenda popolata) + merge `bot_appointments`; **non** dipende da Make. Scheduler
interno dedicato (tick 60s, `server/agenda_notify.ts`), fuso Europe/Rome con DST, dedup persistente
su `/data` (`agenda_notify_log` UNIQUE + `agenda_digest_last_sent_date`), backoff Z-API, audit,
salute in `/api/selftest` + `/api/bot/flow-health` (`agendaJobs`). Logica pura in
`server/agenda_notify_logic.ts` con test `scripts/test_agenda_notify.ts` (40 asserzioni).

**Invarianti verificati in produzione dopo il deploy (26/07):** `autoSend:true`, `waCommands:false`,
`controlNumber:393762547718`, `decideWorkAutoSend`/webhook non toccati; `/api/selftest` `issues:0`
con `agendaDigest:ok` e `agendaReminder:ok`.

**Deploy.** `railway up` (Dockerfile, `dist/` pre-compilata) dopo `npm run predeploy` verde
(test 26 file OK, typecheck 0, build OK). **Backup DB PRIMA** del deploy: dump binario del volume
`/data` (`data.db`+`-wal`+`-shm`) via `railway ssh`, `PRAGMA integrity_check = ok`, in
`~/wa-cruscotto-backups/<timestamp>/`. **DB preservato**: bozze 0→0, appuntamenti 25→25, integrità ok
(il volume `/data` è persistente e non viene sostituito dal redeploy). Coda bozze non toccata dal deploy.

**Assunzione (modificabile).** Digest inviato **anche nel weekend** (`agenda_digest_weekends=1`),
perché è l'agenda personale di Mariano. Per soli feriali: impostare `agenda_digest_weekends=0` in
`app_settings` (nessun redeploy).

# Restart automatico 2026-09-04T10:53:58Z — riavvio dopo crash
