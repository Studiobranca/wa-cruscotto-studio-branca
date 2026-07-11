/*
 * sentlog.ts — Audit-log persistente degli invii autonomi del bot (rev. 11/07/2026).
 *
 * Chiude la lacuna di osservabilità emersa con l'incidente del 06/07: non esisteva
 * modo di elencare cosa il bot avesse inviato da solo. Ora ogni invio autonomo
 * (cortesia o appuntamento) viene registrato e consultabile in sola lettura via
 * GET /api/bot/sent. Il MERITO non viene mai auto-inviato → non comparirà mai qui.
 *
 * Isolato in try/catch: un errore di logging non deve MAI bloccare l'invio o il bot.
 */
import db from './db.js';
import { buildSentEntry, type SentInput } from './sentlog_logic.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    contact_name TEXT,
    kind TEXT,                 -- 'appointment' | 'courtesy'
    draft_id INTEGER,
    text_hash TEXT,
    text_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_sent_log_created ON bot_sent_log(created_at);
`);

/** Registra un invio autonomo del bot. Best-effort: non lancia mai. */
export function recordBotSend(e: SentInput): void {
  try {
    const r = buildSentEntry(e, new Date().toISOString());
    db.prepare(`
      INSERT INTO bot_sent_log (phone, contact_name, kind, draft_id, text_hash, text_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(r.phone, r.contact_name, r.kind, r.draft_id, r.text_hash, r.text_preview, r.created_at);
  } catch (err: any) {
    console.error('[SentLog] insert fallito:', err?.message);
  }
}

/** Elenco invii autonomi (sola lettura). `since` ISO opzionale (default: ultimi 7 giorni). */
export function getSentLog(sinceISO?: string, limit = 200): any[] {
  const since = sinceISO || new Date(Date.now() - 7 * 86400000).toISOString();
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  try {
    return db.prepare(`
      SELECT id, phone, contact_name AS contactName, kind, draft_id AS draftId,
             text_hash AS textHash, text_preview AS textPreview, created_at AS createdAt
      FROM bot_sent_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?
    `).all(since, lim);
  } catch { return []; }
}

/** Riepilogo per tipo dell'audit-log (per diagnostica / prova invariante). */
export function getSentLogSummary(sinceISO?: string): { since: string; total: number; byKind: Record<string, number> } {
  const since = sinceISO || new Date(Date.now() - 7 * 86400000).toISOString();
  const byKind: Record<string, number> = {};
  let total = 0;
  try {
    const rows = db.prepare(`SELECT kind, COUNT(*) AS c FROM bot_sent_log WHERE created_at >= ? GROUP BY kind`).all(since) as any[];
    for (const r of rows) { byKind[r.kind || 'unknown'] = r.c; total += r.c; }
  } catch { /* tabella non pronta */ }
  return { since, total, byKind };
}
