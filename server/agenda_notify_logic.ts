/*
 * agenda_notify_logic.ts — Logica PURA delle due notifiche d'agenda verso MARIANO
 * (numero di controllo), rev. 26/07/2026. Nessun DB, nessuna rete → testabile a unità
 * (scripts/test_agenda_notify.ts). Rispetta l'invariante: queste funzioni NON inviano
 * nulla e NON toccano il flusso bozze/clienti.
 *
 *  1) DIGEST MATTUTINO (08:00 Europe/Rome, ogni giorno): elenco TOTALE degli
 *     appuntamenti di OGGI, ordinati per ora, con ora inizio–fine, oggetto,
 *     controparte, luogo o LINK (udienza telematica), nota. In testa il conteggio.
 *     Se non ci sono appuntamenti → messaggio breve "nessun appuntamento" (così il
 *     sistema si dimostra VIVO: niente "verde ma morto").
 *  2) REMINDER T-10: 10 minuti prima dell'inizio, un messaggio per appuntamento,
 *     UNA sola volta (dedup su chiave id@startISO → segue automaticamente gli
 *     spostamenti; il cancellato sparisce dall'agenda e non genera reminder).
 */

export interface AgendaItem {
  id: string;                 // id stabile: 'cal:<eventId>' oppure 'bot:<rowId>'
  startISO: string | null;    // ISO con offset Rome (es. 2026-07-26T09:30:00+02:00); null = tutto il giorno
  endISO: string | null;      // idem, opzionale
  allDay: boolean;
  title: string;              // oggetto/titolo
  counterparty: string | null;// controparte/cliente
  location: string | null;    // luogo fisico
  link: string | null;        // link udienza telematica / videocall
  note: string | null;        // nota breve
  source: 'google-calendar' | 'bot_appointments';
}

/** Ora "da orologio" (HH:MM) letta dall'ISO locale Rome (l'ISO porta già l'offset
 *  corretto → i caratteri 11..16 sono l'ora di parete che Mariano vede in agenda). */
export function wallTime(iso: string | null): string {
  if (!iso || iso.length < 16) return '';
  return iso.slice(11, 16);
}

/** Etichetta oraria dell'appuntamento: "09:30–10:30", "09:30" o "tutto il giorno". */
export function timeRangeLabel(it: AgendaItem): string {
  if (it.allDay || !it.startISO) return 'tutto il giorno';
  const s = wallTime(it.startISO);
  const e = wallTime(it.endISO);
  return e && e !== s ? `${s}–${e}` : s;
}

/** Ordina: prima i timed per ora crescente, poi gli "tutto il giorno". Stabile. */
export function sortAgenda(items: AgendaItem[]): AgendaItem[] {
  return items.slice().sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
    const sa = a.startISO || '', sb = b.startISO || '';
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/** Luogo/Link da mostrare: il LINK (udienza telematica) ha priorità sul luogo fisico. */
export function placeLine(it: AgendaItem): string | null {
  if (it.link) return `🔗 ${it.link}`;
  if (it.location) return `📍 ${it.location}`;
  return null;
}

/** Blocco testuale di un appuntamento nel digest (WhatsApp: *singolo asterisco*). */
export function agendaItemBlock(it: AgendaItem): string {
  const L: string[] = [`🕘 *${timeRangeLabel(it)}* — ${it.title || 'Appuntamento'}`];
  if (it.counterparty) L.push(`   👤 ${it.counterparty}`);
  const p = placeLine(it);
  if (p) L.push(`   ${p}`);
  if (it.note) L.push(`   📝 ${String(it.note).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return L.join('\n');
}

/**
 * Compone il DIGEST del mattino. `dateFullIT` es. "domenica 26 luglio 2026".
 * `test` = anteponi un'etichetta di prova ben visibile. Ritorna anche `count`.
 */
export function composeAgendaDigest(params: {
  items: AgendaItem[];
  dateFullIT: string;
  test?: boolean;
}): { text: string; count: number } {
  const items = sortAgenda(params.items);
  const n = items.length;
  const head = params.test ? '🧪 *MESSAGGIO DI PROVA* (digest agenda)\n\n' : '';
  const L: string[] = [`${head}📅 *Agenda di ${params.dateFullIT}*`];
  if (n === 0) {
    L.push('\nOggi nessun appuntamento in agenda.');
    L.push('\n_(Notifica automatica: il sistema agenda è attivo.)_');
    return { text: L.join('\n'), count: 0 };
  }
  L.push(`\nOggi hai *${n}* appuntament${n === 1 ? 'o' : 'i'}:`);
  for (const it of items) L.push(`\n${agendaItemBlock(it)}`);
  return { text: L.join('\n'), count: n };
}

/** Compone il REMINDER T-10 di un singolo appuntamento (verso Mariano). */
export function composeReminder(it: AgendaItem, leadMin = 10): string {
  const L: string[] = [`⏰ *Tra ${leadMin} minuti* — ${it.title || 'Appuntamento'}`];
  L.push(`🕘 ${timeRangeLabel(it)}`);
  if (it.counterparty) L.push(`👤 ${it.counterparty}`);
  const p = placeLine(it);
  if (p) L.push(p);
  if (it.note) L.push(`📝 ${String(it.note).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  return L.join('\n');
}

/** Chiave di dedup del reminder: cambia se l'appuntamento viene SPOSTATO (startISO
 *  diverso → nuovo reminder al nuovo orario), resta uguale a parità di orario
 *  (nessun reinvio anche se lo scheduler gira ogni minuto). */
export function reminderDedupKey(it: AgendaItem): string {
  return `rem:${it.id}@${it.startISO ?? 'allday'}`;
}

/** Un reminder è "dovuto ADESSO" se: ha un orario, e now ∈ [start-lead, start).
 *  Dopo l'inizio non si invia (inutile). */
export function isReminderDue(it: AgendaItem, nowMs: number, leadMin = 10): boolean {
  if (it.allDay || !it.startISO) return false;
  const startMs = Date.parse(it.startISO);
  if (isNaN(startMs)) return false;
  return nowMs >= startMs - leadMin * 60000 && nowMs < startMs;
}

/** Seleziona i reminder da inviare ORA, escludendo quelli già inviati (sentKeys). */
export function selectDueReminders(
  items: AgendaItem[], nowMs: number, leadMin: number, sentKeys: Set<string>,
): AgendaItem[] {
  return items.filter((it) => isReminderDue(it, nowMs, leadMin) && !sentKeys.has(reminderDedupKey(it)));
}

export type DigestStatus = 'sent-already' | 'due' | 'waiting' | 'not-a-day' | 'missed';

/**
 * Decisione PURA sul digest: va inviato ADESSO?
 * - non è un giorno d'invio (weekend con flag OFF) → 'not-a-day'
 * - già inviato oggi → 'sent-already'
 * - prima dell'ora target → 'waiting'
 * - nella finestra [target, target+catchup) → 'due' (invia)
 * - oltre la finestra di recupero → 'missed' (probabile downtime lungo: non invio tardivo)
 */
export function digestDecision(p: {
  romeHour: number; dow: number; targetHour: number; catchupHours: number;
  weekendsEnabled: boolean; lastSentDate: string | null; todayDate: string;
}): { due: boolean; status: DigestStatus } {
  const isSendDay = p.weekendsEnabled || (p.dow >= 1 && p.dow <= 5);
  if (!isSendDay) return { due: false, status: 'not-a-day' };
  if (p.lastSentDate === p.todayDate) return { due: false, status: 'sent-already' };
  if (p.romeHour < p.targetHour) return { due: false, status: 'waiting' };
  if (p.romeHour < p.targetHour + p.catchupHours) return { due: true, status: 'due' };
  return { due: false, status: 'missed' };
}

const DOW_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MON_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Data completa in italiano da ISO YYYY-MM-DD (calcolo a mezzogiorno UTC: indipendente
 *  dal fuso del server), es. "domenica 26 luglio 2026". */
export function dateFullITfromISO(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DOW_IT[dow]} ${d} ${MON_IT[m - 1]} ${y}`;
}
