/**
 * appointment_bridge.ts — PONTE conferma→agenda dalle RISPOSTE di Mariano.
 *
 * Quando Mariano risponde a un cliente (testo o VOCALE trascritto) e CONFERMA /
 * SPOSTA / DISDICE un appuntamento, questo modulo scrive/aggiorna/cancella
 * l'evento su Google Calendar (e specchia su Apple se abilitato). NON invia mai
 * messaggi al cliente: parla solo con il numero di controllo (Mariano stesso).
 *
 * Regola d'oro: in caso di ambiguità (nessun appuntamento pendente e data/ora
 * non chiare) NON crea nulla — logga e chiede a Mariano di precisare. Mai inventare.
 *
 * NON tocca gli invarianti (autoSend / waCommands / decideWorkAutoSend / webhook):
 * è additivo e gated dal setting `bot_confirm_from_replies` (default ON).
 */
import { db } from './db.js';
import { detectApptIntent, extractDateTimeIT } from './appt_nlp.js';
import { updateCalendarEvent, createCalendarEvent } from './integrations.js';
import { mirrorToApple, deleteFromApple, appleEnabled } from './caldav.js';
import {
  getPendingAppointment, getActiveFutureAppointments, recordAppointment,
  markAppointmentConfirmed, cancelAppointmentRow, getControlNumber,
} from './chatbot.js';
import { sendTextMessage } from './zapi.js';

function getSetting(key: string, def: string): string {
  try { const r = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any; return r?.value ?? def; }
  catch { return def; }
}
function setSetting(key: string, value: string): void {
  try { db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value); }
  catch { /* best-effort */ }
}
export function isConfirmFromRepliesEnabled(): boolean { return getSetting('bot_confirm_from_replies', '1') === '1'; }

/** Salute del ponte (ultimo esito e ultimo errore) — per selftest/flow-health. */
export function getBridgeHealth(): any {
  const ok = (() => { try { return JSON.parse(getSetting('bridge_last_ok', '')); } catch { return null; } })();
  const err = (() => { try { return JSON.parse(getSetting('bridge_last_err', '')); } catch { return null; } })();
  return { enabled: isConfirmFromRepliesEnabled(), appleMirror: appleEnabled(), lastOk: ok, lastError: err };
}
function recordOk(detail: any) { setSetting('bridge_last_ok', JSON.stringify({ at: new Date().toISOString(), ...detail })); }
function recordErr(detail: any) { setSetting('bridge_last_err', JSON.stringify({ at: new Date().toISOString(), ...detail })); }

function endTime(start: string): string {
  const [h, m] = start.split(':').map((x) => parseInt(x, 10));
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}
function nowRome(): Date {
  // Data "parete" a Europe/Rome, così i calcoli oggi/domani/giorni usano il fuso giusto.
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => Number(s.find((p) => p.type === t)?.value);
  return new Date(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), 0);
}
function contactNameOf(phone: string): string {
  try { const c = db.prepare(`SELECT contact_name FROM conversations WHERE phone = ?`).get(phone) as any; return c?.contact_name || phone; }
  catch { return phone; }
}
async function notifyControl(msg: string): Promise<void> {
  try { await sendTextMessage(getControlNumber(), msg); } catch (e: any) { console.error('[Ponte] notifica controllo:', e.message); }
}
function apptUid(appt: any): string { return appt.event_id || `cruscotto-appt-${appt.id}`; }

/**
 * Analizza la risposta di Mariano (già trascritta se vocale) su una chat cliente.
 * Ritorna un breve riepilogo da inviare al numero di controllo, o null se non
 * c'è nulla di pertinente (così il chiamante non invia nulla).
 */
export async function handleControlAppointmentReply(clientPhone: string, text: string): Promise<string | null> {
  if (!isConfirmFromRepliesEnabled()) return null;
  const intent = detectApptIntent(text);
  if (!intent) return null;

  const cname = contactNameOf(clientPhone);
  const pending = getPendingAppointment(clientPhone);
  const actives = getActiveFutureAppointments(clientPhone);
  const dt = extractDateTimeIT(text, nowRome());

  try {
    // ── DISDETTA ──────────────────────────────────────────────────────────
    if (intent === 'cancel') {
      if (!actives.length) return null; // niente da disdire → è solo chat
      for (const a of actives) {
        try { await cancelAppointmentRow(a); if (appleEnabled()) await deleteFromApple(apptUid(a)); }
        catch (e: any) { console.error('[Ponte] disdetta:', e.message); }
      }
      const f = actives[0];
      recordOk({ action: 'cancel', phone: clientPhone, date: f.date, start: f.start });
      return `❌ Disdetta registrata in agenda per ${cname}:\n📅 ${f.date} ore ${f.start} — ${f.reason || 'Appuntamento'}${appleEnabled() ? ' (Google + Apple)' : ''}.`;
    }

    // ── CONFERMA (eventualmente con spostamento) ─────────────────────────
    const hasDate = !!dt.date;
    const target = pending || actives[0] || null;

    // Caso A: c'è un appuntamento tracciato → conferma (e sposta se data/ora nuove)
    if (target) {
      const newDate = dt.date || target.date;
      const newStart = dt.time || target.start;
      const newEnd = endTime(newStart);
      const moved = newDate !== target.date || newStart !== target.start;
      const title = `✅ ${target.reason || 'Appuntamento'} — ${cname}`;
      const desc = `Appuntamento CONFERMATO dallo studio.\nCliente: ${cname} (${clientPhone})\nMotivo: ${target.reason || '-'}\nConfermato il ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`;
      let calOk = false;
      if (target.event_id) {
        const r = await updateCalendarEvent({ eventId: target.event_id, title, description: desc, colorId: '10', startDate: `${newDate}T${newStart}:00`, endDate: `${newDate}T${newEnd}:00` });
        calOk = r.success;
      } else {
        const r = await createCalendarEvent({ title, description: desc, startDate: `${newDate}T${newStart}:00`, endDate: `${newDate}T${newEnd}:00` });
        if (r.success && r.eventId) { try { db.prepare(`UPDATE bot_appointments SET event_id = ? WHERE id = ?`).run(r.eventId, target.id); target.event_id = r.eventId; } catch { /* */ } }
        calOk = r.success;
      }
      try { db.prepare(`UPDATE bot_appointments SET date = ?, start = ?, end = ?, status = 'confermato', confirmed_at = datetime('now') WHERE id = ?`).run(newDate, newStart, newEnd, target.id); } catch { /* */ }
      let appleOk = false;
      if (appleEnabled()) appleOk = await mirrorToApple({ uid: apptUid(target), summary: title, description: desc, date: newDate, start: newStart, end: newEnd });
      recordOk({ action: moved ? 'confirm+move' : 'confirm', phone: clientPhone, date: newDate, start: newStart, calOk, appleOk });
      const esito = calOk ? 'Agenda Google aggiornata (confermato)' : '⚠️ NON sono riuscito ad aggiornare Google: controlla a mano';
      const ap = appleEnabled() ? (appleOk ? ' + Apple ok' : ' + ⚠️ Apple fallito') : '';
      return `✅ ${cname} — appuntamento ${moved ? 'SPOSTATO e ' : ''}CONFERMATO:\n📅 ${newDate} ore ${newStart} — ${target.reason || 'Appuntamento'}\n${esito}${ap}.`;
    }

    // Caso B: nessun appuntamento tracciato
    if (hasDate && dt.time) {
      // Conferma con data+ora complete → crea evento confermato ex novo
      const reason = 'Appuntamento';
      const newEnd = endTime(dt.time);
      const title = `✅ ${reason} — ${cname}`;
      const desc = `Appuntamento CONFERMATO dallo studio (da risposta WhatsApp).\nCliente: ${cname} (${clientPhone})\nCreato il ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`;
      const r = await createCalendarEvent({ title, description: desc, startDate: `${dt.date}T${dt.time}:00`, endDate: `${dt.date}T${newEnd}:00` });
      const id = recordAppointment({ phone: clientPhone, contactName: cname, eventId: r.eventId ?? null, date: dt.date!, start: dt.time, end: newEnd, reason });
      markAppointmentConfirmed(id);
      let appleOk = false;
      if (appleEnabled()) appleOk = await mirrorToApple({ uid: r.eventId || `cruscotto-appt-${id}`, summary: title, description: desc, date: dt.date!, start: dt.time, end: newEnd });
      recordOk({ action: 'create-confirmed', phone: clientPhone, date: dt.date, start: dt.time, calOk: r.success, appleOk });
      const ap = appleEnabled() ? (appleOk ? ' + Apple ok' : ' + ⚠️ Apple fallito') : '';
      return `✅ ${cname} — nuovo appuntamento CONFERMATO in agenda:\n📅 ${dt.date} ore ${dt.time} — ${reason}\n${r.success ? 'Google ok' : '⚠️ Google fallito'}${ap}.`;
    }

    if (hasDate && !dt.time) {
      // Data senza ora e nessun appuntamento pendente → NON inventare l'ora
      recordErr({ action: 'ambiguo-ora', phone: clientPhone, date: dt.date, text: text.slice(0, 120) });
      return `⚠️ ${cname}: ho letto una conferma per il ${dt.date} ma SENZA orario e non c'è una proposta in sospeso. Non ho creato nulla per non sbagliare l'ora: rispondi indicando l'ora (es. "alle 15") e la segno.`;
    }

    // Conferma generica senza data e senza appuntamento pendente → è solo chat
    return null;
  } catch (e: any) {
    recordErr({ action: 'exception', phone: clientPhone, error: e.message });
    console.error('[Ponte] errore:', e.message);
    await notifyControl(`⚠️ Ponte agenda: errore nel processare la conferma per ${cname}: ${e.message}. Controlla l'appuntamento a mano.`);
    return null;
  }
}
