/*
 * pec.ts — Monitoraggio PEC del contenzioso (Legalmail/InfoCert) — rev. 12/07/2026.
 *
 * SICUREZZA (inderogabile): SOLO LETTURA IMAP. La PEC NON riceve MAI risposte automatiche,
 * nessun deposito/invio verso enti. I termini procedurali calcolati sono SEMPRE proposti
 * come "[DA CONFERMARE]". Modulo ISOLATO (import dinamico in try/catch dai chiamanti): un
 * suo errore non tocca il resto del cruscotto.
 *
 * Attivazione dietro env: PEC_USER + PEC_PASS (host/porta hanno default Legalmail).
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import db from './db.js';
import { classifyPec, extractDates, extractHearingDate, extractRG } from './pec_logic.js';
import { computeDeadlinesFromEvent } from './pec_terms.js';
import { createCalendarEvent } from './integrations.js';
import { createDeadline } from './deadlines.js';
import { sendTextMessage } from './zapi.js';
import { getControlNumber } from './chatbot.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS pec_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    pec_uid INTEGER,
    from_addr TEXT,
    subject TEXT,
    category TEXT,
    event_type TEXT,
    confident INTEGER DEFAULT 0,
    hearing_date TEXT,
    rg_ref TEXT,
    dates_json TEXT,
    attachments_json TEXT,
    body_excerpt TEXT,
    client_key TEXT,
    status TEXT DEFAULT 'nuovo',       -- nuovo | da_rivedere | processato
    calendar_event_ids TEXT,           -- JSON: idempotenza calendarizzazione (BLOCCO 3)
    received_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pec_events_status ON pec_events(status, created_at);
`);

function envSetting(key: string, def = ''): string { return (process.env[key] || def).trim(); }
export function pecConfig() {
  return {
    host: envSetting('PEC_IMAP_HOST', 'mbox.cert.legalmail.it'),
    port: parseInt(envSetting('PEC_IMAP_PORT', '993'), 10) || 993,
    user: envSetting('PEC_USER', 'studiotributariobrancamariano@legalmail.it'),
    pass: process.env.PEC_PASS || '',
  };
}
export function pecEnabled(): boolean { const c = pecConfig(); return !!(c.user && c.pass); }

function setSetting(k: string, v: string) { try { db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v); } catch { /* noop */ } }
function getSetting(k: string): string | null { try { return (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(k) as any)?.value ?? null; } catch { return null; } }

/** Inserisce (o ignora se già visto) un evento PEC estratto da un messaggio. Ritorna id o null. */
export function ingestPecMessage(m: {
  messageId: string; uid?: number; fromAddr: string; subject: string; body: string;
  attachments: string[]; receivedAt: string;
}): number | null {
  const exists = db.prepare(`SELECT id FROM pec_events WHERE message_id = ?`).get(m.messageId) as any;
  if (exists) return null;
  const cls = classifyPec(m.fromAddr, m.subject, m.body);
  const hearing = extractHearingDate(`${m.subject}\n${m.body}`);
  const rg = extractRG(`${m.subject}\n${m.body}`);
  const dates = extractDates(`${m.subject}\n${m.body}`);
  const status = cls.confident ? 'nuovo' : 'da_rivedere';
  const info = db.prepare(`
    INSERT INTO pec_events (message_id, pec_uid, from_addr, subject, category, event_type, confident,
      hearing_date, rg_ref, dates_json, attachments_json, body_excerpt, status, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.messageId, m.uid ?? null, m.fromAddr, m.subject, cls.category, cls.eventType, cls.confident ? 1 : 0,
    hearing, rg, JSON.stringify(dates), JSON.stringify(m.attachments || []), String(m.body || '').slice(0, 500), status, m.receivedAt);
  return Number(info.lastInsertRowid);
}

// ═══ BLOCCO 3 — CALENDARIZZAZIONE (idempotente) ══════════════════════════════
// Per ogni UDIENZA e ogni TERMINE calcolato crea un evento Google Calendar + una voce
// nello scadenzario (bot_deadlines). I termini calcolati hanno prefisso "[DA CONFERMARE]".
// Idempotente: se il pec_event è già 'processato' (calendar_event_ids valorizzato) → skip.
// Nessun invio ai clienti/enti: solo agenda interna + alert al numero di controllo.
async function calEvent(title: string, description: string, dateISO: string, startHHMM = '09:00', durMin = 60): Promise<string | null> {
  const start = `${dateISO}T${startHHMM}:00`;
  const endMs = Date.parse(start) + durMin * 60000;
  const end = new Date(endMs).toISOString().slice(0, 19); // locale-naive ISO; timeZone gestita dall'integrazione
  try { const r = await createCalendarEvent({ title, description, startDate: start, endDate: end }); return r.success ? (r.eventId || 'created') : null; }
  catch { return null; }
}

/** Processa UN pec_event (confident): crea eventi Calendar + scadenze. Idempotente. */
export async function processPecEvent(row: any): Promise<{ ok: boolean; created: number; skipped?: boolean }> {
  if (!row || row.status === 'processato' || row.calendar_event_ids) return { ok: true, created: 0, skipped: true };
  const rg = row.rg_ref ? ` R.G. ${row.rg_ref}` : '';
  const who = row.from_addr || '';
  const ids: string[] = [];
  let created = 0;
  const lines: string[] = [];

  // 1) UDIENZA (data certa comunicata dall'ente → NON [DA CONFERMARE], ma orario da verificare)
  if (row.hearing_date) {
    const title = `⚖️ UDIENZA${rg} — ${row.category}`;
    const desc = `Udienza fissata (fonte PEC). Oggetto: ${row.subject}\nMittente: ${who}\n⏰ Orario da verificare sull'avviso.`;
    const eid = await calEvent(title, desc, row.hearing_date, '09:00', 60);
    if (eid) { ids.push(`hearing:${eid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: 'Udienza CGT', description: `${row.subject} (orario da verificare)`, dueDate: row.hearing_date });
    lines.push(`⚖️ Udienza${rg}: ${row.hearing_date} (orario da verificare)`);
  }

  // 2) TERMINI calcolati → SEMPRE [DA CONFERMARE]
  const terms = computeDeadlinesFromEvent({ eventType: row.event_type, category: row.category, hearingDate: row.hearing_date, baseDate: row.received_at ? String(row.received_at).slice(0, 10) : null });
  for (const t of terms) {
    const title = `[DA CONFERMARE] ${t.tipo}${rg}`;
    const desc = `Termine PROPOSTO (da confermare) — ${t.norma}\n${t.note}${t.uncertain ? '\n⚠️ Regola incerta: verificare.' : ''}\nFascicolo: ${row.rg_ref || 'n/d'} · PEC: ${row.subject}`;
    const eid = await calEvent(title, desc, t.dueDate, '09:00', 30);
    if (eid) { ids.push(`term:${eid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `[DA CONFERMARE] ${t.tipo}`, description: `${t.norma} — ${t.note}`, dueDate: t.dueDate });
    lines.push(`• [DA CONFERMARE] ${t.tipo}: ${t.dueDate} (${t.norma})`);
  }

  db.prepare(`UPDATE pec_events SET status = 'processato', calendar_event_ids = ? WHERE id = ?`).run(JSON.stringify(ids), row.id);

  if (lines.length) {
    const alert = `📩 *PEC contenzioso* — nuovo evento${rg}\n${row.subject}\n\n${lines.join('\n')}\n\n⚠️ I termini sono PROPOSTE [DA CONFERMARE]: verifica sull'atto (date di notifica, giorni liberi, feriale).`;
    try { await sendTextMessage(getControlNumber(), alert); } catch { /* best-effort */ }
  }
  return { ok: true, created };
}

/** Processa tutti i pec_events 'nuovo' (confident). I 'da_rivedere' restano per revisione umana. */
export async function runPecProcessing(): Promise<{ processed: number; created: number }> {
  const rows = db.prepare(`SELECT * FROM pec_events WHERE status = 'nuovo' ORDER BY id ASC LIMIT 50`).all() as any[];
  let processed = 0, created = 0;
  for (const r of rows) {
    try { const res = await processPecEvent(r); processed++; created += res.created; }
    catch (e: any) { console.error('[PEC] processing evento', r.id, e?.message); }
  }
  return { processed, created };
}

/** Poll IMAP della casella PEC (sola lettura). Idempotente per Message-ID. Non lancia mai. */
export async function pollPec(force = false): Promise<{ enabled: boolean; processed: number; created: number; error?: string }> {
  if (!pecEnabled()) return { enabled: false, processed: 0, created: 0, error: 'PEC non configurata (mancano PEC_USER/PEC_PASS)' };
  const c = pecConfig();
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  let processed = 0, created = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (total) {
        const from = Math.max(1, total - 60);
        for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true })) {
          processed++;
          try {
            const parsed = await simpleParser(msg.source as Buffer);
            const messageId = parsed.messageId || `pec_${msg.uid}`;
            if (db.prepare(`SELECT 1 FROM pec_events WHERE message_id = ?`).get(messageId)) continue;
            const fromVal = (parsed.from as any)?.value?.[0] || {};
            const atts = (parsed.attachments || []).map((a: any) => a.filename || 'allegato');
            const id = ingestPecMessage({
              messageId, uid: msg.uid, fromAddr: fromVal.address || '', subject: parsed.subject || '(senza oggetto)',
              body: parsed.text || '', attachments: atts, receivedAt: (parsed.date || new Date()).toISOString(),
            });
            if (id) created++;
          } catch (e: any) { console.error('[PEC] parse messaggio fallito:', e?.message); }
        }
      }
    } finally { lock.release(); }
    await client.logout().catch(() => {});
    setSetting('pec_last_poll', new Date().toISOString());
    // Dopo l'ingestione, calendarizza gli eventi confident (idempotente, isolato).
    try { await runPecProcessing(); } catch (e: any) { console.error('[PEC] processing:', e?.message); }
    return { enabled: true, processed, created };
  } catch (e: any) {
    try { await client.logout().catch(() => {}); } catch { /* noop */ }
    console.error('[PEC] poll fallito:', e?.message);
    setSetting('pec_last_error', `${new Date().toISOString()} ${e?.message}`);
    return { enabled: true, processed, created, error: e?.message };
  }
}

export function getPecEvents(limit = 100): any[] {
  const rows = db.prepare(`SELECT * FROM pec_events ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as any[];
  return rows.map((r) => ({ ...r, dates: r.dates_json ? JSON.parse(r.dates_json) : [], attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [] }));
}

export function getPecStatus(): any {
  const c = pecConfig();
  const counts: any = {};
  try { for (const r of db.prepare(`SELECT status, COUNT(*) n FROM pec_events GROUP BY status`).all() as any[]) counts[r.status] = r.n; } catch { /* noop */ }
  return {
    enabled: pecEnabled(),
    host: c.host, port: c.port, user: c.user,   // niente password: mai esposta
    lastPoll: getSetting('pec_last_poll'),
    lastError: getSetting('pec_last_error'),
    counts,
  };
}
