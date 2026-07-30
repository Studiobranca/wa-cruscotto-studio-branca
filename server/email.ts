/**
 * Posta in arrivo — Studio Tributario Branca
 *
 * Legge via IMAP le caselle dello studio (Tiscali + iCloud), classifica i messaggi
 * (lavoro / fornitore / altro / automatica / ignorata — vedi rubrica in contacts.ts)
 * e li archivia in `incoming_emails`. Per le email di LAVORO recenti si comporta
 * come il cruscotto WhatsApp: genera una risposta col chatbot e — se riguarda
 * APPUNTAMENTI o DOCUMENTAZIONE — la invia in automatico via SMTP (incrociando
 * l'agenda Google). Le altre email restano per lo smistamento.
 *
 * SALVAGUARDIE:
 *  - SOLA LETTURA in ingresso (non cancella/sposta nulla sul server).
 *  - Auto-risposta SOLO a email recenti (< EMAIL_REPLY_MAX_AGE_MIN, default 120 min) →
 *    al primo giro NON risponde al pregresso già in inbox.
 *  - Auto-risposta SOLO se il mittente è marcato ESPLICITAMENTE "È cliente" in rubrica
 *    (pulsante nel Cruscotto → contacts.ts): la categoria 'lavoro' da sola NON basta (può
 *    derivare da una parola chiave anche per un mittente mai confermato come cliente).
 *    MAI a mittenti automatici/noreply; MAI alle urgenze (need_human) → quelle restano
 *    senza risposta automatica e generano un alert email dedicato a Mariano (rev. 01/07/2026:
 *    prima solo appuntamenti/documenti auto-rispondevano, ora ogni risposta di merito non
 *    urgente di un cliente confermato parte da sola — stessa logica già attiva su WhatsApp,
 *    "allarga la maglia, valuta solo le criticità").
 *  - Tutto isolato: si attiva solo con le credenziali via env; un errore qui non tocca il bot.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db } from './db.js';
import { generateReplyCore, materializeProposedEvent, getControlNumber, sendStudioAlertEmail, sanitizeReply, isAutoAppointmentsEnabled } from './chatbot.js';
import { sendTextMessage } from './zapi.js';
import * as contacts from './contacts.js';
import { decideWorkAutoSend } from './autosend.js';
import { dateCoherenceIssue } from './date_guard.js';
import { saveEmailDraft, recordEmailSend, getEmailDraft, markEmailDraftSent, markEmailDraftRejected } from './emaildrafts.js';

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
    category TEXT,            -- lavoro | fornitore | altro | automatica | ignorata
    matched_client TEXT,
    seen INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0,
    reply_text TEXT,
    reply_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_emails_uid ON incoming_emails(account, uid);
  CREATE INDEX IF NOT EXISTS idx_incoming_emails_cat ON incoming_emails(category, email_date);
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

function classify(subject: string, fromAddr: string, body: string): string {
  // La rubrica (contacts.ts) è la fonte di verità: un contatto marcato esplicitamente
  // vince sempre sulle euristiche, anche se il testo contiene parole chiave di lavoro.
  const known = contacts.findContact(fromAddr);
  if (known) {
    if (known.type === 'cliente') return 'lavoro';
    if (known.type === 'fornitore') return 'fornitore';
    if (known.type === 'ignorato') return 'ignorata';
    if (known.type === 'cgt') return 'commissione_tributaria';
  }
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

/** Email "di servizio" a un cliente (promemoria appuntamento, richiamo lista d'attesa —
 *  reminders.ts): usa la prima casella configurata; NON è la risposta a un thread.
 *  Ritorna false (senza sollevare) se nessuna casella è configurata o l'invio fallisce. */
export async function sendStudioEmail(to: string, subject: string, body: string): Promise<boolean> {
  const acc = accounts()[0];
  if (!acc || !to) return false;
  try {
    const t = transporterFor(acc);
    await t.sendMail({
      from: `"Studio Tributario Branca" <${acc.user}>`,
      to, subject, text: `${body}${SIGN}`,
    });
    return true;
  } catch (e: any) {
    console.error('[Email] invio di servizio fallito:', e.message);
    return false;
  }
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

/** Invia a Mariano un alert email dedicato per un'urgenza (need_human) arrivata via posta:
 *  stesso principio del need_human WhatsApp (notifyUrgentByEmail), canale distinto e
 *  affidabile, per non confonderla con il generico "email cliente in attesa di gestione". */
async function notifyUrgentEmail(row: { from_addr: string; from_name: string; subject: string; body: string }, reason?: string): Promise<void> {
  const esc = (s: any) => String(s ?? '').replace(/[<>&]/g, (c) => (({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]));
  const subject = `🔴 URGENTE — email cliente — ${row.from_name || row.from_addr}`;
  const html = `
    <h2 style="color:#b00020;margin:0 0 8px">Richiesta urgente arrivata via EMAIL</h2>
    <p><b>Cliente:</b> ${esc(row.from_name || row.from_addr)} (${esc(row.from_addr)})</p>
    <p><b>Oggetto:</b> ${esc(row.subject)}</p>
    ${reason ? `<p><b>Motivo segnalato dal bot:</b> ${esc(reason)}</p>` : ''}
    <p style="white-space:pre-wrap">${esc((row.body || '').slice(0, 1000))}</p>
    <p>Nessuna risposta automatica è stata inviata: apri il Cruscotto (tab Email) o rispondi
    direttamente dalla tua casella di posta.</p>
  `;
  try { await sendStudioAlertEmail(subject, html); }
  catch (e: any) { console.error('[Email] alert urgenza fallito:', e.message); }
}

/** Genera e INVIA la risposta automatica a una email di lavoro non urgente (rev. 01/07/2026:
 *  ampliato da "solo appuntamenti/documenti" a QUALSIASI risposta di merito non urgente).
 *  Ritorna una breve etichetta dell'azione svolta o null. */
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
  // AUTORIZZAZIONE ESPLICITA (rev. 01/07/2026, pulsante "È cliente" nel Cruscotto): la
  // categoria 'lavoro' da sola NON basta per autorizzare l'invio automatico — può derivare
  // da una parola chiave anche per un mittente MAI confermato come cliente dallo studio.
  // Solo un contatto marcato esplicitamente 'cliente' in rubrica autorizza l'auto-risposta;
  // gli altri restano segnalati (categoria/notifica) ma senza invio automatico.
  const contact = contacts.findContact(fromAddr);
  if (!contact || contact.type !== 'cliente') return null;
  // VIP/high (regola inderogabile 08/07/2026): MAI risposte/gestione automatica, su nessun
  // canale — anche se il mittente è un cliente confermato. Doppio strato: generateReplyCore
  // ha lo stesso guard, ma qui si esce prima e resta l'avviso "in attesa" a Mariano.
  if (contacts.isVipContact(`email:${fromAddr}`)) {
    console.log(`[Email] Mittente VIP/high (${fromAddr}): nessuna auto-risposta, gestisce Mariano.`);
    return null;
  }
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

  // ─── ALLINEAMENTO ALL'INVARIANTE (rev. 11/07/2026) ────────────────────────
  // Come su WhatsApp: MERITO e URGENZE via email NON partono più da sole → BOZZA da
  // approvare (coda email_drafts). In autonomia resta SOLO il flusso appuntamenti.
  const draftIt = (needsHuman: boolean, urgent: boolean, reason?: string): string => {
    const id = saveEmailDraft({
      account: acc.user, toAddr: fromAddr, toName: row.from_name, subject: row.subject,
      draftText: res.draftText || '', inReplyTo: row.message_id, proposedEvent: res.proposedEvent || null,
      needsHuman, incomingId: row.id,
    });
    if (urgent) { notifyUrgentEmail(row, reason || res.humanReason).catch(() => {}); }
    else { sendTextMessage(getControlNumber(), `✉️ Bozza email pronta per ${row.from_name || fromAddr} (oggetto: "${row.subject}"). Rivedila nel Cruscotto.`).catch(() => {}); }
    console.log(`[Email] Bozza email #${id} per ${fromAddr}${needsHuman ? ' [need_human]' : ''} — merito/urgenza NON auto-inviata.`);
    return 'bozza';
  };

  // URGENZA → mai auto-risposta: bozza needs_human + alert dedicato.
  if (res.needsHuman) return draftIt(true, true);
  if (!res.draftText) return null;

  // GUARDRAIL anti-leak: testo non isolabile in sicurezza → bozza + alert (mai grezzo).
  const san = sanitizeReply(res.draftText);
  if (!san.safe) {
    console.warn(`[Sanitizer] Email ${fromAddr}: testo non isolabile (rimossi=${san.removed.length}, tool=${san.residualTool}) → bozza.`);
    return draftIt(true, true, 'Guardrail anti-ragionamento: risposta email da rivedere a mano.');
  }
  if (san.changed) { res.draftText = san.clean; }

  // GUARDIA COERENZA DATA/TESTO (incidente 13/07): data nel testo incoerente con
  // l'appuntamento registrato/confermato → bozza, mai auto-invio col giorno sbagliato.
  for (const evd of [res.proposedEvent?.date, res.confirmedEvent?.date]) {
    const issue = evd ? dateCoherenceIssue(res.draftText, evd) : null;
    if (issue) {
      console.warn(`[DateGuard] Email ${fromAddr}: ${issue} → bozza.`);
      return draftIt(true, true, 'Guardia date: giorno/data nel testo incoerente con l\'appuntamento registrato.');
    }
  }

  // DECISIONE: in autonomia SOLO il flusso appuntamenti; ogni altra risposta (merito,
  // conferme documenti non-appuntamento) → BOZZA. Fail-safe verso la bozza.
  const decision = decideWorkAutoSend({
    appointmentFlow: !!res.appointmentFlow,
    needsHuman: false,
    autoApptEnabled: isAutoAppointmentsEnabled(),
    sanitizerDiverted: false,
  });
  if (decision !== 'appointment-auto') return draftIt(false, false);

  // APPUNTAMENTO in autonomia (agenda già incrociata) → invia + audit-log.
  try {
    if (res.proposedEvent) {
      await materializeProposedEvent(key, row.from_name || fromAddr, res.proposedEvent, 'email');
    }
    await sendReply(acc, fromAddr, row.subject, res.draftText, row.message_id || undefined);
    db.prepare(`UPDATE incoming_emails SET replied = 1, reply_text = ?, reply_at = datetime('now') WHERE id = ?`)
      .run(res.draftText, row.id);
    recordEmailSend({ toAddr: fromAddr, subject: row.subject, kind: 'appointment', draftId: null, text: res.draftText });
    console.log(`[Email] Appuntamento autonomo inviato a ${fromAddr}.`);
    return 'appuntamento';
  } catch (e: any) {
    console.error('[Email] invio appuntamento fallito:', e.message);
    return null;
  }
}

// ─── Approvazione/rifiuto BOZZE email (dal Cruscotto) ────────────────────────
// L'invio parte SOLO su approvazione umana (non è un auto-invio). Registra l'audit.
export async function approveEmailDraft(id: number, opts: { text?: string } = {}): Promise<{ ok: boolean; status: number; message?: string }> {
  const d = getEmailDraft(id);
  if (!d) return { ok: false, status: 404, message: 'Bozza non trovata' };
  if (d.status !== 'pending') return { ok: false, status: 400, message: 'Bozza già gestita' };
  const acc = accounts().find((a) => a.user === d.account) || accounts()[0];
  if (!acc) return { ok: false, status: 500, message: 'Nessun account email configurato' };
  const finalText = (opts.text && String(opts.text).trim()) || d.draft_text || '';
  try {
    if (d.proposed_event) {
      await materializeProposedEvent(`email:${d.to_addr}`, d.to_name || d.to_addr, d.proposed_event, 'email');
    }
    await sendReply(acc, d.to_addr, d.subject, finalText, d.in_reply_to || undefined);
    if (d.incoming_id) { try { db.prepare(`UPDATE incoming_emails SET replied = 1, reply_text = ?, reply_at = datetime('now') WHERE id = ?`).run(finalText, d.incoming_id); } catch { /* best-effort */ } }
    recordEmailSend({ toAddr: d.to_addr, subject: d.subject, kind: 'reply-approved', draftId: id, text: finalText });
    markEmailDraftSent(id);
    return { ok: true, status: 200 };
  } catch (e: any) { return { ok: false, status: 500, message: e.message }; }
}
export function rejectEmailDraft(id: number): boolean {
  const d = getEmailDraft(id);
  if (!d || d.status !== 'pending') return false;
  markEmailDraftRejected(id);
  return true;
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
  // INCIDENTE 27-28/07 (v2.18.3): ImapFlow emette un 'error' event asincrono (es. durante
  // close()/perdita connessione: "Failed to receive greeting" → NoConnection) FUORI dalla
  // catena await. Senza un listener, Node lancia uncaughtException e abbatte l'INTERO processo
  // (webhook WhatsApp incluso → 502). Un handler 'error' rende l'evento innocuo.
  client.on('error', (e: any) => console.error(`[Email] IMAP error ${acc.name}:`, e?.message || e));
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
          let text = (parsed.text || '').replace(/\s+/g, ' ').trim();

          // Lettura automatica degli allegati (rev. 01/07/2026): prima venivano ignorati del
          // tutto (si leggeva solo il testo del corpo). Analizza il primo allegato immagine/PDF
          // (tipo di documento, mittente/ente, riferimenti visibili) e lo aggiunge al testo, così
          // classificazione e risposta automatica tengono conto di cosa è stato ricevuto davvero.
          const attachment = (parsed.attachments || []).find((a: any) =>
            a.content && (/^image\/(jpeg|png|gif|webp)$/.test(a.contentType) || a.contentType === 'application/pdf'),
          ) as any;
          if (attachment) {
            try {
              const dv = await import('./docvision.js');
              const desc = attachment.contentType === 'application/pdf'
                ? await dv.analyzePdfBuffer(attachment.content as Buffer)
                : await dv.analyzeImageBuffer(attachment.content as Buffer, attachment.contentType);
              if (desc) text = `${text}\n\n[Allegato "${attachment.filename || 'documento'}"] analisi automatica: ${desc}`.trim();
            } catch (e: any) {
              console.error(`[DocVision] allegato ${acc.name}:`, e.message);
            }
          }

          const snippet = text.slice(0, 240);
          const category = classify(subject, fromAddr, text);
          // matched_client è un'etichetta "probabile cliente": solo i contatti di tipo
          // cliente contano (i fornitori NON devono innescare l'avviso "email cliente").
          const knownContact = contacts.findContact(fromAddr);
          const matched = (knownContact?.type === 'cliente' ? knownContact.name : null) || matchClient(fromName);
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

const CATEGORY_OF_TYPE: Record<contacts.ContactType, string> = {
  cliente: 'lavoro', fornitore: 'fornitore', ignorato: 'ignorata', cgt: 'commissione_tributaria',
};

/** Segna l'email (e il suo mittente) con un tipo di contatto (cliente/fornitore/ignorato/cgt):
 *  aggiorna la rubrica (con raffronto WhatsApp per nome) e riclassifica le sue email. */
function markEmailAs(id: number, type: contacts.ContactType): boolean {
  const row = db.prepare(`SELECT from_addr, from_name FROM incoming_emails WHERE id = ?`).get(id) as any;
  if (!row?.from_addr) return false;
  contacts.setContactType(row.from_addr, row.from_name || null, type);
  const category = CATEGORY_OF_TYPE[type];
  const matchedClient = type === 'cliente' ? (row.from_name || null) : null;
  db.prepare(`UPDATE incoming_emails SET category = ?, matched_client = ? WHERE lower(from_addr) = lower(?)`)
    .run(category, matchedClient, row.from_addr);
  return true;
}
export function markEmailAsClient(id: number): boolean { return markEmailAs(id, 'cliente'); }
export function markEmailAsFornitore(id: number): boolean { return markEmailAs(id, 'fornitore'); }
export function markEmailAsNotClient(id: number): boolean { return markEmailAs(id, 'ignorato'); }
/** Segna l'email come Commissione Tributaria/Corte di Giustizia Tributaria: da ricollegare
 *  a un procedimento anche quando non arriva via PEC. Mai lavoro, mai auto-risposta
 *  (category !== 'lavoro' esclude già l'auto-invio in maybeAutoReply). */
export function markEmailAsCGT(id: number): boolean { return markEmailAs(id, 'cgt'); }

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
