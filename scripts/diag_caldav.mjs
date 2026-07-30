// Diagnostica LIVE iCloud CalDAV: principal -> calendar-home -> lista calendari.
const USER = process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com';
const PASS = process.env.EMAIL_ICLOUD_PASS;
if (!PASS) { console.log('NO_PASS'); process.exit(0); }
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
async function propfind(url, body, depth = '0') {
  const r = await fetch(url, { method: 'PROPFIND', headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: depth }, body });
  const t = await r.text();
  return { status: r.status, text: t };
}
// 1) principal
let r = await propfind('https://caldav.icloud.com/', `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
console.log('PRINCIPAL status', r.status);
const pm = r.text.match(/current-user-principal[^>]*>[\s\S]*?<href[^>]*>([^<]+)</i);
const principal = pm ? pm[1] : null;
console.log('principal href:', principal);
if (!principal) { console.log('SNIP:', r.text.slice(0, 400)); process.exit(0); }
const host = 'https://caldav.icloud.com';
const purl = principal.startsWith('http') ? principal : host + principal;
// 2) calendar-home-set
r = await propfind(purl, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
const hm = r.text.match(/calendar-home-set[^>]*>[\s\S]*?<href[^>]*>([^<]+)</i);
const home = hm ? hm[1] : null;
console.log('calendar-home:', home);
if (!home) { console.log('SNIP:', r.text.slice(0, 400)); process.exit(0); }
// 3) list calendars
r = await propfind(home, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`, '1');
console.log('HOME list status', r.status);
const blocks = r.text.split(/<[^>]*response>/i);
for (const b of blocks) {
  const href = (b.match(/href>([^<]+)</i) || [])[1];
  const name = (b.match(/displayname>([^<]*)</i) || [])[1];
  const isCal = /calendar\b/i.test(b) && /VEVENT/i.test(b);
  if (href && (name || isCal)) console.log(`  CAL? ${isCal ? 'YES' : 'no '} | ${name || '(no name)'} | ${href}`);
}
