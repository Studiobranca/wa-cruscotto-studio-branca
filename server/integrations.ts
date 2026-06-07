/**
 * Studio Branca — Integrazioni Connettori
 * Google Contacts | Google Calendar | Notion
 *
 * Tutte le chiamate usano OAuth2 token o API key configurate
 * come variabili d'ambiente in Railway.
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
