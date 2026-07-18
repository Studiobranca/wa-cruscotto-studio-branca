/*
 * emaildrafts.ts — Coda BOZZE email + audit-log invii email (rev. 11/07/2026).
 *
 * ALLINEAMENTO ALL'INVARIANTE: come su WhatsApp, le risposte di MERITO e le URGENZE
 * via email NON partono più da sole → diventano BOZZE da approvare. In autonomia
 * resta solo il flusso APPUNTAMENTI (già incrociato con l'agenda). Qui vivono la
 * tabella delle bozze email e l'audit-log degli invii autonomi/approvati.
 *
 * Solo storage/lettura: nessun invio SMTP qui (sta in email.ts). Isolato in try/catch.
 */
import { db } from './db.js';
import { hashText } from './sentlog_logic.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT,
    to_addr TEXT NOT NULL,
    to_name TEXT,
    subject TEXT,
    draft_text TEXT,
    in_reply_to TEXT,
    proposed_event TEXT,            -- JSON oppure NULL
    needs_human INTEGER DEFAULT 0,
    incoming_id INTEGER,            -- id in incoming_emails
    status TEXT DEFAULT 'pending',  -- pending | sent | rejected
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_email_drafts_status ON email_drafts(status);
  CREATE TABLE IF NOT EXISTS email_sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_addr TEXT,
    subject TEXT,
    kind TEXT,                      -- 'appointment' | 'reply-approved'
    draft_id INTEGER,
    text_hash TEXT,
    text_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_sent_log_created ON email_sent_log(created_at);
`);

export interface EmailDraftInput {
  account?: string | null; toAddr: string; toName?: string | null; subject: string;
  draftText: string; inReplyTo?: string | null; proposedEvent?: any; needsHuman?: boolean; incomingId?: number | null;
}
export function saveEmailDraft(e: EmailDraftInput): number {
  // 1 sola bozza pending per mittente: scarta le precedenti (come WhatsApp).
  try { db.prepare(`UPDATE email_drafts SET status = 'rejected' WHERE to_addr = ? AND status = 'pending'`).run(e.toAddr); } catch { /* best-effort */ }
  const info = db.prepare(`
    INSERT INTO email_drafts (account, to_addr, to_name, subject, draft_text, in_reply_to, proposed_event, needs_human, incoming_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(e.account ?? null, e.toAddr, e.toName ?? null, e.subject, e.draftText, e.inReplyTo ?? null,
    e.proposedEvent ? JSON.stringify(e.proposedEvent) : null, e.needsHuman ? 1 : 0, e.incomingId ?? null);
  return Number(info.lastInsertRowid);
}
function safeParseProposedEvent(raw: any): any | null {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { console.error('[emaildrafts] proposed_event JSON corrotto, ignorato:', e); return null; }
}
export function getEmailDrafts(status = 'pending'): any[] {
  const rows = db.prepare(`SELECT * FROM email_drafts WHERE status = ? ORDER BY created_at DESC`).all(status) as any[];
  return rows.map((r) => ({ ...r, proposed_event: safeParseProposedEvent(r.proposed_event) }));
}
export function getEmailDraft(id: number): any | null {
  const r = db.prepare(`SELECT * FROM email_drafts WHERE id = ?`).get(id) as any;
  if (!r) return null;
  return { ...r, proposed_event: safeParseProposedEvent(r.proposed_event) };
}
export function markEmailDraftSent(id: number): void {
  db.prepare(`UPDATE email_drafts SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(id);
}
export function markEmailDraftRejected(id: number): void {
  db.prepare(`UPDATE email_drafts SET status = 'rejected' WHERE id = ?`).run(id);
}

export function recordEmailSend(e: { toAddr: string; subject: string; kind: 'appointment' | 'reply-approved'; draftId?: number | null; text: string }): void {
  try {
    db.prepare(`INSERT INTO email_sent_log (to_addr, subject, kind, draft_id, text_hash, text_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(e.toAddr, e.subject, e.kind, e.draftId ?? null, hashText(e.text), String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 140), new Date().toISOString());
  } catch (err: any) { console.error('[EmailSentLog] insert fallito:', err?.message); }
}
export function getEmailSentLog(sinceISO?: string, limit = 200): any[] {
  const since = sinceISO || new Date(Date.now() - 7 * 86400000).toISOString();
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  try {
    return db.prepare(`SELECT id, to_addr AS toAddr, subject, kind, draft_id AS draftId, text_hash AS textHash, text_preview AS textPreview, created_at AS createdAt
      FROM email_sent_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(since, lim);
  } catch { return []; }
}
export function getEmailSentSummary(sinceISO?: string): { since: string; total: number; byKind: Record<string, number> } {
  const since = sinceISO || new Date(Date.now() - 7 * 86400000).toISOString();
  const byKind: Record<string, number> = {}; let total = 0;
  try {
    for (const r of db.prepare(`SELECT kind, COUNT(*) c FROM email_sent_log WHERE created_at >= ? GROUP BY kind`).all(since) as any[]) { byKind[r.kind || 'unknown'] = r.c; total += r.c; }
  } catch { /* tabella non pronta */ }
  return { since, total, byKind };
}
