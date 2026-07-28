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
import { classifyPec, extractDates, extractHearingDate, extractRG, extractHearingLink, classifyOutcome, extractLiquidatedAmount,
  hasSentenceNotification, extractSentenceRef, extractOrgano, extractSentenceDate, selectCounterpartyPec, formatDateIT, composeNotificaText } from './pec_logic.js';
import { computeDeadlinesFromEvent, computeRecoveryDeadline, computeAppealDeadline } from './pec_terms.js';
import { createCalendarEvent } from './integrations.js';
import { createDeadline } from './deadlines.js';
import { sendTextMessage } from './zapi.js';
import { getControlNumber } from './chatbot.js';
import nodemailer from 'nodemailer';

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
// Migrazioni (rev. 13/07): udienza telematica (link), esito sentenza + importo liquidato.
try { db.exec(`ALTER TABLE pec_events ADD COLUMN hearing_link TEXT`); } catch { /* già presente */ }
try { db.exec(`ALTER TABLE pec_events ADD COLUMN is_remote INTEGER DEFAULT 0`); } catch { /* già presente */ }
try { db.exec(`ALTER TABLE pec_events ADD COLUMN outcome TEXT`); } catch { /* già presente */ }
try { db.exec(`ALTER TABLE pec_events ADD COLUMN amount TEXT`); } catch { /* già presente */ }
// Migrazione (rev. 13/07 — bis): flag "sentenza notificata" per il termine di appello.
try { db.exec(`ALTER TABLE pec_events ADD COLUMN sentence_notified INTEGER DEFAULT 0`); } catch { /* già presente */ }

// ═══ CODA NOTIFICHE ex L. 53/1994 (feature B) ════════════════════════════════
// Le notifiche della sentenza favorevole alle controparti sono PREPARATE e messe in coda
// ad ALTA PRIORITÀ. L'INVIO REALE parte SOLO su approvazione umana
// (POST /api/pec/notifiche/:id/approva-invia) — oppure, se PEC_AUTOSEND_NOTIFICA=1
// (default OFF), automaticamente. Idempotente per pec_event_id.
db.exec(`
  CREATE TABLE IF NOT EXISTS pec_notifiche (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pec_event_id INTEGER UNIQUE,
    rg_ref TEXT,
    sentence_ref TEXT,
    organo TEXT,
    sentence_date TEXT,
    subject TEXT,
    body_text TEXT,                     -- testo ESATTO ex L.53/1994
    recipients_json TEXT,               -- PEC controparti (o [] se da verificare)
    attachment_name TEXT,
    attachment_b64 TEXT,                -- PDF della sentenza (base64) per l'invio
    status TEXT DEFAULT 'pronta',       -- pronta | destinatari_da_verificare | inviata | errore
    autosend INTEGER DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pec_notifiche_status ON pec_notifiche(status, created_at);
`);

function envSetting(key: string, def = ''): string { return (process.env[key] || def).trim(); }
function recoveryDays(): number { return parseInt(envSetting('PEC_RECOVERY_DAYS', '60'), 10) || 60; }
function appealPreviewDays(): number { return parseInt(envSetting('APPEAL_PREVIEW_DAYS', '5'), 10) || 5; }
/** Auto-invio notifica SENZA via libera umano: default OFF. Documentato come RISCHIOSO. */
export function pecAutosendNotifica(): boolean { return /^(1|true|on|yes)$/i.test(envSetting('PEC_AUTOSEND_NOTIFICA', '')); }
function pecSmtpConfig() {
  return {
    host: envSetting('PEC_SMTP_HOST', 'sendm.cert.legalmail.it'),
    port: parseInt(envSetting('PEC_SMTP_PORT', '465'), 10) || 465,
    user: pecConfig().user,
    pass: process.env.PEC_PASS || '',
  };
}
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
  const full = `${m.subject}\n${m.body}`;
  const cls = classifyPec(m.fromAddr, m.subject, m.body);
  const hearing = extractHearingDate(full);
  const rg = extractRG(full);
  const dates = extractDates(full);
  const link = extractHearingLink(full);
  const oc = classifyOutcome(full);
  const amount = oc.isSentenza ? extractLiquidatedAmount(full) : null;
  const notified = oc.isSentenza && hasSentenceNotification(full) ? 1 : 0;
  const status = cls.confident ? 'nuovo' : 'da_rivedere';
  const info = db.prepare(`
    INSERT INTO pec_events (message_id, pec_uid, from_addr, subject, category, event_type, confident,
      hearing_date, rg_ref, dates_json, attachments_json, body_excerpt, status, received_at,
      hearing_link, is_remote, outcome, amount, sentence_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.messageId, m.uid ?? null, m.fromAddr, m.subject, cls.category, cls.eventType, cls.confident ? 1 : 0,
    hearing, rg, JSON.stringify(dates), JSON.stringify(m.attachments || []), String(m.body || '').slice(0, 500), status, m.receivedAt,
    link.url || null, link.remote ? 1 : 0, oc.isSentenza ? oc.esito : null, amount, notified);
  return Number(info.lastInsertRowid);
}

// ═══ BLOCCO 3 — CALENDARIZZAZIONE (idempotente) ══════════════════════════════
// Per ogni UDIENZA e ogni TERMINE calcolato crea un evento Google Calendar + una voce
// nello scadenzario (bot_deadlines). I termini calcolati hanno prefisso "[DA CONFERMARE]".
// Idempotente: se il pec_event è già 'processato' (calendar_event_ids valorizzato) → skip.
// Nessun invio ai clienti/enti: solo agenda interna + alert al numero di controllo.
async function calEvent(title: string, description: string, dateISO: string, startHHMM = '09:00', durMin = 60, location?: string): Promise<string | null> {
  const start = `${dateISO}T${startHHMM}:00`;
  const endMs = Date.parse(start) + durMin * 60000;
  const end = new Date(endMs).toISOString().slice(0, 19); // locale-naive ISO; timeZone gestita dall'integrazione
  try { const r = await createCalendarEvent({ title, description, startDate: start, endDate: end, location }); return r.success ? (r.eventId || 'created') : null; }
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
  //    CASO 1: se telematica, il link di collegamento va nell'evento (location + descrizione).
  if (row.hearing_date) {
    const isRemote = row.is_remote === 1;
    const link: string | null = row.hearing_link || null;
    const remoteTag = isRemote ? (link ? ' (da remoto — link in agenda)' : ' (da remoto — [link da verificare])') : '';
    const title = `⚖️ UDIENZA${rg} — ${row.category}${isRemote ? ' [TELEMATICA]' : ''}`;
    const linkLine = isRemote ? (link ? `\n🔗 Collegamento: ${link}` : `\n🔗 Udienza da remoto — [link da verificare] (non estratto con certezza dalla PEC)`) : '';
    const desc = `Udienza fissata (fonte PEC). Oggetto: ${row.subject}\nMittente: ${who}\n⏰ Orario da verificare sull'avviso.${linkLine}`;
    const eid = await calEvent(title, desc, row.hearing_date, '09:00', 60, link || undefined);
    if (eid) { ids.push(`hearing:${eid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `Udienza CGT${isRemote ? ' (telematica)' : ''}`, description: `${row.subject}${isRemote ? (link ? ` — link: ${link}` : ' — [link da verificare]') : ''} (orario da verificare)`, dueDate: row.hearing_date });
    lines.push(`⚖️ Udienza${rg}: ${row.hearing_date}${remoteTag}`);
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

  // 3) SENTENZA FAVOREVOLE → compenso liquidato [DA VERIFICARE] + recupero somme +N gg [DA CONFERMARE]
  //    (CASO 2 e CASO 3). L'importo è un'estrazione da testo/PDF: SEMPRE da verificare.
  if (row.outcome === 'favorevole' || row.outcome === 'parziale') {
    const base = row.received_at ? String(row.received_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const importo = row.amount || null;
    const impTxt = importo ? `€ ${importo} [DA VERIFICARE]` : 'importo non estratto [DA VERIFICARE]';
    // Nota compenso sul giorno della sentenza (fonte PEC).
    const cTitle = `[DA VERIFICARE] Compenso liquidato${rg} — ${impTxt}`;
    const cDesc = `Sentenza ${row.outcome} (fonte PEC). Compenso/spese liquidate a favore: ${impTxt}.\nL'importo è un'ESTRAZIONE dal testo/PDF e va CONFERMATO dal Dott. Branca.\nPEC: ${row.subject}`;
    const cEid = await calEvent(cTitle, cDesc, base, '09:00', 30);
    if (cEid) { ids.push(`compenso:${cEid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `[DA VERIFICARE] Compenso liquidato`, description: `Sentenza ${row.outcome} — ${impTxt}`, dueDate: base });
    lines.push(`⚖️ Sentenza ${row.outcome}${rg}: compenso ${impTxt}`);

    // CASO 3: scadenza recupero somme a +N gg dalla notifica alla controparte.
    // La data di notifica alla controparte spesso NON è nella PEC della sentenza:
    // si usa la data disponibile più prudente (base) e lo si segnala esplicitamente.
    const rec = computeRecoveryDeadline(base, recoveryDays(), importo);
    const rTitle = `[DA CONFERMARE] ${rec.tipo}${rg}`;
    const rDesc = `${rec.norma}\n${rec.note}\nFascicolo: ${row.rg_ref || 'n/d'} · PEC: ${row.subject}`;
    const rEid = await calEvent(rTitle, rDesc, rec.dueDate, '09:00', 30);
    if (rEid) { ids.push(`recupero:${rEid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `[DA CONFERMARE] ${rec.tipo}`, description: `${rec.norma} — ${rec.note}`, dueDate: rec.dueDate });
    lines.push(`💶 [DA CONFERMARE] Recupero somme: ${rec.dueDate} (+${recoveryDays()}gg dalla notifica alla controparte — decorrenza da confermare)`);
  }

  // 4) TERMINE DI APPELLO (per QUALSIASI sentenza): BREVE 60 gg se risulta la NOTIFICA
  //    (art. 51 D.Lgs 546/1992); altrimenti LUNGO 6 mesi (art. 327 c.p.c. via art. 38 c.3
  //    D.Lgs 546/1992) dalla pubblicazione/deposito. Feriale 1–31/8 applicata. [DA CONFERMARE].
  //    Oltre all'evento, crea un PROMEMORIA a −N giorni (APPEAL_PREVIEW_DAYS, default 5).
  if (row.outcome) {
    const base = row.received_at ? String(row.received_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const notified = row.sentence_notified === 1;
    const preview = appealPreviewDays();
    const ap = computeAppealDeadline({ depositDate: base, notificationDate: notified ? base : null, previewDays: preview });
    const decorrenza = notified
      ? 'Decorrenza: DATA DI NOTIFICA della sentenza (prudenzialmente = data PEC) — DA CONFERMARE.'
      : 'Decorrenza: DATA DI PUBBLICAZIONE/DEPOSITO (prudenzialmente = data PEC) — DA CONFERMARE.';
    const aTitle = `[DA CONFERMARE] ${ap.tipo}${rg}`;
    const aDesc = `${ap.norma}\n${ap.note}\n${decorrenza}\nFascicolo: ${row.rg_ref || 'n/d'} · PEC: ${row.subject}`;
    const aEid = await calEvent(aTitle, aDesc, ap.dueDate, '09:00', 30);
    if (aEid) { ids.push(`appello:${aEid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `[DA CONFERMARE] ${ap.tipo}`, description: `${ap.norma} — ${ap.note}`, dueDate: ap.dueDate });
    // Promemoria anticipato (−N gg) sul calendario + scadenzario, al numero di controllo.
    const pTitle = `⏰ PREAVVISO ${preview}gg — scadenza appello${rg}`;
    const pDesc = `Promemoria: fra ${preview} giorni scade il termine di appello (${ap.dueDate}).\n${ap.norma}\nVERIFICARE decorrenza (notifica/pubblicazione), giorni liberi e feriale prima di agire.`;
    const pEid = await calEvent(pTitle, pDesc, ap.previewDate, '09:00', 30);
    if (pEid) { ids.push(`appello_preavviso:${pEid}`); created++; }
    createDeadline({ clientKey: row.rg_ref || null, tipo: `⏰ Preavviso appello (−${preview}gg)`, description: `Scadenza appello ${ap.dueDate} — ${ap.norma}`, dueDate: ap.previewDate });
    lines.push(`⚖️ [DA CONFERMARE] ${ap.tipoTermine === 'breve' ? 'Appello 60gg (notifica)' : 'Appello 6 mesi (deposito)'}: ${ap.dueDate} · preavviso ${preview}gg il ${ap.previewDate}`);
  }

  db.prepare(`UPDATE pec_events SET status = 'processato', calendar_event_ids = ? WHERE id = ?`).run(JSON.stringify(ids), row.id);

  if (lines.length) {
    const alert = `📩 *PEC contenzioso* — nuovo evento${rg}\n${row.subject}\n\n${lines.join('\n')}\n\n⚠️ Termini/importi sono PROPOSTE [DA CONFERMARE]/[DA VERIFICARE]: verifica sull'atto (notifiche, giorni liberi, feriale, importo).`;
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

// ═══ FEATURE B — NOTIFICA SENTENZA FAVOREVOLE ex L. 53/1994 ══════════════════
// PREPARA la notifica alle controparti (testo esatto + allegato PDF), la mette in coda ad
// ALTA PRIORITÀ con alert immediato ("pronto-invio a un tap"). L'INVIO REALE parte SOLO su
// approvazione (POST .../approva-invia) o, se PEC_AUTOSEND_NOTIFICA=1 (default OFF), da solo.
export interface PrepareNotificaInput {
  pecEventId: number; rgRef?: string | null; fullText: string; subject: string;
  ownUser?: string; senderAddr?: string;
  attachment?: { filename: string; contentB64: string } | null;
}

/** Prepara (idempotente per pec_event_id) la notifica e la mette in coda. NON invia. */
export async function prepareNotifica(inp: PrepareNotificaInput): Promise<{ ok: boolean; id?: number; status?: string; skipped?: boolean }> {
  const exists = db.prepare(`SELECT id, status FROM pec_notifiche WHERE pec_event_id = ?`).get(inp.pecEventId) as any;
  if (exists) return { ok: true, id: exists.id, status: exists.status, skipped: true };
  const sentenceRef = extractSentenceRef(inp.fullText);
  const organo = extractOrgano(inp.fullText);
  const sentDateISO = extractSentenceDate(inp.fullText);
  const bodyText = composeNotificaText({ sentenceRef, organo, sentenceDateHuman: formatDateIT(sentDateISO) });
  const recipients = selectCounterpartyPec(inp.fullText, inp.ownUser, inp.senderAddr);
  const attName = inp.attachment?.filename || null;
  const attB64 = inp.attachment?.contentB64 || null;
  const status = recipients.length ? 'pronta' : 'destinatari_da_verificare';
  const subject = `Notifica ex L. 53/1994 — sentenza n. ${sentenceRef || '…/…'}${inp.rgRef ? ` — R.G. ${inp.rgRef}` : ''}`;
  const info = db.prepare(`
    INSERT INTO pec_notifiche (pec_event_id, rg_ref, sentence_ref, organo, sentence_date, subject,
      body_text, recipients_json, attachment_name, attachment_b64, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(inp.pecEventId, inp.rgRef || null, sentenceRef, organo, sentDateISO, subject,
    bodyText, JSON.stringify(recipients), attName, attB64, status);
  const id = Number(info.lastInsertRowid);

  // Alert IMMEDIATO ad ALTA PRIORITÀ (pronto-invio a un tap).
  const missing: string[] = [];
  if (!recipients.length) missing.push('destinatari da verificare');
  if (!attB64) missing.push('allegato PDF non disponibile');
  if (!sentenceRef) missing.push('n. sentenza da completare');
  if (!organo) missing.push('organo da completare');
  const alert = `🚨 *NOTIFICA SENTENZA (L.53/1994) PRONTA — richiede il TUO VIA LIBERA*${inp.rgRef ? `\nR.G. ${inp.rgRef}` : ''}\n`
    + `Destinatari: ${recipients.length ? recipients.join(', ') : '⚠️ DA VERIFICARE (nessuna PEC controparte certa)'}\n`
    + `Allegato: ${attName || '⚠️ non disponibile'}\n\n"${bodyText}"\n\n`
    + (missing.length ? `⚠️ Da completare: ${missing.join('; ')}.\n` : '')
    + `➡️ Invio SOLO su approvazione: POST /api/pec/notifiche/${id}/approva-invia\n`
    + `⚠️ La notifica fa DECORRERE il termine breve d'appello per TUTTE le parti: irreversibile.`;
  try { await sendTextMessage(getControlNumber(), alert); } catch { /* best-effort */ }

  // Auto-invio SENZA via libera SOLO se esplicitamente abilitato (default OFF) e destinatari certi.
  if (pecAutosendNotifica() && status === 'pronta') {
    db.prepare(`UPDATE pec_notifiche SET autosend = 1 WHERE id = ?`).run(id);
    try { await sendNotifica(id, { viaAutosend: true }); } catch (e: any) { console.error('[PEC] autosend notifica', id, e?.message); }
  }
  return { ok: true, id, status };
}

/** Invio REALE via SMTP Legalmail. Parte SOLO da approvazione umana o da autosend flag.
 *  Idempotente: se già 'inviata' → skip. Se PEC non configurata → resta in coda "pronta". */
export async function sendNotifica(id: number, opts: { viaAutosend?: boolean } = {}): Promise<{ ok: boolean; status: string; error?: string }> {
  const row = db.prepare(`SELECT * FROM pec_notifiche WHERE id = ?`).get(id) as any;
  if (!row) return { ok: false, status: 'inesistente', error: 'notifica inesistente' };
  if (row.status === 'inviata') return { ok: true, status: 'inviata' };
  const recipients: string[] = row.recipients_json ? JSON.parse(row.recipients_json) : [];
  if (!recipients.length) { db.prepare(`UPDATE pec_notifiche SET last_error = ? WHERE id = ?`).run('destinatari da verificare', id); return { ok: false, status: row.status, error: 'destinatari da verificare: completa i destinatari prima di inviare' }; }
  const smtp = pecSmtpConfig();
  if (!smtp.user || !smtp.pass) { db.prepare(`UPDATE pec_notifiche SET last_error = ? WHERE id = ?`).run('PEC non configurata (SMTP)', id); return { ok: false, status: row.status, error: 'PEC non configurata: la notifica resta in coda "pronta"' }; }
  try {
    const transporter = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: true, auth: { user: smtp.user, pass: smtp.pass } });
    const attachments = row.attachment_b64 ? [{ filename: row.attachment_name || 'sentenza.pdf', content: Buffer.from(row.attachment_b64, 'base64') }] : [];
    await transporter.sendMail({ from: smtp.user, to: recipients.join(', '), subject: row.subject, text: row.body_text, attachments });
    db.prepare(`UPDATE pec_notifiche SET status = 'inviata', sent_at = datetime('now'), last_error = NULL WHERE id = ?`).run(id);
    const done = `✅ Notifica L.53/1994 INVIATA${opts.viaAutosend ? ' (autosend)' : ' (approvata)'}${row.rg_ref ? ` — R.G. ${row.rg_ref}` : ''}\nDestinatari: ${recipients.join(', ')}`;
    try { await sendTextMessage(getControlNumber(), done); } catch { /* noop */ }
    return { ok: true, status: 'inviata' };
  } catch (e: any) {
    db.prepare(`UPDATE pec_notifiche SET status = 'errore', last_error = ? WHERE id = ?`).run(String(e?.message || e).slice(0, 300), id);
    return { ok: false, status: 'errore', error: e?.message };
  }
}

/** Lista notifiche (SOLA LETTURA): non espone il base64 dell'allegato. */
export function getNotifiche(limit = 100): any[] {
  const rows = db.prepare(`SELECT id, pec_event_id, rg_ref, sentence_ref, organo, sentence_date, subject, body_text,
    recipients_json, attachment_name, status, autosend, last_error, sent_at, created_at
    FROM pec_notifiche ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as any[];
  return rows.map((r) => ({ ...r, recipients: r.recipients_json ? JSON.parse(r.recipients_json) : [], has_attachment: !!r.attachment_name }));
}

/** Elabora UN messaggio grezzo IMAP (parse → ingest → prepara notifica se sentenza vinta).
 *  Idempotente (dedup Message-ID). Ritorna true se ha creato un nuovo pec_event. Non lancia. */
async function ingestRawMessage(source: Buffer, uid: number | undefined, ownUser: string): Promise<boolean> {
  const parsed = await simpleParser(source);
  const messageId = parsed.messageId || `pec_${uid}`;
  if (db.prepare(`SELECT 1 FROM pec_events WHERE message_id = ?`).get(messageId)) return false;
  const fromVal = (parsed.from as any)?.value?.[0] || {};
  const attsFull = (parsed.attachments || []) as any[];
  const atts = attsFull.map((a: any) => a.filename || 'allegato');
  const id = ingestPecMessage({
    messageId, uid, fromAddr: fromVal.address || '', subject: parsed.subject || '(senza oggetto)',
    body: parsed.text || '', attachments: atts, receivedAt: (parsed.date || new Date()).toISOString(),
  });
  if (!id) return false;
  // FEATURE B — sentenza FAVOREVOLE/PARZIALE con PDF → PREPARA notifica ex L.53/1994
  // (coda ad alta priorità, NESSUN invio automatico salvo flag). Isolato.
  try {
    const full = `${parsed.subject || ''}\n${parsed.text || ''}`;
    const oc = classifyOutcome(full);
    if (oc.isSentenza && (oc.esito === 'favorevole' || oc.esito === 'parziale')) {
      const pdf = attsFull.find((a: any) => /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.contentType || ''));
      const attachment = pdf && pdf.content ? { filename: pdf.filename || 'sentenza.pdf', contentB64: Buffer.from(pdf.content).toString('base64') } : null;
      await prepareNotifica({ pecEventId: id, rgRef: extractRG(full), fullText: full, subject: parsed.subject || '', ownUser, senderAddr: fromVal.address || '', attachment });
    }
  } catch (e: any) { console.error('[PEC] prepareNotifica:', e?.message); }
  return true;
}

/** Poll IMAP della casella PEC (sola lettura). Idempotente per Message-ID. Non lancia mai. */
export async function pollPec(force = false): Promise<{ enabled: boolean; processed: number; created: number; error?: string }> {
  if (!pecEnabled()) return { enabled: false, processed: 0, created: 0, error: 'PEC non configurata (mancano PEC_USER/PEC_PASS)' };
  const c = pecConfig();
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  // v2.18.3: handler 'error' obbligatorio — un evento 'error' emesso da ImapFlow senza listener
  // abbatte l'intero processo (uncaughtException). Vedi incidente 27-28/07.
  client.on('error', (e: any) => console.error('[PEC] IMAP error:', e?.message || e));
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
          try { if (await ingestRawMessage(msg.source as Buffer, msg.uid, c.user)) created++; }
          catch (e: any) { console.error('[PEC] parse messaggio fallito:', e?.message); }
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

// ═══ BACKSCAN — scansione a ritroso ultimi N mesi (min 2) ════════════════════
// Recupera i messaggi PEC degli ultimi N mesi via IMAP SEARCH (SINCE), li fa passare per la
// stessa pipeline (ingest → termini/appello/sentenza → notifica L.53 in coda). Idempotente.
// Se la PEC non è configurata NON fallisce: ritorna {ok:false, reason}.
export async function backscanPec(months = 2): Promise<{ ok: boolean; reason?: string; months?: number; since?: string; scanned?: number; created?: number; notifichePronte?: number; sentenzeVinte?: number; error?: string }> {
  const m = Math.max(2, Math.floor(Number(months) || 2));
  if (!pecEnabled()) { setSetting('pec_backscan_last', JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'PEC non configurata' })); return { ok: false, reason: 'PEC non configurata' }; }
  const since = new Date(); since.setMonth(since.getMonth() - m); since.setHours(0, 0, 0, 0);
  const sinceISO = since.toISOString().slice(0, 10);
  const c = pecConfig();
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  // v2.18.3: handler 'error' obbligatorio — un evento 'error' emesso da ImapFlow senza listener
  // abbatte l'intero processo (uncaughtException). Vedi incidente 27-28/07.
  client.on('error', (e: any) => console.error('[PEC] IMAP error:', e?.message || e));
  let scanned = 0, created = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since }, { uid: true }) as number[];
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          scanned++;
          try { if (await ingestRawMessage(msg.source as Buffer, msg.uid, c.user)) created++; }
          catch (e: any) { console.error('[PEC] backscan msg fallito:', e?.message); }
        }
      }
    } finally { lock.release(); }
    await client.logout().catch(() => {});
    // Calendarizza/termini per i nuovi eventi (idempotente).
    try { await runPecProcessing(); } catch (e: any) { console.error('[PEC] backscan processing:', e?.message); }
    const notifichePronte = (db.prepare(`SELECT COUNT(*) n FROM pec_notifiche WHERE status = 'pronta'`).get() as any)?.n || 0;
    const sentenzeVinte = (db.prepare(`SELECT COUNT(*) n FROM pec_events WHERE outcome IN ('favorevole','parziale')`).get() as any)?.n || 0;
    const summary = { ts: new Date().toISOString(), ok: true, months: m, since: sinceISO, scanned, created, notifichePronte, sentenzeVinte };
    setSetting('pec_backscan_last', JSON.stringify(summary));
    return { ok: true, months: m, since: sinceISO, scanned, created, notifichePronte, sentenzeVinte };
  } catch (e: any) {
    try { await client.logout().catch(() => {}); } catch { /* noop */ }
    console.error('[PEC] backscan fallito:', e?.message);
    setSetting('pec_backscan_last', JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'errore', error: e?.message }));
    return { ok: false, reason: 'errore', months: m, since: sinceISO, scanned, created, error: e?.message };
  }
}

export function getBackscanStatus(): any {
  const raw = getSetting('pec_backscan_last');
  return { enabled: pecEnabled(), lastBackscan: raw ? JSON.parse(raw) : null };
}

/** Conteggi notifiche per stato (per il cruscotto). */
export function getNotificheCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  try { for (const r of db.prepare(`SELECT status, COUNT(*) n FROM pec_notifiche GROUP BY status`).all() as any[]) counts[r.status] = r.n; } catch { /* noop */ }
  return counts;
}

/** INVIO MASSIVO PROTETTO: invia SOLO le notifiche 'pronta' con destinatari verificati.
 *  Esclude 'destinatari_da_verificare', 'inviata', 'errore'. È un'azione UMANA esplicita
 *  (chiamata dall'endpoint di approvazione) o via flag PEC_AUTOSEND_NOTIFICA. */
export async function approveAllNotifiche(): Promise<{ ok: boolean; sent: number; skipped: number; details: Array<{ id: number; status: string; error?: string }> }> {
  const rows = db.prepare(`SELECT id FROM pec_notifiche WHERE status = 'pronta' ORDER BY id ASC`).all() as any[];
  let sent = 0, skipped = 0;
  const details: Array<{ id: number; status: string; error?: string }> = [];
  for (const r of rows) {
    const res = await sendNotifica(r.id);
    if (res.ok && res.status === 'inviata') { sent++; details.push({ id: r.id, status: 'inviata' }); }
    else { skipped++; details.push({ id: r.id, status: res.status, error: res.error }); }
  }
  return { ok: true, sent, skipped, details };
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
