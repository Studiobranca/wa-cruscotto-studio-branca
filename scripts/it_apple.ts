/* Integration test LIVE Apple mirror via modulo caldav.ts (PUT + DELETE reali). */
process.env.APPLE_CALENDAR_ENABLED = '1';
process.env.APPLE_CALENDAR_NAME = process.env.APPLE_CALENDAR_NAME || 'Home';
const { mirrorToApple, deleteFromApple, appleEnabled } = await import('../server/caldav.js');
let pass = 0, fail = 0;
const check = (l: string, c: boolean) => { if (c) { pass++; console.log('PASS —', l); } else { fail++; console.error('FAIL —', l); } };
check('appleEnabled true', appleEnabled());
const uid = 'it-apple-ponte-' + Date.now();
const put = await mirrorToApple({ uid, summary: '🧪 IT Apple ponte (auto-cleanup)', description: 'test modulo', date: '2026-12-31', start: '18:00', end: '19:00' });
check('mirrorToApple PUT ok (calendario "' + process.env.APPLE_CALENDAR_NAME + '")', put);
const del = await deleteFromApple(uid);
check('deleteFromApple ok', del);
console.log(`\nIT Apple: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
