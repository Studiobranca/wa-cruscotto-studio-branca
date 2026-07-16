/* Test integrazione Make.com (HUB automazioni). Nessun invio reale né rete:
 * si esercitano schema, gating env, secret e la DECISIONE PURA inbound.
 * L'invariante è verificato: l'inbound NON invia mai al cliente (percorsi testati
 * si fermano prima di ogni invio; il success path è coperto via decideInboundAction). */
import { inboundSchema, isMakeConfigured, secretMatches, decideInboundAction, notifyMake, makeInbound } from '../server/make.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// Ambiente pulito e deterministico (salva/ripristina).
const saved = { s: process.env.MAKE_SHARED_SECRET, u: process.env.MAKE_WEBHOOK_URL };
delete process.env.MAKE_SHARED_SECRET;
delete process.env.MAKE_WEBHOOK_URL;

// ── Schema ────────────────────────────────────────────────────
ok('payload canceled valido passa', inboundSchema.safeParse({ changeType: 'canceled', eventId: 'abc' }).success);
ok('payload update valido passa', inboundSchema.safeParse({ changeType: 'updated', eventId: 'e1', start: '2026-09-10T09:00:00+02:00' }).success);
ok('eventId troppo lungo → scarta', !inboundSchema.safeParse({ eventId: 'x'.repeat(300) }).success);

// ── Gating env ────────────────────────────────────────────────
ok('senza env: inbound OFF, outbound OFF', !isMakeConfigured().inbound && !isMakeConfigured().outbound);
process.env.MAKE_SHARED_SECRET = 'topsecret';
ok('con secret: inbound ON, outbound ancora OFF', isMakeConfigured().inbound && !isMakeConfigured().outbound);
process.env.MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/xxxx';
ok('con secret+url: outbound ON', isMakeConfigured().outbound);

// ── Secret (timing-safe) ──────────────────────────────────────
ok('secret corretto combacia', secretMatches('topsecret'));
ok('secret errato rifiutato', !secretMatches('wrong'));
ok('secret vuoto rifiutato', !secretMatches(''));

// ── Decisione PURA inbound ────────────────────────────────────
const appt = { date: '2026-09-10', start: '09:00', status: 'confermato' };
ok('cancel + appt attivo → canceled_local', decideInboundAction({ changeType: 'canceled' }, appt).action === 'canceled_local');
ok('cancel + appt già annullato → already_canceled', decideInboundAction({ changeType: 'canceled' }, { ...appt, status: 'annullato' }).action === 'already_canceled');
ok('cancel + nessun appt → no_match', decideInboundAction({ status: 'cancelled' }, null).action === 'no_match');
const moved = decideInboundAction({ changeType: 'updated', start: '2026-09-11T10:00:00+02:00' }, appt);
ok('update con nuovo orario → moved_local', moved.action === 'moved_local', moved.action);
ok('ISO→data/ora Europe/Rome corrette', moved.date === '2026-09-11' && moved.start === '10:00', `${moved.date} ${moved.start}`);
ok('update stesso orario → in_sync', decideInboundAction({ changeType: 'updated', date: '2026-09-10', startTime: '09:00' }, appt).action === 'in_sync');

// ── Handler gating (mock req/res: si ferma PRIMA di ogni invio) ─
function mockRes() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
async function run() {
  delete process.env.MAKE_SHARED_SECRET; // inbound disattivo
  const r1 = mockRes();
  await makeInbound({ headers: {}, body: {} } as any, r1 as any);
  ok('inbound senza secret env → 503 disabled', r1.statusCode === 503 && r1.body?.disabled === true);

  process.env.MAKE_SHARED_SECRET = 'topsecret'; // attivo, ma secret sbagliato
  const r2 = mockRes();
  await makeInbound({ headers: { 'x-make-secret': 'nope' }, body: { changeType: 'updated' } } as any, r2 as any);
  ok('inbound secret errato → 401', r2.statusCode === 401);

  // Outbound no-op senza URL (nessuna rete, non lancia).
  delete process.env.MAKE_WEBHOOK_URL;
  let threw = false;
  try { await notifyMake({ event: 'appointment_confirmed', appointmentId: 1 }); } catch { threw = true; }
  ok('notifyMake senza URL: no-op, non lancia', !threw);

  // Ripristina env originale.
  if (saved.s === undefined) delete process.env.MAKE_SHARED_SECRET; else process.env.MAKE_SHARED_SECRET = saved.s;
  if (saved.u === undefined) delete process.env.MAKE_WEBHOOK_URL; else process.env.MAKE_WEBHOOK_URL = saved.u;

  console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
  process.exit(fails === 0 ? 0 : 1);
}
run();
