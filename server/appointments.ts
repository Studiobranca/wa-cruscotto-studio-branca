/**
 * Disponibilità appuntamenti — Studio Tributario Branca
 *
 * Calcola gli slot liberi incrociando l'orario studio con Google Calendar
 * (freeBusy). Calendario ricevimento Dott. Branca (salvo appuntamenti):
 *  ── ORARIO STANDARD (fino al 9 luglio 2026 e da settembre 2026) ──
 *  - lun, mar, gio: 9:00–18:00 a orario continuato
 *  - mer, ven: 9:00–13:00 (solo mattina)
 *  ── ORARIO ESTIVO 2026 (date esatte comunicate dallo Studio) ──
 *  - 10–25 luglio 2026: ORARIO UNICO 9:00–14:00 tutti i feriali
 *  - 26 luglio – 31 agosto 2026: CHIUSO, NESSUN appuntamento
 *  - 1–30 settembre 2026: torna all'orario STANDARD
 *  - da ottobre 2026: DA RIDETERMINARE → per ora usa lo STANDARD (fallback)
 *  ── SEMPRE esclusi ──
 *  - sabato, domenica; feste comandate italiane (incl. lunedì dell'Angelo)
 */

const TZ = 'Europe/Rome';

// Periodi 2026 a date esatte (override sullo standard). ATTENZIONE: lo Studio
// rideterminerà ottobre 2026 → finché non arriva, ottobre+ usa lo standard.
const ESTIVO_UNICO_DA = '2026-07-10';   // incluso
const ESTIVO_UNICO_A = '2026-07-25';    // incluso → 9–14 ogni feriale
const CHIUSURA_DA = '2026-07-26';       // incluso
const CHIUSURA_A = '2026-08-31';        // incluso → niente appuntamenti

// Finestra di apertura del giorno (ore intere) o null se CHIUSO. dow: 0=dom..6=sab.
function openWindow(ds: string, dow: number): { start: number; last: number } | null {
  if (ds >= ESTIVO_UNICO_DA && ds <= ESTIVO_UNICO_A) return { start: 9, last: 14 }; // orario unico estivo
  if (ds >= CHIUSURA_DA && ds <= CHIUSURA_A) return null;                            // chiusura estiva
  const fullDay = dow === 1 || dow === 2 || dow === 4;                              // standard
  return { start: 9, last: fullDay ? 18 : 13 };
}

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

// Pasqua (algoritmo di Gauss) → lunedì dell'Angelo
function easterMonday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(Date.UTC(year, month - 1, day));
  easter.setUTCDate(easter.getUTCDate() + 1);
  return easter.toISOString().slice(0, 10);
}

function isHoliday(ds: string): boolean {
  const [y, md] = [parseInt(ds.slice(0, 4)), ds.slice(5)];
  const fixed = ['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'];
  if (fixed.includes(md)) return true;
  if (ds === easterMonday(y)) return true;
  return false;
}

interface Slot { date: string; start: string; end: string; dow: number; }

// Slot teorici di un giorno secondo il calendario studio (slot da 1 ora).
function daySlots(ds: string, dow: number): Slot[] {
  if (dow === 0 || dow === 6) return [];          // domenica, sabato
  if (isHoliday(ds)) return [];
  const win = openWindow(ds, dow);                // null = chiuso (es. 26/7–31/8)
  if (!win) return [];
  const out: Slot[] = [];
  for (let h = win.start; h < win.last; h++) {
    out.push({ date: ds, start: `${String(h).padStart(2, '0')}:00`, end: `${String(h + 1).padStart(2, '0')}:00`, dow });
  }
  return out;
}

// Offset Europe/Rome per una data (gestisce ora legale)
function romeOffset(ds: string): string {
  const probe = new Date(`${ds}T12:00:00Z`);
  const rome = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(probe);
  return parseInt(rome) - 12 === 2 ? '+02:00' : '+01:00';
}

const MAX_LOOKAHEAD = 120; // cap duro: oltre non cerchiamo la riapertura (anti-runaway)

export async function getAvailability(days = 14, fromDate?: Date): Promise<{ slots: Slot[]; calendarChecked: boolean; reopening?: boolean }> {
  const today = fromDate ?? new Date(); // fromDate solo per test deterministici; in produzione = oggi
  const dsOf = (i: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return { ds: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, dow: d.getDay() };
  };
  const all: Slot[] = [];
  for (let i = 1; i <= days; i++) {
    const { ds, dow } = dsOf(i);
    all.push(...daySlots(ds, dow));
  }
  // CHIUSURA ESTIVA (26/07–31/08) o finestra interamente chiusa: se nei prossimi
  // `days` giorni non esiste NEMMENO uno slot teorico (studio chiuso), guarda OLTRE
  // la chiusura e proponi le PRIME DATE DI RIAPERTURA (max ~4 giorni aperti), restando
  // nel flusso appuntamento invece di spingere la lista d'attesa. (UX 28/07/2026)
  let reopening = false;
  if (!all.length) {
    let openDays = 0; let lastDate = '';
    for (let i = days + 1; i <= MAX_LOOKAHEAD; i++) {
      const { ds, dow } = dsOf(i);
      const s = daySlots(ds, dow);
      if (!s.length) continue;
      if (ds !== lastDate) { if (openDays >= 4) break; openDays++; lastDate = ds; }
      all.push(...s);
      reopening = true;
    }
  }
  if (!all.length) return { slots: [], calendarChecked: false, reopening };

  // Occupato da Google Calendar (freeBusy su 'primary')
  let busy: { start: number; end: number }[] = [];
  let calendarChecked = false;
  const token = await getGoogleAccessToken();
  if (token) {
    try {
      const first = all[0], last = all[all.length - 1];
      const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: `${first.date}T00:00:00${romeOffset(first.date)}`,
          timeMax: `${last.date}T23:59:59${romeOffset(last.date)}`,
          timeZone: TZ,
          items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const cal = data.calendars?.[Object.keys(data.calendars || {})[0]];
        busy = (cal?.busy || []).map((b: any) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
        calendarChecked = true;
      }
    } catch (e) {
      console.error('[Appuntamenti] freeBusy:', e);
    }
  }

  const free = all.filter(s => {
    const off = romeOffset(s.date);
    const st = Date.parse(`${s.date}T${s.start}:00${off}`);
    const en = Date.parse(`${s.date}T${s.end}:00${off}`);
    return !busy.some(b => b.start < en && b.end > st);
  });
  return { slots: free, calendarChecked, reopening };
}

/**
 * Verifica se uno slot specifico è occupato in Google Calendar (freeBusy).
 * Usato al momento dell'approvazione di un appuntamento per avvisare Mariano
 * se nel frattempo è diventato impegnato. Ritorna { busy, checked }: se il
 * calendario non è verificabile (checked=false) NON si blocca l'approvazione.
 */
export async function isSlotBusy(date: string, start: string, end: string): Promise<{ busy: boolean; checked: boolean; error?: boolean }> {
  const token = await getGoogleAccessToken();
  // Google NON configurato: non è un errore, semplicemente non verificabile (checked=false).
  if (!token) return { busy: false, checked: false };
  const off = romeOffset(date);
  try {
    const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: `${date}T${start}:00${off}`,
        timeMax: `${date}T${end}:00${off}`,
        timeZone: TZ,
        items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
      }),
    });
    // ERRORE di verifica (Google configurato ma non risponde): fail-safe anti-overbooking
    // → segnala error, così il chiamante NON auto-conferma e lascia la bozza.
    if (!resp.ok) { console.error('[Appuntamenti] isSlotBusy HTTP', resp.status); return { busy: false, checked: false, error: true }; }
    const data = await resp.json() as any;
    const cal = data.calendars?.[Object.keys(data.calendars || {})[0]];
    const busy = (cal?.busy || []).length > 0;
    return { busy, checked: true };
  } catch (e: any) {
    console.error('[Appuntamenti] isSlotBusy errore:', e?.message);
    return { busy: false, checked: false, error: true };
  }
}

const DOW_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTH_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Testo italiano con le prime disponibilità, raggruppate per giorno. */
export function formatAvailabilityIT(slots: Slot[], maxDays = 4, maxPerDay = 3): string {
  if (!slots.length) return 'al momento non ci sono disponibilità nei prossimi giorni; la ricontatteremo appena possibile';
  const byDay: Record<string, Slot[]> = {};
  for (const s of slots) { (byDay[s.date] = byDay[s.date] || []).push(s); }
  const lines: string[] = [];
  for (const ds of Object.keys(byDay).sort().slice(0, maxDays)) {
    const d = byDay[ds];
    const day = parseInt(ds.slice(8, 10)), month = MONTH_IT[parseInt(ds.slice(5, 7)) - 1];
    const hours = d.slice(0, maxPerDay).map(s => s.start).join(', ');
    lines.push(`• ${DOW_IT[d[0].dow]} ${day} ${month}: ore ${hours}`);
  }
  return lines.join('\n');
}

/** Data in italiano (senza giorno della settimana), es. "3 luglio". */
export function formatDateIT(ds: string): string {
  const day = parseInt(ds.slice(8, 10), 10), month = MONTH_IT[parseInt(ds.slice(5, 7), 10) - 1];
  return `${day} ${month}`;
}

/** Giorno della settimana italiano di una data YYYY-MM-DD (calcolo a mezzogiorno UTC:
 *  indipendente dal fuso del server). */
export function weekdayIT(ds: string): string {
  return DOW_IT[new Date(`${ds}T12:00:00Z`).getUTCDay()] || '';
}

/** Data COMPLETA in italiano con giorno della settimana, es. "giovedì 16 luglio 2026".
 *  È la formulazione che il bot deve COPIARE nel testo al cliente (incidente 13/07:
 *  il modello scriveva "giovedì 16" ma registrava il 17 — il giorno lo calcola il server). */
export function formatDateFullIT(ds: string): string {
  return `${weekdayIT(ds)} ${formatDateIT(ds)} ${ds.slice(0, 4)}`;
}

export interface NowStatus {
  isOpenNow: boolean;
  freeNow: boolean;
  appointmentsRemainingToday: number;
  nextSlot: { date: string; start: string } | null;
  calendarChecked: boolean;
}

/**
 * Stato "adesso" per le richieste di passare SUBITO in studio (non un appuntamento
 * futuro): lo studio è aperto in questo momento? Il Dott. Branca è libero ADESSO?
 * Quanti impegni restano oggi prima che si liberi? Se lo studio è chiuso ora, qual è
 * la prima data/ora utile? Sempre incrociato con l'orario REALE dello studio
 * (openWindow/isHoliday, le stesse regole di getAvailability) e con Google Calendar.
 */
export async function getNowStatus(): Promise<NowStatus> {
  const now = new Date();
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now), 10);

  const todaySlots = daySlots(todayISO, dow);
  const isOpenNow = todaySlots.some((s) => hour >= parseInt(s.start.slice(0, 2), 10) && hour < parseInt(s.end.slice(0, 2), 10));

  let freeNow = true;
  let appointmentsRemainingToday = 0;
  let calendarChecked = false;

  const token = await getGoogleAccessToken();
  // Il freeBusy di "oggi" serve solo se lo studio è aperto ORA (freeNow/appointmentsRemainingToday
  // non vengono letti dal chiamante quando isOpenNow è false — vedi runTool check_walkin_now).
  if (token && isOpenNow && todaySlots.length) {
    try {
      const off = romeOffset(todayISO);
      const last = todaySlots[todaySlots.length - 1];
      const timeMax = `${todayISO}T${last.end}:00${off}`;
      const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: now.toISOString(),
          timeMax,
          timeZone: TZ,
          items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const cal = data.calendars?.[Object.keys(data.calendars || {})[0]];
        const busy = (cal?.busy || []) as { start: string; end: string }[];
        calendarChecked = true;
        appointmentsRemainingToday = busy.length;
        const nowMs = now.getTime();
        freeNow = !busy.some((b) => Date.parse(b.start) <= nowMs && Date.parse(b.end) > nowMs);
      }
    } catch (e) {
      console.error('[Appuntamenti] getNowStatus freeBusy:', e);
    }
  }

  let nextSlot: { date: string; start: string } | null = null;
  if (!isOpenNow) {
    const firstToday = todaySlots[0];
    if (firstToday && hour < parseInt(firstToday.start.slice(0, 2), 10)) {
      // Oggi apriamo più tardi: il prossimo slot utile è oggi stesso.
      nextSlot = { date: todayISO, start: firstToday.start };
    } else {
      // Oggi è finito (o chiuso tutto il giorno): cerca il primo slot dei prossimi giorni.
      const { slots } = await getAvailability(60);
      if (slots.length) nextSlot = { date: slots[0].date, start: slots[0].start };
    }
  }

  return { isOpenNow, freeNow, appointmentsRemainingToday, nextSlot, calendarChecked };
}
