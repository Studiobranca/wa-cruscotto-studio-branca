# RUNBOOK d'incidente — WA Cruscotto (AB STUDIO)

Servizio: `wa-cruscotto-v2` su Railway · prod `https://wa-cruscotto-v2-production.up.railway.app`
Diagnostica rapida: `GET /api/health` · `GET /api/version` · `GET /api/bot/monitor` ·
`GET /api/bot/flow-health` · `GET /api/bot/zapi-info` · `GET /api/selftest`.

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

## Contatti tecnici / riferimenti
- Numero di controllo (notifiche a Mariano): `393762547718`. Device Z-API (linea studio): `393457050479`.
- Env chiave: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ZAPI_*`, `GOOGLE_*`, `BREVO_API_KEY`, `ALERT_EMAIL`,
  `EMAIL_TISCALI_PASS`, `EMAIL_ICLOUD_PASS`. (Per SMS in futuro: `SMS_PROVIDER`, `SKEBBY_*`.)
