/*
 * agenda_notify.ts — I DUE JOB verso MARIANO (numero di controllo), rev. 26/07/2026.
 *
 *  1) DIGEST MATTUTINO 08:00 Europe/Rome, OGNI giorno (weekend configurabile). Elenco
 *     totale appuntamenti di oggi dalla fonte REALE (agenda_source: Google Calendar +
 *     bot_appointments). Se vuoto → messaggio "nessun appuntamento" (prova di vita).
 *  2) REMINDER T-10: 10 min prima di ogni appuntamento, uno per appuntamento, UNA volta.
 *
 * IDEMPOTENZA (persistente su volume /data):
 *  - digest: setting `agenda_digest_last_sent_date` (+ riga unica in agenda_notify_log).
 *  - reminder: chiave `rem:<id>@<startISO>` UNIQUE in agenda_notify_log → nessun reinvio
 *    (tick al minuto sicuro); lo spostamento cambia startISO → nuovo reminder al nuovo
 *    orario; il cancellato sparisce dall'agenda → nessun reminder.
 * ROBUSTEZZA: se Z-API è giù, backoff esponenziale del canale (max 5 min) e ritento.
 * SALUTE: heartbeat `agenda_tick_last_at` + stato dei due job (getAgendaJobsHealth),
 *  esposto in /api/selftest e /api/bot/flow-health → se il loop muore, EMERGE subito.
 *
 * INVARIANTI: nessun invio ai clienti, nessun passaggio dal flusso bozze, autoSend/
 * waCommands/decideWorkAutoSend/webhook INTATTI. Unico sink: sendTextMessage(control).
 */

import db from './db.js';
import { sendTextMessage } from './zapi.js';
import { getControlNumber } from './chatbot.js';
import { getTodayAgenda, romeToday, romeOffset } from './agenda_source.js';
import {
  composeAgendaDigest, composeReminder, selectDueReminders, reminderDedupKey,
  digestDecision, dateFullITfromISO, type AgendaItem,
} from './agenda_notify_logic.js';

// ─── Tabella audit + dedup (persistente) ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS agenda_notify_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- 'digest' | 'digest-test' | 'reminder'
    dedup_key TEXT NOT NULL,
    target TEXT,
    title TEXT,
    text_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agenda_notify_dedup ON agenda_notify_log(kind, dedup_key);
  CREATE INDEX IF NOT EXISTS idx_agenda_notify_created ON agenda_notify_log(created_at);
`);

// ─── Settings (app_settings, come maintenance.ts/reminders.ts) ───────────────
function getSetting(key: string, def: string): string {
  try { return (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any)?.value ?? def; }
  catch { return def; }
}
function setSetting(key: string, value: string): void {
  try { db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value); }
  catch { /* best-effort */ }
}

// Toggle e parametri (facilmente configurabili da DB, senza redeploy).
export function agendaDigestEnabled(): boolean { return getSetting('agenda_digest', '1') === '1'; }
export function agendaRemindersEnabled(): boolean { return getSetting('agenda_reminders', '1') === '1'; }
export function digestHour(): number { return clampInt(getSetting('agenda_digest_hour', '8'), 0, 23, 8); }
export function digestCatchupHours(): number { return clampInt(getSetting('agenda_digest_catchup_h', '4'), 1, 12, 4); }
export function digestWeekends(): boolean { return getSetting('agenda_digest_weekends', '1') === '1'; }
export function reminderLeadMin(): number { return clampInt(getSetting('agenda_reminder_lead_min', '10'), 1, 120, 10); }
function clampInt(v: string, lo: number, hi: number, def: number): number {
  const n = parseInt(v, 10); if (isNaN(n)) return def; return Math.min(Math.max(n, lo), hi);
}

// ─── Fuso Europe/Rome ────────────────────────────────────────────────────────
function romeNow(): { iso: string; hour: number; minute: number; dow: number } {
  const now = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
  const hh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [hour, minute] = hh.split(':').map((n) => parseInt(n, 10));
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { iso, hour, minute, dow };
}
function romeMidnightMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00${romeOffset(iso)}`);
}

// ─── Backoff del canale Z-API (condiviso dai due job) ────────────────────────
let chFails = 0;
let chNextAttemptMs = 0;
function channelReady(nowMs: number): boolean { return nowMs >= chNextAttemptMs; }
function channelOk(): void { chFails = 0; chNextAttemptMs = 0; }
function channelFailed(nowMs: number): void {
  chFails++;
  const delay = Math.min(60000 * Math.pow(2, chFails - 1), 300000); // 60s,120s,240s,300s cap
  chNextAttemptMs = nowMs + delay;
  console.warn(`[AgendaNotify] Z-API invio fallito (#${chFails}); backoff ${Math.round(delay / 1000)}s.`);
}

/** Sink UNICO verso Mariano. Ritorna esito con motivo. NON marca nulla come inviato. */
async function sendToControl(text: string): Promise<{ ok: boolean; reason?: string }> {
  const nowMs = Date.now();
  if (!channelReady(nowMs)) return { ok: false, reason: 'backoff' };
  const control = getControlNumber();
  if (!control) return { ok: false, reason: 'no-control-number' };
  try {
    const r: any = await sendTextMessage(control, text);
    if (r && r.skipped) return { ok: false, reason: `skipped:${r.reason || 'unknown'}` }; // es. self-send guard
    channelOk();
    return { ok: true };
  } catch (e: any) {
    channelFailed(nowMs);
    return { ok: false, reason: e?.message || 'send-error' };
  }
}

function recordNotify(kind: string, dedupKey: string, target: string, title: string, text: string): boolean {
  try {
    const info = db.prepare(`
      INSERT OR IGNORE INTO agenda_notify_log (kind, dedup_key, target, title, text_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, dedupKey, target, title.slice(0, 120), text.replace(/\s+/g, ' ').trim().slice(0, 180), new Date().toISOString());
    return info.changes > 0;
  } catch (e: any) { console.error('[AgendaNotify] audit insert:', e?.message); return true; }
}

function sentReminderKeys(): Set<string> {
  try {
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const rows = db.prepare(`SELECT dedup_key FROM agenda_notify_log WHERE kind = 'reminder' AND created_at >= ?`).all(since) as any[];
    return new Set(rows.map((r) => r.dedup_key));
  } catch { return new Set(); }
}

// ─── Boot grace: alla prima accensione non fare catch-up "a freddo" del digest per
//     ~2 min, così un eventuale invio di PROVA post-deploy fa fede per la giornata
//     (niente doppione). NON tocca i reminder. ───────────────────────────────
const BOOT_MS = Date.now();
const DIGEST_BOOT_GRACE_MS = 120000;

// ═══ 1) DIGEST MATTUTINO ═════════════════════════════════════════════════════
export async function runAgendaDigest(opts: { force?: boolean; test?: boolean } = {}): Promise<any> {
  const { iso, hour, dow } = romeNow();
  setSetting('agenda_digest_last_run_at', new Date().toISOString());

  if (!opts.force && !opts.test) {
    if (!agendaDigestEnabled()) return { sent: false, reason: 'disabled' };
    const dec = digestDecision({
      romeHour: hour, dow, targetHour: digestHour(), catchupHours: digestCatchupHours(),
      weekendsEnabled: digestWeekends(), lastSentDate: getSetting('agenda_digest_last_sent_date', ''), todayDate: iso,
    });
    if (!dec.due) return { sent: false, status: dec.status };
    // Grace anti-doppione post-deploy: rimanda il catch-up a freddo di ~2 min.
    if (Date.now() - BOOT_MS < DIGEST_BOOT_GRACE_MS && hour >= digestHour()) {
      return { sent: false, status: 'boot-grace' };
    }
  }

  const agenda = await getTodayAgenda(iso);
  const { text, count } = composeAgendaDigest({ items: agenda.items, dateFullIT: dateFullITfromISO(iso), test: !!opts.test });
  const r = await sendToControl(text);
  if (!r.ok) {
    setSetting('agenda_digest_last_status', `send-failed:${r.reason}`);
    return { sent: false, error: r.reason, count, source: agenda.source };
  }
  if (opts.test) {
    // Il test contiene il contenuto REALE di oggi → vale come digest odierno (niente doppione).
    setSetting('agenda_digest_last_sent_date', iso);
    setSetting('agenda_digest_last_status', 'sent-test');
    recordNotify('digest-test', `digest-test:${iso}:${Date.now()}`, getControlNumber(), `agenda ${iso} (test)`, text);
  } else {
    setSetting('agenda_digest_last_sent_date', iso);
    setSetting('agenda_digest_last_status', 'sent');
    recordNotify('digest', `digest:${iso}`, getControlNumber(), `agenda ${iso}`, text);
  }
  console.log(`[AgendaNotify] Digest ${iso} inviato a Mariano (${count} appuntamenti, fonte ${agenda.source}${opts.test ? ', TEST' : ''}).`);
  return { sent: true, count, source: agenda.source, googleOk: agenda.googleOk, test: !!opts.test };
}

// ═══ 2) REMINDER T-10 ════════════════════════════════════════════════════════
export async function runAgendaReminders(opts: { force?: boolean } = {}): Promise<any> {
  setSetting('agenda_reminders_last_run_at', new Date().toISOString());
  if (!opts.force && !agendaRemindersEnabled()) return { sent: 0, reason: 'disabled' };
  const nowMs = Date.now();
  const iso = romeToday();
  const agenda = await getTodayAgenda(iso);
  const lead = reminderLeadMin();
  const already = sentReminderKeys();
  const due = selectDueReminders(agenda.items, nowMs, lead, already);
  let sent = 0;
  for (const it of due) {
    const key = reminderDedupKey(it);
    const text = composeReminder(it, lead);
    const r = await sendToControl(text);
    if (r.ok) { recordNotify('reminder', key, getControlNumber(), it.title, text); sent++; console.log(`[AgendaNotify] Reminder T-${lead} inviato: ${it.title} (${key}).`); }
    else { console.warn(`[AgendaNotify] Reminder non inviato (${r.reason}) → ritento al prossimo tick: ${key}`); break; }
  }
  return { sent, due: due.length, source: agenda.source };
}

// ─── Tick + scheduler interno (60s) ──────────────────────────────────────────
export async function agendaNotifierTick(): Promise<void> {
  setSetting('agenda_tick_last_at', new Date().toISOString());
  try { await runAgendaDigest(); } catch (e: any) { console.error('[AgendaNotify] digest tick:', e?.message); }
  try { await runAgendaReminders(); } catch (e: any) { console.error('[AgendaNotify] reminder tick:', e?.message); }
}

export function startAgendaNotifier(): void {
  setInterval(() => { agendaNotifierTick().catch(() => {}); }, 60 * 1000);
  setTimeout(() => { agendaNotifierTick().catch(() => {}); }, 20 * 1000); // primo giro dopo 20s
  console.log(`[AgendaNotify] Scheduler avviato (digest ${digestHour()}:00 Rome ogni giorno${digestWeekends() ? ' incl. weekend' : ' feriali'} + reminder T-${reminderLeadMin()}, tick 60s).`);
}

// ─── SALUTE dei due job (per /api/selftest e /api/bot/flow-health) ───────────
export interface HealthItem { name: string; status: 'ok' | 'warn' | 'error'; detail: string; }

function remindersSentToday(iso: string): number {
  try {
    const since = new Date(romeMidnightMs(iso)).toISOString();
    return (db.prepare(`SELECT COUNT(*) c FROM agenda_notify_log WHERE kind = 'reminder' AND created_at >= ?`).get(since) as any)?.c || 0;
  } catch { return 0; }
}

export function getAgendaJobsHealth(): { items: HealthItem[]; digest: any; reminders: any } {
  const { iso, hour, dow } = romeNow();
  const tickAt = getSetting('agenda_tick_last_at', '');
  const tickMs = tickAt ? Date.parse(tickAt) : NaN;
  const tickAgeSec = isNaN(tickMs) ? null : Math.round((Date.now() - tickMs) / 1000);
  const loopAlive = tickAgeSec != null && tickAgeSec < 180; // tick atteso ogni 60s

  const lastSent = getSetting('agenda_digest_last_sent_date', '') || null;
  const enabled = agendaDigestEnabled();
  const dec = digestDecision({
    romeHour: hour, dow, targetHour: digestHour(), catchupHours: digestCatchupHours(),
    weekendsEnabled: digestWeekends(), lastSentDate: lastSent, todayDate: iso,
  });
  let dStatus: HealthItem['status'] = 'ok';
  let dDetail = '';
  if (!loopAlive) { dStatus = 'error'; dDetail = `scheduler FERMO (ultimo tick: ${tickAt || 'mai'})`; }
  else if (!enabled) { dStatus = 'warn'; dDetail = 'disattivato (agenda_digest=0)'; }
  else if (dec.status === 'sent-already') { dStatus = 'ok'; dDetail = `inviato oggi (${lastSent})`; }
  else if (dec.status === 'waiting') { dStatus = 'ok'; dDetail = `in attesa delle ${digestHour()}:00`; }
  else if (dec.status === 'not-a-day') { dStatus = 'ok'; dDetail = 'oggi non previsto (weekend OFF)'; }
  else if (dec.status === 'due') { dStatus = 'ok'; dDetail = 'in coda (invio entro ~1 min)'; }
  else { dStatus = 'warn'; dDetail = 'finestra mattutina persa (probabile downtime)'; } // 'missed'

  const rEnabled = agendaRemindersEnabled();
  let rStatus: HealthItem['status'] = 'ok';
  let rDetail = '';
  if (!loopAlive) { rStatus = 'error'; rDetail = `scheduler FERMO (ultimo tick: ${tickAt || 'mai'})`; }
  else if (!rEnabled) { rStatus = 'warn'; rDetail = 'disattivato (agenda_reminders=0)'; }
  else { rStatus = 'ok'; rDetail = `loop attivo (tick ${tickAgeSec}s fa), reminder inviati oggi: ${remindersSentToday(iso)}`; }

  const digest = { name: 'agendaDigest', status: dStatus, detail: dDetail, lastSentDate: lastSent, targetHour: digestHour(), weekends: digestWeekends(), lastRunAt: getSetting('agenda_digest_last_run_at', '') || null, lastStatus: getSetting('agenda_digest_last_status', '') || null };
  const reminders = { name: 'agendaReminder', status: rStatus, detail: rDetail, lastTickAt: tickAt || null, tickAgeSec, leadMin: reminderLeadMin(), sentToday: remindersSentToday(iso) };
  return {
    items: [{ name: 'agendaDigest', status: dStatus, detail: dDetail }, { name: 'agendaReminder', status: rStatus, detail: rDetail }],
    digest, reminders,
  };
}

/** Anteprima agenda di oggi (sola lettura, nessun invio) + fonte usata. */
export async function getAgendaTodayPreview(): Promise<any> {
  const iso = romeToday();
  const agenda = await getTodayAgenda(iso);
  const { text, count } = composeAgendaDigest({ items: agenda.items, dateFullIT: dateFullITfromISO(iso), test: false });
  return {
    date: iso, source: agenda.source, googleConfigured: agenda.googleConfigured, googleOk: agenda.googleOk,
    googleError: agenda.googleError, counts: agenda.counts, count, items: agenda.items, preview: text,
  };
}
