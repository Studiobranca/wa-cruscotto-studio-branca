/* Test endpoint SITO: validazione input, lead → persistenza, booking → PENDING.
 * Nessun invio reale (nessuna email/WhatsApp): si esercitano schemi e DB. */
import { leadSchema, bookingSchema, recordLead, getSiteLeads } from '../server/site.js';
import { recordAppointment, getPendingAppointment } from '../server/chatbot.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// ── Validazione LEAD ──────────────────────────────────────────
ok('lead valido passa', leadSchema.safeParse({ name: 'Mario Rossi', email: 'm@r.it', message: 'Salve' }).success);
ok('lead email non valida → scarta', !leadSchema.safeParse({ name: 'Mario Rossi', email: 'non-email', message: 'x' }).success);
ok('lead nome troppo corto → scarta', !leadSchema.safeParse({ name: 'M', email: 'm@r.it', message: 'ciao' }).success);
ok('lead messaggio vuoto → scarta', !leadSchema.safeParse({ name: 'Mario', email: 'm@r.it', message: '' }).success);
ok('honeypot presente nello schema', leadSchema.safeParse({ name: 'Mario', email: 'm@r.it', message: 'ciao', website: 'bot' }).success);

// ── Validazione BOOKING ───────────────────────────────────────
ok('booking valido passa', bookingSchema.safeParse({ name: 'Mario Rossi', email: 'm@r.it', phone: '3331234567', date: '2026-09-10', start: '09:00' }).success);
ok('booking data malformata → scarta', !bookingSchema.safeParse({ name: 'Mario Rossi', email: 'm@r.it', phone: '3331234567', date: '10/09/2026', start: '09:00' }).success);
ok('booking ora malformata → scarta', !bookingSchema.safeParse({ name: 'Mario Rossi', email: 'm@r.it', phone: '3331234567', date: '2026-09-10', start: '9' }).success);
ok('booking senza telefono → scarta', !bookingSchema.safeParse({ name: 'Mario Rossi', email: 'm@r.it', date: '2026-09-10', start: '09:00' }).success);

// ── LEAD → persistenza ────────────────────────────────────────
const marker = 'TEST-' + Date.now();
const leadId = recordLead({ kind: 'contatto', name: 'Test Lead', email: 't@e.it', message: marker });
ok('lead salvato con id', leadId > 0);
const found = getSiteLeads().some((l) => l.id === leadId && l.message === marker && l.status === 'nuovo');
ok('lead recuperabile con status "nuovo"', found);

// ── BOOKING → SEMPRE pending "da_confermare" (INVARIANTE) ──────
const testPhone = '39000' + (Date.now() % 1000000);
const apptId = recordAppointment({ phone: testPhone, contactName: 'Test Booking', eventId: null, date: '2026-09-11', start: '10:00', end: '11:00', reason: 'test invariante' });
ok('appuntamento creato con id', apptId > 0);
const appt = getPendingAppointment(testPhone);
ok('appuntamento è "da_confermare" (PENDING, mai auto-confermato)', !!appt && appt.status === 'da_confermare', appt ? appt.status : 'nessuno');
ok('appuntamento senza event_id (nessun evento Google auto-confermato)', !!appt && (appt.event_id === null || appt.event_id === undefined));
ok('appuntamento senza esito (outcome nullo)', !!appt && (appt.outcome === null || appt.outcome === undefined));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
