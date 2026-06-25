/**
 * Studio Branca — Integrazioni Connettori
 * Google Contacts | Google Calendar | Notion
 *
 * Architettura ibrida:
 * - Se GOOGLE_CLIENT_ID + GOOGLE_REFRESH_TOKEN presenti: chiamate dirette OAuth2
 * - Altrimenti: gli eventi vengono accodati in integration_queue
 *   e processati dai cron Perplexity che hanno i connettori già collegati.
 */

import { db } from './db.js';

// ─── Tipi ───────────────────────────────────────────────────────────────────

export interface IntegrationLog {
  id?: number;
  integration: string;
  action: string;
  status: 'success' | 'error' | 'skipped';
  detail: string;
  created_at?: string;
}

// ─── DB: tabella integration_logs ───────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  // Coda eventi per processamento asincrono da cron Perplexity
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      processed_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
} catch {}

function logIntegration(entry: IntegrationLog) {
  try {
    db.prepare(`
      INSERT INTO integration_logs (integration, action, status, detail)
      VALUES (?, ?, ?, ?)
    `).run(entry.integration, entry.action, entry.status, entry.detail);
  } catch {}
}

function getSetting(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM integration_settings WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  } catch { return null; }
}

// ─── Helper: Google OAuth2 access token via refresh token ───────────────────

async function getGoogleAccessToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await resp.json() as any;
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

// ─── GOOGLE CONTACTS ─────────────────────────────────────────────────────────

/**
 * Cerca un contatto in Google Contacts per numero di telefono.
 * Ritorna il nome se trovato, null altrimenti.
 */
export async function findGoogleContact(phone: string): Promise<string | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null;

  try {
    // Normalizza numero
    const cleanPhone = phone.replace(/\D/g, '');

    const resp = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(cleanPhone)}&readMask=names,phoneNumbers&pageSize=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const results = data.results || [];
    for (const r of results) {
      const phones = r.person?.phoneNumbers || [];
      for (const p of phones) {
        const normalized = (p.value || '').replace(/\D/g, '');
        if (normalized.endsWith(cleanPhone) || cleanPhone.endsWith(normalized)) {
          const name = r.person?.names?.[0]?.displayName;
          return name || null;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Crea un nuovo contatto in Google Contacts.
 */
export async function createGoogleContact(params: {
  phone: string;
  name?: string;
  note?: string;
}): Promise<{ success: boolean; resourceName?: string; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) {
    return { success: false, error: 'Google OAuth non configurato' };
  }

  const displayName = params.name || params.phone;

  try {
    const body = {
      names: [{ displayName }],
      phoneNumbers: [{ value: params.phone, type: 'mobile' }],
      biographies: params.note ? [{ value: params.note, contentType: 'TEXT_PLAIN' }] : [],
    };

    const resp = await fetch('https://people.googleapis.com/v1/people:createContact', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const data = await resp.json() as any;
      logIntegration({
        integration: 'google_contacts',
        action: 'create_contact',
        status: 'success',
        detail: `Creato: ${displayName} (${params.phone})`,
      });
      return { success: true, resourceName: data.resourceName };
    } else {
      const err = await resp.text();
      logIntegration({
        integration: 'google_contacts',
        action: 'create_contact',
        status: 'error',
        detail: `Errore HTTP ${resp.status}: ${err.substring(0, 100)}`,
      });
      return { success: false, error: `HTTP ${resp.status}` };
    }
  } catch (e: any) {
    logIntegration({
      integration: 'google_contacts',
      action: 'create_contact',
      status: 'error',
      detail: e.message,
    });
    return { success: false, error: e.message };
  }
}

// ─── GOOGLE CALENDAR ─────────────────────────────────────────────────────────

/**
 * Crea un evento in Google Calendar.
 */
export async function createCalendarEvent(params: {
  title: string;
  description: string;
  startDate: string; // ISO8601
  endDate: string;   // ISO8601
  calendarId?: string;
}): Promise<{ success: boolean; eventId?: string; eventLink?: string; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) {
    return { success: false, error: 'Google OAuth non configurato' };
  }

  const calId = params.calendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';

  try {
    const event = {
      summary: params.title,
      description: params.description,
      start: { dateTime: params.startDate, timeZone: 'Europe/Rome' },
      end: { dateTime: params.endDate, timeZone: 'Europe/Rome' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'email', minutes: 1440 },
        ],
      },
    };

    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (resp.ok) {
      const data = await resp.json() as any;
      logIntegration({
        integration: 'google_calendar',
        action: 'create_event',
        status: 'success',
        detail: `Evento: "${params.title}" — ${params.startDate}`,
      });
      return { success: true, eventId: data.id, eventLink: data.htmlLink };
    } else {
      const err = await resp.text();
      logIntegration({
        integration: 'google_calendar',
        action: 'create_event',
        status: 'error',
        detail: `HTTP ${resp.status}: ${err.substring(0, 100)}`,
      });
      return { success: false, error: `HTTP ${resp.status}` };
    }
  } catch (e: any) {
    logIntegration({
      integration: 'google_calendar',
      action: 'create_event',
      status: 'error',
      detail: e.message,
    });
    return { success: false, error: e.message };
  }
}

/**
 * Aggiorna (PATCH) un evento esistente su Google Calendar.
 * Usato per confermare un appuntamento "[DA CONFERMARE]" quando il cliente conferma:
 * cambia titolo, descrizione e colore. Tutti i campi sono opzionali (PATCH parziale).
 */
export async function updateCalendarEvent(params: {
  eventId: string;
  title?: string;
  description?: string;
  colorId?: string;        // es. '10' = verde "Basil" (confermato)
  startDate?: string;      // ISO8601
  endDate?: string;        // ISO8601
  calendarId?: string;
}): Promise<{ success: boolean; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) return { success: false, error: 'Google OAuth non configurato' };
  const calId = params.calendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';

  const body: Record<string, any> = {};
  if (params.title !== undefined) body.summary = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.colorId !== undefined) body.colorId = params.colorId;
  if (params.startDate) body.start = { dateTime: params.startDate, timeZone: 'Europe/Rome' };
  if (params.endDate) body.end = { dateTime: params.endDate, timeZone: 'Europe/Rome' };

  try {
    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(params.eventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (resp.ok) {
      logIntegration({ integration: 'google_calendar', action: 'update_event', status: 'success', detail: `Evento ${params.eventId} aggiornato` });
      return { success: true };
    }
    const err = await resp.text();
    logIntegration({ integration: 'google_calendar', action: 'update_event', status: 'error', detail: `HTTP ${resp.status}: ${err.substring(0, 100)}` });
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    logIntegration({ integration: 'google_calendar', action: 'update_event', status: 'error', detail: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Aggiunge testo IN CODA alla descrizione di un evento esistente (GET + PATCH), senza
 * sovrascrivere quanto già presente. Usato per annotare sull'appuntamento i documenti
 * ricevuti dal cliente dopo la creazione dell'evento.
 */
export async function appendEventDescription(eventId: string, text: string, calendarId?: string): Promise<{ success: boolean; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) return { success: false, error: 'Google OAuth non configurato' };
  const calId = calendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';
  try {
    const getResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    let desc = '';
    if (getResp.ok) { const ev = await getResp.json() as any; desc = ev.description || ''; }
    const newDesc = desc ? `${desc}\n${text}` : text;
    return updateCalendarEvent({ eventId, description: newDesc, calendarId: calId });
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Crea/aggiorna un evento "tutto il giorno" su Google Calendar.
 * Usato dal digest giornaliero: se eventId è fornito aggiorna (PATCH), altrimenti
 * crea. `date` = YYYY-MM-DD (l'evento copre l'intera giornata, transparent = non
 * blocca l'agenda perché è una nota, non un impegno).
 */
export async function upsertAllDayEvent(params: {
  title: string;
  description: string;
  date: string;
  eventId?: string | null;
  calendarId?: string;
}): Promise<{ success: boolean; eventId?: string; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) return { success: false, error: 'Google OAuth non configurato' };
  const calId = params.calendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';
  const next = new Date(`${params.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endDate = next.toISOString().slice(0, 10);
  const event = {
    summary: params.title,
    description: params.description,
    start: { date: params.date },
    end: { date: endDate },
    transparency: 'transparent',
  };
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
  const url = params.eventId ? `${base}/${encodeURIComponent(params.eventId)}` : base;
  const method = params.eventId ? 'PATCH' : 'POST';
  try {
    const resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      logIntegration({ integration: 'google_calendar', action: params.eventId ? 'update_digest' : 'create_digest', status: 'success', detail: params.date });
      return { success: true, eventId: data.id };
    }
    if (resp.status === 404 && params.eventId) {
      return upsertAllDayEvent({ ...params, eventId: null }); // eventId stantio → ricrea
    }
    const err = await resp.text();
    logIntegration({ integration: 'google_calendar', action: 'digest', status: 'error', detail: `HTTP ${resp.status}: ${err.substring(0, 80)}` });
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ─── NOTION ──────────────────────────────────────────────────────────────────

const NOTION_VERSION = '2022-06-28';

/**
 * Salva una comunicazione WhatsApp nel database Notion Comunicazioni.
 */
export async function saveToNotionComunicazioni(params: {
  oggetto: string;
  estratto: string;
  canale: 'WhatsApp' | 'Email' | 'Telefono' | 'Di persona' | 'PEC';
  direzione: 'Ricevuto' | 'Inviato';
  data: string; // ISO date YYYY-MM-DD
  stato?: 'Da rispondere' | 'Risposto' | 'In attesa' | 'Archiviato';
  note?: string;
}): Promise<{ success: boolean; pageId?: string; error?: string }> {
  const notionToken = process.env.NOTION_API_KEY;
  const dbId = process.env.NOTION_COMUNICAZIONI_DB_ID || '2373e517cc104920a7cc346bd22b9515';

  if (!notionToken) {
    return { success: false, error: 'NOTION_API_KEY non configurata' };
  }

  try {
    const properties: Record<string, any> = {
      Oggetto: { title: [{ text: { content: params.oggetto } }] },
      Canale: { select: { name: params.canale } },
      Direzione: { select: { name: params.direzione } },
      Stato: { select: { name: params.stato || 'Da rispondere' } },
      Data: { date: { start: params.data } },
    };

    if (params.estratto) {
      properties.Estratto = { rich_text: [{ text: { content: params.estratto.substring(0, 2000) } }] };
    }
    if (params.note) {
      properties.Note = { rich_text: [{ text: { content: params.note.substring(0, 2000) } }] };
    }

    const resp = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${notionToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    });

    if (resp.ok) {
      const data = await resp.json() as any;
      logIntegration({
        integration: 'notion',
        action: 'save_comunicazione',
        status: 'success',
        detail: `Salvato: "${params.oggetto}"`,
      });
      return { success: true, pageId: data.id };
    } else {
      const err = await resp.text();
      logIntegration({
        integration: 'notion',
        action: 'save_comunicazione',
        status: 'error',
        detail: `HTTP ${resp.status}: ${err.substring(0, 100)}`,
      });
      return { success: false, error: `HTTP ${resp.status}` };
    }
  } catch (e: any) {
    logIntegration({
      integration: 'notion',
      action: 'save_comunicazione',
      status: 'error',
      detail: e.message,
    });
    return { success: false, error: e.message };
  }
}

// ─── RILEVAMENTO APPUNTAMENTI ────────────────────────────────────────────────

const APPOINTMENT_KEYWORDS = [
  'appuntamento', 'incontro', 'riunione', 'meeting', 'chiamata', 'colloquio',
  'quando ci vediamo', 'possiamo vederci', 'disponibile', 'libero il',
  'prenota', 'prenotare', 'fissare', 'fissare un', 'quando sei',
];

/**
 * Rileva se un messaggio contiene una richiesta di appuntamento.
 */
export function detectAppointmentRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return APPOINTMENT_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── EXPORT: getLogs ─────────────────────────────────────────────────────────

export function getIntegrationLogs(limit = 50): IntegrationLog[] {
  try {
    return db.prepare(`
      SELECT * FROM integration_logs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as IntegrationLog[];
  } catch {
    return [];
  }
}

export function getIntegrationStats(): Record<string, any> {
  try {
    const stats = db.prepare(`
      SELECT integration, status, COUNT(*) as count
      FROM integration_logs
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY integration, status
    `).all() as any[];

    const result: Record<string, any> = {};
    for (const row of stats) {
      if (!result[row.integration]) result[row.integration] = { success: 0, error: 0, skipped: 0 };
      result[row.integration][row.status] = (result[row.integration][row.status] || 0) + row.count;
    }
    return result;
  } catch {
    return {};
  }
}

// ─── CODA EVENTI (per cron Perplexity) ──────────────────────────────────────

export function enqueueEvent(eventType: string, payload: Record<string, any>): number {
  try {
    const result = db.prepare(`
      INSERT INTO integration_queue (event_type, payload)
      VALUES (?, ?)
    `).run(eventType, JSON.stringify(payload));
    return result.lastInsertRowid as number;
  } catch {
    return -1;
  }
}

export function getPendingEvents(limit = 50): any[] {
  try {
    return db.prepare(`
      SELECT * FROM integration_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as any[];
  } catch {
    return [];
  }
}

export function markEventProcessed(id: number, success: boolean, error?: string): void {
  try {
    db.prepare(`
      UPDATE integration_queue
      SET status = ?, processed_at = datetime('now'), error = ?
      WHERE id = ?
    `).run(success ? 'done' : 'error', error || null, id);
  } catch {}
}

export function getQueueStats(): any {
  try {
    return db.prepare(`
      SELECT status, COUNT(*) as count
      FROM integration_queue
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY status
    `).all();
  } catch {
    return [];
  }
}
