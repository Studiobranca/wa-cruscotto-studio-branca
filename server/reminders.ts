/**
 * reminders.ts — Job automatici su appuntamenti e attese (v2.10, rev. 08/07/2026).
 *
 *  1) PROMEMORIA APPUNTAMENTI (runReminders): la sera prima (18–21 Rome) ricorda al
 *     cliente l'appuntamento di domani — WhatsApp o email a seconda del canale con cui
 *     è stato preso — invitando a inviare PRIMA i documenti; se l'appuntamento è ancora
 *     "da confermare" chiede conferma (la risposta del cliente rientra nel normale
 *     flusso bot → confirm_appointment). 1 solo invio per appuntamento (reminder_sent).
 *  2) RICHIAMO LISTA D'ATTESA (runWaitlistRecall): quando in agenda tornano slot liberi
 *     (es. riapertura 1° settembre), ricontatta in ordine di arrivo i clienti in
 *     bot_waitlist con le prime disponibilità reali. Max 1 giro al giorno, max 10 per giro.
 *  3) SLA RISPOSTE (runSlaCheck): se una bozza WhatsApp resta 'pending' o una email di
 *     lavoro resta senza gestione oltre la soglia (default 4h), avvisa il numero di
 *     controllo UNA sola volta per elemento. Il collo di bottiglia reale è l'approvazione
 *     umana: questo job impedisce che una risposta pronta resti dimenticata.
 *
 * POLICY AUTO-INVIO (coerente con autosend.ts, post-incidente 06/07): 1) e 2) sono
 * flusso AGENDA puro — stessa classe di autonomia degli appuntamenti (agenda già
 * incrociata, NESSUNA risposta di merito) — con toggle dedicati bot_reminders /
 * bot_waitlist_recall (default ON). 3) scrive SOLO al numero di controllo, mai ai clienti.
 *
 * La logica pura (finestre, eleggibilità, testi) è in reminders_logic.ts, testata da
 * scripts/test_reminders.ts. Trigger manuale: POST /api/bot/jobs/:job/run (routes.ts).
 */

import db from './db.js';
import { getAvailability, formatAvailabilityIT } from './appointments.js';
import { sendTextMessage } from './zapi.js';
import { getControlNumber, getWaitlist, markWaitlistNotified, getAllAppointments, expireAppointmentRow } from './chatbot.js';
import { isVipContact } from './contacts.js';
import { selectExpiredProposals } from './agenda_logic.js';
import {
  channelOfKey, inReminderWindow, inRecallWindow, inSlaWindow,
  isTooFresh, sqliteToMs, reminderMessageIT, waitlistRecallMessageIT, slaAlertText,
} from './reminders_logic.js';
import { selectAgingDrafts, agingDigestText, type AgingOpts } from './aging_logic.js';

// ─── Settings (app_settings, come maintenance.ts) ────────────────────────────
function getSetting(key: string, def: string): string {
  try { return (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any)?.value ?? def; }
  catch { return def; }
}
function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
export function remindersEnabled(): boolean { return getSetting('bot_reminders', '1') === '1'; }
export function waitlistRecallEnabled(): boolean { return getSetting('bot_waitlist_recall', '1') === '1'; }
export function slaHours(): number { return parseInt(getSetting('sla_hours', '4'), 10) || 4; }

function romeNow(): { iso: string; hour: number } {
  const now = new Date();
  return {
    iso: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now),
    hour: parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(now), 10),
  };
}
function romeDatePlus(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(Date.now() + days * 86400000));
}

/** Consegna sul canale giusto della chiave (WhatsApp o email). Best-effort: false = fallito. */
async function deliver(key: string, text: string, emailSubject: string): Promise<boolean> {
  const k = channelOfKey(key);
  if (k.channel === 'whatsapp') {
    try { await sendTextMessage(k.address, text); return true; }
    catch (e: any) { console.error('[Reminders] invio WhatsApp fallito:', e.message); return false; }
  }
  try {
    const mail = await import('./email.js');
    return await mail.sendStudioEmail(k.address, emailSubject, text);
  } catch (e: any) { console.error('[Reminders] invio email fallito:', e.message); return false; }
}

// ═══ 1) PROMEMORIA "APPUNTAMENTO DI DOMANI" ══════════════════════════════════
export async function runReminders(force = false): Promise<{ sent: number; skipped: number }> {
  if (!remindersEnabled()) return { sent: 0, skipped: 0 };
  const { hour } = romeNow();
  if (!force && !inReminderWindow(hour)) return { sent: 0, skipped: 0 };
  const tomorrow = romeDatePlus(1);
  const rows = db.prepare(`
    SELECT * FROM bot_appointments
    WHERE date = ? AND status IN ('da_confermare','confermato') AND COALESCE(reminder_sent, 0) = 0
    ORDER BY start ASC
  `).all(tomorrow) as any[];
  let sent = 0, skipped = 0;
  for (const a of rows) {
    // VIP/high (regola inderogabile 08/07/2026): nessun automatismo verso di loro,
    // nemmeno il promemoria — anche se marcati VIP DOPO la presa dell'appuntamento.
    // Non si marca reminder_sent: l'appuntamento resta visibile, lo gestisce Mariano.
    if (isVipContact(a.phone)) { skipped++; continue; }
    // Appuntamento preso da poche ore: il cliente lo ha fresco, niente promemoria.
    if (!force && isTooFresh(a.created_at, Date.now())) { skipped++; continue; }
    const text = reminderMessageIT(a, channelOfKey(a.phone).channel);
    const ok = await deliver(a.phone, text, 'Promemoria appuntamento — Studio Tributario Branca');
    if (ok) {
      db.prepare(`UPDATE bot_appointments SET reminder_sent = 1 WHERE id = ?`).run(a.id);
      sent++;
      console.log(`[Reminders] Promemoria appuntamento ${a.date} ${a.start} → ${a.contact_name || a.phone}`);
    }
  }
  if (sent) {
    try { await sendTextMessage(getControlNumber(), `🔔 Promemoria inviati per ${sent} appuntament${sent === 1 ? 'o' : 'i'} di domani (${tomorrow}).`); }
    catch { /* best-effort */ }
  }
  return { sent, skipped };
}

// ═══ 2) RICHIAMO LISTA D'ATTESA ══════════════════════════════════════════════
export async function runWaitlistRecall(force = false): Promise<{ notified: number }> {
  if (!waitlistRecallEnabled()) return { notified: 0 };
  const { iso, hour } = romeNow();
  if (!force) {
    if (!inRecallWindow(hour)) return { notified: 0 };
    if (getSetting(`waitlist_recall_done_${iso}`, '') === '1') return { notified: 0 };
  }
  const pending = getWaitlist('in_attesa');
  if (!pending.length) return { notified: 0 };
  const { slots } = await getAvailability(14);
  if (!slots.length) return { notified: 0 }; // agenda ancora piena/chiusa: si riprova domani
  setSetting(`waitlist_recall_done_${iso}`, '1'); // 1 giro al giorno (dopo aver visto che ci sono slot)
  const avail = formatAvailabilityIT(slots);
  let notified = 0;
  for (const w of pending.slice(0, 10)) {
    // VIP/high: mai ricontatto automatico; la voce resta in_attesa per Mariano.
    if (isVipContact(w.phone)) continue;
    const text = waitlistRecallMessageIT(w.contact_name, w.reason, avail, channelOfKey(w.phone).channel);
    const ok = await deliver(w.phone, text, 'Nuove disponibilità per un appuntamento — Studio Tributario Branca');
    if (ok) { markWaitlistNotified(w.id); notified++; }
  }
  if (notified) {
    try { await sendTextMessage(getControlNumber(), `📋 Lista d'attesa: ricontattat${notified === 1 ? 'o 1 cliente' : `i ${notified} clienti`} con le nuove disponibilità in agenda.`); }
    catch { /* best-effort */ }
  }
  return { notified };
}

// ═══ 3) SLA RISPOSTE IN ATTESA ═══════════════════════════════════════════════
export async function runSlaCheck(force = false): Promise<{ alerted: number }> {
  const { hour } = romeNow();
  if (!force && !inSlaWindow(hour)) return { alerted: 0 };
  const soglia = slaHours();
  const cutoff = Date.now() - soglia * 3600000;

  // Migrazioni LAZY (qui e non a livello modulo: bot_drafts esiste sempre, ma
  // incoming_emails viene creata solo quando il modulo email si carica, dopo di noi).
  try { db.exec(`ALTER TABLE bot_drafts ADD COLUMN sla_notified INTEGER DEFAULT 0`); } catch { /* già presente */ }
  try { db.exec(`ALTER TABLE incoming_emails ADD COLUMN sla_notified INTEGER DEFAULT 0`); } catch { /* già presente o tabella assente */ }

  const drafts = (db.prepare(`
    SELECT id, phone, contact_name, created_at FROM bot_drafts
    WHERE status = 'pending' AND COALESCE(sla_notified, 0) = 0
  `).all() as any[]).filter((d) => {
    const t = sqliteToMs(d.created_at);
    return !isNaN(t) && t < cutoff;
  });

  let emails: any[] = [];
  try {
    emails = (db.prepare(`
      SELECT id, from_addr, from_name, subject, email_date FROM incoming_emails
      WHERE category = 'lavoro' AND COALESCE(replied, 0) = 0 AND COALESCE(seen, 0) = 0
        AND COALESCE(sla_notified, 0) = 0
    `).all() as any[]).filter((e) => {
      const t = Date.parse(e.email_date);
      // Solo la finestra recente: il pregresso storico in inbox non deve fare rumore.
      return !isNaN(t) && t < cutoff && t > Date.now() - 7 * 86400000;
    });
  } catch { /* modulo email non attivo */ }

  if (!drafts.length && !emails.length) return { alerted: 0 };
  const text = slaAlertText(
    drafts.map((d) => ({ id: d.id, who: d.contact_name || d.phone, ageMin: (Date.now() - sqliteToMs(d.created_at)) / 60000 })),
    emails.map((e) => ({ who: e.from_name || e.from_addr, subject: e.subject || '(senza oggetto)', ageMin: (Date.now() - Date.parse(e.email_date)) / 60000 })),
    soglia,
  );
  try { await sendTextMessage(getControlNumber(), text); }
  catch (e: any) {
    // Invio fallito: NON marcare, così si ritenta al prossimo giro.
    console.error('[Reminders] alert SLA fallito:', e.message);
    return { alerted: 0 };
  }
  for (const d of drafts) db.prepare(`UPDATE bot_drafts SET sla_notified = 1 WHERE id = ?`).run(d.id);
  for (const e of emails) { try { db.prepare(`UPDATE incoming_emails SET sla_notified = 1 WHERE id = ?`).run(e.id); } catch { /* tabella assente */ } }
  console.log(`[Reminders] Alert SLA: ${drafts.length} bozze + ${emails.length} email in attesa da >${soglia}h.`);
  return { alerted: drafts.length + emails.length };
}

// ═══ 4) AGING BOZZE — DIGEST BACKLOG (rev. 11/07/2026) ═══════════════════════
// Complementare allo SLA (one-shot a ~4h). Qui: 1 DIGEST/giorno del backlog ANCORA
// aperto, con priorità alle URGENZE ferme oltre 24h (le altre oltre 48h) + gli
// appuntamenti [DA CONFERMARE] già passati/in giornata. Solo notifica al numero di
// controllo (Mariano): NESSUN messaggio ai clienti. Idempotente 1×/giorno.
export function draftAgingEnabled(): boolean { return getSetting('bot_draft_aging', '1') === '1'; }
function agingOpts(): AgingOpts {
  return {
    urgentHours: parseInt(getSetting('aging_urgent_hours', '24'), 10) || 24,
    normalHours: parseInt(getSetting('aging_normal_hours', '48'), 10) || 48,
  };
}
function overdueProposedAppointments(todayISO: string): { who: string; date: string; start: string }[] {
  try {
    return (db.prepare(`
      SELECT phone, contact_name, date, start FROM bot_appointments
      WHERE status = 'da_confermare' AND date <= ? ORDER BY date ASC, start ASC
    `).all(todayISO) as any[]).map((a) => ({ who: a.contact_name || a.phone, date: a.date, start: a.start }));
  } catch { return []; }
}
export async function runDraftAging(force = false): Promise<{ alerted: number }> {
  if (!draftAgingEnabled()) return { alerted: 0 };
  const { iso, hour } = romeNow();
  if (!force) {
    if (hour < 8 || hour > 21) return { alerted: 0 };            // niente notifiche notturne
    if (getSetting(`draft_aging_done_${iso}`, '') === '1') return { alerted: 0 }; // 1×/giorno
  }
  const opts = agingOpts();
  const drafts = db.prepare(`SELECT id, phone, contact_name, needs_human, created_at FROM bot_drafts WHERE status = 'pending'`).all() as any[];
  const sel = selectAgingDrafts(drafts, Date.now(), opts);
  const overdue = overdueProposedAppointments(iso);
  if (!sel.count && !overdue.length) { if (!force) setSetting(`draft_aging_done_${iso}`, '1'); return { alerted: 0 }; }
  const text = agingDigestText(sel, overdue, opts);
  try { await sendTextMessage(getControlNumber(), text); }
  catch (e: any) { console.error('[Reminders] alert aging fallito:', e.message); return { alerted: 0 }; }
  if (!force) setSetting(`draft_aging_done_${iso}`, '1');
  console.log(`[Reminders] Aging bozze: ${sel.urgent.length} urgenti + ${sel.normal.length} normali + ${overdue.length} appuntamenti da confermare scaduti.`);
  return { alerted: sel.count + overdue.length };
}

/** Vista prioritaria di sola lettura (nessun invio) — per endpoint /api/bot/drafts/aging. */
export function getAgingView(): any {
  const opts = agingOpts();
  const { iso } = romeNow();
  const drafts = db.prepare(`SELECT id, phone, contact_name, needs_human, created_at FROM bot_drafts WHERE status = 'pending'`).all() as any[];
  const sel = selectAgingDrafts(drafts, Date.now(), opts);
  return { opts, ...sel, overdueAppointments: overdueProposedAppointments(iso), totalPending: drafts.length };
}

// ═══ 5) PULIZIA PROPOSTE APPUNTAMENTO SCADUTE (rev. 11/07/2026) ══════════════
// Le proposte [DA CONFERMARE] con data ORMAI passata e mai confermate restavano
// attive, occupando l'agenda (evento freeBusy "fantasma"). Questo job idempotente
// le porta a status 'scaduto' e aggiorna l'evento Calendar a [SCADUTA]. Gira nel
// tick; NESSUN messaggio ai clienti (solo pulizia interna).
export async function runAppointmentCleanup(force = false): Promise<{ expired: number }> {
  const todayISO = romeNow().iso;
  const rows = getAllAppointments();
  const expired = selectExpiredProposals(
    rows.map((r: any) => ({ id: r.id, date: r.date, status: r.status })),
    todayISO,
  );
  if (!expired.length) return { expired: 0 };
  let done = 0;
  for (const e of expired) {
    const full = rows.find((r: any) => r.id === e.id);
    try { await expireAppointmentRow(full); done++; }
    catch (err: any) { console.error('[Reminders] scadenza appuntamento', e.id, err.message); }
  }
  if (done) {
    console.log(`[Reminders] Pulizia agenda: ${done} propost${done === 1 ? 'a' : 'e'} [DA CONFERMARE] scadut${done === 1 ? 'a' : 'e'} → 'scaduto'.`);
    if (force || done > 0) {
      try { await sendTextMessage(getControlNumber(), `⌛ Agenda: ${done} propost${done === 1 ? 'a' : 'e'} di appuntamento scadut${done === 1 ? 'a' : 'e'} (mai confermat${done === 1 ? 'a' : 'e'}) e liberat${done === 1 ? 'o lo slot' : 'i gli slot'}.`); }
      catch { /* best-effort */ }
    }
  }
  return { expired: done };
}

/** Un giro di tutti i job: chiamato dal tick di maintenance (ogni 30 min). Ogni job è
 *  isolato in try/catch: un errore qui non deve MAI toccare digest/watchdog/bot. */
export async function remindersTick(): Promise<void> {
  try { await runReminders(); } catch (e: any) { console.error('[Reminders] promemoria:', e.message); }
  try { await runWaitlistRecall(); } catch (e: any) { console.error('[Reminders] lista d\'attesa:', e.message); }
  try { await runSlaCheck(); } catch (e: any) { console.error('[Reminders] SLA:', e.message); }
  try { await runDraftAging(); } catch (e: any) { console.error('[Reminders] aging bozze:', e.message); }
  try { await runAppointmentCleanup(); } catch (e: any) { console.error('[Reminders] pulizia agenda:', e.message); }
}

/** Stato sintetico per Cruscotto/diagnostica. */
export function getRemindersStatus(): any {
  const count = (sql: string) => { try { return (db.prepare(sql).get() as any)?.c ?? 0; } catch { return 0; } };
  return {
    remindersEnabled: remindersEnabled(),
    waitlistRecallEnabled: waitlistRecallEnabled(),
    slaHours: slaHours(),
    tomorrowAppointments: count(`SELECT COUNT(*) c FROM bot_appointments WHERE date = '${romeDatePlus(1)}' AND status IN ('da_confermare','confermato')`),
    waitlistPending: count(`SELECT COUNT(*) c FROM bot_waitlist WHERE status = 'in_attesa'`),
    waitlistNotified: count(`SELECT COUNT(*) c FROM bot_waitlist WHERE status = 'ricontattato'`),
  };
}
