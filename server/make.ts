/**
 * make.ts — HUB di automazione Make.com  (rev. 16/07/2026, v2.17.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Make.com fa da HUB di orchestrazione e NON duplica la sync nativa con Google
 * Calendar (freeBusy + create/update event vivono già in integrations.ts /
 * appointments.ts). Per evitare loop e doppie scritture sul Calendar:
 *
 *   • INBOUND  (Make → Cruscotto)   POST /api/integrations/make/inbound
 *       Riceve gli eventi Calendar (created/updated/canceled) intercettati da Make,
 *       AGGIORNA SOLO lo stato LOCALE dell'appuntamento e PREPARA una BOZZA
 *       (promemoria/variazione). NON riscrive su Google Calendar. NON invia MAI
 *       nulla al cliente in automatico: la bozza resta pending + avviso al numero
 *       di controllo. Invariante rispettato: merito/urgenze SEMPRE bozza.
 *
 *   • OUTBOUND (Cruscotto → Make)    POST a MAKE_WEBHOOK_URL
 *       Notifica Make quando un appuntamento è confermato/spostato/annullato o
 *       arriva un lead dal sito (per orchestrazioni extra). NON tocca il Calendar.
 *
 * Gating (attivo SOLO se le env sono presenti, altrimenti "disabled"/no-op):
 *   • MAKE_SHARED_SECRET   → abilita l'inbound (autenticazione richiesta).
 *   • MAKE_WEBHOOK_URL(+secret) → abilita l'outbound.
 * Difensivo: ogni funzione è in try/catch e non può far cadere il bot.
 */
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import db from './db.js';
import { getControlNumber, sendStudioAlertEmail } from './chatbot.js';
import { sendTextMessage } from './zapi.js';
import { saveEmailDraft } from './emaildrafts.js';

// ─── DB: audit-log eventi Make ────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS make_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
      event_type TEXT,                -- created|updated|canceled|confirmed|moved|lead...
      external_id TEXT,               -- eventId Google o riferimento esterno
      appointment_id INTEGER,         -- riga bot_appointments collegata (se nota)
      status TEXT,                    -- ok | error | skipped | disabled | unauthorized
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_make_events_created ON make_events(created_at);
  `);
} catch { /* best-effort */ }

interface MakeLog {
  direction: 'inbound' | 'outbound'; eventType?: string; externalId?: string | null;
  appointmentId?: number | null; status: string; detail?: string;
}
function logMake(e: MakeLog): void {
  try {
    db.prepare(
      `INSERT INTO make_events (direction, event_type, external_id, appointment_id, status, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(e.direction, e.eventType ?? null, e.externalId ?? null, e.appointmentId ?? null, e.status, (e.detail ?? '').slice(0, 500));
  } catch { /* il logging non blocca mai */ }
}

const esc = (s: unknown): string => String(s ?? '').replace(/[<>&]/g, (c) => (({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as Record<string, string>)[c]));

// ─── Configurazione / gating ──────────────────────────────────────────────────
export function isMakeConfigured(): { inbound: boolean; outbound: boolean } {
  const hasSecret = !!process.env.MAKE_SHARED_SECRET;
  const hasUrl = !!process.env.MAKE_WEBHOOK_URL;
  return { inbound: hasSecret, outbound: hasSecret && hasUrl };
}

/** Confronto a tempo costante del secret condiviso (anti timing-attack). */
export function secretMatches(provided: string): boolean {
  const secret = process.env.MAKE_SHARED_SECRET || '';
  if (!secret || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function extractSecret(req: Request): string {
  const h = req.headers || {};
  const bearer = String(h['authorization'] || '').replace(/^Bearer\s+/i, '');
  const body = (req.body || {}) as Record<string, unknown>;
  return String(h['x-make-secret'] || bearer || body.secret || '');
}

// ─── Schema payload inbound (evento Calendar veicolato da Make) ────────────────
export const inboundSchema = z.object({
  changeType: z.string().trim().max(32).optional(),   // created|updated|canceled|deleted
  eventId: z.string().trim().max(256).optional(),
  calendarId: z.string().trim().max(256).optional(),
  status: z.string().trim().max(40).optional(),       // Google: confirmed|tentative|cancelled
  summary: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5000).optional(),
  start: z.string().trim().max(64).optional(),        // ISO8601 o YYYY-MM-DD
  end: z.string().trim().max(64).optional(),
  date: z.string().trim().max(20).optional(),         // YYYY-MM-DD (comodità)
  startTime: z.string().trim().max(10).optional(),    // HH:MM
  endTime: z.string().trim().max(10).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(160).optional(),
  contactName: z.string().trim().max(160).optional(),
}).passthrough();
export type InboundLike = z.infer<typeof inboundSchema>;

// ─── Normalizzazione data/ora (Europe/Rome) da campi separati o ISO ────────────
function toDateTime(p: InboundLike): { date?: string; start?: string; end?: string } {
  const parse = (s?: string): { d?: string; t?: string } | undefined => {
    if (!s) return undefined;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    if (m) return { d: m[1], t: m[2] };
    const d = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
    if (d) return { d: d[1], t: undefined };
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const d2 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(parsed);
      const t2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
      return { d: d2, t: t2 };
    }
    return undefined;
  };
  const s = parse(p.start);
  const e = parse(p.end);
  return { date: p.date || s?.d, start: p.startTime || s?.t, end: p.endTime || e?.t };
}

function isCancel(p: InboundLike): boolean {
  const ct = String(p.changeType || '').toLowerCase();
  const st = String(p.status || '').toLowerCase();
  return ct === 'canceled' || ct === 'cancelled' || ct === 'deleted' || st === 'cancelled';
}

export interface InboundDecision { cancel: boolean; date?: string; start?: string; end?: string; action: string; }

/**
 * Decisione PURA (senza side-effect, testabile) su cosa fare di un evento inbound,
 * dato l'appuntamento locale eventualmente combaciante per event_id.
 *   canceled_local | already_canceled | moved_local | in_sync | no_match
 */
export function decideInboundAction(p: InboundLike, appt: { date?: string; start?: string; status?: string } | null): InboundDecision {
  const cancel = isCancel(p);
  const { date, start, end } = toDateTime(p);
  let action = 'no_match';
  if (cancel) {
    if (appt && appt.status !== 'annullato') action = 'canceled_local';
    else if (appt) action = 'already_canceled';
  } else if (appt && date && start && (appt.date !== date || appt.start !== start)) {
    action = 'moved_local';
  } else if (appt) {
    action = 'in_sync';
  }
  return { cancel, date, start, end, action };
}

// ─── INBOUND: Make → Cruscotto  (POST /api/integrations/make/inbound) ─────────
export async function makeInbound(req: Request, res: Response): Promise<Response> {
  // 1) Gating: senza secret configurato l'endpoint è DISATTIVO.
  if (!isMakeConfigured().inbound) {
    logMake({ direction: 'inbound', status: 'disabled', detail: 'MAKE_SHARED_SECRET assente' });
    return res.status(503).json({ ok: false, disabled: true, error: 'Integrazione Make non configurata.' });
  }
  // 2) Autenticazione col secret condiviso.
  if (!secretMatches(extractSecret(req))) {
    logMake({ direction: 'inbound', status: 'unauthorized' });
    return res.status(401).json({ ok: false, error: 'Secret non valido.' });
  }
  // 3) Validazione payload.
  const parsed = inboundSchema.safeParse(req.body || {});
  if (!parsed.success) {
    logMake({ direction: 'inbound', status: 'error', detail: 'payload non valido' });
    return res.status(400).json({ ok: false, error: 'Payload non valido.' });
  }
  const p = parsed.data;

  try {
    // Match SOLO per event_id: unico riferimento sicuro, evita falsi accoppiamenti/loop.
    let appt: { id: number; date?: string; start?: string; status?: string } | null = null;
    if (p.eventId) {
      appt = (db.prepare(`SELECT id, date, start, status FROM bot_appointments WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(p.eventId) as any) || null;
    }
    const { cancel, date, start, end, action } = decideInboundAction(p, appt);

    // Mutazione SOLO dello stato LOCALE (NIENTE scrittura su Google Calendar → no loop).
    if (action === 'canceled_local' && appt) {
      db.prepare(`UPDATE bot_appointments SET status = 'annullato' WHERE id = ?`).run(appt.id);
    } else if (action === 'moved_local' && appt) {
      db.prepare(`UPDATE bot_appointments SET date = ?, start = ?, end = COALESCE(?, end) WHERE id = ?`).run(date, start, end ?? null, appt.id);
    }

    // 4) PREPARA una BOZZA (mai inviata): promemoria/variazione al cliente, in coda
    //    bozze del Cruscotto. INVARIANTE: nessun invio automatico al cliente.
    let draftId: number | null = null;
    if (p.email && (action === 'canceled_local' || action === 'moved_local')) {
      const quando = date && start ? `${date} ore ${start}` : (p.start || 'la data concordata');
      const subject = cancel
        ? 'Variazione appuntamento — Studio Tributario Branca'
        : 'Aggiornamento appuntamento — Studio Tributario Branca';
      const body = cancel
        ? `Gentile ${p.contactName || 'Cliente'},\n\nla contattiamo riguardo all'appuntamento presso lo Studio Tributario Branca: si è resa necessaria una variazione. La ricontatteremo per concordare una nuova data.\n\nCordiali saluti\nStudio Tributario Branca`
        : `Gentile ${p.contactName || 'Cliente'},\n\nle confermiamo l'aggiornamento del suo appuntamento presso lo Studio Tributario Branca: ${quando}.\n\nCordiali saluti\nStudio Tributario Branca`;
      try {
        draftId = saveEmailDraft({
          toAddr: p.email, toName: p.contactName || null, subject, draftText: body,
          needsHuman: false, proposedEvent: { eventId: p.eventId, date, start, end, changeType: p.changeType },
        });
      } catch { /* bozza best-effort */ }
    }

    // 5) Avviso SEMPRE al numero di controllo (Mariano). MAI al cliente in automatico.
    //    Doppio canale: WhatsApp (best-effort) + email allo studio (affidabile).
    const notice = `🔄 Make/Calendar: ${cancel ? 'ANNULLO' : 'aggiornamento'} evento\n${p.summary || p.contactName || p.eventId || '—'}\n📅 ${date || '?'} ${start || ''}\nAzione: ${action}${draftId ? ` · bozza #${draftId} pronta` : ''}`;
    sendTextMessage(getControlNumber(), notice).catch(() => {});
    if (action === 'canceled_local' || action === 'moved_local') {
      const html = `<h3 style="color:#004225;margin:0 0 8px">Variazione appuntamento (via Make/Calendar)</h3>
        <p><b>Evento:</b> ${esc(p.summary || p.contactName || p.eventId || '—')}</p>
        <p><b>Quando:</b> ${esc(date || '?')} ${esc(start || '')}</p>
        <p><b>Azione:</b> ${esc(action)}</p>
        ${draftId ? `<p>✍️ Bozza cortesia #${draftId} pronta (pending): va approvata dallo studio. Nessun invio automatico al cliente.</p>` : ''}`;
      sendStudioAlertEmail(cancel ? '🔄 Annullo appuntamento (Make/Calendar)' : '🔄 Aggiornamento appuntamento (Make/Calendar)', html).catch(() => {});
    }

    logMake({ direction: 'inbound', eventType: cancel ? 'canceled' : (p.changeType || 'updated'), externalId: p.eventId ?? null, appointmentId: appt?.id ?? null, status: 'ok', detail: action });
    return res.json({ ok: true, matched: !!appt, appointmentId: appt?.id ?? null, action, draftId });
  } catch (err: any) {
    console.error('[make/inbound]', err?.message);
    logMake({ direction: 'inbound', status: 'error', detail: err?.message });
    return res.status(500).json({ ok: false, error: 'Errore interno.' });
  }
}

// ─── OUTBOUND: Cruscotto → Make  (POST a MAKE_WEBHOOK_URL) ─────────────────────
export type MakeOutboundEvent =
  | 'appointment_confirmed' | 'appointment_canceled' | 'appointment_moved'
  | 'site_lead' | 'booking_request';

/**
 * Notifica Make di un evento del Cruscotto per orchestrazioni extra.
 * NON scrive su Google Calendar (lo fa già l'integrazione nativa) → nessun loop.
 * Fire-and-forget: non lancia MAI e non blocca il chiamante. No-op se non configurato.
 */
export async function notifyMake(payload: { event: MakeOutboundEvent; appointmentId?: number | null; [k: string]: unknown }): Promise<void> {
  if (!isMakeConfigured().outbound) {
    logMake({ direction: 'outbound', eventType: payload.event, appointmentId: payload.appointmentId ?? null, status: 'disabled' });
    return;
  }
  try {
    const resp = await fetch(process.env.MAKE_WEBHOOK_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-make-secret': process.env.MAKE_SHARED_SECRET as string },
      body: JSON.stringify({ source: 'wa-cruscotto', sentAt: new Date().toISOString(), ...payload }),
    });
    logMake({ direction: 'outbound', eventType: payload.event, appointmentId: payload.appointmentId ?? null, status: resp.ok ? 'ok' : 'error', detail: resp.ok ? undefined : `HTTP ${resp.status}` });
  } catch (e: any) {
    logMake({ direction: 'outbound', eventType: payload.event, appointmentId: payload.appointmentId ?? null, status: 'error', detail: e?.message });
  }
}

// ─── Stato integrazione (diagnostica: nessun secret esposto) ───────────────────
export function makeStatus(_req: Request, res: Response): Response {
  const configured = isMakeConfigured();
  let recent: unknown[] = [];
  try {
    recent = db.prepare(`SELECT direction, event_type AS eventType, status, appointment_id AS appointmentId, created_at AS createdAt FROM make_events ORDER BY id DESC LIMIT 15`).all() as unknown[];
  } catch { /* tabella non pronta */ }
  return res.json({
    ok: true,
    configured,
    webhookConfigured: !!process.env.MAKE_WEBHOOK_URL,
    inboundPath: '/api/integrations/make/inbound',
    recent,
  });
}
