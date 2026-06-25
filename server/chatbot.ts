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
import { getAvailability, formatAvailabilityIT, isSlotBusy } from './appointments.js';
import { sendTextMessage } from './zapi.js';
import { createCalendarEvent, updateCalendarEvent, appendEventDescription } from './integrations.js';
import { broadcastEvent } from './sse.js';

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
export function isAutoSendEnabled(): boolean { return getSetting('bot_auto_send', '0') === '1'; }

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

LEGGI SEMPRE TUTTA la conversazione recente prima di rispondere: tra un messaggio e l'altro il
Dott. Branca può intervenire e rispondere DI PERSONA al cliente (i suoi messaggi compaiono come
[STUDIO]). Tienine conto: non ripetere e non contraddire quanto lo studio ha già detto o fatto,
e prosegui in modo coerente. Se il Dott. Branca ha GIÀ gestito o risposto all'ultima richiesta e
non serve aggiungere altro, chiama already_handled (NON inviare alcun messaggio).

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
- DOCUMENTI PRIMA DELL'INCONTRO: se l'appuntamento riguarda documenti da esaminare (atti o
  cartelle notificate, fatture, dichiarazioni, contratti, avvisi), CHIARISCI sempre che il
  cliente deve inviarli su questa chat PRIMA dell'appuntamento: solo così potranno essere
  visionati e poi DISCUSSI durante l'incontro. Senza i documenti in anticipo l'incontro non
  sarebbe produttivo.
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
- ORARI STUDIO (get_availability li rispetta già; non proporre MAI fuori da questi):
  lunedì, martedì e giovedì 9:00–18:00 (orario continuato); mercoledì e venerdì 9:00–13:00.
  MAI sabato e domenica, MAI feste comandate; studio CHIUSO dal 20 luglio al 31 agosto.
- CONTROLLO DUPLICATI (obbligatorio): prima di rispondere a una richiesta o a un invio di
  documenti, chiama find_previous_requests per verificare se il cliente aveva GIÀ inviato lo
  stesso documento o fatto la stessa richiesta. Se sì, faglielo presente con garbo citando
  la data (es. "risulta che ci aveva già inviato ... in data ...").
- Documenti/foto ricevuti: conferma la ricezione, indica di cosa si tratta se riconoscibile,
  e dai un primo inquadramento tecnico utile; precisa che verranno esaminati in dettaglio.

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

Il tuo output finale deve contenere ESCLUSIVAMENTE il testo del messaggio da inviare al
cliente: NIENTE analisi, premesse, ragionamenti o commenti tra parentesi.`;

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
    description: 'Cerca nello storico dei messaggi del cliente se aveva già inviato lo stesso documento o fatto la stessa richiesta in passato. Usalo SEMPRE prima di rispondere a una richiesta/invio documenti.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Parole chiave della richiesta/documento (es. "dichiarazione redditi", "visura", "f24")' } },
      required: ['query'],
    },
  },
];

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
  const lines = rows.map((r) => {
    const who = r.direction === 'sent' ? 'STUDIO' : 'CLIENTE';
    return `[${who}] ${(r.content || '').replace(/\n+/g, ' ').trim()}`;
  });
  return `Conversazione WhatsApp con ${contactName} (${phone}):\n\n${lines.join('\n')}\n\nLeggi TUTTA la conversazione qui sopra: i messaggi [STUDIO] includono anche eventuali risposte DIRETTE del Dott. Branca. Genera la prossima risposta dello STUDIO tenendone conto: non ripetere né contraddire quanto già detto/fatto.`;
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
    const rows = db.prepare(`
      SELECT content, timestamp FROM live_messages
      WHERE phone = ? AND direction = 'received' AND content IS NOT NULL
      ORDER BY timestamp DESC LIMIT 300
    `).all(phone) as any[];
    const cutoff = Date.now() - 2 * 86400000; // ignora le ultime 48h (conversazione corrente)
    const hits = rows.filter((r) => {
      const t = Date.parse(r.timestamp);
      return !isNaN(t) && t < cutoff && kws.some((k) => (r.content || '').toLowerCase().includes(k));
    }).slice(0, 5);
    if (!hits.length) return 'Nessuna richiesta o documento simile inviato in passato dal cliente.';
    return 'Richieste/documenti SIMILI già inviati in passato (cita la data al cliente):\n' +
      hits.map((h) => `- ${(h.timestamp || '').slice(0, 10)}: "${(h.content || '').replace(/\n+/g, ' ').slice(0, 90)}"`).join('\n');
  }
  if (name === 'get_availability') {
    out.appointmentFlow = true;
    const days = Math.min(Math.max(parseInt(input?.days, 10) || 14, 1), 30);
    const { slots, calendarChecked } = await getAvailability(days);
    const txt = formatAvailabilityIT(slots);
    // Elenco macchina-leggibile con DATA ESATTA (YYYY-MM-DD): il modello DEVE
    // copiare questi valori in propose_booking, mai inventare la data/anno.
    const iso = slots.slice(0, 12).map((s) => `${s.date} ${s.start}`).join('; ');
    return `${calendarChecked ? '' : '(agenda non verificata su Calendar) '}Prossime disponibilità (da mostrare al cliente):\n${txt}\n\nSlot con data esatta da usare in propose_booking (date=YYYY-MM-DD, start=HH:MM): ${iso}`;
  }
  if (name === 'propose_booking') {
    const date = String(input?.date || '');
    const start = String(input?.start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) {
      return 'Errore: data o ora non valide. Usa get_availability e riprova con uno slot esatto.';
    }
    out.proposedEvent = { date, start, end: endTime(start), reason: String(input?.reason || 'Appuntamento') };
    out.appointmentFlow = true;
    return 'Proposta registrata. Comunica al cliente lo slot e che resta in attesa di conferma, ringrazia e — se l\'incontro riguarda documenti da esaminare — CHIARISCI che deve inviarli su questa chat PRIMA dell\'appuntamento (es. atti/cartelle notificate, fatture, dichiarazioni, contratti, avvisi): solo così potranno essere visionati e poi discussi durante l\'incontro. Infine chiedigli di confermare quando avrà la certezza di poter venire.';
  }
  if (name === 'confirm_appointment') {
    out.appointmentFlow = true;
    const appt = getPendingAppointment(phone);
    if (!appt) {
      return 'Non risulta alcun appuntamento in attesa di conferma per questo cliente: non confermare nulla, prosegui normalmente.';
    }
    const r = await confirmAppointmentRow(appt, { notify: true });
    return `Appuntamento confermato e ${r.calendarUpdated ? 'agenda aggiornata' : 'segnalato al Dott. Branca'}. Scrivi al cliente un breve messaggio che CONFERMA l'appuntamento del ${appt.date} alle ${appt.start}, ringrazia, e — se l'incontro riguarda documenti da esaminare — RIBADISCI che deve inviarli su questa chat PRIMA dell'appuntamento, così potranno essere visionati e discussi durante l'incontro; indica che lo studio è in Via Operai 102, Barcellona P.G. (ME).`;
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
    recordDocNote(phone, summary);
    // Se c'è già un appuntamento in agenda per questo cliente, annota subito sull'evento.
    const appt = getActiveAppointmentWithEvent(phone);
    if (appt?.event_id) {
      try {
        await appendEventDescription(appt.event_id, `📎 Documenti ricevuti (${new Date().toISOString().slice(0, 10)}): ${summary}`);
        markDocNotesAttached(phone);
      } catch (e: any) { console.error('[Chatbot] annota documenti su evento:', e.message); }
    }
    return 'Documentazione annotata come promemoria per l\'appuntamento. Conferma al cliente la ricezione, indica che sarà esaminata prima dell\'incontro e RICORDA che i documenti utili vanno inviati su questa chat PRIMA dell\'appuntamento.';
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Chatbot] ANTHROPIC_API_KEY non configurata: bozza non generata.');
    return null;
  }

  const out: DraftResult = { draftText: '', proposedEvent: null, needsHuman: false };
  const messages: any[] = [{ role: 'user', content: buildTranscript(phone, contactName) }];

  // Data odierna (Europe/Rome) iniettata nel system: senza, il modello sbaglia
  // l'anno quando il cliente cita un giorno senza anno (es. "martedì 17").
  const todayStr = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome',
  });
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

  // Se per questo cliente c'è un appuntamento "da confermare", informane il modello:
  // se il cliente lo conferma deve chiamare confirm_appointment (aggiorna l'agenda).
  const pendingAppt = getPendingAppointment(phone);
  const apptBlock = pendingAppt
    ? `\n\nAPPUNTAMENTO IN ATTESA DI CONFERMA per questo cliente: ${pendingAppt.date} alle ${pendingAppt.start}${pendingAppt.reason ? ` (${pendingAppt.reason})` : ''}.
- Se nell'ULTIMO messaggio il cliente CONFERMA che può venire (es. "confermo", "sì va bene", "ci sono", "perfetto", "ok per quel giorno"), chiama confirm_appointment e poi conferma con garbo.
- Se invece chiede di SPOSTARE l'orario, usa get_availability per riproporre nuovi slot; se vuole DISDIRE o è incerto, NON chiamare confirm_appointment.`
    : '';

  const system = `${SYSTEM_PROMPT}\n\nData odierna: ${todayStr} (${todayISO}). Usa SEMPRE date coerenti con oggi e non inventare l'anno.${apptBlock}`;

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
          const result = await runTool(b.name, b.input, out, phone);
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

  // Controllo agenda: se Mariano è impegnato nello slot, blocca (salvo force)
  if (d.proposed_event && !opts.force) {
    const ev = d.proposed_event;
    const { busy, checked } = await isSlotBusy(ev.date, ev.start, ev.end);
    if (busy && checked) {
      return { ok: false, status: 409, conflict: true, contactName: d.contact_name,
        message: `Risulti impegnato ${ev.date} alle ${ev.start}.` };
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
    const ev = d.proposed_event;
    // Promemoria documenti già inviati dal cliente (a cosa si riferiscono): in descrizione.
    const docNotes = getUnattachedDocNotes(d.phone);
    const docBlock = docNotes.length ? `\n\n${formatDocNotes(docNotes)}` : '';
    calendar = await createCalendarEvent({
      title: `[DA CONFERMARE] ${ev.reason} — ${d.contact_name || d.phone}`,
      description: `Appuntamento proposto dal chatbot WhatsApp.\nCliente: ${d.contact_name || ''} (${d.phone})\nMotivo: ${ev.reason}${docBlock}\n\n⚠️ Confermare con il cliente.`,
      startDate: `${ev.date}T${ev.start}:00`,
      endDate: `${ev.date}T${ev.end}:00`,
    });
    // Traccia l'appuntamento (con eventId) così la conferma del cliente potrà
    // ritrovare e aggiornare l'evento in agenda.
    recordAppointment({
      phone: d.phone, contactName: d.contact_name, eventId: calendar?.eventId ?? null,
      date: ev.date, start: ev.start, end: ev.end, reason: ev.reason,
    });
    if (docNotes.length) markDocNotesAttached(d.phone);
  }
  markDraftSent(id);
  broadcastEvent('message', { type: 'sent', phone: d.phone, contactName: d.contact_name, content: finalText, timestamp: now });
  return { ok: true, status: 200, calendar, contactName: d.contact_name, hadEvent: !!d.proposed_event };
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

// ─── Comandi di approvazione via WhatsApp (risposte di Mariano) ──────────────
// Riconosce: "OK 4", "SI 4", "NO 4", "OK 4 <nuovo testo>", "OK 4 FORZA".
// Ritorna il testo di risposta da inviare a Mariano, o null se non è un comando.
export async function handleControlCommand(text: string): Promise<string | null> {
  const m = (text || '').trim().match(/^(ok|sì|si|approva|invia|conferma|no|rifiuta|scarta)\s+#?(\d+)\s*([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const id = parseInt(m[2], 10);
  const rest = (m[3] || '').trim();
  const isReject = ['no', 'rifiuta', 'scarta'].includes(verb);

  const d = getDraft(id);
  if (!d) return `❓ Bozza #${id} non trovata.`;
  if (d.status !== 'pending') return `ℹ️ Bozza #${id} già gestita.`;

  if (isReject) { markDraftRejected(id); return `🗑️ Bozza #${id} (${d.contact_name || d.phone}) rifiutata.`; }

  const force = /^(forza|conferma)$/i.test(rest);
  const edited = (!force && rest) ? rest : undefined;
  const r = await approveDraftCore(id, { text: edited, force });
  if (r.conflict) return `⚠️ ${r.message}\nRispondi "OK ${id} FORZA" per confermare comunque l'appuntamento.`;
  if (!r.ok) return `❌ ${r.message}`;
  return `✅ Inviato a ${r.contactName || d.phone}.${r.hadEvent ? ' Appuntamento [DA CONFERMARE] in agenda.' : ''}`;
}
