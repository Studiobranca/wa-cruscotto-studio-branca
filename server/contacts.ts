/**
 * Rubrica unificata — Studio Tributario Branca
 *
 * Un contatto email (indirizzo o dominio) può essere marcato come CLIENTE,
 * FORNITORE o IGNORATO (pubblicità/estranei): la classificazione delle email
 * in arrivo (email.ts) usa questa rubrica come fonte di verità, prima di
 * ricadere sulle euristiche (mittenti automatici, parole chiave).
 *
 * RAFFRONTO CON WHATSAPP: quando un contatto viene marcato cliente/fornitore,
 * si cerca in automatico una corrispondenza per nome tra le conversazioni
 * WhatsApp già attive, così la rubrica collega lo stesso cliente sui due
 * canali (telefono trovato in automatico, comunque editabile a mano).
 *
 * SCHEDA CONTATTO (uso interno studio): getContactProfile() aggrega, per un
 * contatto, gli appuntamenti (bot_appointments), le note documenti
 * (bot_doc_notes), la cronologia email (incoming_emails) e la cronologia
 * WhatsApp (conversations/live_messages) — sia sulla chiave email
 * ("email:indirizzo") sia sul telefono collegato.
 */
import { db } from './db.js';

export type ContactType = 'cliente' | 'fornitore' | 'ignorato';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    value TEXT UNIQUE NOT NULL,   -- indirizzo completo (mario@x.it) o dominio (@studioX.it)
    name TEXT,
    type TEXT NOT NULL DEFAULT 'cliente',  -- cliente | fornitore | ignorato
    phone TEXT,                    -- numero WhatsApp collegato (auto o manuale), opzionale
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_contacts_type ON email_contacts(type);
`);

// Migrazione idempotente dalle vecchie tabelle whitelist/blacklist (se presenti e
// con righe): non tocca nulla se email_contacts ha già dati o se le vecchie
// tabelle non esistono/sono vuote.
try {
  const already = db.prepare(`SELECT COUNT(*) as c FROM email_contacts`).get() as { c: number };
  if (already.c === 0) {
    try {
      const oldClients = db.prepare(`SELECT value, name FROM email_clients`).all() as any[];
      for (const r of oldClients) {
        db.prepare(`INSERT OR IGNORE INTO email_contacts (value, name, type) VALUES (?, ?, 'cliente')`).run(r.value, r.name || null);
      }
    } catch { /* tabella non esistente */ }
    try {
      const oldIgnored = db.prepare(`SELECT value, name FROM email_ignored`).all() as any[];
      for (const r of oldIgnored) {
        db.prepare(`INSERT OR IGNORE INTO email_contacts (value, name, type) VALUES (?, ?, 'ignorato')`).run(r.value, r.name || null);
      }
    } catch { /* tabella non esistente */ }
  }
} catch (e: any) { console.error('[Contatti] migrazione whitelist/blacklist:', e.message); }

export function listContacts(type?: ContactType): { value: string; name: string | null; type: ContactType; phone: string | null; created_at: string }[] {
  try {
    if (type) return db.prepare(`SELECT value, name, type, phone, created_at FROM email_contacts WHERE type = ? ORDER BY value`).all(type) as any[];
    return db.prepare(`SELECT value, name, type, phone, created_at FROM email_contacts ORDER BY type, value`).all() as any[];
  } catch { return []; }
}

/** Cerca in automatico, tra le conversazioni WhatsApp già attive, un contatto con
 *  nome corrispondente (stesso criterio già in uso per l'abbinamento email→cliente). */
export function autoMatchPhone(name: string | null | undefined): { phone: string; contact_name: string } | null {
  const n = (name || '').trim();
  if (n.length < 4) return null;
  try {
    const row = db.prepare(
      `SELECT phone, contact_name FROM conversations WHERE contact_name IS NOT NULL AND contact_name LIKE ? LIMIT 1`,
    ).get(`%${n}%`) as any;
    return row?.phone ? { phone: row.phone, contact_name: row.contact_name } : null;
  } catch { return null; }
}

/** Imposta il tipo (cliente/fornitore/ignorato) per un indirizzo/dominio: crea o
 *  aggiorna la riga, e se cliente/fornitore prova ad agganciare un numero WhatsApp
 *  già noto (raffronto per nome) quando non c'è ancora un telefono collegato. */
export function setContactType(value: string, name: string | null | undefined, type: ContactType): { value: string; matchedPhone: string | null } {
  const v = (value || '').trim().toLowerCase();
  if (!v) return { value: v, matchedPhone: null };
  const existing = db.prepare(`SELECT phone FROM email_contacts WHERE value = ?`).get(v) as any;
  let phone: string | null = existing?.phone ?? null;
  if (!phone && type !== 'ignorato') {
    const m = autoMatchPhone(name);
    if (m) phone = m.phone;
  }
  db.prepare(`
    INSERT INTO email_contacts (value, name, type, phone, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(value) DO UPDATE SET
      type = excluded.type,
      name = COALESCE(excluded.name, email_contacts.name),
      phone = COALESCE(email_contacts.phone, excluded.phone),
      updated_at = datetime('now')
  `).run(v, name || null, type, phone);
  return { value: v, matchedPhone: phone };
}

export function removeContact(value: string): void {
  db.prepare(`DELETE FROM email_contacts WHERE value = ?`).run((value || '').trim().toLowerCase());
}

export function setContactPhone(value: string, phone: string | null): void {
  db.prepare(`UPDATE email_contacts SET phone = ?, updated_at = datetime('now') WHERE value = ?`)
    .run(phone && phone.trim() ? phone.trim() : null, (value || '').trim().toLowerCase());
}

/** Il mittente ha un tipo noto in rubrica? Match per indirizzo completo o per dominio. */
export function findContact(fromAddr: string): { value: string; name: string | null; type: ContactType; phone: string | null } | null {
  const f = (fromAddr || '').toLowerCase();
  if (!f) return null;
  const domain = '@' + (f.split('@')[1] || '');
  try {
    const row = db.prepare(`SELECT value, name, type, phone FROM email_contacts WHERE value = ? OR value = ? LIMIT 1`).get(f, domain) as any;
    return row || null;
  } catch { return null; }
}

/** Scheda contatto: aggrega appuntamenti, note documenti, cronologia email e WhatsApp. */
export function getContactProfile(value: string): any {
  const v = (value || '').trim().toLowerCase();
  const contact = db.prepare(`SELECT value, name, type, phone, created_at FROM email_contacts WHERE value = ?`).get(v) as any;
  if (!contact) return null;

  const emailKey = `email:${v}`;
  const keys = contact.phone ? [contact.phone, emailKey] : [emailKey];
  const placeholders = keys.map(() => '?').join(',');

  const appointments = db.prepare(
    `SELECT date, start, end, reason, status, created_at FROM bot_appointments WHERE phone IN (${placeholders}) ORDER BY date DESC, start DESC LIMIT 20`,
  ).all(...keys) as any[];

  const docNotes = db.prepare(
    `SELECT summary, created_at FROM bot_doc_notes WHERE phone IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`,
  ).all(...keys) as any[];

  const emailHistory = v.startsWith('@')
    ? db.prepare(`SELECT subject, snippet, email_date, category FROM incoming_emails WHERE lower(from_addr) LIKE ? ORDER BY email_date DESC LIMIT 20`).all(`%${v}`) as any[]
    : db.prepare(`SELECT subject, snippet, email_date, category FROM incoming_emails WHERE lower(from_addr) = ? ORDER BY email_date DESC LIMIT 20`).all(v) as any[];

  let whatsapp: any = null;
  if (contact.phone) {
    const conv = db.prepare(`SELECT phone, contact_name, last_message, last_message_at, total_received, total_sent FROM conversations WHERE phone = ?`).get(contact.phone) as any;
    if (conv) whatsapp = conv;
  }

  return { contact, appointments, docNotes, emailHistory, whatsapp };
}
