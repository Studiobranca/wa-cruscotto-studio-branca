/* Test unità logica agenda: anti-overbooking, proposte scadute, esito. Pura, nessun invio. */
import { shouldBlockSlot, selectExpiredProposals, selectPendingOutcome, isValidOutcome } from '../server/agenda_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// Anti-overbooking (fail-safe)
ok('errore Calendar → blocca (fail-safe)', shouldBlockSlot({ busy: false, checked: false, error: true }) === true);
ok('occupato+verificato → blocca', shouldBlockSlot({ busy: true, checked: true }) === true);
ok('libero+verificato → NON blocca', shouldBlockSlot({ busy: false, checked: true }) === false);
ok('Google non configurato → NON blocca', shouldBlockSlot({ busy: false, checked: false }) === false);

// Proposte scadute
const rows = [
  { id: 1, date: '2026-07-05', status: 'da_confermare' },  // passata, non confermata → scade
  { id: 2, date: '2026-07-20', status: 'da_confermare' },  // futura → no
  { id: 3, date: '2026-07-05', status: 'confermato' },     // passata ma confermata → no
  { id: 4, date: '2026-07-11', status: 'da_confermare' },  // oggi → no (solo < oggi)
];
const exp = selectExpiredProposals(rows, '2026-07-11');
ok('solo la proposta passata non confermata scade', exp.length === 1 && exp[0].id === 1, `ids=${exp.map((e) => e.id)}`);

// Esito / no-show
const appts = [
  { id: 10, date: '2026-07-08', status: 'confermato', outcome: null },  // passato, confermato, senza esito → pending
  { id: 11, date: '2026-07-08', status: 'confermato', outcome: 'tenuto' }, // ha esito → no
  { id: 12, date: '2026-07-20', status: 'confermato', outcome: null },  // futuro → no
];
const pend = selectPendingOutcome(appts, '2026-07-11');
ok('solo confermato passato senza esito è pending-outcome', pend.length === 1 && pend[0].id === 10);

ok('outcome valido: no_show', isValidOutcome('no_show') === true);
ok('outcome valido: tenuto', isValidOutcome('tenuto') === true);
ok('outcome non valido: xyz', isValidOutcome('xyz') === false);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
