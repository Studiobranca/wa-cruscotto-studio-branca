/**
 * Posta in arrivo — Studio Tributario Branca
 *
 * Legge via IMAP le caselle dello studio (Tiscali + iCloud), classifica i messaggi
 * (lavoro / altro / automatica) e li archivia in `incoming_emails` per la
 * visualizzazione/smistamento nel Cruscotto. SOLA LETTURA: non invia, non cancella,
 * non sposta nulla sul server di posta.
 *
 * ISOLAMENTO: il modulo si attiva SOLO se sono presenti le password via env
 * (EMAIL_TISCALI_PASS / EMAIL_ICLOUD_PASS). Avvio e poll sono tutti protetti: un
 * errore qui NON deve mai impattare il bot WhatsApp.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from './db.js';

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
    matched_client TEXT,     -- nome contatto noto, se riconosciuto
    seen INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_emails_uid ON incoming_emails(account, uid);
  CREATE INDEX IF NOT EXISTS idx_incoming_emails_cat ON incoming_emails(category, email_date);
`);

interface MailAccount { name: string; host: string; port: number; user: string; pass: string; }

function accounts(): MailAccount[] {
  const out: MailAccount[] = [];
  if (process.env.EMAIL_TISCALI_PASS) {
    out.push({
      name: 'tiscali',
      host: process.env.EMAIL_TISCALI_HOST || 'imap.tiscali.it',
      port: parseInt(process.env.EMAIL_TISCALI_PORT || '993', 10),
      user: process.env.EMAIL_TISCALI_USER || 'studiobranca@tiscali.it',
      pass: process.env.EMAIL_TISCALI_PASS,
    });
  }
  if (process.env.EMAIL_ICLOUD_PASS) {
    out.push({
      name: 'icloud',
      host: process.env.EMAIL_ICLOUD_HOST || 'imap.mail.me.com',
      port: parseInt(process.env.EMAIL_ICLOUD_PORT || '993', 10),
      user: process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com',
      pass: process.env.EMAIL_ICLOUD_PASS,
    });
  }
  return out;
}

// Parole-chiave "lavoro di studio" (fiscale/tributario/lavoro/contenzioso).
const WORK_KW = [
  '730', 'dichiarazione', 'iva', 'irpef', 'ires', 'irap', 'unico', 'scadenza', 'fattura',
  'detra', 'bonus', 'f24', 'f23', 'agenzia entrate', 'cartella', 'accertamento', 'ricorso',
  'udienza', 'tributari', 'inps', 'inail', 'contribut', 'imu', 'tari', 'rateizzazione',
  'adesione', 'notifica', 'contenzioso', 'bilancio', 'redditi', 'rimborso', 'cassetto fiscale',
  'cgt', 'corte di giustizia tributaria', 'precetto', 'decreto ingiuntivo', 'mutuo', 'pec',
  'busta paga', 'cedolino', 'durc', 'cu ', 'certificazione unica', 'spese', 'ravvedimento',
];

function classify(subject: string, fromAddr: string, body: string): string {
  const hay = `${subject} ${body}`.toLowerCase();
  if (WORK_KW.some((k) => hay.includes(k))) return 'lavoro';
  const f = (fromAddr || '').toLowerCase();
  if (/no[-_.]?reply|newsletter|mailing|mailchimp|sendgrid|notifiche?@|marketing|info@|do[-_.]?not[-_.]?reply/.test(f)) {
    return 'automatica';
  }
  return 'altro';
}

// Best-effort: il mittente corrisponde a un contatto WhatsApp noto? (per nome)
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

async function pollAccount(acc: MailAccount): Promise<number> {
  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: true,
    auth: { user: acc.user, pass: acc.pass },
    logger: false,
  });
  let stored = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (!total) return 0;
      const from = Math.max(1, total - 40); // ultimi ~40 messaggi
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
          const matched = matchClient(fromName);
          const emailDate = (parsed.date || new Date()).toISOString();
          db.prepare(`
            INSERT OR IGNORE INTO incoming_emails
              (account, uid, message_id, from_addr, from_name, subject, snippet, email_date, category, matched_client, seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(acc.name, msg.uid, parsed.messageId || null, fromAddr, fromName, subject, snippet, emailDate, category, matched);
          stored++;
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
  return { configured: accounts().map((a) => ({ name: a.name, user: a.user })), lastPoll };
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

async function pollAll(): Promise<void> {
  const accs = accounts();
  if (!accs.length) return;
  let stored = 0;
  let lastError: string | undefined;
  for (const acc of accs) {
    try {
      stored += await pollAccount(acc);
    } catch (e: any) {
      lastError = `${acc.name}: ${e.message}`;
      console.error(`[Email] poll ${acc.name} fallito:`, e.message);
    }
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
  console.log(`[Email] Poller avviato per: ${accs.map((a) => a.name).join(', ')} (ogni ${Math.round(intervalMs / 60000)} min, sola lettura).`);
  pollAll().catch((e) => console.error('[Email] primo poll:', e.message));
  if (emailTimer) clearInterval(emailTimer);
  emailTimer = setInterval(() => { pollAll().catch((e) => console.error('[Email] poll:', e.message)); }, intervalMs);
}
