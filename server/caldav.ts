/**
 * caldav.ts — Specchio degli appuntamenti su Apple Calendar (iCloud CalDAV).
 *
 * SICUREZZA/INVARIANTE: è un mirror OPZIONALE, DISATTIVO per default. Si accende
 * SOLO con env APPLE_CALENDAR_ENABLED=1. Ogni funzione è best-effort e non lancia
 * mai: un guasto iCloud NON deve toccare il flusso Google/agenda già funzionante.
 *
 * Credenziali: EMAIL_ICLOUD_USER (default studiobranca@icloud.com) + EMAIL_ICLOUD_PASS
 * (app-specific password già presente per la posta). Calendario di destinazione:
 * APPLE_CALENDAR_URL (href collezione completo) OPPURE APPLE_CALENDAR_NAME (nome
 * visibile, es. "Home"). Finché Mariano non sceglie il calendario, il mirror resta OFF.
 */

const HOST = 'https://caldav.icloud.com';

export function appleEnabled(): boolean {
  return process.env.APPLE_CALENDAR_ENABLED === '1' && !!process.env.EMAIL_ICLOUD_PASS;
}
function authHeader(): string {
  const user = process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com';
  const pass = process.env.EMAIL_ICLOUD_PASS || '';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

let cachedCollection: string | null = null;

async function propfind(url: string, body: string, depth = '1'): Promise<string> {
  const r = await fetch(url, { method: 'PROPFIND', headers: { Authorization: authHeader(), 'Content-Type': 'application/xml; charset=utf-8', Depth: depth }, body });
  return r.text();
}

/** Trova l'href della collezione calendario di destinazione (cache in-process). */
async function resolveCollection(): Promise<string | null> {
  if (process.env.APPLE_CALENDAR_URL) return process.env.APPLE_CALENDAR_URL;
  if (cachedCollection) return cachedCollection;
  try {
    // principal → calendar-home → match per nome
    let xml = await propfind(HOST + '/', `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`, '0');
    const principal = (xml.match(/current-user-principal[^>]*>[\s\S]*?<href[^>]*>([^<]+)</i) || [])[1];
    if (!principal) return null;
    xml = await propfind(HOST + principal, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, '0');
    const home = (xml.match(/calendar-home-set[^>]*>[\s\S]*?<href[^>]*>([^<]+)</i) || [])[1];
    if (!home) return null;
    const homeUrl = home.startsWith('http') ? home : HOST + home;
    xml = await propfind(homeUrl, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`, '1');
    const want = (process.env.APPLE_CALENDAR_NAME || 'Home').toLowerCase();
    let fallback: string | null = null;
    for (const m of xml.matchAll(/<response[^>]*>([\s\S]*?)<\/response>/gi)) {
      const b = m[1];
      const href = (b.match(/<href[^>]*>([^<]+)</i) || [])[1];
      const name = ((b.match(/<displayname[^>]*>([^<]*)</i) || [])[1] || '').trim();
      const isCal = /<calendar[\s\/>]/i.test(b) && /VEVENT/i.test(b);
      if (!href || !isCal) continue;
      if (!fallback) fallback = href;
      if (name.toLowerCase() === want) { cachedCollection = href; return href; }
    }
    cachedCollection = fallback;
    return fallback;
  } catch { return null; }
}

function icsEscape(s: string): string {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function dtLocal(dateIso: string, hhmm: string): string {
  return `${dateIso.replace(/-/g, '')}T${(hhmm || '09:00').replace(':', '')}00`;
}

export interface AppleEvent {
  uid: string;            // stabile (es. google eventId o cruscotto-<id>)
  summary: string;
  description?: string;
  date: string;           // YYYY-MM-DD
  start: string;          // HH:MM
  end?: string | null;    // HH:MM
  location?: string;
}

/** Crea/aggiorna (PUT idempotente) l'evento su Apple Calendar. Best-effort. */
export async function mirrorToApple(ev: AppleEvent): Promise<boolean> {
  if (!appleEnabled()) return false;
  try {
    const col = await resolveCollection();
    if (!col) return false;
    const end = ev.end || (() => { const [h, m] = ev.start.split(':').map(Number); const d = new Date(2000, 0, 1, h, m + 30); return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`; })();
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//cruscotto//ponte//IT', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${now}`,
      `DTSTART;TZID=Europe/Rome:${dtLocal(ev.date, ev.start)}`,
      `DTEND;TZID=Europe/Rome:${dtLocal(ev.date, end)}`,
      `SUMMARY:${icsEscape(ev.summary)}`,
      ev.description ? `DESCRIPTION:${icsEscape(ev.description)}` : '',
      ev.location ? `LOCATION:${icsEscape(ev.location)}` : '',
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    const url = HOST + col + encodeURIComponent(ev.uid) + '.ics';
    const r = await fetch(url, { method: 'PUT', headers: { Authorization: authHeader(), 'Content-Type': 'text/calendar; charset=utf-8' }, body: ics });
    return r.status >= 200 && r.status < 300;
  } catch (e: any) { console.error('[CalDAV] mirror fallito:', e.message); return false; }
}

/** Cancella l'evento su Apple Calendar (per disdetta/scadenza). Best-effort. */
export async function deleteFromApple(uid: string): Promise<boolean> {
  if (!appleEnabled()) return false;
  try {
    const col = await resolveCollection();
    if (!col) return false;
    const url = HOST + col + encodeURIComponent(uid) + '.ics';
    const r = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader() } });
    return r.status >= 200 && r.status < 300;
  } catch (e: any) { console.error('[CalDAV] delete fallito:', e.message); return false; }
}
