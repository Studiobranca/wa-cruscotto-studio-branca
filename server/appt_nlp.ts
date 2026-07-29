/**
 * appt_nlp.ts — Estrazione linguaggio naturale (italiano) per il PONTE conferma→agenda.
 *
 * Legge le RISPOSTE di Mariano (testo o vocale trascritto) per capire se sta
 * CONFERMANDO / SPOSTANDO / DISDICENDO un appuntamento e, quando indicato, con
 * quale data/ora. Regola d'oro: MEGLIO NON DECIDERE CHE INVENTARE. Se la data o
 * l'ora sono ambigue, si ritorna `ambiguous` e il chiamante NON crea nulla.
 *
 * Funzioni PURE (nessun I/O): unit-testabili con un `now` fisso.
 */

export type ApptIntent = 'confirm' | 'cancel' | null;

const MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, sett: 9, ott: 10, nov: 11, dic: 12,
};
const WEEKDAYS: Record<string, number> = {
  // 0=domenica … 6=sabato (come getDay)
  domenica: 0, lunedi: 1, 'lunedì': 1, martedi: 2, 'martedì': 2, mercoledi: 3, 'mercoledì': 3,
  giovedi: 4, 'giovedì': 4, venerdi: 5, 'venerdì': 5, sabato: 6,
};

function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[’`]/g, "'").trim();
}

/** Intento appuntamento nel messaggio di Mariano. cancel ha priorità su confirm. */
export function detectApptIntent(text: string): ApptIntent {
  const t = norm(text);
  if (!t) return null;
  // Disdetta / annullamento (prioritario)
  if (/\b(annull|disd|cancell|niente appuntament|non se ne fa|salta l'appunt|salti?amo l'appunt)/.test(t)) return 'cancel';
  // Conferma / accordo su appuntamento
  if (/\b(conferm|va bene|va benissimo|d'accordo|daccordo|ci vediamo|ci sentiamo|perfetto|procediamo|fissi?amo|fissa(lo)?|blocca(lo)?|prenot|metti in agenda|segna(lo)? in agenda|ci sto|ok(ay)?\b|okey|👍|✅)/.test(t)) return 'confirm';
  return null;
}

export interface ExtractedDT {
  date?: string;  // YYYY-MM-DD
  time?: string;  // HH:MM
  ambiguousTime?: boolean;
}

function iso(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

/** Estrae DATA e ORA (italiano) dal testo. `now` = riferimento (Europe/Rome). */
export function extractDateTimeIT(text: string, now: Date): ExtractedDT {
  const t = norm(text).replace(/\ball['e ]?/g, 'alle '); // "all'una"→"alle una" (best-effort)
  const out: ExtractedDT = {};
  const y0 = now.getFullYear(), m0 = now.getMonth() + 1, d0 = now.getDate();

  // ── ORA ─────────────────────────────────────────────────────────────
  // mezzogiorno / mezzanotte
  if (/mezzogiorno/.test(t)) out.time = '12:00';
  else if (/mezzanotte/.test(t)) out.time = '00:00';
  else {
    // "alle 15", "alle 15:30", "ore 10", "10:00", "15.30", "15,30", "h 9"
    const tm = t.match(/(?:\balle\b|\bore\b|\bh\b|\ba\b)\s*(\d{1,2})(?:[:.,](\d{2}))?/) ||
               t.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (tm) {
      let hh = parseInt(tm[1], 10);
      const mm = tm[2] ? parseInt(tm[2], 10) : 0;
      if (hh <= 23 && mm <= 59) {
        const pm = /pomeriggio|sera|del pome|di sera/.test(t);
        const am = /mattin|di matt/.test(t);
        if (pm && hh >= 1 && hh <= 7) hh += 12;               // "alle 3 del pomeriggio" → 15
        else if (!pm && !am && hh >= 1 && hh <= 7) { hh += 12; out.ambiguousTime = true; } // studio: 1-7 → pomeriggio (segnalato)
        out.time = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
      }
    }
  }

  // ── DATA ────────────────────────────────────────────────────────────
  const setDate = (y: number, m: number, d: number) => { out.date = iso(y, m, d); };

  if (/\boggi\b/.test(t)) setDate(y0, m0, d0);
  else if (/dopodomani/.test(t)) { const dd = new Date(now); dd.setDate(dd.getDate() + 2); setDate(dd.getFullYear(), dd.getMonth() + 1, dd.getDate()); }
  else if (/\bdomani\b/.test(t)) { const dd = new Date(now); dd.setDate(dd.getDate() + 1); setDate(dd.getFullYear(), dd.getMonth() + 1, dd.getDate()); }

  if (!out.date) {
    // giorno + mese testuale: "3 settembre", "il 3 di settembre 2026"
    const dm = t.match(/\b(\d{1,2})(?:\s*(?:°|º))?\s*(?:di\s+)?(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|gen|feb|mar|apr|mag|giu|lug|ago|sett?|ott|nov|dic)\b(?:\s+(\d{4}))?/);
    if (dm) {
      const d = parseInt(dm[1], 10);
      const m = MONTHS[dm[2]];
      let y = dm[3] ? parseInt(dm[3], 10) : y0;
      if (!dm[3] && (m < m0 || (m === m0 && d < d0))) y = y0 + 1; // passato → prossimo anno
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) setDate(y, m, d);
    }
  }

  if (!out.date) {
    // numerico: 3/9, 03/09/2026, 3-9-26
    const dn = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
    if (dn) {
      const d = parseInt(dn[1], 10), m = parseInt(dn[2], 10);
      let y = dn[3] ? parseInt(dn[3], 10) : y0;
      if (y < 100) y += 2000;
      if (!dn[3] && (m < m0 || (m === m0 && d < d0))) y = y0 + 1;
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) setDate(y, m, d);
    }
  }

  if (!out.date) {
    // giorno della settimana: "martedì", "martedì prossimo"
    const wd = t.match(/\b(domenica|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato)(\s+prossim[oa])?/);
    if (wd) {
      const target = WEEKDAYS[wd[1]];
      const forceNext = !!wd[2];
      const dd = new Date(now);
      let delta = (target - dd.getDay() + 7) % 7;  // 0 = stesso giorno (oggi)
      if (forceNext) delta += 7;                    // "prossimo" = settimana successiva
      dd.setDate(dd.getDate() + delta);
      setDate(dd.getFullYear(), dd.getMonth() + 1, dd.getDate());
    }
  }

  return out;
}
