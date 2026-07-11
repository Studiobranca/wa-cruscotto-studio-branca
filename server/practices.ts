/*
 * practices.ts — Checklist documenti per pratica/cliente (rev. 11/07/2026).
 *
 * Traccia quali documenti servono per una pratica e cosa è già arrivato. La RICHIESTA
 * al cliente dei documenti mancanti è SEMPRE una BOZZA da approvare (mai auto-inviata):
 * l'invio parte solo dall'approvazione umana nel Cruscotto. Invariante rispettato.
 */
import db from './db.js';
import { missingDocs, checklistProgress, composeDocRequest, type DocRow } from './practices_logic.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS doc_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key TEXT NOT NULL,        -- telefono o email:<addr>
    contact_name TEXT,
    pratica TEXT NOT NULL,
    doc_name TEXT NOT NULL,
    status TEXT DEFAULT 'richiesto', -- richiesto | ricevuto
    fascicolo TEXT,                  -- riferimento/percorso fascicolo (opzionale)
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    received_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_doc_checklist_client ON doc_checklist(client_key, pratica);
`);

/** Crea una checklist (una riga per documento). Ritorna gli id creati. */
export function createChecklist(clientKey: string, pratica: string, docs: string[], opts: { contactName?: string; fascicolo?: string } = {}): number[] {
  const ins = db.prepare(`INSERT INTO doc_checklist (client_key, contact_name, pratica, doc_name, fascicolo) VALUES (?, ?, ?, ?, ?)`);
  const ids: number[] = [];
  for (const d of docs) {
    const name = String(d || '').trim();
    if (!name) continue;
    ids.push(Number(ins.run(clientKey, opts.contactName || null, pratica, name, opts.fascicolo || null).lastInsertRowid));
  }
  return ids;
}

export function getChecklist(clientKey?: string, pratica?: string): DocRow[] {
  let sql = `SELECT * FROM doc_checklist WHERE 1=1`;
  const args: any[] = [];
  if (clientKey) { sql += ` AND client_key = ?`; args.push(clientKey); }
  if (pratica) { sql += ` AND pratica = ?`; args.push(pratica); }
  sql += ` ORDER BY pratica, id`;
  return db.prepare(sql).all(...args) as any[];
}

/** Stato raggruppato per pratica con avanzamento. */
export function getChecklistGrouped(clientKey: string): any[] {
  const rows = getChecklist(clientKey) as any[];
  const byPratica: Record<string, any[]> = {};
  for (const r of rows) (byPratica[r.pratica] = byPratica[r.pratica] || []).push(r);
  return Object.entries(byPratica).map(([pratica, docs]) => ({ pratica, docs, progress: checklistProgress(docs) }));
}

export function markDocReceived(id: number): boolean {
  const info = db.prepare(`UPDATE doc_checklist SET status = 'ricevuto', received_at = datetime('now') WHERE id = ? AND status != 'ricevuto'`).run(id);
  return info.changes > 0;
}

/** Costruisce il testo (BOZZA) di richiesta documenti mancanti per una pratica. */
export function buildDocRequestText(clientKey: string, pratica: string): { text: string; missing: string[]; contactName: string | null } {
  const rows = getChecklist(clientKey, pratica) as any[];
  const miss = missingDocs(rows);
  const contactName = rows[0]?.contact_name || null;
  return { text: composeDocRequest(pratica, miss.map((m) => m.doc_name), contactName), missing: miss.map((m) => m.doc_name), contactName };
}
