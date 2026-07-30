/* Integration test LIVE del ponte conferma→agenda contro Google Calendar reale.
 * Crea una proposta, simula la conferma NL di Mariano (spostamento+conferma),
 * poi la disdetta; verifica sul Calendar reale; pulisce tutto. */
import { createCalendarEvent } from '../server/integrations.js';
import { recordAppointment } from '../server/chatbot.js';
import { handleControlAppointmentReply } from '../server/appointment_bridge.js';
import db from '../server/db.js';

const PHONE = '390000000000@test';
const CAL = process.env.GOOGLE_CALENDAR_ID || 'primary';
async function token() {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: process.env.GOOGLE_REFRESH_TOKEN!, grant_type: 'refresh_token' }) });
  return (await r.json() as any).access_token;
}
async function getEvent(t: string, id: string) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${id}`, { headers: { Authorization: 'Bearer ' + t } });
  return await r.json() as any;
}
let pass = 0, fail = 0;
const check = (l: string, c: boolean) => { if (c) { pass++; console.log('PASS —', l); } else { fail++; console.error('FAIL —', l); } };

// pulizia preventiva righe test
db.prepare(`DELETE FROM bot_appointments WHERE phone = ?`).run(PHONE);

// 1) proposta [DA CONFERMARE] reale
const created = await createCalendarEvent({ title: '[DA CONFERMARE] Test ponte — IT', description: 'test', startDate: '2026-12-30T09:00:00', endDate: '2026-12-30T10:00:00' });
check('evento proposta creato su Google (' + created.eventId + ')', !!created.eventId);
const apptId = recordAppointment({ phone: PHONE, contactName: 'TEST Ponte', eventId: created.eventId ?? null, date: '2026-12-30', start: '09:00', end: '10:00', reason: 'Test ponte' });

// 2) conferma NL di Mariano con spostamento
const r1 = await handleControlAppointmentReply(PHONE, 'ok confermo, spostiamo al 31 dicembre alle 18');
console.log('  bridge →', r1);
const t = await token();
const ev1 = await getEvent(t, created.eventId!);
check('titolo confermato (✅)', (ev1.summary || '').startsWith('✅'));
check('spostato al 2026-12-31T18:00', (ev1.start?.dateTime || '').startsWith('2026-12-31T18:00'));
check('colore verde (10)', ev1.colorId === '10');
const row = db.prepare(`SELECT * FROM bot_appointments WHERE id = ?`).get(apptId) as any;
check('DB stato confermato + data/ora aggiornate', row.status === 'confermato' && row.date === '2026-12-31' && row.start === '18:00');

// 3) disdetta NL
const r2 = await handleControlAppointmentReply(PHONE, 'annulla tutto per favore');
console.log('  bridge →', r2);
const ev2 = await getEvent(t, created.eventId!);
check('titolo annullato ([ANNULLATO])', (ev2.summary || '').includes('[ANNULLATO]'));

// cleanup
await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${created.eventId}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
db.prepare(`DELETE FROM bot_appointments WHERE phone = ?`).run(PHONE);
console.log(`\nIT ponte: ${pass} PASS, ${fail} FAIL — evento test cancellato.`);
process.exit(fail ? 1 : 0);
