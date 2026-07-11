/*
 * deadlines.ts — Scadenzario adempimenti per cliente (rev. 11/07/2026).
 * Registro scadenze (F24, dichiarazioni, adempimenti). I promemoria delle scadenze
 * imminenti vanno SOLO al numero di controllo di Mariano, MAI ai clienti.
 */
import db from './db.js';
import { selectImminentDeadlines, type DeadlineRow } from './deadlines_logic.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_deadlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key TEXT,                 -- telefono, email:<addr>, o nome cliente
    contact_name TEXT,
    tipo TEXT,                       -- es. F24, Dichiarazione redditi, IVA, ...
    description TEXT,
    due_date TEXT NOT NULL,          -- YYYY-MM-DD
    status TEXT DEFAULT 'aperto',    -- aperto | completato
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bot_deadlines_due ON bot_deadlines(status, due_date);
`);

export function createDeadline(e: { clientKey?: string; contactName?: string; tipo?: string; description?: string; dueDate: string }): number {
  const info = db.prepare(`INSERT INTO bot_deadlines (client_key, contact_name, tipo, description, due_date) VALUES (?, ?, ?, ?, ?)`)
    .run(e.clientKey || null, e.contactName || null, e.tipo || null, e.description || null, e.dueDate);
  return Number(info.lastInsertRowid);
}
export function listDeadlines(opts: { status?: string; client?: string } = {}): any[] {
  let sql = `SELECT * FROM bot_deadlines WHERE 1=1`; const a: any[] = [];
  if (opts.status) { sql += ` AND status = ?`; a.push(opts.status); }
  if (opts.client) { sql += ` AND client_key = ?`; a.push(opts.client); }
  sql += ` ORDER BY due_date ASC`;
  return db.prepare(sql).all(...a) as any[];
}
export function completeDeadline(id: number): boolean {
  return db.prepare(`UPDATE bot_deadlines SET status = 'completato', completed_at = datetime('now') WHERE id = ? AND status != 'completato'`).run(id).changes > 0;
}
export function deleteDeadline(id: number): boolean {
  return db.prepare(`DELETE FROM bot_deadlines WHERE id = ?`).run(id).changes > 0;
}

/** Adempimenti imminenti/scaduti (aperti) entro `withinDays`. */
export function getImminentDeadlines(todayISO: string, withinDays = 7): any[] {
  const rows = (db.prepare(`SELECT id, tipo, description, contact_name, due_date, status FROM bot_deadlines WHERE status = 'aperto'`).all() as any[])
    .map((r) => ({ id: r.id, tipo: r.tipo, description: r.description, who: r.contact_name, due_date: r.due_date, status: r.status } as DeadlineRow));
  return selectImminentDeadlines(rows, todayISO, withinDays);
}
