/* Test LIVE Apple: l'evento finisce ESATTAMENTE in "mariano branca (2)" (71E3940B)
 * e NON nell'omonimo (28DD70A7). Coerenza con Google. Cleanup. Usa config di produzione. */
import { mirrorToApple, deleteFromApple, appleEnabled } from '../server/caldav.js';

const USER = process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com';
const PASS = process.env.EMAIL_ICLOUD_PASS!;
const HOST = 'https://caldav.icloud.com';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const TARGET = '/561289538/calendars/71E3940B-18F6-4DF0-9F71-D48EDC791189/'; // mariano branca (2) — operativo
const OTHER  = '/561289538/calendars/28DD70A7-F156-46D6-9637-4359060CD8A8/'; // mariano branca (2) — compleanni
const uid = 'it-apple-verify-' + Date.now();
let pass = 0, fail = 0;
const chk = (l: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' — ' + l); };

async function reportHas(href: string, needle: string): Promise<boolean> {
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261230T000000Z" end="20270102T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await fetch(HOST + href, { method: 'REPORT', headers: { Authorization: auth, 'Content-Type': 'application/xml', Depth: '1' }, body });
  return (await r.text()).includes(needle);
}
async function gtoken() { const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: process.env.GOOGLE_REFRESH_TOKEN!, grant_type: 'refresh_token' }) }); return (await r.json() as any).access_token; }

console.log('appleEnabled=', appleEnabled(), '| APPLE_CALENDAR_URL=', process.env.APPLE_CALENDAR_URL);
chk('appleEnabled true', appleEnabled());

// 1) crea su Apple via modulo di produzione
const put = await mirrorToApple({ uid, summary: '🧪 TEST ponte→mariano branca (2)', description: 'verifica placement', date: '2026-12-31', start: '18:00', end: '19:00' });
chk('mirrorToApple ok', put);
// 2) è in TARGET (71E3940B)?
chk('evento PRESENTE in "mariano branca (2)" 71E3940B', await reportHas(TARGET, uid));
// 3) NON è nell'omonimo (28DD70A7)?
chk('evento ASSENTE nell\'omonimo 28DD70A7', !(await reportHas(OTHER, uid)));
// 4) Google coerente (crea evento gemello, verifica, cancella)
const t = await gtoken();
const gcreate = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: '🧪 TEST coerenza Google', start: { dateTime: '2026-12-31T18:00:00', timeZone: 'Europe/Rome' }, end: { dateTime: '2026-12-31T19:00:00', timeZone: 'Europe/Rome' } }) });
const gev = await gcreate.json() as any;
chk('Google create ok (id ' + gev.id + ')', gcreate.status === 200 && !!gev.id);
// 5) spostamento su Apple (stesso uid, nuova ora)
const mv = await mirrorToApple({ uid, summary: '🧪 TEST spostato', description: 'x', date: '2026-12-31', start: '19:30', end: '20:00' });
chk('spostamento Apple ok', mv);
// 6) cleanup
chk('delete Apple ok', await deleteFromApple(uid));
if (gev.id) await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + gev.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
console.log(`\nIT Apple verify: ${pass} PASS, ${fail} FAIL | UID=${uid} | collection=${TARGET}`);
process.exit(fail ? 1 : 0);
