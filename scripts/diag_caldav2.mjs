// iCloud CalDAV: elenca calendari (con nome) + PUT/DELETE VEVENT di test sul target.
const USER = process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com';
const PASS = process.env.EMAIL_ICLOUD_PASS;
const HOST = 'https://caldav.icloud.com';
const HOME = HOST + '/561289538/calendars/';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
async function propfind(url, body, depth = '1') {
  const r = await fetch(url, { method: 'PROPFIND', headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: depth }, body });
  return { status: r.status, text: await r.text() };
}
const r = await propfind(HOME, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`);
const cals = [];
for (const m of r.text.matchAll(/<response[^>]*>([\s\S]*?)<\/response>/gi)) {
  const b = m[1];
  const href = (b.match(/<href[^>]*>([^<]+)</i) || [])[1];
  const name = (b.match(/<displayname[^>]*>([^<]*)</i) || [])[1] || '';
  const isCal = /<calendar[\s\/>]/i.test(b) && /VEVENT/i.test(b);
  if (href && isCal) cals.push({ href, name });
}
console.log('CALENDARS con VEVENT:');
cals.forEach(c => console.log(`  ${c.name || '(no name)'} | ${c.href}`));
// scegli target: nome che sembra agenda personale/principale
const pref = cals.find(c => /casa|home|personale|principale|mariano|studio|lavoro|calendario/i.test(c.name)) || cals[0];
console.log('TARGET:', pref ? `${pref.name} | ${pref.href}` : '(nessuno)');
if (!pref) process.exit(0);
const url = HOST + pref.href + 'test-ponte-cruscotto.ics';
const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//cruscotto//test//IT','BEGIN:VEVENT','UID:test-ponte-cruscotto@studiobranca','DTSTAMP:20261231T170000Z','DTSTART;TZID=Europe/Rome:20261231T180000','DTEND;TZID=Europe/Rome:20261231T183000','SUMMARY:🧪 TEST ponte Apple (auto-cleanup)','END:VEVENT','END:VCALENDAR'].join('\r\n');
const put = await fetch(url, { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'text/calendar; charset=utf-8' }, body: ics });
console.log('PUT status:', put.status);
const del = await fetch(url, { method: 'DELETE', headers: { Authorization: auth } });
console.log('DELETE status:', del.status);
