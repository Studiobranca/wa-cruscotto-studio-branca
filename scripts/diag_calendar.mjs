// Diagnostica LIVE Google Calendar (scope + account + CRUD reale). Cleanup incluso.
const CID = process.env.GOOGLE_CLIENT_ID, CS = process.env.GOOGLE_CLIENT_SECRET, RT = process.env.GOOGLE_REFRESH_TOKEN;
const CAL = process.env.GOOGLE_CALENDAR_ID || 'primary';
async function token() {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CID, client_secret: CS, refresh_token: RT, grant_type: 'refresh_token' }) });
  const d = await r.json(); if (!d.access_token) throw new Error('no token: ' + JSON.stringify(d)); return d.access_token;
}
const t = await token();
const ti = await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + t)).json();
console.log('SCOPES:', ti.scope);
console.log('TOKEN_EMAIL:', ti.email || '(n/d)');
const cl = await (await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: { Authorization: 'Bearer ' + t } })).json();
console.log('CALENDARS:', (cl.items || []).map(c => `${c.id}${c.primary ? ' [PRIMARY]' : ''} | ${c.summary} | access=${c.accessRole}`).join('\n  '));
console.log('TARGET_CAL(GOOGLE_CALENDAR_ID or primary):', CAL);
// CRUD test
const start = '2026-12-31T18:00:00', end = '2026-12-31T18:30:00';
const ev = { summary: '🧪 TEST ponte cruscotto (auto-cleanup)', description: 'Evento di test CRUD — verrà cancellato.', start: { dateTime: start, timeZone: 'Europe/Rome' }, end: { dateTime: end, timeZone: 'Europe/Rome' } };
const cr = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
const crd = await cr.json();
console.log('CREATE:', cr.status, 'id=', crd.id, 'link=', crd.htmlLink);
if (crd.id) {
  const pt = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${crd.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: '🧪 TEST spostato', start: { dateTime: '2026-12-31T19:00:00', timeZone: 'Europe/Rome' }, end: { dateTime: '2026-12-31T19:30:00', timeZone: 'Europe/Rome' } }) });
  console.log('PATCH(move):', pt.status);
  const dl = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${crd.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
  console.log('DELETE(cleanup):', dl.status);
}
