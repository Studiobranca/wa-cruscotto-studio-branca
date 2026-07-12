/**
 * chatbot.ts — Assistente conversazionale WhatsApp per AB STUDIO SRL.
 *
 * Genera BOZZE di risposta ai clienti di lavoro (non-VIP) usando Claude via REST
 * (nessun SDK, coerente con lo stile del repo). Il bot dialoga per raccogliere le
 * informazioni e proporre slot d'agenda, ma NON invia nulla da solo: ogni bozza
 * viene approvata da Mariano nel Cruscotto (draft mode). La prenotazione viene
 * materializzata come evento "[DA CONFERMARE]" solo all'approvazione.
 *
 * Riusa: getAvailability()/formatAvailabilityIT() (appointments.ts) per l'agenda.
 */

import db from './db.js';
import { getAvailability, formatAvailabilityIT, isSlotBusy, getNowStatus, formatDateIT } from './appointments.js';
import { shouldBlockSlot } from './agenda_logic.js';
import { sendTextMessage } from './zapi.js';
import { createCalendarEvent, updateCalendarEvent, appendEventDescription } from './integrations.js';
import { broadcastEvent } from './sse.js';
import { resolveIdentities, isVipContact } from './contacts.js';
import { sanitizeClientText, type SanitizeResult } from './sanitize.js';
import { detectRegisterFromTranscript } from './register.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_LOOPS = 4;
const HISTORY_LIMIT = 30;

// ─── Persistenza: tabella bozze (idempotente) ────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    contact_name TEXT,
    incoming_excerpt TEXT,
    draft_text TEXT,
    proposed_event TEXT,            -- JSON {date,start,end,reason} oppure NULL
    needs_human INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',  -- pending | sent | rejected
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bot_drafts_status ON bot_drafts(status);
`);

// ─── Persistenza: appuntamenti tracciati (per conferma cliente) ───────────────
// Ogni appuntamento creato all'approvazione di una bozza viene registrato qui con
// l'eventId di Google Calendar, così quando il cliente CONFERMA su WhatsApp si può
// ritrovare l'evento e aggiornarlo (da "[DA CONFERMARE]" a confermato + verde).
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    contact_name TEXT,
    event_id TEXT,                  -- id evento Google Calendar (NULL se Google non configurato)
    date TEXT NOT NULL,             -- YYYY-MM-DD
    start TEXT NOT NULL,            -- HH:MM
    end TEXT,                       -- HH:MM
    reason TEXT,
    status TEXT DEFAULT 'da_confermare',  -- da_confermare | confermato | annullato
    created_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bot_appt_phone ON bot_appointments(phone, status);
`);
// Migrazione idempotente (v2.10): flag promemoria "appuntamento di domani" già inviato.
try { db.exec(`ALTER TABLE bot_appointments ADD COLUMN reminder_sent INTEGER DEFAULT 0`); } catch { /* già presente */ }
// Migrazione (rev. 11/07): esito appuntamento (tenuto | no_show | annullato) — NULL = da registrare.
// Nota: lo status guadagna anche il valore 'scaduto' per le proposte [DA CONFERMARE] mai confermate.
try { db.exec(`ALTER TABLE bot_appointments ADD COLUMN outcome TEXT`); } catch { /* già presente */ }

// ─── Persistenza: lista d'attesa appuntamenti (v2.10) ─────────────────────────
// Quando get_availability non ha slot (chiusura estiva, agenda piena) il bot propone
// la lista d'attesa: appena tornano disponibilità il job runWaitlistRecall (reminders.ts)
// ricontatta i clienti in ordine di arrivo con le prime date libere.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    contact_name TEXT,
    reason TEXT,
    status TEXT DEFAULT 'in_attesa',   -- in_attesa | ricontattato | chiuso
    created_at TEXT DEFAULT (datetime('now')),
    notified_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bot_waitlist_status ON bot_waitlist(status);
`);
/** Inserisce (o aggiorna, se già in attesa) un cliente nella lista d'attesa. */
export function addToWaitlist(phone: string, contactName: string | null, reason: string): number {
  const ex = db.prepare(`SELECT id FROM bot_waitlist WHERE phone = ? AND status = 'in_attesa'`).get(phone) as any;
  if (ex) {
    db.prepare(`UPDATE bot_waitlist SET reason = ?, contact_name = COALESCE(?, contact_name) WHERE id = ?`).run(reason, contactName, ex.id);
    return ex.id;
  }
  const info = db.prepare(`INSERT INTO bot_waitlist (phone, contact_name, reason) VALUES (?, ?, ?)`).run(phone, contactName, reason);
  return Number(info.lastInsertRowid);
}
export function getWaitlist(status?: string): any[] {
  if (status) return db.prepare(`SELECT * FROM bot_waitlist WHERE status = ? ORDER BY created_at ASC`).all(status) as any[];
  return db.prepare(`SELECT * FROM bot_waitlist ORDER BY created_at ASC`).all() as any[];
}
export function markWaitlistNotified(id: number): void {
  db.prepare(`UPDATE bot_waitlist SET status = 'ricontattato', notified_at = datetime('now') WHERE id = ?`).run(id);
}
export function closeWaitlistEntry(id: number): void {
  db.prepare(`UPDATE bot_waitlist SET status = 'chiuso' WHERE id = ?`).run(id);
}

// ─── Persistenza: note documenti (promemoria in agenda) ───────────────────────
// Quando il cliente invia documentazione, il bot annota un breve sunto di "a cosa si
// riferisce", che viene attaccato all'evento dell'appuntamento in agenda: così lo studio
// ricorda di cosa si parlerà. Nessuna lettura del file: solo un promemoria da contesto.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_doc_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    summary TEXT NOT NULL,
    attached INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_doc_notes_phone ON bot_doc_notes(phone, attached);
`);
export function recordDocNote(phone: string, summary: string): void {
  db.prepare(`INSERT INTO bot_doc_notes (phone, summary) VALUES (?, ?)`).run(phone, summary);
}
/** Note documenti non ancora attaccate a un evento, per un numero. */
export function getUnattachedDocNotes(phone: string): { id: number; summary: string; created_at: string }[] {
  return db.prepare(`SELECT id, summary, created_at FROM bot_doc_notes WHERE phone = ? AND attached = 0 ORDER BY created_at ASC`).all(phone) as any[];
}
export function markDocNotesAttached(phone: string): void {
  db.prepare(`UPDATE bot_doc_notes SET attached = 1 WHERE phone = ? AND attached = 0`).run(phone);
}
/** Righe formattate dei documenti, per la descrizione dell'evento calendario. */
export function formatDocNotes(notes: { summary: string; created_at: string }[]): string {
  if (!notes.length) return '';
  return notes.map((n) => `📎 Documenti ricevuti (${(n.created_at || '').slice(0, 10)}): ${n.summary}`).join('\n');
}
/** Ultimo appuntamento attivo (da confermare o confermato) con evento, per un numero. */
export function getActiveAppointmentWithEvent(phone: string): any | null {
  return db.prepare(`
    SELECT * FROM bot_appointments
    WHERE phone = ? AND status IN ('da_confermare','confermato') AND event_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(phone) as any || null;
}

/** Registra un appuntamento appena creato in agenda (stato: da_confermare). */
export function recordAppointment(a: {
  phone: string; contactName?: string | null; eventId?: string | null;
  date: string; start: string; end?: string | null; reason?: string | null;
}): number {
  // Evita doppioni: annulla un'eventuale proposta pendente identica per lo stesso cliente.
  db.prepare(`UPDATE bot_appointments SET status = 'annullato' WHERE phone = ? AND status = 'da_confermare'`).run(a.phone);
  const info = db.prepare(`
    INSERT INTO bot_appointments (phone, contact_name, event_id, date, start, end, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'da_confermare')
  `).run(a.phone, a.contactName || null, a.eventId || null, a.date, a.start, a.end || null, a.reason || null);
  return Number(info.lastInsertRowid);
}

/** Ultimo appuntamento in attesa di conferma per un numero (o null). */
export function getPendingAppointment(phone: string): any | null {
  return db.prepare(`
    SELECT * FROM bot_appointments
    WHERE phone = ? AND status = 'da_confermare'
    ORDER BY created_at DESC LIMIT 1
  `).get(phone) as any || null;
}

/**
 * Appuntamento FUTURO già in agenda per un numero (da confermare o confermato),
 * con data >= oggi. Serve al dedup: se il cliente riscrive per la stessa cosa, il
 * bot NON deve fissarne un altro ma gestire quello esistente.
 */
export function getUpcomingAppointment(phone: string): any | null {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  return db.prepare(`
    SELECT * FROM bot_appointments
    WHERE phone = ? AND status IN ('da_confermare','confermato') AND date >= ?
    ORDER BY date ASC, start ASC LIMIT 1
  `).get(phone, today) as any || null;
}

/** Segna un appuntamento come confermato dal cliente. */
export function markAppointmentConfirmed(id: number): void {
  db.prepare(`UPDATE bot_appointments SET status = 'confermato', confirmed_at = datetime('now') WHERE id = ?`).run(id);
}

/** Tutti gli appuntamenti in attesa di conferma (per la lista nel Cruscotto). */
export function getPendingAppointments(): any[] {
  return db.prepare(`
    SELECT * FROM bot_appointments WHERE status = 'da_confermare'
    ORDER BY date ASC, start ASC
  `).all() as any[];
}

/** Un appuntamento per id. */
export function getAppointmentById(id: number): any | null {
  return db.prepare(`SELECT * FROM bot_appointments WHERE id = ?`).get(id) as any || null;
}

/** TUTTI gli appuntamenti futuri attivi (da confermare o confermati) di un contatto:
 *  usati da cancel_appointment e dallo spostamento (il nuovo slot annulla i vecchi). */
export function getActiveFutureAppointments(phone: string): any[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  return db.prepare(`
    SELECT * FROM bot_appointments
    WHERE phone = ? AND status IN ('da_confermare','confermato') AND date >= ?
    ORDER BY date ASC, start ASC
  `).all(phone, today) as any[];
}

/**
 * Conferma un appuntamento (riga bot_appointments): aggiorna l'evento in Google Calendar
 * (titolo ✅ + verde) e lo segna 'confermato'. È il cuore condiviso tra la conferma
 * AUTOMATICA (tool confirm_appointment, quando il cliente conferma su WhatsApp) e quella
 * MANUALE (pulsante nel Cruscotto). Con notify=true avvisa anche il numero di controllo.
 */
export async function confirmAppointmentRow(appt: any, opts: { notify?: boolean } = {}): Promise<{ ok: boolean; calendarUpdated: boolean }> {
  let calOk = false;
  if (appt.event_id) {
    const r = await updateCalendarEvent({
      eventId: appt.event_id,
      title: `✅ ${appt.reason || 'Appuntamento'} — ${appt.contact_name || appt.phone}`,
      description: `Appuntamento CONFERMATO.\nCliente: ${appt.contact_name || ''} (${appt.phone})\nMotivo: ${appt.reason || '-'}\nConfermato il ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`,
      colorId: '10', // verde "Basil"
    });
    calOk = r.success;
  }
  markAppointmentConfirmed(appt.id);
  if (opts.notify) {
    const esito = calOk
      ? 'Agenda aggiornata (evento confermato).'
      : appt.event_id ? '⚠️ Non sono riuscito ad aggiornare l\'evento in agenda: aggiornalo a mano.'
        : '⚠️ Aggiorna l\'agenda a mano (evento non tracciato).';
    try {
      await sendTextMessage(
        getControlNumber(),
        `✅ ${appt.contact_name || appt.phone} ha CONFERMATO l'appuntamento:\n📅 ${appt.date} ore ${appt.start} — ${appt.reason || 'Appuntamento'}\n${esito}`,
      );
    } catch (e: any) { console.error('[Chatbot] notifica conferma fallita:', e.message); }
  }
  return { ok: true, calendarUpdated: calOk };
}

/** Annulla un appuntamento: marca l'evento come [ANNULLATO] (grigio) e lo segna 'annullato'. */
export async function cancelAppointmentRow(appt: any): Promise<void> {
  if (appt.event_id) {
    await updateCalendarEvent({
      eventId: appt.event_id,
      title: `❌ [ANNULLATO] ${appt.reason || 'Appuntamento'} — ${appt.contact_name || appt.phone}`,
      colorId: '8', // grafite
    });
  }
  db.prepare(`UPDATE bot_appointments SET status = 'annullato' WHERE id = ?`).run(appt.id);
}

/** Fa SCADERE una proposta [DA CONFERMARE] mai confermata: aggiorna l'evento Calendar a
 *  [SCADUTA] e porta lo status a 'scaduto' (distinto da 'annullato' dal cliente). Così lo
 *  slot non resta "fantasma" occupando l'agenda. Rev. 11/07/2026. */
export async function expireAppointmentRow(appt: any): Promise<void> {
  if (appt.event_id) {
    try {
      await updateCalendarEvent({
        eventId: appt.event_id,
        title: `⌛ [SCADUTA] ${appt.reason || 'Appuntamento'} — ${appt.contact_name || appt.phone}`,
        colorId: '8', // grafite
      });
    } catch (e: any) { console.error('[Chatbot] scadenza evento Calendar:', e.message); }
  }
  db.prepare(`UPDATE bot_appointments SET status = 'scaduto' WHERE id = ?`).run(appt.id);
}

/** Righe appuntamento (per job/endpoint agenda). */
export function getAllAppointments(): any[] {
  return db.prepare(`SELECT * FROM bot_appointments ORDER BY date DESC, start DESC`).all() as any[];
}
export function getAppointmentRow(id: number): any | null {
  return db.prepare(`SELECT * FROM bot_appointments WHERE id = ?`).get(id) as any || null;
}
/** Registra l'esito di un appuntamento (tenuto | no_show | annullato). Rev. 11/07/2026. */
export function setAppointmentOutcome(id: number, outcome: string): boolean {
  const info = db.prepare(`UPDATE bot_appointments SET outcome = ? WHERE id = ?`).run(outcome, id);
  return info.changes > 0;
}

// ─── Config (app_settings key/value) ─────────────────────────────────────────
function getSetting(key: string, def: string): string {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any;
    return row?.value ?? def;
  } catch { return def; }
}
export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
export function isBotEnabled(): boolean { return getSetting('bot_enabled', '1') === '1'; }
export function getBotModel(): string { return getSetting('bot_model', DEFAULT_MODEL); }
// Risposta automatica per i clienti non-VIP: se attiva il bot INVIA da solo le risposte
// (tranne i casi urgenti need_human, che restano bozza). Default OFF (modalità bozza).
// BLINDATURA: l'auto-invio delle risposte ai clienti è BLOCCATO per default.
// Non basta il toggle del Cruscotto (che resta solo "intenzione"): per attivarlo
// davvero serve DELIBERATAMENTE l'env BOT_ALLOW_AUTOSEND=1 su Railway. Così un
// click distratto nell'interfaccia o una regressione di un commit non possono
// far ripartire le risposte automatiche ai clienti. Finché l'env non è '1', il
// bot prepara SOLO bozze da approvare. (Vale insieme al guard di sendTextMessage:
// se numero controllo == device, comunque nulla parte verso la propria linea.)
export function isAutoSendEnabled(): boolean {
  if (process.env.BOT_ALLOW_AUTOSEND !== '1') return false;
  return getSetting('bot_auto_send', '0') === '1';
}

// Appuntamenti in AUTONOMIA: il bot, sul flusso agenda (proposta/conferma/spostamento),
// risponde da solo al cliente DOPO aver incrociato Google Calendar. È un automatismo
// VOLUTO e circoscritto (solo agenda, non urgenze, non risposte di merito generiche) →
// di default attivo, con un proprio interruttore. NON è soggetto al lucchetto autoSend
// perché è limitato al flusso appuntamenti e l'agenda è già verificata.
export function isAutoAppointmentsEnabled(): boolean {
  return getSetting('bot_auto_appointments', '1') === '1';
}

// Approvazione bozze via comando WhatsApp ("OK <id>" / "NO <id>"). Interruttore di
// SICUREZZA: se il numero di controllo fosse esposto a un'auto-risposta AI, i comandi
// potrebbero approvare bozze da soli → si può spegnere qui (default ON). Si gestisce
// comunque sempre dal Cruscotto.
export function waCommandsEnabled(): boolean {
  return getSetting('wa_commands', '1') === '1';
}

// Anti-spam cortesia: il messaggio "sono impegnato, ricontatto" per i messaggi NON di
// lavoro parte al massimo una volta al giorno per contatto (così una chat personale fitta
// non riceve dieci risposte uguali di fila).
function todayRome(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
}
export function courtesySentToday(phone: string): boolean {
  return getSetting(`courtesy_${phone}`, '') === todayRome();
}
export function markCourtesySent(phone: string): void {
  setSetting(`courtesy_${phone}`, todayRome());
}

// Numero WhatsApp di Mariano per notifica/approvazione bozze (solo cifre).
export function getControlNumber(): string {
  return (getSetting('control_number', '') || process.env.CONTROL_WHATSAPP || '393457050479').replace(/\D/g, '');
}
// Quando inviare la notifica WhatsApp delle bozze a Mariano.
// Default 'always' (scelta utente): ogni bozza viene notificata su WhatsApp; Mariano
// risponde da WhatsApp oppure dal Cruscotto.
export function getNotifyMode(): 'off' | 'outside_hours' | 'always' {
  const m = getSetting('notify_mode', 'always');
  return (m === 'off' || m === 'outside_hours') ? m : 'always';
}
function isBusinessHoursRome(): boolean {
  const now = new Date();
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(now), 10);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  if (dow === 0 || dow === 6) return false;
  return (hour >= 9 && hour < 13) || (hour >= 15 && hour < 19);
}
// Default 'always': ogni bozza è notificata su WhatsApp. ('outside_hours' = solo
// fuori orario di studio; 'off' = mai, solo Cruscotto.)
export function shouldNotifyControl(): boolean {
  const m = getNotifyMode();
  if (m === 'off') return false;
  if (m === 'always') return true;
  return !isBusinessHoursRome();
}

// ─── Persona + guardrail (skill whatsapp-studio) ─────────────────────────────
const SYSTEM_PROMPT = `Sei l'assistente virtuale dello Studio Tributario Branca,
studio di commercialista/tributarista, consulente del lavoro e amministratore di condominio.
Titolare: Dott. Mariano Branca — Via Operai 102, 98051 Barcellona P.G. (ME).

Stai rispondendo a un cliente su WhatsApp. RISPECCHIA IL REGISTRO del cliente: se ti dà del
tu rispondi col tu, se ti dà del Lei rispondi col Lei (nel dubbio, dai del Lei). Tono sempre
cordiale e professionale. Le tue risposte di merito vengono riviste dal Dott. Branca prima
dell'invio, quindi puoi entrare nel merito tecnico con competenza, senza rinvii generici.

PRIORITÀ DI LETTURA — rispondi innanzitutto al MESSAGGIO/I PIÙ RECENTE/I DEL CLIENTE (la sezione
marcata come tale nel transcript): è quello il punto di partenza della tua risposta, non lo
storico. Consulta lo STORICO PRECEDENTE solo per: (a) non ripetere o contraddire quanto il
Dott. Branca ha già detto/fatto DI PERSONA (i suoi messaggi compaiono come [STUDIO]); (b) capire
a cosa si riferisce il cliente quando il messaggio più recente è ambiguo, breve, o INSISTE su
qualcosa già discusso (ripete la stessa domanda, dice "come detto", "ancora non mi risponde",
ecc.) — solo in questi casi vai ad analizzare le conversazioni antecedenti per ricostruire il
contesto esatto. Se il Dott. Branca ha GIÀ gestito o risposto all'ultima richiesta e non serve
aggiungere altro, chiama already_handled (NON inviare alcun messaggio).

OBIETTIVO — risposte TECNICHE, ACCURATE e UTILI (mai superficiali):
- Inquadra correttamente la questione: qualifica l'atto o l'adempimento di cui si parla
  (es. avviso di accertamento, cartella di pagamento, avviso bonario, intimazione di
  pagamento, F24, dichiarazione, ravvedimento, rateizzazione) e spiega con chiarezza il
  meccanismo rilevante.
- Cita il riferimento normativo o l'istituto pertinente quando lo conosci con certezza
  (es. accertamento con adesione D.lgs. 218/1997; ravvedimento operoso art. 13 D.lgs.
  472/1997; ricorso alla Corte di Giustizia Tributaria art. 21 D.lgs. 546/1992), in
  linguaggio comprensibile per il cliente.
- Indica con precisione i TERMINI/scadenze applicabili (es. 60 giorni dalla notifica per
  ricorso o adesione), ricordando SEMPRE al cliente di verificare la DATA DI NOTIFICA
  esatta riportata sull'atto, da cui decorrono i termini.
- Quando proponi un'azione, spiega in 2-3 punti i passaggi concreti.

LIMITI DI ACCURATEZZA (zero-errori — inderogabili):
1. NON inventare MAI norme, importi, percentuali, scadenze o dati che non conosci con
   certezza. Se un dato va verificato sui documenti o sulla normativa aggiornata, dillo con
   franchezza e rimanda l'esattezza all'incontro: meglio prudente che impreciso.
2. NIENTE quantificazioni puntuali del singolo caso via chat (importo esatto dovuto,
   calcolo preciso di sanzioni/interessi sulla sua posizione): puoi spiegare CRITERI e
   ORDINI DI GRANDEZZA normativi, ma il numero definitivo si determina in studio sui suoi
   documenti.
3. Niente strategie difensive di dettaglio o pareri definitivi su contenziosi via chat:
   inquadra la questione e i termini, poi rimanda allo studio per la decisione operativa.

GESTIONE OPERATIVA:
- GESTIONE APPUNTAMENTI (in autonomia): quando il cliente chiede un appuntamento gestisci tu
  l'intero scambio, confrontandoti con l'agenda. Usa get_availability per proporre 2-3 slot
  reali (incrocia già l'agenda Google e gli orari studio); quando il cliente sceglie uno slot
  chiama propose_booking; se in un secondo momento conferma di poter venire chiama
  confirm_appointment. Non serve l'approvazione dello studio per concordare data e ora.
  SPOSTAMENTO: se il cliente chiede di spostare un appuntamento esistente, usa get_availability
  e poi propose_booking sul nuovo slot — il vecchio appuntamento viene annullato in automatico
  alla registrazione del nuovo. DISDETTA: se il cliente vuole ANNULLARE l'appuntamento senza
  riprogrammarlo ora, chiama cancel_appointment (libera l'agenda e avvisa lo studio), poi
  conferma con garbo la disdetta e resta a disposizione per una nuova data.
  LISTA D'ATTESA: se get_availability NON restituisce alcuno slot (agenda piena o chiusura),
  NON proporre mai date a mano: proponi al cliente di essere inserito in lista d'attesa e, se
  accetta, chiama add_to_waitlist col motivo — verrà ricontattato in automatico su questo
  stesso canale appena si libereranno nuove date.
- RICHIESTA DI PASSARE SUBITO/ORA in studio (in autonomia, diverso da un appuntamento futuro:
  "posso passare adesso/subito/in giornata?", NON "vorrei un appuntamento"): chiama SEMPRE
  check_walkin_now (mai a intuito, sempre incrociando l'agenda reale e l'orario di lavoro) e
  segui la sua indicazione:
  • Se lo studio è aperto ORA e il Dott. Branca è libero → dai l'OK di passare subito.
  • Se lo studio è aperto ma il Dott. Branca è impegnato → dai comunque l'OK di passare, ma
    avvisa con garbo che dovrà attendere, indicando quanti impegni risultano prima di lui/lei.
  • Se lo studio ORA è chiuso → NON spiegare il motivo della chiusura: comunica solo la prima
    data/ora utile per incontrarsi (fornita dallo strumento), dicendo che prima di quella non è
    possibile.
  In ogni caso aggiungi che, se vuole, può nel frattempo inviare tutta la documentazione su
  questa chat o via email per una valutazione preliminare.
- DOCUMENTI PRIMA DELL'INCONTRO: se l'appuntamento riguarda documenti da esaminare (atti o
  cartelle notificate, fatture, dichiarazioni, contratti, avvisi), CHIARISCI sempre che il
  cliente deve inviarli PRIMA dell'appuntamento: solo così potranno essere visionati e poi
  DISCUSSI durante l'incontro. Senza i documenti in anticipo l'incontro non sarebbe produttivo.
  COME inviarli: su questa chat WhatsApp OPPURE via email a studiobranca@tiscali.it o
  studiobranca@icloud.com. Indica SEMPRE questi due indirizzi quando chiedi la documentazione.
- RICHIESTE DI CHIAMATA: se il cliente chiede di essere richiamato o lamenta una chiamata
  senza risposta ("mi chiami", "ti ho chiamato e non rispondi", "richiamatemi"), NON promettere
  una chiamata immediata: spiega con cortesia che ora non è possibile rispondere subito e che lo
  studio lo richiamerà appena libero. Poi: chiedi se è urgente (se sì chiama need_human per
  segnalarlo); invitalo a inviare su questa chat i documenti utili; ed eventualmente proponi un
  appuntamento (gestione agenda qui sopra).
- RICHIESTE DI CHIARIMENTO: se dal messaggio emerge che il cliente ha bisogno di un chiarimento
  o di una consulenza, tendi SEMPRE a ricondurre la questione a un appuntamento IN PRESENZA,
  facendoti inviare PRIMA la documentazione pertinente per la valutazione. Puoi dare un primo
  inquadramento tecnico, ma la trattazione vera avviene in studio sui documenti.
- ORARI STUDIO (get_availability li applica GIÀ con le date esatte; non proporre MAI fuori da
  questi e non citare orari diversi da quelli che get_availability restituisce):
  • STANDARD (fino al 9 luglio 2026 e da settembre 2026): lun/mar/gio 9:00–18:00 continuato;
    mer/ven 9:00–13:00.
  • 10–25 luglio 2026: ORARIO UNICO 9:00–14:00 tutti i feriali.
  • 26 luglio–31 agosto 2026: studio CHIUSO, NON fissare alcun appuntamento in questo periodo
    (se il cliente chiede, spiega che si riprende dal 1° settembre e proponi date da settembre;
    se get_availability non restituisce slot proponibili, offri la lista d'attesa —
    add_to_waitlist — così sarà ricontattato in automatico alla riapertura).
  • settembre 2026: di nuovo orario STANDARD.
  MAI sabato e domenica, MAI feste comandate. In ogni caso fidati SEMPRE degli slot reali di
  get_availability (incrocia già l'agenda Google del Dott. Branca).
- ANALISI DEL DOCUMENTO RICEVUTO (obbligatorio, PRIMA di rispondere — mai risposte generiche):
  se nel messaggio più recente compare "📄 Documento ricevuto ... — analisi automatica: ..."
  (foto WhatsApp) oppure, per le email, "[Allegato "..."] analisi automatica: ...", quella è
  una descrizione GIÀ FATTA in automatico di cosa contiene la foto/allegato — LEGGILA prima di
  scrivere la risposta, è la base per capire di che documento si tratta. È un'estrazione
  automatica (può essere incompleta o imprecisa su un documento sfocato/parziale): valgono su
  di essa gli stessi LIMITI DI ACCURATEZZA sopra, non darla mai per certa al 100% né citarla al
  cliente come fosse una tua lettura infallibile.
  1. VERIFICA LA CORRISPONDENZA: la richiesta del cliente riguarda proprio il documento appena
     arrivato, o è il completamento di una pratica aperta in precedenza (appuntamento già
     fissato, ricorso in corso, documento già chiesto)? Usa lo STORICO PRECEDENTE per capirlo.
  2. Se trovi corrispondenza chiara: rispondi nel merito citando cosa hai riconosciuto (tipo di
     atto, mittente/ente) SENZA calcolare importi/scadenze specifiche (resta il limite sopra).
  3. Se NON trovi corrispondenza, o non capisci a cosa si riferisce il documento o la richiesta
     (es. un allegato isolato senza spiegazione, o un messaggio breve tipo "quello che ti avevo
     detto"): chiama SEMPRE find_previous_requests — cerca sia su WhatsApp sia sulle email
     collegate dello stesso cliente (raffronto multi-canale) — per ricostruire il contesto PRIMA
     di rispondere. Non limitarti a "l'abbiamo ricevuto, lo esamineremo" senza averci provato.
  4. Se dopo la ricerca resta poco chiaro: o chiedi con garbo al cliente di INTEGRARE la
     documentazione/spiegare a cosa si riferisce (indica in modo specifico cosa manca, non in
     modo generico), oppure — se il tema richiede comunque un confronto diretto — proponi un
     appuntamento (gestione agenda sopra: SEMPRE confrontandoti con orari studio e agenda reale
     via get_availability, mai a caso).
  5. Se resti in dubbio anche dopo aver cercato e chiesto, o la situazione ha margini di rischio
     (termini che potrebbero già decorrere, atto che non riesci a inquadrare con certezza):
     chiama need_human, non indovinare.

URGENZE (cartella esattoriale, avviso di accertamento, atto notificato con termini in
decorrenza, udienza, pignoramento): chiama need_human per allertare il Dott. Branca, MA
fornisci comunque al cliente un inquadramento tecnico utile (di che atto si tratta, quale
termine corre, cosa portare) e rassicura che il Dott. Branca lo seguirà personalmente e in
tempi rapidi. Chiedi copia dell'atto su questa chat.

REGOLE GENERALI:
1. Italiano. Messaggi chiari e completi quanto serve, ben strutturati (usa elenchi puntati
   quando aiutano la lettura), senza muri di testo né tecnicismi gratuiti.
2. REGISTRO: rispecchia sempre il tu/Lei usato dal cliente (vedi sopra).
3. Resta SEMPRE sui temi dello studio: NON aggiungere chiacchiere personali, social o
   battute tratte dalla cronologia (inviti, eventi privati, vacanze, ecc.).
4. MESSAGGI NON DI LAVORO: molti clienti sono anche amici e mescolano lavoro e chiacchiere.
   Occupati SOLO del lavoro. Se l'ultimo messaggio del cliente NON contiene una richiesta o un
   argomento di studio (è solo personale, sociale, off-topic), chiama ignore_personal per
   classificarlo e scrivi comunque un BREVE messaggio di cortesia: che il Dott. Branca al
   momento è impegnato e lo ricontatterà appena libero. Nient'altro: non alimentare la
   conversazione personale.
5. CHIUSURA (sempre, in OGNI messaggio — anche dopo aver fissato un appuntamento e anche nei
   messaggi di cortesia): ricorda che per parlare con lo studio negli orari di segreteria si
   può chiamare lo 0909797187, e chiudi con la firma "Assistente Virtuale — Studio Tributario
   Branca".
6. FORMATTAZIONE (WhatsApp NON è Markdown — inderogabile): WhatsApp interpreta il *singolo
   asterisco* come grassetto. NON usare MAI il doppio asterisco **così** (compare come testo
   letterale con gli asterischi, un errore che il cliente vede subito): se serve enfasi usa
   *singolo asterisco*, con moderazione (poche parole chiave per messaggio, non frasi intere).
   NON usare intestazioni Markdown (###, ecc.) né tabelle. Per gli elenchi usa un trattino "- "
   a inizio riga, semplice testo. EMOJI: al massimo una, solo se pertinente e sobria (es. ✅ per
   una conferma), MAI più di una nello stesso messaggio e MAI emoji decorative o giocose (🎉😊
   e simili): lo studio comunica con un tono professionale, non da chat informale.

SOLO IL TESTO PER IL CLIENTE (INDEROGABILE — la tua risposta viene inviata così com'è):
- Il blocco di testo che produci come risposta deve contenere ESCLUSIVAMENTE le parole
  rivolte al cliente, esattamente come le leggerà lui. Comincia direttamente dal saluto o
  dalla frase per il cliente.
- È VIETATO scrivere nel testo qualsiasi: ragionamento, analisi del messaggio del cliente,
  spiegazione di cosa stai facendo o perché, meta-commento, premessa, note per lo studio,
  didascalie o commenti tra parentesi. Esempi VIETATI da NON scrivere mai:
  "La cliente non ha confermato...", "Il 'va bene' è ambiguo...", "Avviso con garbo e propongo...",
  "Non chiamo confirm_appointment", "Non faccio propose_booking".
- È VIETATO nominare nel testo gli strumenti/funzioni interni (get_availability, propose_booking,
  confirm_appointment, cancel_appointment, add_to_waitlist, need_human, check_walkin_now,
  note_documents, already_handled, ignore_personal, find_previous_requests) o qualunque nome
  di funzione/tool.
- Le decisioni operative (proporre/confermare/spostare un appuntamento, segnalare un'urgenza,
  classificare un messaggio) si prendono ESCLUSIVAMENTE chiamando i tool con la tool-call
  apposita: NON vanno descritte, motivate o annunciate nel testo per il cliente.
- Se hai bisogno di ragionare, fallo tramite le tool-call e i loro risultati, mai nel testo
  finale. Il testo finale è solo ciò che il cliente deve leggere: nient'altro.`;

const TOOLS = [
  {
    name: 'get_availability',
    description: 'Restituisce i prossimi slot liberi reali dell\'agenda dello studio (incrocia Google Calendar con gli orari studio). Usalo prima di proporre un appuntamento.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Giorni avanti da considerare (default 14)' } },
    },
  },
  {
    name: 'check_walkin_now',
    description: 'Quando il cliente chiede di passare SUBITO/ORA/in giornata in studio (NON un appuntamento futuro): controlla se lo studio è aperto in questo momento, se il Dott. Branca è libero ADESSO, quanti impegni restano oggi prima che si liberi, e — se lo studio è chiuso ora — la prima data/ora utile. Per fissare un appuntamento futuro usa invece get_availability.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_booking',
    description: 'Registra la proposta di appuntamento sullo slot scelto dal cliente. NON conferma definitivamente: l\'evento verrà creato come "DA CONFERMARE" e validato dallo studio.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Data YYYY-MM-DD' },
        start: { type: 'string', description: 'Ora inizio HH:MM (24h)' },
        reason: { type: 'string', description: 'Motivo/oggetto dell\'appuntamento' },
      },
      required: ['date', 'start', 'reason'],
    },
  },
  {
    name: 'confirm_appointment',
    description: 'Conferma DEFINITIVAMENTE l\'appuntamento che era "da confermare" per questo cliente, perché il cliente ha appena confermato di poter venire. Aggiorna l\'agenda dello studio (evento da "[DA CONFERMARE]" a confermato) e avvisa il Dott. Branca. Chiamalo SOLO se nel system risulta un appuntamento in attesa di conferma e il cliente lo ha confermato; NON usarlo se il cliente chiede di spostare o disdire.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancel_appointment',
    description: 'DISDICE l\'appuntamento futuro di questo cliente (in attesa di conferma o già confermato) perché il cliente ha chiesto di ANNULLARLO e NON vuole riprogrammarlo ora: libera lo slot in agenda e avvisa lo studio. NON usarlo se il cliente vuole SPOSTARE l\'appuntamento: in quel caso usa get_availability e poi propose_booking (il vecchio appuntamento viene annullato automaticamente alla registrazione del nuovo).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Motivo della disdetta riferito dal cliente (facoltativo)' } },
    },
  },
  {
    name: 'add_to_waitlist',
    description: 'Inserisce il cliente nella LISTA D\'ATTESA dello studio quando get_availability NON ha restituito alcuna disponibilità (chiusura estiva o agenda piena) e il cliente vuole comunque un appuntamento: appena si libereranno nuove date verrà ricontattato in automatico su questo stesso canale. Chiamalo SOLO dopo get_availability senza slot e col consenso del cliente a essere ricontattato.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Motivo/oggetto dell\'appuntamento richiesto (es. "avviso di accertamento", "dichiarazione redditi")' } },
      required: ['reason'],
    },
  },
  {
    name: 'need_human',
    description: 'Segnala che la richiesta è urgente o complessa e deve gestirla direttamente il Dott. Branca (no risposta automatica risolutiva).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Perché serve l\'intervento umano' } },
      required: ['reason'],
    },
  },
  {
    name: 'ignore_personal',
    description: 'Classifica il messaggio come personale/non di lavoro (chiacchiere, social, off-topic), così non viene riportato nel digest di lavoro. NON impedisce la risposta: dopo averlo chiamato scrivi comunque un BREVE messaggio di cortesia (il Dott. Branca è impegnato e ricontatterà appena libero).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Perché è personale/non di lavoro' } },
      required: ['reason'],
    },
  },
  {
    name: 'note_documents',
    description: 'Quando il cliente INVIA documentazione (atti, cartelle, fatture, dichiarazioni, contratti, avvisi, foto di documenti), registra un BREVE sunto di a cosa si riferisce: verrà annotato sull\'appuntamento in agenda come promemoria per lo studio (di cosa si parlerà). Usalo ogni volta che arrivano documenti.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Sunto breve di cosa sono / a cosa si riferiscono i documenti (es. "cartella Agenzia Riscossione 2023", "contratto di locazione + 3 fatture")' } },
      required: ['summary'],
    },
  },
  {
    name: 'already_handled',
    description: 'Usa questo SOLO quando dalla conversazione risulta che il Dott. Branca (messaggi [STUDIO]) ha GIÀ risposto o gestito di persona l\'ultima richiesta del cliente e non serve aggiungere altro: NON verrà inviato alcun messaggio (niente bozza, niente cortesia).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Cosa ha già fatto/detto lo studio di persona' } },
      required: ['reason'],
    },
  },
  {
    name: 'find_previous_requests',
    description: 'Cerca nello storico SIA dei messaggi WhatsApp SIA delle email collegate allo stesso cliente (raffronto multi-canale) se aveva già inviato lo stesso documento o fatto la stessa richiesta in passato. Usalo SEMPRE prima di rispondere a una richiesta/invio documenti, e SEMPRE quando non capisci a cosa si riferisce un documento o una richiesta.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Parole chiave della richiesta/documento (es. "dichiarazione redditi", "visura", "f24")' } },
      required: ['query'],
    },
  },
];

// Nomi REALI degli strumenti interni, ricavati dalle definizioni sopra: usati dal
// guardrail per non lasciarne traccia nel testo inviato al cliente. Derivati (non a
// mano) così restano automaticamente in sincronia se si aggiunge/rimuove un tool.
export const BOT_TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

/**
 * Ripulisce una risposta prima dell'invio, usando i nomi-tool reali di questo bot.
 * Vedi server/sanitize.ts. Se `safe` è false il chiamante NON deve auto-inviare:
 * la risposta va lasciata come BOZZA da revisionare a mano.
 */
export function sanitizeReply(raw: string): SanitizeResult {
  return sanitizeClientText(raw, BOT_TOOL_NAMES);
}

// ─── Cronologia conversazione → trascritto ───────────────────────────────────
function buildTranscript(phone: string, contactName: string): string {
  const rows = db.prepare(`
    SELECT direction, content, is_audio, is_image
    FROM live_messages
    WHERE phone = ? AND content IS NOT NULL AND content != ''
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(phone, HISTORY_LIMIT) as any[];
  rows.reverse();
  const lineOf = (r: any) => `[${r.direction === 'sent' ? 'STUDIO' : 'CLIENTE'}] ${(r.content || '').replace(/\n+/g, ' ').trim()}`;

  // Isola l'ultimo blocco continuo di messaggi CLIENTE (spesso il cliente scrive più
  // messaggi di fila — testo, poi una foto, poi un'altra riga — prima che si risponda):
  // è quello il "messaggio più recente" a cui rispondere, il resto è solo storico/contesto.
  let splitIdx = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].direction === 'received') splitIdx = i; else break;
  }
  const storico = rows.slice(0, splitIdx).map(lineOf);
  const recenti = rows.slice(splitIdx).map(lineOf);

  const storicoBlock = storico.length
    ? `STORICO PRECEDENTE (solo per contesto/continuità — non è la base della risposta):\n${storico.join('\n')}\n\n`
    : '';
  const recentiBlock = recenti.length ? recenti.join('\n') : '(nessun nuovo messaggio del cliente)';

  return `Conversazione WhatsApp con ${contactName} (${phone}):\n\n${storicoBlock}MESSAGGIO/I PIÙ RECENTE/I DEL CLIENTE — rispondi PRINCIPALMENTE a questo:\n${recentiBlock}\n\nGenera la prossima risposta dello STUDIO basandoti innanzitutto sul blocco più recente qui sopra; usa lo storico solo per non ripetere/contraddire quanto già detto/fatto, o se il messaggio più recente è ambiguo o insiste su qualcosa già discusso.`;
}

interface DraftResult {
  draftText: string;
  proposedEvent: { date: string; start: string; end: string; reason: string } | null;
  needsHuman: boolean;
  humanReason?: string;
  personal?: boolean;
  // true quando la risposta nasce dal flusso agenda (disponibilità/proposta/conferma):
  // questi messaggi li invia il bot in autonomia (l'agenda è già stata incrociata).
  appointmentFlow?: boolean;
  // true quando il Dott. Branca ha già gestito di persona l'ultima richiesta → nessun messaggio.
  handled?: boolean;
  // true quando il bot ha registrato documentazione ricevuta (tool note_documents):
  // su email autorizza l'invio automatico della risposta (conferma ricezione + integrazione).
  docNoted?: boolean;
}

// Esito della generazione: 'work' (bozza da approvare) o 'personal' (chat privata,
// nessuna azione/bozza). null = il bot non ha potuto operare.
export interface DraftOutcome {
  kind: 'work' | 'personal';
  result: DraftResult | null;
}

// Classificazione per-messaggio (lavoro/personale) usata dal digest per riportare
// SOLO il lavoro, anche sui contatti misti amico+cliente.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_msg_class (
    message_id TEXT PRIMARY KEY,
    phone TEXT,
    day TEXT,
    kind TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_msg_class_day ON bot_msg_class(day);
`);
export function recordClassification(messageId: string, phone: string, day: string, kind: 'work' | 'personal'): void {
  if (!messageId) return;
  db.prepare(`INSERT OR REPLACE INTO bot_msg_class (message_id, phone, day, kind) VALUES (?, ?, ?, ?)`).run(messageId, phone, day, kind);
}

function endTime(start: string): string {
  const [h, m] = start.split(':').map((x) => parseInt(x, 10));
  const eh = (h + 1) % 24;
  return `${String(eh).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

async function runTool(name: string, input: any, out: DraftResult, phone: string): Promise<string> {
  if (name === 'find_previous_requests') {
    const kws = String(input?.query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 6);
    if (!kws.length) return 'Nessun termine utile per la ricerca.';
    const cutoff = Date.now() - 2 * 86400000; // ignora le ultime 48h (conversazione corrente)

    // Cerca sia su WhatsApp SIA sulle email collegate in rubrica allo stesso cliente
    // (raffronto multi-canale): il cliente potrebbe aver scritto un messaggio ora ma aver
    // già inviato lo stesso documento per email tempo fa, o viceversa.
    const { phone: waPhone, email } = resolveIdentities(phone);

    let waHits: { data: string; testo: string }[] = [];
    if (waPhone) {
      const rows = db.prepare(`
        SELECT content, timestamp FROM live_messages
        WHERE phone = ? AND direction = 'received' AND content IS NOT NULL
        ORDER BY timestamp DESC LIMIT 300
      `).all(waPhone) as any[];
      waHits = rows.filter((r) => {
        const t = Date.parse(r.timestamp);
        return !isNaN(t) && t < cutoff && kws.some((k) => (r.content || '').toLowerCase().includes(k));
      }).slice(0, 5).map((r) => ({ data: (r.timestamp || '').slice(0, 10), testo: (r.content || '').replace(/\n+/g, ' ').slice(0, 90) }));
    }

    let emailHits: { data: string; testo: string }[] = [];
    if (email) {
      try {
        const domain = '@' + (email.split('@')[1] || '');
        const rows = db.prepare(`
          SELECT subject, snippet, email_date FROM incoming_emails
          WHERE (lower(from_addr) = ? OR lower(from_addr) LIKE ?) AND email_date IS NOT NULL
          ORDER BY email_date DESC LIMIT 300
        `).all(email, `%${domain}`) as any[];
        emailHits = rows.filter((r) => {
          const t = Date.parse(r.email_date);
          const hay = `${r.subject || ''} ${r.snippet || ''}`.toLowerCase();
          return !isNaN(t) && t < cutoff && kws.some((k) => hay.includes(k));
        }).slice(0, 5).map((r) => ({ data: (r.email_date || '').slice(0, 10), testo: `${r.subject || ''} — ${(r.snippet || '').slice(0, 70)}` }));
      } catch { /* tabella email non disponibile: non bloccare la ricerca WhatsApp */ }
    }

    if (!waHits.length && !emailHits.length) return 'Nessuna richiesta o documento simile inviato in passato dal cliente (né su WhatsApp né via email).';
    const lines: string[] = [];
    if (waHits.length) lines.push('Su WhatsApp:', ...waHits.map((h) => `- ${h.data}: "${h.testo}"`));
    if (emailHits.length) lines.push('Via email:', ...emailHits.map((h) => `- ${h.data}: "${h.testo}"`));
    return 'Richieste/documenti SIMILI già inviati in passato (cita la data e il canale al cliente):\n' + lines.join('\n');
  }
  if (name === 'get_availability') {
    out.appointmentFlow = true;
    const days = Math.min(Math.max(parseInt(input?.days, 10) || 14, 1), 30);
    const { slots, calendarChecked } = await getAvailability(days);
    if (!slots.length) {
      return `${calendarChecked ? '' : '(agenda non verificata su Calendar) '}NESSUNA disponibilità nei prossimi ${days} giorni (agenda piena o chiusura dello studio). NON proporre MAI date o orari a mano. Proponi al cliente la LISTA D'ATTESA: se accetta di essere ricontattato quando si libereranno nuove date, chiama add_to_waitlist con il motivo dell'appuntamento; verrà ricontattato in automatico su questo stesso canale. Nel frattempo può inviare la documentazione su questa chat o via email.`;
    }
    const txt = formatAvailabilityIT(slots);
    // Elenco macchina-leggibile con DATA ESATTA (YYYY-MM-DD): il modello DEVE
    // copiare questi valori in propose_booking, mai inventare la data/anno.
    const iso = slots.slice(0, 12).map((s) => `${s.date} ${s.start}`).join('; ');
    return `${calendarChecked ? '' : '(agenda non verificata su Calendar) '}Prossime disponibilità (da mostrare al cliente):\n${txt}\n\nSlot con data esatta da usare in propose_booking (date=YYYY-MM-DD, start=HH:MM): ${iso}`;
  }
  if (name === 'check_walkin_now') {
    out.appointmentFlow = true;
    const s = await getNowStatus();
    if (s.isOpenNow) {
      if (s.freeNow) {
        return 'Lo studio è APERTO ora e il Dott. Branca è LIBERO: dai al cliente l\'OK di passare subito. Aggiungi che, se comodo, può inviare fin da ora la documentazione su questa chat o via email, così viene già valutata al suo arrivo.';
      }
      const impegni = s.appointmentsRemainingToday > 0
        ? ` Risultano ${s.appointmentsRemainingToday} impegn${s.appointmentsRemainingToday === 1 ? 'o' : 'i'} in agenda prima di lui/lei oggi.`
        : '';
      return `Lo studio è APERTO ora ma il Dott. Branca è IMPEGNATO: dai comunque l'OK di passare, ma avvisa che dovrà attendere.${impegni} Nel frattempo può inviare la documentazione su questa chat o via email per la valutazione.`;
    }
    if (s.nextSlot) {
      return `Lo studio ORA è chiuso. NON spiegare il motivo della chiusura: comunica solo che prima di ${formatDateIT(s.nextSlot.date)} alle ${s.nextSlot.start} non è possibile incontrarsi. Nel frattempo può comunque inviare tutta la documentazione su questa chat o via email per una valutazione preliminare.`;
    }
    return 'Lo studio ORA è chiuso e non risulta una disponibilità nei prossimi giorni: invita il cliente a inviare la documentazione su questa chat o via email nel frattempo; sarà ricontattato appena possibile per un appuntamento.';
  }
  if (name === 'propose_booking') {
    const date = String(input?.date || '');
    const start = String(input?.start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) {
      return 'Errore: data o ora non valide. Usa get_availability e riprova con uno slot esatto.';
    }
    out.proposedEvent = { date, start, end: endTime(start), reason: String(input?.reason || 'Appuntamento') };
    out.appointmentFlow = true;
    return 'Proposta registrata. Comunica al cliente lo slot e che resta in attesa di conferma, ringrazia e — se l\'incontro riguarda documenti da esaminare — CHIARISCI che deve inviarli PRIMA dell\'appuntamento (es. atti/cartelle notificate, fatture, dichiarazioni, contratti, avvisi), su questa chat WhatsApp OPPURE via email a studiobranca@tiscali.it o studiobranca@icloud.com: solo così potranno essere visionati e poi discussi durante l\'incontro. Infine chiedigli di confermare quando avrà la certezza di poter venire.';
  }
  if (name === 'confirm_appointment') {
    out.appointmentFlow = true;
    const appt = getPendingAppointment(phone);
    if (!appt) {
      return 'Non risulta alcun appuntamento in attesa di conferma per questo cliente: non confermare nulla, prosegui normalmente.';
    }
    const r = await confirmAppointmentRow(appt, { notify: true });
    return `Appuntamento confermato e ${r.calendarUpdated ? 'agenda aggiornata' : 'segnalato al Dott. Branca'}. Scrivi al cliente un breve messaggio che CONFERMA l'appuntamento del ${appt.date} alle ${appt.start}, ringrazia, e — se l'incontro riguarda documenti da esaminare — RIBADISCI che deve inviarli PRIMA dell'appuntamento (su questa chat WhatsApp oppure via email a studiobranca@tiscali.it o studiobranca@icloud.com), così potranno essere visionati e discussi durante l'incontro; indica che lo studio è in Via Operai 102, Barcellona P.G. (ME).`;
  }
  if (name === 'cancel_appointment') {
    out.appointmentFlow = true;
    const appts = getActiveFutureAppointments(phone);
    if (!appts.length) {
      return 'Non risulta alcun appuntamento futuro da disdire per questo cliente: NON confermare alcuna disdetta; se serve chiedi con garbo a quale appuntamento si riferisce.';
    }
    for (const a of appts) {
      try { await cancelAppointmentRow(a); }
      catch (e: any) { console.error('[Chatbot] disdetta appuntamento:', e.message); }
    }
    const first = appts[0];
    const motivo = String(input?.reason || '').trim().slice(0, 200);
    try {
      await sendTextMessage(
        getControlNumber(),
        `❌ ${first.contact_name || phone} ha DISDETTO l'appuntamento:\n📅 ${first.date} ore ${first.start} — ${first.reason || 'Appuntamento'}${motivo ? `\nMotivo: ${motivo}` : ''}\nAgenda aggiornata (evento annullato).`,
      );
    } catch (e: any) { console.error('[Chatbot] notifica disdetta fallita:', e.message); }
    return `Appuntamento del ${first.date} alle ${first.start} DISDETTO e agenda aggiornata. Scrivi al cliente un breve messaggio che conferma la disdetta, ringrazia, e resta a disposizione per fissare un nuovo appuntamento quando vorrà (se indica già una nuova preferenza, usa get_availability per proporre slot reali).`;
  }
  if (name === 'add_to_waitlist') {
    out.appointmentFlow = true;
    const reason = String(input?.reason || 'Appuntamento').trim().slice(0, 200) || 'Appuntamento';
    const c = db.prepare(`SELECT contact_name FROM conversations WHERE phone = ?`).get(phone) as any;
    addToWaitlist(phone, c?.contact_name || null, reason);
    return 'Cliente inserito in lista d\'attesa. Comunicagli che al momento non ci sono disponibilità in agenda, che è stato inserito in lista d\'attesa e che verrà ricontattato su questo stesso canale con le prime date disponibili appena si libereranno. Nel frattempo può inviare la documentazione utile su questa chat o via email a studiobranca@tiscali.it o studiobranca@icloud.com, così sarà già valutata.';
  }
  if (name === 'need_human') {
    out.needsHuman = true;
    out.humanReason = String(input?.reason || '');
    return 'Segnalato al Dott. Branca. Scrivi al cliente un messaggio rassicurante (verrà ricontattato al più presto).';
  }
  if (name === 'ignore_personal') {
    out.personal = true;
    return 'Classificato come personale/non di lavoro. Ora scrivi comunque un BREVE messaggio di cortesia: che il Dott. Branca al momento è impegnato e ricontatterà appena libero. Chiudi col recapito di segreteria e la firma. Nient\'altro.';
  }
  if (name === 'note_documents') {
    const summary = String(input?.summary || '').trim().slice(0, 300);
    if (!summary) return 'Nessun contenuto da annotare.';
    out.docNoted = true;
    recordDocNote(phone, summary);
    // Se c'è già un appuntamento in agenda per questo cliente, annota subito sull'evento.
    const appt = getActiveAppointmentWithEvent(phone);
    if (appt?.event_id) {
      try {
        await appendEventDescription(appt.event_id, `📎 Documenti ricevuti (${new Date().toISOString().slice(0, 10)}): ${summary}`);
        markDocNotesAttached(phone);
      } catch (e: any) { console.error('[Chatbot] annota documenti su evento:', e.message); }
    }
    return 'Documentazione annotata come promemoria per l\'appuntamento. Conferma al cliente la ricezione, indica che sarà esaminata prima dell\'incontro e RICORDA che eventuali altri documenti utili vanno inviati PRIMA dell\'appuntamento, su questa chat WhatsApp oppure via email a studiobranca@tiscali.it o studiobranca@icloud.com.';
  }
  if (name === 'already_handled') {
    out.handled = true;
    return 'Ok: il Dott. Branca ha già gestito la richiesta di persona. NON produrre alcun messaggio.';
  }
  return 'Strumento sconosciuto.';
}

/**
 * Genera la bozza di risposta. Ritorna null se il bot non può operare
 * (manca ANTHROPIC_API_KEY) o se non produce testo.
 */
export async function generateDraft(phone: string, contactName: string): Promise<DraftOutcome | null> {
  return generateReplyCore(phone, contactName, buildTranscript(phone, contactName), 'whatsapp');
}

/**
 * Cuore della generazione risposta, condiviso tra WhatsApp ed EMAIL. `key` è
 * l'identificativo del contatto (telefono per WhatsApp, indirizzo email per le
 * email): è la chiave usata per appuntamenti e note documenti, indipendente per
 * canale. `userContent` è il messaggio/transcript da passare al modello.
 */
export async function generateReplyCore(
  key: string, contactName: string, userContent: string, channel: 'whatsapp' | 'email' = 'whatsapp',
): Promise<DraftOutcome | null> {
  // ─── GUARD VIP STRUTTURALE (regola inderogabile di Mariano, 08/07/2026) ──────
  // I contatti VIP/high li gestisce SOLO Mariano di persona: il bot non genera
  // NULLA per loro (né bozza, né auto-risposta, né cortesia), su nessun canale.
  // Il webhook WhatsApp li esclude già a monte (priority vip/high); questo è il
  // punto di blocco UNICO che copre anche il canale EMAIL (dove il guard mancava)
  // e qualunque chiamante futuro.
  if (isVipContact(key)) {
    console.log(`[Chatbot] Contatto VIP/high (${contactName} — ${key}): nessuna generazione, gestisce Mariano.`);
    return null;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Chatbot] ANTHROPIC_API_KEY non configurata: bozza non generata.');
    return null;
  }

  const out: DraftResult = { draftText: '', proposedEvent: null, needsHuman: false };
  const messages: any[] = [{ role: 'user', content: userContent }];
  const dest = channel === 'email' ? 'in risposta a questa email' : 'su questa chat';

  // Data odierna (Europe/Rome) iniettata nel system: senza, il modello sbaglia
  // l'anno quando il cliente cita un giorno senza anno (es. "martedì 17").
  const todayStr = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome',
  });
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

  // Se per questo cliente c'è un appuntamento "da confermare", informane il modello:
  // se il cliente lo conferma deve chiamare confirm_appointment (aggiorna l'agenda).
  // Dedup appuntamenti: se esiste GIÀ un appuntamento futuro (da confermare o confermato)
  // il modello deve gestire QUELLO, non fissarne un secondo per la stessa cosa.
  const upcomingAppt = getUpcomingAppointment(key);
  const pendingAppt = getPendingAppointment(key);
  let apptBlock = '';
  if (upcomingAppt && upcomingAppt.status === 'confermato') {
    apptBlock = `\n\n⚠️ QUESTO CLIENTE HA GIÀ UN APPUNTAMENTO CONFERMATO IN AGENDA: ${upcomingAppt.date} alle ${upcomingAppt.start}${upcomingAppt.reason ? ` (${upcomingAppt.reason})` : ''}.
- NON proporre e NON fissare un nuovo appuntamento per la stessa questione: l'appuntamento c'è già. Ricordaglielo con garbo (data e ora).
- Solo se il cliente chiede ESPLICITAMENTE di SPOSTARLO, usa get_availability per riproporre nuovi slot (alla registrazione del nuovo con propose_booking il vecchio si annulla da solo); se chiede di DISDIRE senza riprogrammare, chiama cancel_appointment.
- Se serve, ricorda che la documentazione utile va inviata ${dest} PRIMA dell'incontro.`;
  } else if (pendingAppt) {
    apptBlock = `\n\nAPPUNTAMENTO IN ATTESA DI CONFERMA per questo cliente: ${pendingAppt.date} alle ${pendingAppt.start}${pendingAppt.reason ? ` (${pendingAppt.reason})` : ''}.
- NON proporre un secondo appuntamento per la stessa cosa: ce n'è già uno in attesa.
- Se nell'ULTIMO messaggio il cliente CONFERMA che può venire (es. "confermo", "sì va bene", "ci sono", "perfetto", "ok per quel giorno"), chiama confirm_appointment e poi conferma con garbo.
- Se invece chiede di SPOSTARE l'orario, usa get_availability per riproporre nuovi slot; se vuole DISDIRE, chiama cancel_appointment; se è incerto, NON chiamare confirm_appointment.`;
  }

  const channelNote = channel === 'email'
    ? `\n\nCANALE = EMAIL. Stai rispondendo via email a un messaggio che il cliente ha inviato allo studio (spesso ALLEGANDO documenti). Scrivi una email cordiale e completa: saluto iniziale ("Gentile ...,"), corpo, chiusura con firma. Quando chiedi documenti o ne confermi la ricezione, di' di inviarli "${dest}". FORMATTAZIONE: qui la regola 6 sul *singolo asterisco* NON si applica — l'email è testo semplice, nessun carattere di enfasi verrà interpretato. NON usare asterischi, cancelletti o altri simboli Markdown per grassetto/enfasi/titoli: scrivi in prosa piana, ordinata in paragrafi brevi, con eventuali elenchi puntati solo col trattino "- ". Nessuna emoji nelle email (canale formale). Per il resto valgono tutte le regole (orari, dedup, zero-errori, niente quantificazioni del singolo caso).`
    : '';

  // REGISTRO tu/Lei (regola 3): rilevato in modo deterministico dai messaggi del
  // cliente e imposto esplicitamente al modello (il solo prompt non bastava). Su EMAIL
  // si usa sempre il Lei (canale formale). Nel dubbio → Lei.
  const reg = channel === 'email' ? 'lei' : detectRegisterFromTranscript(userContent);
  const registerBlock = reg === 'tu'
    ? `\n\n⚠️ REGISTRO DA USARE: il cliente ti dà del TU. Rispondi TUTTO il messaggio dandogli del tu (verbi e pronomi alla 2ª persona singolare: "ti", "tu", "puoi", "ti aspetto"). NON passare al Lei.`
    : `\n\n⚠️ REGISTRO DA USARE: usa il Lei (registro formale di cortesia) per tutto il messaggio.`;

  const system = `${SYSTEM_PROMPT}\n\nData odierna: ${todayStr} (${todayISO}). Usa SEMPRE date coerenti con oggi e non inventare l'anno.${registerBlock}${apptBlock}${channelNote}`;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    let data: any;
    try {
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: getBotModel(),
          max_tokens: 1500,
          system,
          tools: TOOLS,
          messages,
        }),
      });
      if (!resp.ok) {
        console.error('[Chatbot] Anthropic HTTP', resp.status, (await resp.text()).substring(0, 200));
        return null;
      }
      data = await resp.json();
    } catch (e: any) {
      console.error('[Chatbot] Errore chiamata Anthropic:', e.message);
      return null;
    }

    const blocks: any[] = data.content || [];
    // accumula testo
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) out.draftText = text;

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: blocks });
      const toolResults: any[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const result = await runTool(b.name, b.input, out, key);
          toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: result });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue; // nuovo giro per la risposta finale
    }
    break; // end_turn
  }

  // Il Dott. Branca ha già gestito di persona: nessuna azione, nessun messaggio.
  if (out.handled) return null;
  // Non-lavoro: si invia comunque un breve messaggio di cortesia (auto), se prodotto.
  if (out.personal) return { kind: 'personal', result: out.draftText ? out : null };
  if (!out.draftText) return null;
  return { kind: 'work', result: out };
}

// ─── CRUD bozze ──────────────────────────────────────────────────────────────
export function saveDraft(d: {
  phone: string; contactName: string; incoming: string; result: DraftResult;
}): number {
  // 1 sola bozza pending per numero: scarta le precedenti
  db.prepare(`UPDATE bot_drafts SET status = 'rejected' WHERE phone = ? AND status = 'pending'`).run(d.phone);
  const info = db.prepare(`
    INSERT INTO bot_drafts (phone, contact_name, incoming_excerpt, draft_text, proposed_event, needs_human, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    d.phone, d.contactName, (d.incoming || '').substring(0, 300),
    d.result.draftText,
    d.result.proposedEvent ? JSON.stringify(d.result.proposedEvent) : null,
    d.result.needsHuman ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

export function getPendingDrafts(): any[] {
  const rows = db.prepare(`SELECT * FROM bot_drafts WHERE status = 'pending' ORDER BY created_at DESC`).all() as any[];
  return rows.map((r) => ({ ...r, proposed_event: r.proposed_event ? JSON.parse(r.proposed_event) : null }));
}
export function getDraft(id: number): any | null {
  const r = db.prepare(`SELECT * FROM bot_drafts WHERE id = ?`).get(id) as any;
  if (!r) return null;
  return { ...r, proposed_event: r.proposed_event ? JSON.parse(r.proposed_event) : null };
}
export function markDraftSent(id: number): void {
  db.prepare(`UPDATE bot_drafts SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(id);
}
export function markDraftRejected(id: number): void {
  db.prepare(`UPDATE bot_drafts SET status = 'rejected' WHERE id = ?`).run(id);
}

// ─── Approvazione condivisa (usata da endpoint HTTP e da WhatsApp) ───────────
export interface ApproveResult {
  ok: boolean; status: number; conflict?: boolean; message?: string;
  calendar?: any; contactName?: string; hadEvent?: boolean;
}
export async function approveDraftCore(id: number, opts: { text?: string; force?: boolean }): Promise<ApproveResult> {
  const d = getDraft(id);
  if (!d) return { ok: false, status: 404, message: 'Bozza non trovata' };
  if (d.status !== 'pending') return { ok: false, status: 400, message: 'Bozza già gestita' };
  const finalText = (opts.text && String(opts.text).trim()) || d.draft_text;

  // Controllo agenda: se Mariano è impegnato nello slot, blocca (salvo force).
  // ANTI-OVERBOOKING fail-safe (rev. 11/07): shouldBlockSlot blocca anche quando il
  // controllo su Google Calendar va in ERRORE (Google configurato ma non risponde) →
  // niente auto-conferma su slot non verificabile, la bozza resta da approvare a mano.
  if (d.proposed_event && !opts.force) {
    const ev = d.proposed_event;
    const chk = await isSlotBusy(ev.date, ev.start, ev.end);
    if (shouldBlockSlot(chk)) {
      return { ok: false, status: 409, conflict: true, contactName: d.contact_name,
        message: chk.error
          ? `Agenda non verificabile ora (${ev.date} ${ev.start}): lasciata in bozza per sicurezza.`
          : `Risulti impegnato ${ev.date} alle ${ev.start}.` };
    }
  }

  await sendTextMessage(d.phone, finalText);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO live_messages
      (message_id, phone, contact_name, content, direction, timestamp, is_read, created_at)
    VALUES (?, ?, ?, ?, 'sent', ?, 1, ?)
  `).run(`bot_${Date.now()}`, d.phone, d.contact_name || d.phone, finalText, now, now);

  let calendar: any = null;
  if (d.proposed_event) {
    calendar = await materializeProposedEvent(d.phone, d.contact_name, d.proposed_event, 'whatsapp');
  }
  markDraftSent(id);
  broadcastEvent('message', { type: 'sent', phone: d.phone, contactName: d.contact_name, content: finalText, timestamp: now });
  return { ok: true, status: 200, calendar, contactName: d.contact_name, hadEvent: !!d.proposed_event };
}

/**
 * Crea l'evento [DA CONFERMARE] su Google Calendar e traccia l'appuntamento
 * (tabella bot_appointments). Cuore condiviso tra WhatsApp (approveDraftCore) ed
 * EMAIL (modulo email). `key` = telefono o indirizzo email del cliente.
 */
export async function materializeProposedEvent(
  key: string, contactName: string | null,
  ev: { date: string; start: string; end: string; reason: string },
  channel: 'whatsapp' | 'email' = 'whatsapp',
): Promise<any> {
  // SPOSTAMENTO (v2.10): il nuovo appuntamento sostituisce quelli attivi precedenti dello
  // stesso cliente — annullali anche in AGENDA (prima recordAppointment li annullava solo
  // nel DB e in Calendar restava un evento fantasma [DA CONFERMARE]).
  for (const prev of getActiveFutureAppointments(key)) {
    try { await cancelAppointmentRow(prev); }
    catch (e: any) { console.error('[Chatbot] annullo appuntamento precedente:', e.message); }
  }
  // Il cliente ha (ri)ottenuto uno slot: chiudi l'eventuale posizione in lista d'attesa.
  try { db.prepare(`UPDATE bot_waitlist SET status = 'chiuso' WHERE phone = ? AND status IN ('in_attesa','ricontattato')`).run(key); } catch { /* best-effort */ }
  const docNotes = getUnattachedDocNotes(key);
  const docBlock = docNotes.length ? `\n\n${formatDocNotes(docNotes)}` : '';
  const src = channel === 'email' ? 'assistente email' : 'chatbot WhatsApp';
  const calendar = await createCalendarEvent({
    title: `[DA CONFERMARE] ${ev.reason} — ${contactName || key}`,
    description: `Appuntamento proposto dall'${src}.\nCliente: ${contactName || ''} (${key})\nMotivo: ${ev.reason}${docBlock}\n\n⚠️ Confermare con il cliente.`,
    startDate: `${ev.date}T${ev.start}:00`,
    endDate: `${ev.date}T${ev.end}:00`,
  });
  recordAppointment({
    phone: key, contactName, eventId: calendar?.eventId ?? null,
    date: ev.date, start: ev.start, end: ev.end, reason: ev.reason,
  });
  if (docNotes.length) markDocNotesAttached(key);
  return calendar;
}

// ─── Notifica WhatsApp della bozza a Mariano ─────────────────────────────────
export async function notifyDraftToControl(id: number): Promise<void> {
  const d = getDraft(id);
  if (!d) return;
  const parts = [`🆕 Bozza #${d.id} — ${d.contact_name || d.phone}`];
  if (d.needs_human) parts.push('⚠️ URGENTE / da gestire di persona');
  if (d.incoming_excerpt) parts.push(`Cliente: "${d.incoming_excerpt}"`);
  if (d.proposed_event) parts.push(`📅 Appuntamento: ${d.proposed_event.date} ore ${d.proposed_event.start} — ${d.proposed_event.reason} (DA CONFERMARE)`);
  parts.push(`\nBozza:\n«${d.draft_text}»`);
  parts.push(`\n👉 Per inviare: OK ${d.id}\n👉 Per rifiutare: NO ${d.id}\n👉 Per modificare: OK ${d.id} <nuovo testo>`);
  try { await sendTextMessage(getControlNumber(), parts.join('\n')); }
  catch (e: any) { console.error('[Chatbot] notifica WhatsApp fallita:', e.message); }
}

// ─── Alert EMAIL per le urgenze (need_human) ─────────────────────────────────
// La notifica WhatsApp a Mariano è inaffidabile (numero controllo == numero device:
// si scrive da sé). Per le urgenze usiamo un'email via Brevo (mittente verificato),
// così l'avviso arriva sempre senza dover tenere aperto il Cruscotto.
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const ALERT_SENDER = { email: 'studiobranca.mariano@gmail.com', name: 'Bot WhatsApp — Studio Branca' };
export function getAlertEmail(): string {
  return process.env.ALERT_EMAIL || 'studiobranca.mariano@gmail.com';
}
/** Invio email di servizio a Mariano (riuso del canale Brevo affidabile). */
export async function sendStudioAlertEmail(subject: string, html: string): Promise<boolean> {
  return sendBrevoEmail(subject, html);
}
async function sendBrevoEmail(subject: string, html: string): Promise<boolean> {
  const key = process.env.BREVO_API_KEY;
  if (!key) { console.warn('[Email] BREVO_API_KEY non configurata: alert email saltato.'); return false; }
  try {
    const resp = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: ALERT_SENDER, to: [{ email: getAlertEmail() }], subject, htmlContent: html }),
    });
    if (!resp.ok) { console.error('[Email] Brevo HTTP', resp.status, (await resp.text()).slice(0, 200)); return false; }
    return true;
  } catch (e: any) { console.error('[Email] invio fallito:', e.message); return false; }
}
/** Invia a Mariano un'email di alert per una bozza urgente (need_human). */
export async function notifyUrgentByEmail(id: number): Promise<void> {
  const d = getDraft(id);
  if (!d) return;
  const base = process.env.PUBLIC_BASE_URL || 'https://wa-cruscotto-v2-production.up.railway.app';
  const esc = (s: any) => String(s ?? '').replace(/[<>&]/g, (c) => (({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]));
  const subject = `🔴 URGENTE — bozza #${d.id} — ${d.contact_name || d.phone}`;
  const html = `
    <h2 style="color:#b00020;margin:0 0 8px">Richiesta urgente sul WhatsApp dello studio</h2>
    <p><b>Cliente:</b> ${esc(d.contact_name || d.phone)} (${esc(d.phone)})</p>
    ${d.incoming_excerpt ? `<p><b>Messaggio:</b><br>${esc(d.incoming_excerpt)}</p>` : ''}
    <p><b>Bozza predisposta dal bot (da approvare):</b></p>
    <blockquote style="border-left:3px solid #b00020;margin:0;padding:4px 12px;color:#333">${esc(d.draft_text).replace(/\n/g, '<br>')}</blockquote>
    <p>👉 Apri il Cruscotto per approvare o rifiutare: <a href="${base}/bot">${base}/bot</a></p>
    <hr><p style="color:#888;font-size:12px">Alert automatico — bozza <code>need_human</code> del bot WhatsApp.</p>`;
  const ok = await sendBrevoEmail(subject, html);
  console.log(`[Email] Alert urgente bozza #${id} → ${getAlertEmail()}: ${ok ? 'inviato' : 'FALLITO'}`);
}

// ─── Comandi di approvazione via WhatsApp (risposte di Mariano) ──────────────
// SOLO comandi RIGIDI: "OK <id>", "OK <id> FORZA", "NO <id>" (ed equivalenti).
// ⚠️ SICUREZZA (rev. 30/06/2026): RIMOSSA la sostituzione-testo "OK <id> <testo>".
// Prima, una risposta come "OK 369 La bozza è chiara…" veniva interpretata come
// approvazione CON testo sostitutivo e spediva quel testo al cliente. Con un'AI che
// risponde sul numero di controllo questo causava auto-approvazioni e invii errati.
// Ora QUALSIASI testo extra (diverso da FORZA) → NON è un comando (ignorato). Le
// modifiche di testo si fanno SOLO dal Cruscotto. Gate generale: waCommandsEnabled().
export async function handleControlCommand(text: string): Promise<string | null> {
  if (!waCommandsEnabled()) return null;
  // Comando valido SOLO se è esattamente il verbo + id (+ eventuale FORZA), nient'altro.
  const m = (text || '').trim().match(/^(ok|sì|si|approva|invia|conferma|no|rifiuta|scarta)\s+#?(\d+)(?:\s+(forza))?\s*$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const id = parseInt(m[2], 10);
  const force = !!m[3];
  const isReject = ['no', 'rifiuta', 'scarta'].includes(verb);

  const d = getDraft(id);
  if (!d) return `❓ Bozza #${id} non trovata.`;
  if (d.status !== 'pending') return `ℹ️ Bozza #${id} già gestita.`;

  if (isReject) { markDraftRejected(id); return `🗑️ Bozza #${id} (${d.contact_name || d.phone}) rifiutata.`; }

  const r = await approveDraftCore(id, { force });
  if (r.conflict) return `⚠️ ${r.message}\nRispondi "OK ${id} FORZA" per confermare comunque l'appuntamento.`;
  if (!r.ok) return `❌ ${r.message}`;
  return `✅ Inviato a ${r.contactName || d.phone}.${r.hadEvent ? ' Appuntamento [DA CONFERMARE] in agenda.' : ''}`;
}
