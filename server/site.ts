/**
 * Endpoint pubblici per il SITO (studiotributariobranca.eu)
 * ─────────────────────────────────────────────────────────────
 * Espone al sito statico su Aruba tre rotte, TUTTE conformi all'invariante:
 *   • POST /api/site/lead            → crea un LEAD dal form contatti (email di
 *                                        alert allo studio; MAI risposta al cliente).
 *   • GET  /api/site/availability    → slot liberi (orario studio × Google Calendar).
 *   • POST /api/site/booking-request → richiesta appuntamento PENDING ("da_confermare"):
 *                                        NESSUNA conferma automatica, la conferma la dà
 *                                        lo studio dal Cruscotto / WhatsApp.
 *
 * Difensivo per costruzione: ogni handler è in try/catch e non può far cadere il bot.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import db from './db.js';
import { getAvailability } from './appointments.js';
import { recordAppointment, getControlNumber, sendStudioAlertEmail } from './chatbot.js';
import { sendTextMessage } from './zapi.js';

// ─── Persistenza lead dal sito ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS site_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT DEFAULT 'contatto',       -- contatto | appuntamento
    name TEXT,
    email TEXT,
    phone TEXT,
    subject TEXT,
    message TEXT,
    meta TEXT,                          -- JSON extra (es. slot richiesto)
    ip TEXT,
    status TEXT DEFAULT 'nuovo',        -- nuovo | gestito | scartato
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_site_leads_status ON site_leads(status, created_at);
`);

export function recordLead(x: {
  kind?: string; name?: string; email?: string; phone?: string;
  subject?: string; message?: string; meta?: any; ip?: string;
}): number {
  const info = db.prepare(`
    INSERT INTO site_leads (kind, name, email, phone, subject, message, meta, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    x.kind || 'contatto', x.name || null, x.email || null, x.phone || null,
    x.subject || null, x.message || null, x.meta ? JSON.stringify(x.meta) : null, x.ip || null,
  );
  return Number(info.lastInsertRowid);
}

/** Elenco lead (per il Cruscotto). */
export function getSiteLeads(status?: string): any[] {
  if (status) return db.prepare(`SELECT * FROM site_leads WHERE status = ? ORDER BY created_at DESC`).all(status) as any[];
  return db.prepare(`SELECT * FROM site_leads ORDER BY created_at DESC LIMIT 500`).all() as any[];
}

/** Elimina un singolo lead per id. Ritorna il numero di righe rimosse (0 o 1). */
export function deleteSiteLead(id: number): number {
  const info = db.prepare(`DELETE FROM site_leads WHERE id = ?`).run(id);
  return info.changes;
}

/** Rimuove i lead di test marcati [TEST SISTEMA] (nel nome o nel messaggio). Ritorna le righe rimosse. */
export function cleanupTestLeads(): number {
  const info = db.prepare(
    `DELETE FROM site_leads WHERE name LIKE '%[TEST SISTEMA]%' OR message LIKE '%[TEST SISTEMA]%'`
  ).run();
  return info.changes;
}

// ─── Rate limit basilare in-memory (per IP) ───────────────────────────────────
const HITS = new Map<string, number[]>();
function rateLimited(ip: string, max = 6, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) HITS.clear(); // guardia memoria
  return arr.length > max;
}
function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}
const esc = (s: any) => String(s ?? '').replace(/[<>&]/g, (c) => (({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]));
function onlyDigits(s: string): string { return String(s || '').replace(/[^\d]/g, ''); }

// ─── Schemi di validazione ────────────────────────────────────────────────────
export const leadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(40).optional().default(''),
  subject: z.string().trim().max(160).optional().default(''),
  message: z.string().trim().min(3).max(4000),
  consent: z.union([z.boolean(), z.string()]).optional(),
  website: z.string().optional().default(''), // honeypot
});

export const bookingSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().min(6).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().trim().max(500).optional().default(''),
  website: z.string().optional().default(''), // honeypot
});

// ─── POST /api/site/lead ──────────────────────────────────────────────────────
export async function siteLead(req: Request, res: Response) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Troppe richieste, riprova tra poco.' });
    const p = leadSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ ok: false, error: 'Dati non validi.' });
    const d = p.data;
    // Honeypot: se compilato, fingi successo (bot) senza fare nulla.
    if (d.website) return res.json({ ok: true });

    const id = recordLead({ kind: 'contatto', name: d.name, email: d.email, phone: d.phone, subject: d.subject, message: d.message, ip });

    // Alert allo studio via email (Brevo, canale affidabile). MAI risposta al cliente.
    const subject = `🟢 Nuovo contatto dal sito — ${d.name}`;
    const html = `
      <h2 style="color:#004225;margin:0 0 8px">Nuovo contatto dal sito</h2>
      <p><b>Nome:</b> ${esc(d.name)}</p>
      <p><b>Email:</b> ${esc(d.email)}</p>
      ${d.phone ? `<p><b>Telefono:</b> ${esc(d.phone)}</p>` : ''}
      ${d.subject ? `<p><b>Oggetto:</b> ${esc(d.subject)}</p>` : ''}
      <p><b>Messaggio:</b></p>
      <blockquote style="border-left:3px solid #c9a84c;margin:0;padding:4px 12px;color:#333">${esc(d.message).replace(/\n/g, '<br>')}</blockquote>
      <hr><p style="color:#888;font-size:12px">Lead #${id} — form contatti del sito. Nessuna risposta automatica inviata al cliente.</p>`;
    sendStudioAlertEmail(subject, html).catch(() => {});

    // Notifica WhatsApp al numero di controllo (best-effort, non blocca).
    sendTextMessage(getControlNumber(),
      `🟢 Nuovo contatto dal sito #${id}\n👤 ${d.name}\n✉️ ${d.email}${d.phone ? `\n📞 ${d.phone}` : ''}${d.subject ? `\n📌 ${d.subject}` : ''}\n\n${d.message}`
    ).catch(() => {});

    return res.json({ ok: true, id });
  } catch (err: any) {
    console.error('[site/lead]', err?.message);
    return res.status(500).json({ ok: false, error: 'Errore interno.' });
  }
}

// ─── GET /api/site/availability ───────────────────────────────────────────────
export async function siteAvailability(req: Request, res: Response) {
  try {
    const days = Math.min(parseInt(String(req.query.days || '21')) || 21, 45);
    const { slots, calendarChecked } = await getAvailability(days);
    // Espone solo i campi utili al widget pubblico.
    const out = slots.map((s) => ({ date: s.date, start: s.start, end: s.end }));
    return res.json({ ok: true, slots: out, count: out.length, calendarChecked });
  } catch (err: any) {
    console.error('[site/availability]', err?.message);
    return res.status(500).json({ ok: false, error: 'Errore interno.' });
  }
}

// ─── POST /api/site/booking-request ───────────────────────────────────────────
export async function siteBookingRequest(req: Request, res: Response) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Troppe richieste, riprova tra poco.' });
    const p = bookingSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ ok: false, error: 'Dati non validi.' });
    const d = p.data;
    if (d.website) return res.json({ ok: true, status: 'pending' }); // honeypot

    // Coerenza con lo slot proposto: deve risultare fra le disponibilità correnti.
    const { slots } = await getAvailability(45);
    const valid = slots.some((s) => s.date === d.date && s.start === d.start);
    if (!valid) return res.status(409).json({ ok: false, error: 'Lo slot selezionato non è più disponibile. Scegline un altro.' });

    const phone = onlyDigits(d.phone);
    const reason = d.reason || 'Richiesta appuntamento dal sito';
    // INVARIANTE: crea SEMPRE come "da_confermare" (pending). Nessuna conferma automatica,
    // nessun evento Google confermato: la conferma la dà lo studio dal Cruscotto.
    const apptId = recordAppointment({
      phone, contactName: d.name, eventId: null,
      date: d.date, start: d.start, end: d.end || null, reason,
    });

    const leadId = recordLead({
      kind: 'appuntamento', name: d.name, email: d.email, phone,
      subject: 'Richiesta appuntamento', message: reason,
      meta: { date: d.date, start: d.start, end: d.end || null, apptId }, ip,
    });

    const subject = `🗓️ Richiesta appuntamento dal sito — ${d.name} (${d.date} ${d.start})`;
    const html = `
      <h2 style="color:#004225;margin:0 0 8px">Richiesta appuntamento (DA CONFERMARE)</h2>
      <p><b>Cliente:</b> ${esc(d.name)}</p>
      <p><b>Email:</b> ${esc(d.email)}</p>
      <p><b>Telefono:</b> ${esc(d.phone)}</p>
      <p><b>Slot richiesto:</b> ${esc(d.date)} ore ${esc(d.start)}${d.end ? `–${esc(d.end)}` : ''}</p>
      ${d.reason ? `<p><b>Motivo:</b> ${esc(d.reason)}</p>` : ''}
      <p style="color:#b00020"><b>⚠️ Appuntamento in stato "da_confermare": va confermato dallo studio (Cruscotto / WhatsApp). Nessuna conferma automatica è stata inviata al cliente.</b></p>
      <hr><p style="color:#888;font-size:12px">Proposta #${apptId} · Lead #${leadId} — widget prenotazioni del sito.</p>`;
    sendStudioAlertEmail(subject, html).catch(() => {});

    sendTextMessage(getControlNumber(),
      `🗓️ Richiesta appuntamento dal sito (DA CONFERMARE)\n#${apptId} — ${d.name}\n📞 ${d.phone} · ✉️ ${d.email}\n📅 ${d.date} ore ${d.start}\n📌 ${reason}\n\nConferma o annulla dal Cruscotto.`
    ).catch(() => {});

    // NB: NESSUNA risposta/conferma al cliente. La conferma parte solo dallo studio.
    return res.json({ ok: true, status: 'pending', appointmentId: apptId, leadId });
  } catch (err: any) {
    console.error('[site/booking-request]', err?.message);
    return res.status(500).json({ ok: false, error: 'Errore interno.' });
  }
}
