/*
 * agenda_source.ts — FONTE DI VERITÀ dell'agenda di OGGI per le notifiche a Mariano.
 * (rev. 26/07/2026)
 *
 * PRIORITÀ: Google Calendar diretto (OAuth2 refresh-token già presente nel cruscotto:
 * GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN + GOOGLE_CALENDAR_ID). È l'agenda REALE completa:
 * appuntamenti di studio (che il bot specchia su Calendar via event_id), udienze —
 * incluse quelle TELEMATICHE con link — e qualsiasi evento inserito a mano da Mariano.
 * NON dipende da Make (che Mariano non ha ancora configurato).
 *
 * FALLBACK / MERGE: la tabella locale `bot_appointments` (SQLite sul volume /data).
 * Se Google non è configurato/raggiungibile → si usa solo bot_appointments. Se Google
 * risponde → si usano gli eventi Calendar e si AGGIUNGONO le righe bot_appointments di
 * oggi NON ancora specchiate su Calendar (event_id assente o non presente tra gli eventi),
 * così l'elenco è completo e senza duplicati.
 */

import db from './db.js';
import type { AgendaItem } from './agenda_notify_logic.js';

const TZ = 'Europe/Rome';

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
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data.access_token ?? null;
  } catch { return null; }
}

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

/** Data di OGGI in Europe/Rome (YYYY-MM-DD). */
export function romeToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Offset Europe/Rome (+01:00 / +02:00) per una data (gestisce l'ora legale). */
export function romeOffset(ds: string): string {
  const probe = new Date(`${ds}T12:00:00Z`);
  const rome = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(probe);
  return parseInt(rome, 10) - 12 === 2 ? '+02:00' : '+01:00';
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/i;
function firstUrl(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(URL_RE);
    if (m) return m[1];
  }
  return null;
}

/** Estrae il link "telematico" da un evento Calendar (hangout, conferenceData, location, descrizione). */
function eventLink(ev: any): string | null {
  const confUri = (ev?.conferenceData?.entryPoints || [])
    .filter((e: any) => e?.uri && (e.entryPointType === 'video' || String(e.uri).startsWith('http')))
    .map((e: any) => e.uri)[0];
  return firstUrl(ev?.hangoutLink, confUri, ev?.location, ev?.description);
}

/** Legge gli eventi Calendar di OGGI (singleEvents, ordinati per inizio). */
async function fetchTodayCalendarEvents(dateISO: string): Promise<{ ok: boolean; items: AgendaItem[]; eventIds: Set<string>; error?: string }> {
  const token = await getGoogleAccessToken();
  if (!token) return { ok: false, items: [], eventIds: new Set(), error: 'google-token-null' };
  const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const off = romeOffset(dateISO);
  const timeMin = `${dateISO}T00:00:00${off}`;
  const timeMax = `${dateISO}T23:59:59${off}`;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
    + `?singleEvents=true&orderBy=startTime&maxResults=50`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return { ok: false, items: [], eventIds: new Set(), error: `HTTP ${resp.status}` };
    const data = await resp.json() as any;
    const evs = (data.items || []) as any[];
    const items: AgendaItem[] = [];
    const eventIds = new Set<string>();
    for (const ev of evs) {
      if (ev.status === 'cancelled') continue;
      if (ev.id) eventIds.add(ev.id);
      const allDay = !!(ev.start?.date && !ev.start?.dateTime);
      const startISO = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00${off}` : null);
      const endISO = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00${off}` : null);
      const link = eventLink(ev);
      // Se la location coincide col link (udienza telematica messa in "luogo"), non ripeterla.
      const location = ev.location && ev.location !== link ? String(ev.location) : null;
      let note: string | null = ev.description ? String(ev.description) : null;
      if (note && link && note.includes(link)) note = note.replace(link, '').trim() || null;
      items.push({
        id: `cal:${ev.id}`,
        startISO, endISO, allDay,
        title: ev.summary || '(senza titolo)',
        counterparty: null,
        location,
        link: link || null,
        note,
        source: 'google-calendar',
      });
    }
    return { ok: true, items, eventIds };
  } catch (e: any) {
    return { ok: false, items: [], eventIds: new Set(), error: e?.message || 'fetch-error' };
  }
}

/** Righe bot_appointments di OGGI (confermato/da_confermare) come AgendaItem. */
function botAppointmentsToday(dateISO: string): { items: AgendaItem[]; rows: any[] } {
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT id, phone, contact_name, event_id, date, start, end, reason, status
      FROM bot_appointments
      WHERE date = ? AND status IN ('confermato','da_confermare')
      ORDER BY start ASC
    `).all(dateISO) as any[];
  } catch { rows = []; }
  const off = romeOffset(dateISO);
  const items: AgendaItem[] = rows.map((a) => ({
    id: `bot:${a.id}`,
    startISO: a.start ? `${a.date}T${a.start}:00${off}` : null,
    endISO: a.end ? `${a.date}T${a.end}:00${off}` : null,
    allDay: !a.start,
    title: a.reason ? String(a.reason) : 'Appuntamento in studio',
    counterparty: a.contact_name || a.phone || null,
    location: null,
    link: null,
    note: a.status === 'da_confermare' ? 'da confermare' : null,
    source: 'bot_appointments' as const,
  }));
  return { items, rows };
}

export interface TodayAgenda {
  dateISO: string;
  items: AgendaItem[];
  source: 'google-calendar' | 'bot_appointments' | 'merged' | 'none';
  googleConfigured: boolean;
  googleOk: boolean;
  googleError?: string;
  counts: { calendar: number; bot: number; total: number };
}

/**
 * Agenda REALE di oggi. Unisce Google Calendar (priorità) e bot_appointments non
 * ancora specchiate. Se Google non è disponibile → solo bot_appointments (source dichiarata).
 */
export async function getTodayAgenda(dateISO?: string): Promise<TodayAgenda> {
  const date = dateISO || romeToday();
  const gConf = googleConfigured();
  const cal = gConf ? await fetchTodayCalendarEvents(date) : { ok: false, items: [], eventIds: new Set<string>(), error: 'google-not-configured' };
  const bot = botAppointmentsToday(date);

  let items: AgendaItem[] = [];
  let source: TodayAgenda['source'] = 'none';

  if (cal.ok) {
    // Calendar è la verità; aggiungi solo le righe bot NON già presenti come evento.
    const extraBot = bot.rows
      .map((a, i) => ({ a, item: bot.items[i] }))
      .filter(({ a }) => !a.event_id || !cal.eventIds.has(a.event_id))
      .map(({ item }) => item);
    items = [...cal.items, ...extraBot];
    source = extraBot.length ? 'merged' : 'google-calendar';
  } else {
    items = bot.items;
    source = bot.items.length ? 'bot_appointments' : (gConf ? 'bot_appointments' : 'none');
  }

  return {
    dateISO: date,
    items,
    source,
    googleConfigured: gConf,
    googleOk: cal.ok,
    googleError: cal.ok ? undefined : (cal as any).error,
    counts: { calendar: cal.items.length, bot: bot.items.length, total: items.length },
  };
}
