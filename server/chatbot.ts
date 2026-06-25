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
import { createCalendarEvent, updateCalendarEvent } from './integrations.js';
import { broadcastEvent } from './sse.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_LOOPS = 4;
const HISTORY_LIMIT = 20;

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

Stai rispondendo a un cliente su WhatsApp. Dai del Lei, tono cordiale e professionale,
messaggi brevi.

COMPORTAMENTO BASE:
- Per qualunque richiesta o documento inviato, conferma che lo studio LI VALUTERÀ
  (es. "valuteremo la sua richiesta" / "valuteremo i documenti che ci ha inviato") e
  NON entrare nel merito fiscale/legale via chat.
- Invita SEMPRE il cliente a passare in studio e a fissare un appuntamento.
- Per gli appuntamenti usa get_availability (proponi 2-3 opzioni) e, quando il cliente
  sceglie, chiama propose_booking (l'appuntamento sarà poi confermato dallo studio).
- ORARI STUDIO (get_availability li rispetta già, ma tienili presente nel dialogo):
  Lun-Ven 9:00-13:00; pomeriggio SOLO lun/mar/gio 15:30-19:00 (NO mercoledì e venerdì
  pomeriggio). MAI sabato, domenica, feste comandate; chiuso dal 20 luglio al 31 agosto.

CONTROLLO DUPLICATI (obbligatorio): prima di rispondere a una richiesta o a un invio di
documenti, chiama find_previous_requests per verificare se il cliente aveva GIÀ inviato lo
stesso documento o fatto la stessa richiesta in passato. Se sì, faglielo presente con
garbo citando la data (es. "risulta che ci aveva già inviato ... in data ...").

REGOLE INDEROGABILI:
1. Italiano, messaggi brevi da chat.
2. NIENTE importi, calcoli, codici, scadenze o pareri precisi via chat → raccogli i dati e
   rimanda all'appuntamento.
3. Urgenze gravi (cartella esattoriale, accertamento, udienza, atto notificato con termini):
   NON gestirle da sola → chiama need_human; rassicura che il Dott. Branca verrà avvisato
   subito e chiedi copia dell'atto.
4. Documenti/foto: conferma la ricezione e indica che verranno valutati.
5. Firma sempre: "Assistente Virtuale — Studio Tributario Branca".
6. Resta SEMPRE sui temi dello studio: NON aggiungere chiacchiere personali, social o
   battute tratte dalla cronologia (inviti, eventi privati, vacanze, ecc.).
7. MOLTI clienti sono anche amici e mescolano lavoro e chiacchiere personali. Occupati
   SOLO del lavoro. Se l'ultimo messaggio del cliente NON contiene una richiesta/argomento
   di studio (è solo personale, sociale, off-topic), chiama ignore_personal e NON produrre
   alcun messaggio: di quella chat lo studio non si occupa.

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
    description: 'Segnala che il messaggio è personale/non rivolto allo studio (chiacchiere, social, off-topic). Lo studio non se ne occupa: NON verrà prodotta alcuna risposta.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Perché è personale/non pertinente' } },
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
  return `Conversazione WhatsApp con ${contactName} (${phone}):\n\n${lines.join('\n')}\n\nGenera la prossima risposta dello STUDIO.`;
}

interface DraftResult {
  draftText: string;
  proposedEvent: { date: string; start: string; end: string; reason: string } | null;
  needsHuman: boolean;
  humanReason?: string;
  personal?: boolean;
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
    return 'Proposta registrata. L\'appuntamento sarà confermato dallo studio: comunica al cliente che è in fase di conferma e ringrazia.';
  }
  if (name === 'confirm_appointment') {
    const appt = getPendingAppointment(phone);
    if (!appt) {
      return 'Non risulta alcun appuntamento in attesa di conferma per questo cliente: non confermare nulla, prosegui normalmente.';
    }
    // Aggiorna l'evento in agenda: "[DA CONFERMARE]" → confermato (verde).
    let calOk = false;
    if (appt.event_id) {
      const r = await updateCalendarEvent({
        eventId: appt.event_id,
        title: `✅ ${appt.reason || 'Appuntamento'} — ${appt.contact_name || phone}`,
        description: `Appuntamento CONFERMATO dal cliente su WhatsApp.\nCliente: ${appt.contact_name || ''} (${phone})\nMotivo: ${appt.reason || '-'}\nConfermato il ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`,
        colorId: '10', // verde "Basil"
      });
      calOk = r.success;
    }
    markAppointmentConfirmed(appt.id);
    // Avvisa Mariano sul numero di controllo.
    const esito = calOk
      ? 'Agenda aggiornata (evento confermato).'
      : appt.event_id
        ? '⚠️ Non sono riuscito ad aggiornare l\'evento in agenda: aggiornalo a mano.'
        : '⚠️ Aggiorna l\'agenda a mano (evento non tracciato).';
    try {
      await sendTextMessage(
        getControlNumber(),
        `✅ ${appt.contact_name || phone} ha CONFERMATO l'appuntamento:\n📅 ${appt.date} ore ${appt.start} — ${appt.reason || 'Appuntamento'}\n${esito}`,
      );
    } catch (e: any) { console.error('[Chatbot] notifica conferma fallita:', e.message); }
    return `Appuntamento confermato e ${calOk ? 'agenda aggiornata' : 'segnalato al Dott. Branca'}. Scrivi al cliente un breve messaggio che CONFERMA l'appuntamento del ${appt.date} alle ${appt.start}, ringrazia e indica che lo studio è in Via Operai 102, Barcellona P.G. (ME).`;
  }
  if (name === 'need_human') {
    out.needsHuman = true;
    out.humanReason = String(input?.reason || '');
    return 'Segnalato al Dott. Branca. Scrivi al cliente un messaggio rassicurante (verrà ricontattato al più presto).';
  }
  if (name === 'ignore_personal') {
    out.personal = true;
    return 'Ok: messaggio personale/non pertinente. NON produrre alcuna risposta.';
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
          max_tokens: 1024,
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

  if (out.personal) return { kind: 'personal', result: null }; // chat privata → nessuna bozza
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
    calendar = await createCalendarEvent({
      title: `[DA CONFERMARE] ${ev.reason} — ${d.contact_name || d.phone}`,
      description: `Appuntamento proposto dal chatbot WhatsApp.\nCliente: ${d.contact_name || ''} (${d.phone})\nMotivo: ${ev.reason}\n\n⚠️ Confermare con il cliente.`,
      startDate: `${ev.date}T${ev.start}:00`,
      endDate: `${ev.date}T${ev.end}:00`,
    });
    // Traccia l'appuntamento (con eventId) così la conferma del cliente potrà
    // ritrovare e aggiornare l'evento in agenda.
    recordAppointment({
      phone: d.phone, contactName: d.contact_name, eventId: calendar?.eventId ?? null,
      date: ev.date, start: ev.start, end: ev.end, reason: ev.reason,
    });
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
