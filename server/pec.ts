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
