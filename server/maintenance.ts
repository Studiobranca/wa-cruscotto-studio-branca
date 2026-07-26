/**
 * maintenance.ts — Compiti automatici di studio per il backend WhatsApp.
 *
 *  1) DIGEST GIORNALIERO: a fine giornata annota TUTTE le comunicazioni del
 *     giorno (clienti + gruppi, solo lettura) su un evento "tutto il giorno" nel
 *     Google Calendar del giorno corrispondente.
 *  2) WATCHDOG FLUSSO: se in orario lavorativo non arrivano più messaggi (caso
 *     anomalo), ri-registra automaticamente il webhook di ricezione su Z-API e
 *     lo segnala (check-control di riparazione autorizzato).
 *
 * Entrambi girano via scheduler interno (startMaintenance) e sono anche
 * esposti come endpoint per essere innescati/monitorati dal Mac Mini.
 */

import db from './db.js';
import { upsertAllDayEvent } from './integrations.js';
import { setReceivedWebhook, getReceivedWebhook, getDevicePhone, zapiGet, sendTextMessage } from './zapi.js';
import { broadcastEvent } from './sse.js';
import { getControlNumber, getAlertEmail, sendStudioAlertEmail, isAutoSendEnabled, waCommandsEnabled, isBotEnabled } from './chatbot.js';
import { remindersTick } from './reminders.js';
import { evaluateZapiHealth, decideMonitorAlert } from './monitor_logic.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://wa-cruscotto-v2-production.up.railway.app';
const WEBHOOK_URL = `${PUBLIC_BASE_URL}/api/webhook/message`;
const STALE_MINUTES = 180;      // oltre 3h senza messaggi in orario lavorativo = anomalo
const REPAIR_COOLDOWN_MIN = 360; // max un tentativo di riparazione ogni 6h

function getSetting(key: string): string | null {
  try { return (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any)?.value ?? null; }
  catch { return null; }
}
function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// ─── Helpers fuso Europe/Rome ────────────────────────────────────────────────
function romeNow(): { iso: string; hour: number; dow: number } {
  const now = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now); // YYYY-MM-DD
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(now), 10);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { iso, hour, dow };
}
function isBusinessHours(): boolean {
  const { hour, dow } = romeNow();
  if (dow === 0 || dow === 6) return false;       // dom/sab
  return (hour >= 9 && hour < 13) || (hour >= 15 && hour < 19);
}

// ═══ 1) DIGEST GIORNALIERO ═══════════════════════════════════════════════════
export function buildDigest(dateISO: string): { title: string; description: string; total: number; contacts: number } {
  // Esclude i contatti VIP/high (viplist = familiari/privati): non vanno annotati
  // nell'agenda di lavoro.
  const rows = db.prepare(`
    SELECT lm.phone, lm.contact_name, lm.is_group, lm.direction, lm.content, lm.timestamp
    FROM live_messages lm
    LEFT JOIN conversations c ON c.phone = lm.phone
    WHERE substr(lm.timestamp, 1, 10) = ?
      AND COALESCE(c.priority, 'none') NOT IN ('vip', 'high')
    ORDER BY lm.timestamp ASC
  `).all(dateISO) as any[];

  // Riporta SOLO il lavoro: escludi i numeri la cui attività del giorno è stata
  // classificata personale (e mai lavoro) dal chatbot — utile per i contatti
  // amico+cliente che mescolano chiacchiere e pratiche.
  const cls = db.prepare(`SELECT phone, kind FROM bot_msg_class WHERE day = ?`).all(dateISO) as any[];
  const workPhones = new Set(cls.filter((c) => c.kind === 'work').map((c) => c.phone));
  const personalOnly = new Set(cls.filter((c) => c.kind === 'personal' && !workPhones.has(c.phone)).map((c) => c.phone));

  const control = getControlNumber();
  const byPhone: Record<string, { name: string; group: boolean; rx: number; tx: number; last: string }> = {};
  for (const r of rows) {
    const k = r.phone;
    if (personalOnly.has(k) || k === control) continue; // chat personale / numero di Mariano → non riportare
    if (!byPhone[k]) byPhone[k] = { name: r.contact_name || r.phone, group: !!r.is_group, rx: 0, tx: 0, last: '' };
    if (r.direction === 'sent') byPhone[k].tx++; else byPhone[k].rx++;
    if (r.content) byPhone[k].last = String(r.content).replace(/\n+/g, ' ').slice(0, 60);
  }
  const entries = Object.entries(byPhone).sort((a, b) => (b[1].rx + b[1].tx) - (a[1].rx + a[1].tx));
  const lines = entries.map(([phone, v]) =>
    `• ${v.name}${v.group ? ' [GRUPPO]' : ''} — ${v.rx} ricevuti${v.tx ? `, ${v.tx} inviati` : ''}${v.last ? `: "${v.last}"` : ''}`
  );
  const total = entries.reduce((s, [, v]) => s + v.rx + v.tx, 0); // solo i messaggi riportati (no personali)
  const contacts = entries.length;
  const title = `📱 WhatsApp ${dateISO}: ${total} msg · ${contacts} contatti`;
  const description = entries.length
    ? `Riepilogo comunicazioni WhatsApp del giorno (clienti e gruppi in sola lettura).\n\n${lines.join('\n').slice(0, 7500)}`
    : 'Nessuna comunicazione WhatsApp registrata.';
  return { title, description, total, contacts };
}

export async function runDailyDigest(dateISO?: string): Promise<{ ok: boolean; date: string; total: number; eventId?: string; error?: string; skipped?: boolean }> {
  const date = dateISO || romeNow().iso;
  const { title, description, total } = buildDigest(date);
  if (total === 0) { setSetting(`digest_done_${date}`, '1'); return { ok: true, date, total: 0, skipped: true }; }
  const prevId = getSetting(`digest_event_${date}`);
  const r = await upsertAllDayEvent({ title, description, date, eventId: prevId });
  if (r.success && r.eventId) {
    setSetting(`digest_event_${date}`, r.eventId);
    setSetting(`digest_done_${date}`, '1');
    return { ok: true, date, total, eventId: r.eventId };
  }
  return { ok: false, date, total, error: r.error };
}

// ═══ 2) WATCHDOG FLUSSO MESSAGGI ═════════════════════════════════════════════
export function lastReceivedAgeMinutes(): number | null {
  const row = db.prepare(`SELECT MAX(timestamp) AS t FROM live_messages WHERE direction = 'received'`).get() as any;
  if (!row?.t) return null;
  const ms = Date.parse(row.t);
  if (isNaN(ms)) return null;
  return Math.round((Date.now() - ms) / 60000);
}

export function getFlowHealth(): { lastAgeMin: number | null; stale: boolean; businessHours: boolean; webhookExpected: string } {
  const age = lastReceivedAgeMinutes();
  return {
    lastAgeMin: age,
    stale: isBusinessHours() && age !== null && age > STALE_MINUTES,
    businessHours: isBusinessHours(),
    webhookExpected: WEBHOOK_URL,
  };
}

export async function repairWebhook(): Promise<{ ok: boolean; previous: string | null; set: string }> {
  const previous = await getReceivedWebhook();
  const ok = await setReceivedWebhook(WEBHOOK_URL);
  setSetting('last_webhook_repair', new Date().toISOString());
  broadcastEvent('flow_repair', { ok, webhook: WEBHOOK_URL, at: new Date().toISOString() });
  console.log(`[Watchdog] Riparazione webhook: ${ok ? 'OK' : 'FALLITA'} → ${WEBHOOK_URL} (precedente: ${previous})`);
  return { ok, previous, set: WEBHOOK_URL };
}

function inRepairCooldown(): boolean {
  const last = getSetting('last_webhook_repair');
  return !!(last && (Date.now() - Date.parse(last)) / 60000 < REPAIR_COOLDOWN_MIN);
}

async function watchdogTick(): Promise<void> {
  const h = getFlowHealth();

  // (A) Controllo PRESENZA del webhook — gira 24/7, INDIPENDENTE dall'orario.
  // Se il webhook ricevuti registrato su Z-API manca o è diverso da quello
  // atteso, lo ri-registra subito (rispettando il cooldown). Così una caduta
  // serale/weekend/fuori orario non resta morta fino al rientro in studio.
  try {
    const current = await getReceivedWebhook();
    const missing = !current || current !== WEBHOOK_URL;
    console.log(`[Watchdog] Webhook check: registrato=${current ?? 'null'} atteso=${WEBHOOK_URL} → ${missing ? 'MANCANTE/DIVERSO' : 'OK'}`);
    if (missing) {
      if (inRepairCooldown()) {
        console.warn('[Watchdog] Webhook mancante/diverso ma in cooldown → riparazione rimandata.');
      } else {
        console.warn('[Watchdog] Webhook ricevuti mancante/diverso → riparazione (anche fuori orario).');
        await repairWebhook();
        return; // repairWebhook aggiorna il cooldown: niente doppia riparazione nello stesso tick
      }
    }
  } catch (e: any) {
    console.error('[Watchdog] Webhook check fallito:', e.message);
  }

  // (B) Watchdog "stale" messaggi — INVARIATO: solo in orario lavorativo,
  // come segnale aggiuntivo di flusso fermo (usato anche per le notifiche).
  if (!h.stale) return;
  if (inRepairCooldown()) return;
  console.warn(`[Watchdog] Flusso messaggi fermo da ${h.lastAgeMin} min in orario lavorativo → riparazione webhook`);
  await repairWebhook();
}

// ═══ 3) AUTOCHECK GIORNALIERO + AUTOCORREZIONE ═══════════════════════════════
// Controlli STRUTTURALI (nessuna chiamata AI → costo zero, eseguito di notte).
// Verifica gli invarianti di sicurezza e ripara ciò che è sicuro riparare; manda
// un'email di riepilogo SOLO se ha trovato/corretto qualcosa (niente rumore quotidiano).
interface CheckItem { name: string; status: 'ok' | 'fixed' | 'warn' | 'error'; detail: string; }

export async function runSelfCheck(): Promise<{ at: string; items: CheckItem[]; issues: number }> {
  const items: CheckItem[] = [];

  // 1) Webhook di ricezione registrato e corretto → ripara se manca/diverso.
  try {
    const current = await getReceivedWebhook();
    if (current === WEBHOOK_URL) items.push({ name: 'webhook', status: 'ok', detail: 'registrato' });
    else if (inRepairCooldown()) items.push({ name: 'webhook', status: 'warn', detail: `diverso (${current ?? 'null'}) ma in cooldown` });
    else { const r = await repairWebhook(); items.push({ name: 'webhook', status: r.ok ? 'fixed' : 'error', detail: r.ok ? 'ri-registrato' : 'riparazione fallita' }); }
  } catch (e: any) { items.push({ name: 'webhook', status: 'error', detail: e.message }); }

  // 2) auto-invio ai clienti LOCKATO: se è acceso senza l'env autorizzativa, forzalo OFF.
  if (getSetting('bot_auto_send') === '1' && process.env.BOT_ALLOW_AUTOSEND !== '1') {
    setSetting('bot_auto_send', '0');
    items.push({ name: 'autoSend', status: 'fixed', detail: 'era ON senza BOT_ALLOW_AUTOSEND → forzato OFF' });
  } else items.push({ name: 'autoSend', status: 'ok', detail: isAutoSendEnabled() ? 'ON (env autorizzata)' : 'OFF' });

  // 3) numero di controllo ≠ numero del dispositivo (altrimenti notifiche su sé stessi).
  try {
    const control = getControlNumber();
    const device = (await getDevicePhone()) || '';
    if (!control) items.push({ name: 'controlNumber', status: 'warn', detail: 'non impostato' });
    else if (device && (control === device)) items.push({ name: 'controlNumber', status: 'warn', detail: `coincide col device ${device} (rischio auto-notifica)` });
    else items.push({ name: 'controlNumber', status: 'ok', detail: `${control} (device ${device || '?'})` });
  } catch (e: any) { items.push({ name: 'controlNumber', status: 'error', detail: e.message }); }

  // 4) comandi WhatsApp: stato (off = approvazione solo da Cruscotto, scelto per sicurezza).
  items.push({ name: 'waCommands', status: 'ok', detail: waCommandsEnabled() ? 'ON' : 'OFF (approvazione da Cruscotto)' });

  // 5) bot abilitato.
  items.push({ name: 'bot', status: isBotEnabled() ? 'ok' : 'warn', detail: isBotEnabled() ? 'abilitato' : 'DISABILITATO' });

  // 6) email: se configurata, l'ultimo poll deve essere riuscito.
  try {
    const mail = await import('./email.js');
    const st: any = mail.getEmailStatus();
    if (!st.configured?.length) items.push({ name: 'email', status: 'ok', detail: 'non configurata' });
    else if (st.lastPoll && st.lastPoll.ok === false) items.push({ name: 'email', status: 'error', detail: `ultimo poll KO: ${st.lastPoll.error || '?'}` });
    else items.push({ name: 'email', status: 'ok', detail: `${st.configured.length} caselle, ultimo poll ${st.lastPoll?.ok ? 'OK' : 'n/d'}` });
  } catch (e: any) { items.push({ name: 'email', status: 'warn', detail: `modulo non valutabile: ${e.message}` }); }

  // 7) Notifiche d'agenda verso Mariano: salute dei due job (digest 08:00 + reminder T-10).
  //    Se lo scheduler dedicato è fermo, qui compare 'error' (anti "verde ma morto").
  try {
    const an = await import('./agenda_notify.js');
    for (const it of an.getAgendaJobsHealth().items) items.push({ name: it.name, status: it.status, detail: it.detail });
  } catch (e: any) { items.push({ name: 'agendaJobs', status: 'error', detail: `modulo non valutabile: ${e.message}` }); }

  const at = new Date().toISOString();
  const issues = items.filter((i) => i.status !== 'ok').length;
  setSetting('selfcheck_last', JSON.stringify({ at, items, issues }));
  console.log(`[SelfCheck] ${at} — ${issues} anomalie/correzioni: ${items.map((i) => `${i.name}:${i.status}`).join(' ')}`);

  // Email di riepilogo SOLO se c'è qualcosa di rilevante (fixed/warn/error).
  const notable = items.filter((i) => i.status !== 'ok');
  if (notable.length) {
    const rows = items.map((i) => {
      const ic = i.status === 'ok' ? '✅' : i.status === 'fixed' ? '🔧' : i.status === 'warn' ? '⚠️' : '❌';
      return `<tr><td>${ic} <b>${i.name}</b></td><td>${i.detail}</td></tr>`;
    }).join('');
    const html = `<h2>Autocheck Cruscotto — ${at.slice(0, 16).replace('T', ' ')}</h2>
      <p>${notable.length} voce/i da segnalare (le correzioni automatiche sono marcate 🔧).</p>
      <table cellpadding="6" style="border-collapse:collapse">${rows}</table>
      <p style="color:#888;font-size:12px">Controllo automatico notturno (nessun costo AI).</p>`;
    try { await sendStudioAlertEmail(`🩺 Autocheck Cruscotto: ${notable.length} segnalazioni`, html); } catch {}
  }
  return { at, items, issues };
}

export function getLastSelfCheck(): any {
  try { return JSON.parse(getSetting('selfcheck_last') || 'null'); } catch { return null; }
}

// ─── MONITORAGGIO SESSIONE Z-API + allarmi (rev. 11/07/2026) ─────────────────
// Complementare al watchdog (che ripara il WEBHOOK): qui controlliamo la SESSIONE
// Z-API (device/telefono). Se cade, l'alert va via EMAIL (Brevo) — canale affidabile
// proprio perché WhatsApp è ciò che è rotto — con cooldown; alla ripresa, notifica di
// ripristino. Nessun doppione col selftest notturno (che verifica invarianti interni).
export async function runMonitoring(force = false): Promise<{ healthy: boolean; reason: string; action: string }> {
  let status: any = null;
  try { status = await zapiGet('status'); } catch { status = null; }
  const { healthy, reason } = evaluateZapiHealth(status);
  const lastState = (getSetting('monitor_zapi_state') as 'up' | 'down' | null) || undefined;
  const lastAtRaw = getSetting('monitor_zapi_alert_at');
  const lastAlertMs = lastAtRaw ? Date.parse(lastAtRaw) : null;
  const { action, newState } = decideMonitorAlert(healthy, lastState || undefined, (lastAlertMs != null && !isNaN(lastAlertMs)) ? lastAlertMs : null, Date.now());
  setSetting('monitor_zapi_state', newState);
  if (action === 'alert-down') {
    setSetting('monitor_zapi_alert_at', new Date().toISOString());
    const html = `<h2 style="color:#b00020">⚠️ Sessione WhatsApp (Z-API) NON attiva</h2>
      <p>${reason}</p>
      <p>Il bot potrebbe non ricevere/inviare messaggi WhatsApp. <b>RUNBOOK</b>: riconnetti la
      sessione Z-API (riscansiona il QR nella dashboard Z-API), poi verifica
      <code>/api/bot/zapi-info</code> e <code>/api/bot/flow-health</code>.</p>`;
    await sendStudioAlertEmail('🔴 WhatsApp/Z-API disconnesso — Studio Branca', html).catch(() => {});
    console.warn('[Monitor] Z-API DOWN:', reason);
  } else if (action === 'alert-recovered') {
    try { await sendTextMessage(getControlNumber(), '✅ Sessione WhatsApp (Z-API) di nuovo attiva.'); } catch { /* best-effort */ }
    await sendStudioAlertEmail('✅ WhatsApp/Z-API ripristinato — Studio Branca', '<p>La sessione Z-API è tornata attiva.</p>').catch(() => {});
    console.log('[Monitor] Z-API RECOVERED');
  }
  return { healthy, reason, action };
}

/** Stato consolidato per diagnostica (sola lettura). */
export function getMonitorStatus(): any {
  return {
    zapiState: getSetting('monitor_zapi_state') || 'unknown',
    lastZapiAlertAt: getSetting('monitor_zapi_alert_at'),
    flow: getFlowHealth(),
    lastSelfCheck: getLastSelfCheck(),
  };
}

// ─── Scheduler interno ───────────────────────────────────────────────────────
export function startMaintenance(): void {
  // All'avvio: assicura che il webhook Z-API sia registrato con notifySentByMe,
  // così i comandi WhatsApp di Mariano (fromMe) vengono sempre inoltrati. Idempotente.
  setTimeout(async () => {
    try {
      const ok = await setReceivedWebhook(WEBHOOK_URL);
      console.log(`[Maintenance] Webhook Z-API auto-configurato (notifySentByMe): ${ok ? 'OK' : 'FALLITO'}`);
    } catch (e: any) { console.error('[Maintenance] auto-config webhook:', e.message); }
  }, 5000);

  const tick = async () => {
    try {
      // Digest: alle 20:30 Rome (o dopo), una volta al giorno
      const { iso, hour } = romeNow();
      if (hour >= 20 && getSetting(`digest_done_${iso}`) !== '1') {
        const r = await runDailyDigest(iso);
        console.log(`[Digest] ${iso}: ${r.ok ? `evento aggiornato (${r.total} msg)` : `errore: ${r.error}`}`);
      }
      // Autocheck giornaliero + autocorrezione: notte (03:00 Rome), 1×/giorno.
      // Di notte i job sono fermi → sicuro riparare; controlli strutturali = costo AI nullo.
      if (hour >= 3 && hour < 6 && getSetting(`selfcheck_done_${iso}`) !== '1') {
        setSetting(`selfcheck_done_${iso}`, '1');
        await runSelfCheck();
      }
      // Watchdog flusso messaggi
      await watchdogTick();
      // Promemoria appuntamenti + richiamo lista d'attesa + SLA risposte (v2.10).
      // Internamente già isolato per singolo job (try/catch in remindersTick).
      await remindersTick();
      // Monitoraggio sessione Z-API (alert via email se il device cade).
      try { await runMonitoring(); } catch (e: any) { console.error('[Monitor] tick:', e.message); }
      // PEC contenzioso (modulo ISOLATO): poll IMAP + calendarizzazione. Attivo SOLO se
      // PEC_USER/PEC_PASS sono impostate; un suo errore non tocca il resto.
      try { const pec = await import('./pec.js'); if (pec.pecEnabled()) await pec.pollPec(); }
      catch (e: any) { console.error('[PEC] tick:', e.message); }
    } catch (e: any) {
      console.error('[Maintenance] tick error:', e.message);
    }
  };
  setInterval(tick, 30 * 60 * 1000); // ogni 30 min
  setTimeout(tick, 60 * 1000);       // primo giro dopo 1 min
  console.log('[Maintenance] Scheduler avviato (digest 20:30 + watchdog flusso + promemoria/lista d\'attesa/SLA).');
}
