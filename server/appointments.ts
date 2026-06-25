/**
 * Disponibilità appuntamenti — Studio Tributario Branca
 *
 * Calcola gli slot liberi incrociando l'orario studio con Google Calendar
 * (freeBusy). Regole fisse concordate (ricevimento Dott. Branca, salvo appuntamenti):
 *  - lun, mar, gio: 9:00–18:00 a orario continuato
 *  - mer, ven: 9:00–13:00 (solo mattina)
 *  - ESCLUSI: sabato, domenica
 *  - ESCLUSE: feste comandate italiane (incl. lunedì dell'Angelo)
 *  - ESCLUSA: chiusura estiva 20 luglio – 31 agosto (ogni anno)
 */

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

function isSummerClosure(ds: string): boolean {
  const md = ds.slice(5); // MM-DD
  return md >= '07-20' && md <= '08-31';
}

interface Slot { date: string; start: string; end: string; dow: number; }

// Slot teorici di un giorno secondo le regole studio (slot da 1 ora)
function daySlots(ds: string, dow: number): Slot[] {
  if (dow === 0 || dow === 6) return [];          // domenica, sabato
  if (isHoliday(ds) || isSummerClosure(ds)) return [];
  // Lun(1), Mar(2), Gio(4): orario continuato 9:00–18:00. Mer(3) e Ven(5): solo 9:00–13:00.
  const fullDay = dow === 1 || dow === 2 || dow === 4;
  const lastHour = fullDay ? 18 : 13;
  const out: Slot[] = [];
  for (let h = 9; h < lastHour; h++) out.push({ date: ds, start: `${String(h).padStart(2, '0')}:00`, end: `${String(h + 1).padStart(2, '0')}:00`, dow });
  return out;
}

// Offset Europe/Rome per una data (gestisce ora legale)
function romeOffset(ds: string): string {
  const probe = new Date(`${ds}T12:00:00Z`);
  const rome = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(probe);
  return parseInt(rome) - 12 === 2 ? '+02:00' : '+01:00';
}

export async function getAvailability(days = 14): Promise<{ slots: Slot[]; calendarChecked: boolean }> {
  const today = new Date();
  const all: Slot[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    all.push(...daySlots(ds, d.getDay()));
  }
  if (!all.length) return { slots: [], calendarChecked: false };

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
  return { slots: free, calendarChecked };
}

/**
 * Verifica se uno slot specifico è occupato in Google Calendar (freeBusy).
 * Usato al momento dell'approvazione di un appuntamento per avvisare Mariano
 * se nel frattempo è diventato impegnato. Ritorna { busy, checked }: se il
 * calendario non è verificabile (checked=false) NON si blocca l'approvazione.
 */
export async function isSlotBusy(date: string, start: string, end: string): Promise<{ busy: boolean; checked: boolean }> {
  const token = await getGoogleAccessToken();
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
    if (!resp.ok) return { busy: false, checked: false };
    const data = await resp.json() as any;
    const cal = data.calendars?.[Object.keys(data.calendars || {})[0]];
    const busy = (cal?.busy || []).length > 0;
    return { busy, checked: true };
  } catch {
    return { busy: false, checked: false };
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
