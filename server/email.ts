/**
 * Posta in arrivo — Studio Tributario Branca
 *
 * Legge via IMAP le caselle dello studio (Tiscali + iCloud), classifica i messaggi
 * (lavoro / altro / automatica) e li archivia in `incoming_emails`. Per le email
 * di LAVORO recenti si comporta come il cruscotto WhatsApp: genera una risposta col
 * chatbot e — se riguarda APPUNTAMENTI o DOCUMENTAZIONE — la invia in automatico via
 * SMTP (incrociando l'agenda Google). Le altre email restano per lo smistamento.
 *
 * SALVAGUARDIE:
 *  - SOLA LETTURA in ingresso (non cancella/sposta nulla sul server).
 *  - Auto-risposta SOLO a email recenti (< EMAIL_REPLY_MAX_AGE_MIN, default 120 min) →
 *    al primo giro NON risponde al pregresso già in inbox.
 *  - Auto-risposta SOLO categoria 'lavoro' e SOLO per appuntamenti/documenti; mai a
 *    mittenti automatici/noreply; mai alle urgenze (need_human) → quelle si smistano.
 *  - Tutto isolato: si attiva solo con le credenziali via env; un errore qui non tocca il bot.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db } from './db.js';
import { generateReplyCore, materializeProposedEvent, getControlNumber } from './chatbot.js';
import { sendTextMessage } from './zapi.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS incoming_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    uid INTEGER,
    message_id TEXT,
    from_addr TEXT,
    from_name TEXT,
    subject TEXT,
    snippet TEXT,
    email_date TEXT,
    category TEXT,            -- lavoro | altro | automatica
    matched_client TEXT,
    seen INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0,
    reply_text TEXT,
    reply_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_emails_uid ON incoming_emails(account, uid);
  CREATE INDEX IF NOT EXISTS idx_incoming_emails_cat ON incoming_emails(category, email_date);

  -- Whitelist clienti: indirizzi o domini noti come CLIENTI dello studio. Un mittente
  -- in whitelist è SEMPRE 'lavoro' (cliente), a prescindere dalle parole chiave.
  CREATE TABLE IF NOT EXISTS email_clients (
    value TEXT PRIMARY KEY,   -- indirizzo completo (mario@x.it) o dominio (@studioX.it)
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Blacklist "non cliente": mittenti che lo studio ha marcato esplicitamente da
  -- IGNORARE come posta (mai 'lavoro', mai notifica, mai risposta automatica),
  -- anche se il testo contiene parole chiave di lavoro.
  CREATE TABLE IF NOT EXISTS email_ignored (
    value TEXT PRIMARY KEY,   -- indirizzo completo o dominio (@dominio.it)
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
// Migrazione idempotente: aggiunge le colonne reply su DB già esistenti (v2.9.6).
for (const col of ['replied INTEGER DEFAULT 0', 'reply_text TEXT', 'reply_at TEXT']) {
  try { db.exec(`ALTER TABLE incoming_emails ADD COLUMN ${col}`); } catch { /* già presente */ }
}

interface MailAccount {
  name: string; host: string; port: number; user: string; pass: string;
  smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpCiphers?: string;
}

function accounts(): MailAccount[] {
  const out: MailAccount[] = [];
  if (process.env.EMAIL_TISCALI_PASS) {
    out.push({
      name: 'tiscali',
      host: process.env.EMAIL_TISCALI_HOST || 'imap.tiscali.it',
      port: parseInt(process.env.EMAIL_TISCALI_PORT || '993', 10),
      user: process.env.EMAIL_TISCALI_USER || 'studiobranca@tiscali.it',
      pass: process.env.EMAIL_TISCALI_PASS,
      smtpHost: process.env.EMAIL_TISCALI_SMTP_HOST || 'smtp.tiscali.it',
      smtpPort: parseInt(process.env.EMAIL_TISCALI_SMTP_PORT || '465', 10),
      smtpSecure: (process.env.EMAIL_TISCALI_SMTP_SECURE || '1') === '1',
      // Tiscali usa parametri DH datati che l'OpenSSL moderno rifiuta ("dh key too small"):
      // si abbassa il security level dei cifrari per quella sola connessione SMTP.
      smtpCiphers: process.env.EMAIL_TISCALI_SMTP_CIPHERS || 'DEFAULT@SECLEVEL=1',
    });
  }
  if (process.env.EMAIL_ICLOUD_PASS) {
    out.push({
      name: 'icloud',
      host: process.env.EMAIL_ICLOUD_HOST || 'imap.mail.me.com',
      port: parseInt(process.env.EMAIL_ICLOUD_PORT || '993', 10),
      user: process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com',
      pass: process.env.EMAIL_ICLOUD_PASS,
      smtpHost: process.env.EMAIL_ICLOUD_SMTP_HOST || 'smtp.mail.me.com',
      smtpPort: parseInt(process.env.EMAIL_ICLOUD_SMTP_PORT || '587', 10),
      smtpSecure: (process.env.EMAIL_ICLOUD_SMTP_SECURE || '0') === '1', // 587 = STARTTLS
      smtpCiphers: process.env.EMAIL_ICLOUD_SMTP_CIPHERS, // default OK per iCloud
    });
  }
  return out;
}

function ownAddresses(): Set<string> {
  return new Set(accounts().map((a) => a.user.toLowerCase()));
}

function autoReplyEnabled(): boolean {
  return process.env.EMAIL_AUTO_REPLY !== '0'; // default ON
}
function replyMaxAgeMin(): number {
  return parseInt(process.env.EMAIL_REPLY_MAX_AGE_MIN || '120', 10);
}
// Notifica al numero di controllo per le email di clienti recenti (anti-spam sul
// pregresso: al primo giro non avvisa per la posta vecchia già in inbox).
function notifyMaxAgeMin(): number {
  return parseInt(process.env.EMAIL_NOTIFY_MAX_AGE_MIN || '180', 10);
}

const WORK_KW = [
  '730', 'dichiarazione', 'iva', 'irpef', 'ires', 'irap', 'unico', 'scadenza', 'fattura',
  'detra', 'bonus', 'f24', 'f23', 'agenzia entrate', 'cartella', 'accertamento', 'ricorso',
  'udienza', 'tributari', 'inps', 'inail', 'contribut', 'imu', 'tari', 'rateizzazione',
  'adesione', 'notifica', 'contenzioso', 'bilancio', 'redditi', 'rimborso', 'cassetto fiscale',
  'cgt', 'corte di giustizia tributaria', 'precetto', 'decreto ingiuntivo', 'mutuo', 'pec',
  'busta paga', 'cedolino', 'durc', 'certificazione unica', 'ravvedimento', 'appuntamento',
  'documenti', 'documentazione', 'consulenza',
];

// Mittente automatico/commerciale/bulk → MAI un cliente (anche se l'oggetto contiene
// parole come "fattura"/"ordine": le email commerciali le usano di continuo).
function isAutomatedSender(fromAddr: string): boolean {
  const f = (fromAddr || '').toLowerCase();
  const local = f.split('@')[0] || '';
  const domain = f.split('@')[1] || '';
  const AUTO_LOCAL = /^(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply|newsletter|mailing|mailer|notif|notifiche?|notification|marketing|promo|promozioni|news|alert|alerts|automated|bounce|postmaster|daemon|no-?responder|account|accounts|billing|support|hello|team|nepa)$/;
  const AUTO_DOMAIN = /(^|\.)(email|mail|mailer|news|em|e|sendgrid|mailchimp|mandrillapp|amazonses|sendinblue|brevo|mailjet|sparkpostmail|cmail|rsys|exct|sailthru|hubspotemail|mktomail)\./;
  return AUTO_LOCAL.test(local) || AUTO_DOMAIN.test(domain);
}

// ─── Whitelist clienti ────────────────────────────────────────────────────────
export function listClients(): { value: string; name: string | null; created_at: string }[] {
  try { return db.prepare(`SELECT value, name, created_at FROM email_clients ORDER BY value`).all() as any[]; }
  catch { return []; }
}
export function addClient(value: string, name?: string): void {
  const v = (value || '').trim().toLowerCase();
  if (!v) return;
  db.prepare(`INSERT INTO email_clients (value, name) VALUES (?, ?) ON CONFLICT(value) DO UPDATE SET name = COALESCE(excluded.name, email_clients.name)`).run(v, name || null);
}
export function removeClient(value: string): void {
  db.prepare(`DELETE FROM email_clients WHERE value = ?`).run((value || '').trim().toLowerCase());
}
/** Il mittente è un cliente noto? Match per indirizzo completo o per dominio. */
function whitelistedClient(fromAddr: string): { match: boolean; name: string | null } {
  const f = (fromAddr || '').toLowerCase();
  if (!f) return { match: false, name: null };
  const domain = '@' + (f.split('@')[1] || '');
  try {
    const row = db.prepare(`SELECT name FROM email_clients WHERE value = ? OR value = ? LIMIT 1`).get(f, domain) as any;
    return { match: !!row, name: row?.name ?? null };
  } catch { return { match: false, name: null }; }
}

// ─── Blacklist "non cliente" ──────────────────────────────────────────────────
export function listIgnored(): { value: string; name: string | null; created_at: string }[] {
  try { return db.prepare(`SELECT value, name, created_at FROM email_ignored ORDER BY value`).all() as any[]; }
  catch { return []; }
}
export function addIgnored(value: string, name?: string): void {
  const v = (value || '').trim().toLowerCase();
  if (!v) return;
  db.prepare(`INSERT INTO email_ignored (value, name) VALUES (?, ?) ON CONFLICT(value) DO UPDATE SET name = COALESCE(excluded.name, email_ignored.name)`).run(v, name || null);
}
export function removeIgnored(value: string): void {
  db.prepare(`DELETE FROM email_ignored WHERE value = ?`).run((value || '').trim().toLowerCase());
}
/** Il mittente è stato marcato esplicitamente come NON cliente? Match indirizzo o dominio. */
function ignoredSender(fromAddr: string): boolean {
  const f = (fromAddr || '').toLowerCase();
  if (!f) return false;
  const domain = '@' + (f.split('@')[1] || '');
  try {
    return !!db.prepare(`SELECT 1 FROM email_ignored WHERE value = ? OR value = ? LIMIT 1`).get(f, domain);
  } catch { return false; }
}

function classify(subject: string, fromAddr: string, body: string): string {
  if (whitelistedClient(fromAddr).match) return 'lavoro';   // cliente noto → sempre lavoro
  if (ignoredSender(fromAddr)) return 'ignorata';           // marcato esplicitamente non-cliente
  if (isAutomatedSender(fromAddr)) return 'automatica';
  const hay = `${subject} ${body}`.toLowerCase();
  if (WORK_KW.some((k) => hay.includes(k))) return 'lavoro';
  return 'altro';
}

// Stessa email arrivata su entrambe le caselle (Tiscali + iCloud): evita doppia
// notifica/risposta. true se esiste già una riga PRECEDENTE con lo stesso message_id.
function isDuplicateMessage(messageId: string | null, currentId: number): boolean {
  if (!messageId) return false;
  try {
    const row = db.prepare(`SELECT 1 FROM incoming_emails WHERE message_id = ? AND id < ? LIMIT 1`).get(messageId, currentId);
    return !!row;
  } catch { return false; }
}

function matchClient(fromName: string): string | null {
  const n = (fromName || '').trim();
  if (n.length < 4) return null;
  try {
    const row = db.prepare(
      `SELECT contact_name FROM conversations WHERE contact_name IS NOT NULL AND contact_name LIKE ? LIMIT 1`,
    ).get(`%${n}%`) as any;
    return row?.contact_name || null;
  } catch { return null; }
}

const SIGN = '\n\n—\nStudio Tributario Branca — Dott. Mariano Branca\nVia Operai 102, 98051 Barcellona P.G. (ME) · Segreteria 0909797187\n(Risposta automatica dell’assistente; le risposte di merito sono riviste dal Dott. Branca.)';

function transporterFor(acc: MailAccount) {
  return nodemailer.createTransport({
    host: acc.smtpHost, port: acc.smtpPort, secure: acc.smtpSecure,
    auth: { user: acc.user, pass: acc.pass },
    requireTLS: !acc.smtpSecure,
    ...(acc.smtpCiphers ? { tls: { ciphers: acc.smtpCiphers } } : {}),
  });
}

async function sendReply(acc: MailAccount, to: string, subject: string, body: string, inReplyTo?: string): Promise<void> {
  const t = transporterFor(acc);
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  await t.sendMail({
    from: `"Studio Tributario Branca" <${acc.user}>`,
    to,
    subject: subj,
    text: `${body}${SIGN}`,
    inReplyTo: inReplyTo || undefined,
    references: inReplyTo || undefined,
  });
}

/** Genera e (se appuntamento/documenti) INVIA la risposta automatica a una email di lavoro.
 *  Ritorna una breve etichetta dell'azione svolta ('appuntamento'|'documenti') o null. */
async function maybeAutoReply(acc: MailAccount, row: {
  id: number; from_addr: string; from_name: string; subject: string; body: string;
  category: string; email_date: string; message_id: string | null;
}): Promise<string | null> {
  if (!autoReplyEnabled()) return null;
  if (row.category !== 'lavoro') return null;
  if (isDuplicateMessage(row.message_id, row.id)) return null;    // stessa email sull'altra casella
  const fromAddr = (row.from_addr || '').toLowerCase();
  if (!fromAddr || ownAddresses().has(fromAddr)) return null;     // mai a noi stessi
  if (isAutomatedSender(fromAddr)) return null;                   // mai a mittenti automatici
  // SOLO email recenti → niente risposte al pregresso in inbox al primo giro.
  const ageMin = (Date.now() - Date.parse(row.email_date)) / 60000;
  if (!(ageMin >= 0) || ageMin > replyMaxAgeMin()) return null;

  const key = `email:${fromAddr}`;
  const content = `Email dal cliente ${row.from_name || fromAddr} <${fromAddr}>\nOggetto: ${row.subject}\n\n${row.body}`;
  let outcome: any = null;
  try {
    outcome = await generateReplyCore(key, row.from_name || fromAddr, content, 'email');
  } catch (e: any) {
    console.error('[Email] generazione risposta fallita:', e.message);
    return null;
  }
  if (!outcome || outcome.kind !== 'work' || !outcome.result) return null;
  const res = outcome.result;
  if (res.needsHuman) return null;                                // urgenze → smistamento, non auto
  const isAppt = !!res.appointmentFlow || !!res.proposedEvent;
  const isDoc = !!res.docNoted;
  if (!isAppt && !isDoc) return null;                             // merito generico → smistamento
  if (!res.draftText) return null;

  try {
    if (res.proposedEvent) {
      await materializeProposedEvent(key, row.from_name || fromAddr, res.proposedEvent, 'email');
    }
    await sendReply(acc, fromAddr, row.subject, res.draftText, row.message_id || undefined);
    db.prepare(`UPDATE incoming_emails SET replied = 1, reply_text = ?, reply_at = datetime('now') WHERE id = ?`)
      .run(res.draftText, row.id);
    const label = isAppt ? 'appuntamento' : 'documenti';
    console.log(`[Email] Risposta automatica (${label}) inviata a ${fromAddr}.`);
    return label;
  } catch (e: any) {
    console.error('[Email] invio risposta fallito:', e.message);
    return null;
  }
}

/** Avvisa il numero di controllo (Cruscotto) dell'arrivo di una email di un cliente.
 *  Solo email di LAVORO o da contatti noti, e solo RECENTI (anti-spam sul pregresso). */
async function notifyControlNewEmail(row: {
  id: number; message_id: string | null; account: string; from_addr: string; from_name: string;
  subject: string; snippet: string; category: string; matched_client: string | null; email_date: string;
}, autoReplied: string | null): Promise<void> {
  if (isAutomatedSender(row.from_addr)) return;                   // mai avvisi per mittenti automatici
  const isClient = row.category === 'lavoro' || !!row.matched_client;
  if (!isClient) return;
  if (isDuplicateMessage(row.message_id, row.id)) return;         // stessa email sull'altra casella
  const ageMin = (Date.now() - Date.parse(row.email_date)) / 60000;
  if (!(ageMin >= 0) || ageMin > notifyMaxAgeMin()) return;       // niente avvisi sul pregresso
  const control = getControlNumber();
  if (!control) return;
  const who = row.matched_client ? `${row.from_name} [cliente: ${row.matched_client}]` : row.from_name;
  const parts = [
    `📧 Nuova email cliente (${row.account})`,
    `Da: ${who} <${row.from_addr}>`,
    `Oggetto: ${row.subject}`,
  ];
  if (row.snippet) parts.push(`\n"${row.snippet.slice(0, 200)}"`);
  parts.push(autoReplied
    ? `\n✅ Risposta automatica inviata (${autoReplied}).`
    : `\nℹ️ In attesa di gestione (apri il Cruscotto › Email).`);
  try { await sendTextMessage(control, parts.join('\n')); }
  catch (e: any) { console.error('[Email] notifica controllo fallita:', e.message); }
}

async function pollAccount(acc: MailAccount): Promise<number> {
  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: true,
    auth: { user: acc.user, pass: acc.pass }, logger: false,
  });
  let stored = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (!total) return 0;
      const from = Math.max(1, total - 40);
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true })) {
        try {
          const exists = db.prepare(`SELECT 1 FROM incoming_emails WHERE account = ? AND uid = ?`).get(acc.name, msg.uid);
          if (exists) continue;
          const parsed = await simpleParser(msg.source as Buffer);
          const subject = parsed.subject || '(senza oggetto)';
          const fromVal = (parsed.from as any)?.value?.[0] || {};
          const fromAddr = fromVal.address || '';
          const fromName = fromVal.name || fromAddr;
          const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
          const snippet = text.slice(0, 240);
          const category = classify(subject, fromAddr, text);
          const matched = whitelistedClient(fromAddr).name || matchClient(fromName);
          const emailDate = (parsed.date || new Date()).toISOString();
          const info = db.prepare(`
            INSERT OR IGNORE INTO incoming_emails
              (account, uid, message_id, from_addr, from_name, subject, snippet, email_date, category, matched_client, seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(acc.name, msg.uid, parsed.messageId || null, fromAddr, fromName, subject, snippet, emailDate, category, matched);
          stored++;
          // Risposta automatica (appuntamenti/documenti) per le email di lavoro recenti.
          const replied = await maybeAutoReply(acc, {
            id: Number(info.lastInsertRowid), from_addr: fromAddr, from_name: fromName,
            subject, body: text.slice(0, 4000), category, email_date: emailDate,
            message_id: parsed.messageId || null,
          });
          // Avviso sul numero di controllo dell'arrivo di una email cliente.
          await notifyControlNewEmail({
            id: Number(info.lastInsertRowid), message_id: parsed.messageId || null,
            account: acc.name, from_addr: fromAddr, from_name: fromName, subject,
            snippet, category, matched_client: matched, email_date: emailDate,
          }, replied);
        } catch (e: any) {
          console.error(`[Email] parse ${acc.name}:`, e.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return stored;
}

let emailTimer: any = null;
let lastPoll: { at: string; ok: boolean; stored: number; error?: string } | null = null;

export function getEmailStatus() {
  return {
    configured: accounts().map((a) => ({ name: a.name, user: a.user })),
    autoReply: autoReplyEnabled(),
    replyMaxAgeMin: replyMaxAgeMin(),
    notifyMaxAgeMin: notifyMaxAgeMin(),
    controlNumber: getControlNumber(),
    lastPoll,
  };
}

export function getRecentEmails(limit = 100, category?: string): any[] {
  const lim = Math.min(Math.max(limit, 1), 500);
  if (category) {
    return db.prepare(`SELECT * FROM incoming_emails WHERE category = ? ORDER BY email_date DESC LIMIT ?`).all(category, lim) as any[];
  }
  return db.prepare(`SELECT * FROM incoming_emails ORDER BY email_date DESC LIMIT ?`).all(lim) as any[];
}

export function markEmailSeen(id: number): void {
  db.prepare(`UPDATE incoming_emails SET seen = 1 WHERE id = ?`).run(id);
}

/** Segna l'email (e il suo mittente) come CLIENTE: whitelist + riclassifica le sue email. */
export function markEmailAsClient(id: number): boolean {
  const row = db.prepare(`SELECT from_addr, from_name FROM incoming_emails WHERE id = ?`).get(id) as any;
  if (!row?.from_addr) return false;
  removeIgnored(row.from_addr);   // un eventuale "non cliente" precedente viene annullato
  addClient(row.from_addr, row.from_name || null);
  db.prepare(`UPDATE incoming_emails SET category = 'lavoro', matched_client = COALESCE(matched_client, ?) WHERE lower(from_addr) = lower(?)`)
    .run(row.from_name || null, row.from_addr);
  return true;
}

/** Segna l'email (e il suo mittente) come NON CLIENTE: blacklist + riclassifica le sue
 *  email come 'ignorata' (mai lavoro, mai notifica, mai risposta automatica). */
export function markEmailAsNotClient(id: number): boolean {
  const row = db.prepare(`SELECT from_addr, from_name FROM incoming_emails WHERE id = ?`).get(id) as any;
  if (!row?.from_addr) return false;
  removeClient(row.from_addr);    // un eventuale "cliente" precedente viene annullato
  addIgnored(row.from_addr, row.from_name || null);
  db.prepare(`UPDATE incoming_emails SET category = 'ignorata', matched_client = NULL WHERE lower(from_addr) = lower(?)`)
    .run(row.from_addr);
  return true;
}

async function pollAll(): Promise<void> {
  const accs = accounts();
  if (!accs.length) return;
  let stored = 0;
  let lastError: string | undefined;
  for (const acc of accs) {
    try { stored += await pollAccount(acc); }
    catch (e: any) { lastError = `${acc.name}: ${e.message}`; console.error(`[Email] poll ${acc.name} fallito:`, e.message); }
  }
  lastPoll = { at: new Date().toISOString(), ok: !lastError, stored, error: lastError };
  if (stored) console.log(`[Email] ${stored} nuove email archiviate.`);
}

export function startEmailPoller(intervalMs = 5 * 60 * 1000): void {
  const accs = accounts();
  if (!accs.length) {
    console.log('[Email] Nessuna casella configurata (EMAIL_TISCALI_PASS / EMAIL_ICLOUD_PASS assenti): poller NON avviato.');
    return;
  }
  console.log(`[Email] Poller avviato per: ${accs.map((a) => a.name).join(', ')} (ogni ${Math.round(intervalMs / 60000)} min, sola lettura; auto-risposta=${autoReplyEnabled() ? 'ON' : 'OFF'}).`);
  pollAll().catch((e) => console.error('[Email] primo poll:', e.message));
  if (emailTimer) clearInterval(emailTimer);
  emailTimer = setInterval(() => { pollAll().catch((e) => console.error('[Email] poll:', e.message)); }, intervalMs);
}
