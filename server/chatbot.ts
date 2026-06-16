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
import { getAvailability, formatAvailabilityIT } from './appointments.js';

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

// ─── Persona + guardrail (skill whatsapp-studio) ─────────────────────────────
const SYSTEM_PROMPT = `Sei l'assistente virtuale di AB STUDIO SRL (Studio Tributario Branca),
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
5. Firma sempre: "Assistente Virtuale — AB STUDIO SRL".

Produci come messaggio finale SOLO il testo da inviare al cliente (niente preamboli).`;

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
    name: 'need_human',
    description: 'Segnala che la richiesta è urgente o complessa e deve gestirla direttamente il Dott. Branca (no risposta automatica risolutiva).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Perché serve l\'intervento umano' } },
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
  if (name === 'need_human') {
    out.needsHuman = true;
    out.humanReason = String(input?.reason || '');
    return 'Segnalato al Dott. Branca. Scrivi al cliente un messaggio rassicurante (verrà ricontattato al più presto).';
  }
  return 'Strumento sconosciuto.';
}

/**
 * Genera la bozza di risposta. Ritorna null se il bot non può operare
 * (manca ANTHROPIC_API_KEY) o se non produce testo.
 */
export async function generateDraft(phone: string, contactName: string): Promise<DraftResult | null> {
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
  const system = `${SYSTEM_PROMPT}\n\nData odierna: ${todayStr} (${todayISO}). Usa SEMPRE date coerenti con oggi e non inventare l'anno.`;

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

  if (!out.draftText) return null;
  return out;
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
