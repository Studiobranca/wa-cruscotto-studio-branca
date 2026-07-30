/* Test unità/integrazione della logica PURA delle notifiche d'agenda a Mariano
 * (agenda_notify_logic.ts). Nessun I/O, nessun invio reale — come test_reminders.ts. */
import {
  wallTime, timeRangeLabel, sortAgenda, composeAgendaDigest, composeReminder,
  reminderDedupKey, isReminderDue, selectDueReminders, digestDecision, dateFullITfromISO,
  type AgendaItem,
} from '../server/agenda_notify_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) fails++;
}

const OFF = '+02:00'; // 26/07/2026 è ora legale
function mk(p: Partial<AgendaItem> & { id: string }): AgendaItem {
  return {
    id: p.id, startISO: p.startISO ?? null, endISO: p.endISO ?? null, allDay: p.allDay ?? false,
    title: p.title ?? 'Appuntamento', counterparty: p.counterparty ?? null, location: p.location ?? null,
    link: p.link ?? null, note: p.note ?? null, source: p.source ?? 'google-calendar',
  };
}

// ── Ora di parete + range ────────────────────────────────────────────────────
ok('wallTime estrae HH:MM', wallTime(`2026-07-26T09:30:00${OFF}`) === '09:30');
ok('range inizio–fine', timeRangeLabel(mk({ id: 'a', startISO: `2026-07-26T09:30:00${OFF}`, endISO: `2026-07-26T10:30:00${OFF}` })) === '09:30–10:30');
ok('range solo inizio', timeRangeLabel(mk({ id: 'a', startISO: `2026-07-26T09:30:00${OFF}` })) === '09:30');
ok('range tutto il giorno', timeRangeLabel(mk({ id: 'a', allDay: true })) === 'tutto il giorno');

// ── Ordinamento: timed per ora, all-day in fondo ─────────────────────────────
const s = sortAgenda([
  mk({ id: 'allday', allDay: true, title: 'Ferie' }),
  mk({ id: 'b', startISO: `2026-07-26T15:00:00${OFF}` }),
  mk({ id: 'a', startISO: `2026-07-26T09:00:00${OFF}` }),
]);
ok('ordina: 09 prima di 15', s[0].id === 'a' && s[1].id === 'b');
ok('ordina: all-day in fondo', s[2].id === 'allday');

// ── DIGEST: vuoto = prova di vita ────────────────────────────────────────────
const empty = composeAgendaDigest({ items: [], dateFullIT: 'domenica 26 luglio 2026' });
ok('digest vuoto: count 0', empty.count === 0);
ok('digest vuoto: "nessun appuntamento"', /nessun appuntamento/i.test(empty.text));
ok('digest vuoto: data in testa', empty.text.includes('domenica 26 luglio 2026'));

// ── DIGEST: pieno con controparte, link, nota ────────────────────────────────
const full = composeAgendaDigest({
  dateFullIT: 'lunedì 27 luglio 2026',
  items: [
    mk({ id: 'cal:1', startISO: `2026-07-27T09:30:00${OFF}`, endISO: `2026-07-27T10:30:00${OFF}`, title: 'Udienza CTR', counterparty: 'Rossi c/ Ag. Entrate', link: 'https://gmeet.example/xyz', note: 'portare fascicolo' }),
    mk({ id: 'bot:2', startISO: `2026-07-27T11:00:00${OFF}`, title: 'Appuntamento studio', counterparty: 'Mario Bianchi', location: 'Studio, Aosta' }),
  ],
});
ok('digest pieno: conteggio in testa', /Oggi hai \*2\* appuntamenti/.test(full.text), full.text.split('\n')[1]);
ok('digest pieno: ora inizio–fine', full.text.includes('09:30–10:30'));
ok('digest pieno: oggetto', full.text.includes('Udienza CTR'));
ok('digest pieno: controparte', full.text.includes('Rossi c/ Ag. Entrate'));
ok('digest pieno: LINK udienza telematica', full.text.includes('https://gmeet.example/xyz'));
ok('digest pieno: nota', full.text.includes('portare fascicolo'));
ok('digest pieno: luogo del 2°', full.text.includes('Studio, Aosta'));
ok('digest TEST etichettato', /MESSAGGIO DI PROVA/.test(composeAgendaDigest({ items: [], dateFullIT: 'x', test: true }).text));

// ── REMINDER T-10 ────────────────────────────────────────────────────────────
const it10 = mk({ id: 'cal:9', startISO: `2026-07-26T10:00:00${OFF}`, endISO: `2026-07-26T11:00:00${OFF}`, title: 'Udienza telematica', counterparty: 'Verdi', link: 'https://ms.example/aula1' });
const rem = composeReminder(it10, 10);
ok('reminder: "Tra 10 minuti"', /Tra 10 minuti/.test(rem));
ok('reminder: oggetto', rem.includes('Udienza telematica'));
ok('reminder: ora', rem.includes('10:00–11:00'));
ok('reminder: controparte', rem.includes('Verdi'));
ok('reminder: link', rem.includes('https://ms.example/aula1'));

// ── Finestra T-10 e idempotenza ──────────────────────────────────────────────
const startMs = Date.parse(`2026-07-26T10:00:00${OFF}`);
ok('non dovuto a T-11', !isReminderDue(it10, startMs - 11 * 60000, 10));
ok('dovuto a T-10 esatto', isReminderDue(it10, startMs - 10 * 60000, 10));
ok('dovuto a T-1', isReminderDue(it10, startMs - 60000, 10));
ok('non dovuto all\'inizio', !isReminderDue(it10, startMs, 10));
ok('non dovuto dopo l\'inizio', !isReminderDue(it10, startMs + 5 * 60000, 10));
ok('all-day: mai reminder', !isReminderDue(mk({ id: 'x', allDay: true }), startMs - 5 * 60000, 10));

// dedup: già inviato → escluso; tick ripetuto → nessun reinvio
const key = reminderDedupKey(it10);
const sent = new Set<string>([key]);
ok('già inviato → non riselezionato', selectDueReminders([it10], startMs - 5 * 60000, 10, sent).length === 0);
ok('non ancora inviato → selezionato', selectDueReminders([it10], startMs - 5 * 60000, 10, new Set()).length === 1);

// spostamento: nuovo startISO → nuova chiave → nuovo reminder al nuovo orario
const moved = mk({ ...it10, startISO: `2026-07-26T15:00:00${OFF}`, endISO: `2026-07-26T16:00:00${OFF}` } as any);
ok('spostato: chiave diversa', reminderDedupKey(moved) !== key);
const movedStart = Date.parse(`2026-07-26T15:00:00${OFF}`);
ok('spostato: dovuto al NUOVO T-10 anche se il vecchio era già inviato', selectDueReminders([moved], movedStart - 5 * 60000, 10, sent).length === 1);

// ── DIGEST: decisione oraria ─────────────────────────────────────────────────
const base = { dow: 1, targetHour: 8, catchupHours: 4, weekendsEnabled: true, lastSentDate: null as string | null, todayDate: '2026-07-27' };
ok('digest: 07:xx → waiting', digestDecision({ ...base, romeHour: 7 }).status === 'waiting');
ok('digest: 08:xx → due', digestDecision({ ...base, romeHour: 8 }).due === true);
ok('digest: 11:xx (entro catch-up) → due', digestDecision({ ...base, romeHour: 11 }).due === true);
ok('digest: 12:xx (oltre catch-up) → missed', digestDecision({ ...base, romeHour: 12 }).status === 'missed');
ok('digest: già inviato oggi → sent-already', digestDecision({ ...base, romeHour: 9, lastSentDate: '2026-07-27' }).status === 'sent-already');
ok('digest: domenica con weekend OFF → not-a-day', digestDecision({ ...base, dow: 0, romeHour: 9, weekendsEnabled: false }).status === 'not-a-day');
ok('digest: domenica con weekend ON → due', digestDecision({ ...base, dow: 0, romeHour: 9, weekendsEnabled: true }).due === true);

// ── Data completa IT ─────────────────────────────────────────────────────────
ok('dateFullITfromISO', dateFullITfromISO('2026-07-26') === 'domenica 26 luglio 2026', dateFullITfromISO('2026-07-26'));

console.log(fails ? `\n${fails} FAIL` : '\nTUTTI OK');
process.exit(fails ? 1 : 0);
