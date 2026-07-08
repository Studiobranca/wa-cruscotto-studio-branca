/**
 * reminders_logic.ts — Logica PURA (senza I/O, senza db) dei job automatici su
 * appuntamenti e attese: finestre orarie, eleggibilità, testi dei messaggi.
 * Separata da reminders.ts (che fa l'I/O) per essere testabile a unità come
 * autosend.ts → scripts/test_reminders.ts.
 */

const SEGRETERIA = '0909797187';
const FIRMA_WA = 'Assistente Virtuale — Studio Tributario Branca';
const EMAIL_DOC = 'studiobranca@tiscali.it o studiobranca@icloud.com';

export type Channel = 'whatsapp' | 'email';

/** Chiave contatto → canale + indirizzo. Le chiavi email sono "email:<indirizzo>"
 *  (convenzione di generateReplyCore), tutte le altre sono numeri WhatsApp. */
export function channelOfKey(key: string): { channel: Channel; address: string } {
  if (key.startsWith('email:')) return { channel: 'email', address: key.slice(6) };
  return { channel: 'whatsapp', address: key };
}

/** Finestra serale del promemoria "appuntamento di domani": 18:00–20:59 Rome. */
export function inReminderWindow(hour: number): boolean {
  return hour >= 18 && hour < 21;
}

/** Finestra diurna del richiamo lista d'attesa: 9:00–17:59 Rome. */
export function inRecallWindow(hour: number): boolean {
  return hour >= 9 && hour < 18;
}

/** Finestra dell'alert SLA (solo di giorno, niente notifiche notturne): 8–20 Rome. */
export function inSlaWindow(hour: number): boolean {
  return hour >= 8 && hour < 20;
}

/** created_at di sqlite (datetime('now') = "YYYY-MM-DD HH:MM:SS" in UTC) → epoch ms. */
export function sqliteToMs(s: string | null | undefined): number {
  if (!s) return NaN;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/** Appuntamento preso da poco (< 6h): niente promemoria, il cliente lo ha fresco. */
export function isTooFresh(createdAt: string | null | undefined, nowMs: number): boolean {
  const t = sqliteToMs(createdAt);
  if (isNaN(t)) return false;
  return nowMs - t < 6 * 3600000;
}

const MONTH_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** "YYYY-MM-DD" → "giovedì 9 luglio" (il giorno della settimana di una data-solo-data
 *  è univoco, non dipende dal fuso: si àncora a mezzogiorno UTC). */
export function humanDateIT(ds: string): string {
  const d = new Date(`${ds}T12:00:00Z`);
  const dow = new Intl.DateTimeFormat('it-IT', { weekday: 'long', timeZone: 'UTC' }).format(d);
  return `${dow} ${parseInt(ds.slice(8, 10), 10)} ${MONTH_IT[parseInt(ds.slice(5, 7), 10) - 1]}`;
}

export interface ApptForReminder {
  date: string;                 // YYYY-MM-DD
  start: string;                // HH:MM
  status: string;               // da_confermare | confermato
  reason?: string | null;
  contact_name?: string | null;
}

/** Testo del promemoria "appuntamento di domani". Registro Lei (default prudente:
 *  qui non abbiamo il transcript per rilevare il tu). Niente Markdown/asterischi. */
export function reminderMessageIT(a: ApptForReminder, channel: Channel): string {
  const nome = (a.contact_name || '').trim();
  const saluto = nome ? `Gentile ${nome},` : 'Gentile cliente,';
  const quando = `domani, ${humanDateIT(a.date)} alle ${a.start}`;
  const righe: string[] = [saluto, ''];
  righe.push(`le ricordiamo l'appuntamento di ${quando} presso lo Studio Tributario Branca, Via Operai 102, Barcellona P.G. (ME)${a.reason ? `, in merito a: ${a.reason}` : ''}.`);
  if (a.status === 'da_confermare') {
    righe.push('');
    righe.push('L\'appuntamento risulta ancora DA CONFERMARE: la preghiamo di rispondere a questo messaggio per confermare che potrà essere presente, oppure per chiedere di spostarlo.');
  } else {
    righe.push('');
    righe.push('Se dovesse avere un imprevisto e volesse spostare o disdire, può rispondere a questo messaggio.');
  }
  righe.push('');
  righe.push(`Se l'incontro riguarda documenti da esaminare (atti, cartelle, fatture, dichiarazioni, contratti, avvisi), la preghiamo di inviarli PRIMA dell'appuntamento${channel === 'whatsapp' ? ` su questa chat oppure via email a ${EMAIL_DOC}` : ` in risposta a questa email`}: solo così potranno essere visionati e discussi durante l'incontro.`);
  righe.push('');
  righe.push(`Per parlare con la segreteria: ${SEGRETERIA}.`);
  if (channel === 'whatsapp') righe.push(FIRMA_WA);
  return righe.join('\n');
}

/** Testo del richiamo della lista d'attesa quando tornano disponibilità in agenda.
 *  `availability` è il testo già formattato da formatAvailabilityIT(). */
export function waitlistRecallMessageIT(
  contactName: string | null | undefined, reason: string | null | undefined,
  availability: string, channel: Channel,
): string {
  const nome = (contactName || '').trim();
  const saluto = nome ? `Gentile ${nome},` : 'Gentile cliente,';
  const righe: string[] = [saluto, ''];
  righe.push(`la ricontattiamo dallo Studio Tributario Branca: si sono liberate nuove disponibilità per un appuntamento${reason ? `, come da sua richiesta (${reason})` : ''}.`);
  righe.push('');
  righe.push('Prime disponibilità:');
  righe.push(availability);
  righe.push('');
  righe.push(`Può rispondere a questo messaggio indicando il giorno e l'ora che preferisce, e provvederemo a fissare l'appuntamento. Per la segreteria: ${SEGRETERIA}.`);
  if (channel === 'whatsapp') righe.push(FIRMA_WA);
  return righe.join('\n');
}

export interface SlaDraftItem { id: number; who: string; ageMin: number; }
export interface SlaEmailItem { who: string; subject: string; ageMin: number; }

function ageIT(min: number): string {
  if (min < 90) return `${Math.round(min)} min`;
  return `${Math.round(min / 60)} h`;
}

/** Testo dell'alert SLA al numero di controllo: bozze WhatsApp ed email di lavoro
 *  in attesa oltre la soglia. Mai inviato ai clienti. */
export function slaAlertText(drafts: SlaDraftItem[], emails: SlaEmailItem[], sogliaOre: number): string {
  const parts: string[] = [`⏰ RISPOSTE IN ATTESA da oltre ${sogliaOre}h:`];
  if (drafts.length) {
    parts.push('');
    parts.push(`Bozze WhatsApp da approvare (${drafts.length}):`);
    for (const d of drafts.slice(0, 8)) parts.push(`- #${d.id} ${d.who} (da ${ageIT(d.ageMin)}) → OK ${d.id} / NO ${d.id}`);
    if (drafts.length > 8) parts.push(`… e altre ${drafts.length - 8}.`);
  }
  if (emails.length) {
    parts.push('');
    parts.push(`Email di lavoro senza gestione (${emails.length}):`);
    for (const e of emails.slice(0, 8)) parts.push(`- ${e.who}: "${e.subject.slice(0, 60)}" (da ${ageIT(e.ageMin)})`);
    if (emails.length > 8) parts.push(`… e altre ${emails.length - 8}.`);
  }
  parts.push('');
  parts.push('👉 Cruscotto per gestirle (avviso unico, non verrà ripetuto).');
  return parts.join('\n');
}
