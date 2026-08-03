/*
 * date_guard.ts — Guardia PURA di coerenza tra il testo per il cliente e la data
 * reale dell'appuntamento registrato.
 *
 * INCIDENTE (13/07/2026, Conti Domenico): il modello scriveva al cliente
 * "giovedì 16 luglio" ma passava a propose_booking date=2026-07-17 (venerdì);
 * alla conferma scriveva "giovedì 17 luglio" (il 17 è venerdì). Il cliente si è
 * confuso e ha dovuto chiedere ("Scusi giovedì 16 o venerdì?").
 *
 * Questa funzione confronta il testo con la data ISO dell'evento: se il testo cita
 * un giorno della settimana o un "N <mese>" incompatibile con la data reale, il
 * messaggio NON deve partire in autonomia (→ bozza da rivedere).
 *
 * Modulo puro e senza import del resto del server (come sanitize.ts) → testabile.
 */

const DOW_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTH_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Giorno della settimana (it) di YYYY-MM-DD, calcolato a mezzogiorno UTC. */
function weekdayOf(ds: string): string {
  return DOW_IT[new Date(`${ds}T12:00:00Z`).getUTCDay()] || '';
}

// I giorni si cercano anche senza accento ("lunedi") e case-insensitive.
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Verifica la coerenza tra `text` (messaggio per il cliente) e `dateISO`
 * (YYYY-MM-DD dell'appuntamento proposto/confermato).
 *
 * Ritorna `null` se coerente (o non verificabile), altrimenti una descrizione
 * del problema. Criterio prudente per evitare falsi positivi: si segnala SOLO
 * quando il testo cita giorni/date dello stesso "tipo" ma NESSUNA occorrenza
 * corrisponde a quella vera (un testo può legittimamente citare anche una data
 * vecchia, es. "il precedente appuntamento del 17 luglio è stato annullato",
 * purché citi da qualche parte anche quella giusta).
 */
export function dateCoherenceIssue(text: string, dateISO: string): string | null {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO || '')) return null;
  const t = norm(text);
  const issues: string[] = [];

  // 1) Giorno della settimana: se nel testo compare ALMENO un nome di giorno ma
  //    NON compare quello vero della data registrata → incoerenza.
  const trueDow = norm(weekdayOf(dateISO));
  const mentioned = DOW_IT.map(norm).filter((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (mentioned.length && !mentioned.includes(trueDow)) {
    issues.push(`il testo cita ${mentioned.join('/')} ma la data registrata (${dateISO}) è di ${trueDow}`);
  }

  // 2) Giorno del mese: se il testo cita "N <mese-vero>" ma mai "<giorno-vero> <mese-vero>".
  const month = MONTH_IT[parseInt(dateISO.slice(5, 7), 10) - 1];
  const trueDay = parseInt(dateISO.slice(8, 10), 10);
  const re = new RegExp(`\\b(\\d{1,2})\\s+${month}\\b`, 'g');
  const days: number[] = [];
  for (let m = re.exec(t); m; m = re.exec(t)) days.push(parseInt(m[1], 10));
  if (days.length && !days.includes(trueDay)) {
    issues.push(`il testo cita il ${days.join('/il ')} ${month} ma la data registrata è il ${trueDay} ${month}`);
  }

  return issues.length ? issues.join('; ') : null;
}
