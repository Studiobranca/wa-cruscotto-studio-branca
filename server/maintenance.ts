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
import { setReceivedWebhook, getReceivedWebhook } from './zapi.js';
import { broadcastEvent } from './sse.js';

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

  const byPhone: Record<string, { name: string; group: boolean; rx: number; tx: number; last: string }> = {};
  for (const r of rows) {
    const k = r.phone;
    if (!byPhone[k]) byPhone[k] = { name: r.contact_name || r.phone, group: !!r.is_group, rx: 0, tx: 0, last: '' };
    if (r.direction === 'sent') byPhone[k].tx++; else byPhone[k].rx++;
    if (r.content) byPhone[k].last = String(r.content).replace(/\n+/g, ' ').slice(0, 60);
  }
  const entries = Object.entries(byPhone).sort((a, b) => (b[1].rx + b[1].tx) - (a[1].rx + a[1].tx));
  const lines = entries.map(([phone, v]) =>
    `• ${v.name}${v.group ? ' [GRUPPO]' : ''} — ${v.rx} ricevuti${v.tx ? `, ${v.tx} inviati` : ''}${v.last ? `: "${v.last}"` : ''}`
  );
  const total = rows.length;
  const contacts = entries.length;
  const title = `📱 WhatsApp ${dateISO}: ${total} msg · ${contacts} contatti`;
  const description = entries.length
    ? `Riepilogo comunicazioni WhatsApp del giorno (clienti e gruppi in sola lettura).\n\n${lines.join('\n').slice(0, 7500)}`
    : 'Nessuna comunicazione WhatsApp registrata.';
  return { title, description, total, contacts };
}

export async function runDailyDigest(dateISO?: string): Promise<{ ok: boolean; date: string; total: number; eventId?: string; error?: string }> {
  const date = dateISO || romeNow().iso;
  const { title, description, total } = buildDigest(date);
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

async function watchdogTick(): Promise<void> {
  const h = getFlowHealth();
  if (!h.stale) return;
  const last = getSetting('last_webhook_repair');
  if (last && (Date.now() - Date.parse(last)) / 60000 < REPAIR_COOLDOWN_MIN) return; // cooldown
  console.warn(`[Watchdog] Flusso messaggi fermo da ${h.lastAgeMin} min in orario lavorativo → riparazione webhook`);
  await repairWebhook();
}

// ─── Scheduler interno ───────────────────────────────────────────────────────
export function startMaintenance(): void {
  const tick = async () => {
    try {
      // Digest: alle 20:30 Rome (o dopo), una volta al giorno
      const { iso, hour } = romeNow();
      if (hour >= 20 && getSetting(`digest_done_${iso}`) !== '1') {
        const r = await runDailyDigest(iso);
        console.log(`[Digest] ${iso}: ${r.ok ? `evento aggiornato (${r.total} msg)` : `errore: ${r.error}`}`);
      }
      // Watchdog flusso messaggi
      await watchdogTick();
    } catch (e: any) {
      console.error('[Maintenance] tick error:', e.message);
    }
  };
  setInterval(tick, 30 * 60 * 1000); // ogni 30 min
  setTimeout(tick, 60 * 1000);       // primo giro dopo 1 min
  console.log('[Maintenance] Scheduler avviato (digest 20:30 + watchdog flusso).');
}
