// Disambigua le due collection iCloud "mariano branca (2)" per CONTENUTO.
// Confronta gli eventi di ogni candidata con Google primary (fonte nota).
const USER = process.env.EMAIL_ICLOUD_USER || 'studiobranca@icloud.com';
const PASS = process.env.EMAIL_ICLOUD_PASS;
const HOST = 'https://caldav.icloud.com';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const START = '20260701T000000Z', END = '20270401T000000Z';
const CANDS = [
  ['mariano branca',      '/561289538/calendars/D79AC91D-9327-416F-9BF8-D4E954E9EC5E/'],
  ['mariano branca (2)#A','/561289538/calendars/28DD70A7-F156-46D6-9637-4359060CD8A8/'],
  ['mariano branca (2)#B','/561289538/calendars/71E3940B-18F6-4DF0-9F71-D48EDC791189/'],
];
async function propfind(url, body, depth='0') {
  const r = await fetch(url, { method:'PROPFIND', headers:{Authorization:auth,'Content-Type':'application/xml; charset=utf-8',Depth:depth}, body });
  return { status:r.status, text: await r.text() };
}
async function report(url, body) {
  const r = await fetch(url, { method:'REPORT', headers:{Authorization:auth,'Content-Type':'application/xml; charset=utf-8',Depth:'1'}, body });
  return { status:r.status, text: await r.text() };
}
const qBody = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${START}" end="${END}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
for (const [label, href] of CANDS) {
  const pf = await propfind(HOST+href, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"><d:prop><d:displayname/><cs:getctag/><ic:calendar-color/></d:prop></d:propfind>`);
  const name = (pf.text.match(/<displayname[^>]*>([^<]*)</i)||[])[1]||'';
  const ctag = (pf.text.match(/getctag[^>]*>([^<]*)</i)||[])[1]||'';
  const color = (pf.text.match(/calendar-color[^>]*>([^<]*)</i)||[])[1]||'';
  const rep = await report(HOST+href, qBody);
  const sums = [...rep.text.matchAll(/SUMMARY:([^\r\n]+)/gi)].map(m=>m[1].trim());
  const dts  = [...rep.text.matchAll(/DTSTART[^:]*:([0-9T]+)/gi)].map(m=>m[1]);
  console.log(`\n=== ${label} | name="${name}" color=${color} ctag=${ctag.slice(-12)}`);
  console.log(`   href=${href}`);
  console.log(`   eventi nel range: ${sums.length}`);
  sums.slice(0,12).forEach((s,i)=>console.log(`     - ${dts[i]||''} ${s}`));
}
// Google primary per confronto
async function gtoken(){const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:process.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})});return (await r.json()).access_token;}
const gt = await gtoken();
const g = await (await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-07-01T00:00:00Z&timeMax=2027-04-01T00:00:00Z&singleEvents=true&orderBy=startTime&maxResults=25`,{headers:{Authorization:'Bearer '+gt}})).json();
console.log(`\n=== GOOGLE primary (studiobranca.mariano@gmail.com) eventi: ${(g.items||[]).length}`);
(g.items||[]).slice(0,15).forEach(e=>console.log(`     - ${(e.start?.dateTime||e.start?.date||'')} ${e.summary||''}`));
