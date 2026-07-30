/* Test unità termine di APPELLO (puro). Breve 60gg (art.51) se notificata; lungo 6 mesi
 * (art.327 c.p.c. via art.38 c.3) dal deposito. Feriale 1–31/8. Sempre [DA CONFERMARE]. */
import { addMonths, computeAppealDeadline } from '../server/pec_terms.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// addMonths: overflow mese e clamp fine mese
ok('addMonths +6 gennaio→luglio', addMonths('2026-01-15', 6) === '2026-07-15', addMonths('2026-01-15', 6));
ok('addMonths +6 attraversa anno', addMonths('2026-10-31', 6) === '2027-04-30', addMonths('2026-10-31', 6));
ok('addMonths clamp 31→28 feb', addMonths('2026-12-31', 2) === '2027-02-28', addMonths('2026-12-31', 2));

// TERMINE BREVE — sentenza NOTIFICATA il 01/07 → +60gg con feriale → 30/09
const breve = computeAppealDeadline({ depositDate: '2026-06-20', notificationDate: '2026-07-01', previewDays: 5 });
ok('breve tipoTermine=breve', breve.tipoTermine === 'breve', breve.tipoTermine);
ok('breve cita art. 51', /art\.\s*51/.test(breve.norma), breve.norma);
ok('breve dueDate 2026-09-30 (feriale)', breve.dueDate === '2026-09-30', breve.dueDate);
ok('breve preview -5gg = 2026-09-25', breve.previewDate === '2026-09-25', breve.previewDate);
ok('breve daConfermare', breve.daConfermare === true);

// TERMINE LUNGO — nessuna notifica → 6 mesi dal deposito 20/03 = 20/09; interseca agosto → +31 → 21/10
const lungo = computeAppealDeadline({ depositDate: '2026-03-20', notificationDate: null, previewDays: 5 });
ok('lungo tipoTermine=lungo', lungo.tipoTermine === 'lungo', lungo.tipoTermine);
ok('lungo cita art. 327', /art\.\s*327/.test(lungo.norma), lungo.norma);
ok('lungo cita art. 38', /art\.\s*38/.test(lungo.norma), lungo.norma);
ok('lungo 6 mesi + feriale = 2026-10-21', lungo.dueDate === '2026-10-21', lungo.dueDate);
ok('lungo preview -5gg = 2026-10-16', lungo.previewDate === '2026-10-16', lungo.previewDate);
ok('lungo daConfermare', lungo.daConfermare === true);

// Lungo senza intersezione agosto — deposito 20/09 → +6 mesi = 20/03/2027 (nessun feriale)
const lungo2 = computeAppealDeadline({ depositDate: '2026-09-20', notificationDate: null });
ok('lungo senza feriale = 2027-03-20', lungo2.dueDate === '2027-03-20', lungo2.dueDate);

// previewDays personalizzato (default 5)
const p10 = computeAppealDeadline({ depositDate: '2026-09-20', notificationDate: null, previewDays: 10 });
ok('preview -10gg = 2027-03-10', p10.previewDate === '2027-03-10', p10.previewDate);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
