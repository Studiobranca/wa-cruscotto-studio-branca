/* Test unità calcolo termini processo tributario (puro). Sempre [DA CONFERMARE]. */
import { ferialeOverlaps, addDaysForward, computeDeadlinesFromEvent } from '../server/pec_terms.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// Sospensione feriale
ok('feriale overlap luglio→agosto', ferialeOverlaps('2026-07-01', '2026-08-30') === true);
ok('nessun overlap settembre→ottobre', ferialeOverlaps('2026-09-01', '2026-10-31') === false);

// 60 gg con feriale: 01/07 +60 = 30/08 → tocca agosto → +31 → 30/09
ok('60gg con feriale → 2026-09-30', addDaysForward('2026-07-01', 60, true) === '2026-09-30', addDaysForward('2026-07-01', 60, true));
// 60 gg senza agosto: 01/09 +60 = 31/10
ok('60gg senza feriale-window → 2026-10-31', addDaysForward('2026-09-01', 60, true) === '2026-10-31', addDaysForward('2026-09-01', 60, true));
// a ritroso -20 dall'udienza
ok('a ritroso -20gg', addDaysForward('2026-09-15', -20, false) === '2026-08-26', addDaysForward('2026-09-15', -20, false));

// notifica atto → termine 60gg (art. 21) con feriale, sempre da confermare
const t1 = computeDeadlinesFromEvent({ eventType: 'notifica_atto', category: 'RISCOSSIONE', baseDate: '2026-07-01' });
ok('notifica → 1 termine impugnazione', t1.length === 1 && /art\. 21/.test(t1[0].norma));
ok('impugnazione dueDate 2026-09-30 (feriale)', t1[0].dueDate === '2026-09-30');
ok('impugnazione daConfermare', t1[0].daConfermare === true && t1[0].uncertain === false);

// fissazione udienza → 3 termini a ritroso, tutti incerti e da confermare
const t2 = computeDeadlinesFromEvent({ eventType: 'fissazione_udienza', hearingDate: '2026-09-15' });
ok('udienza → 3 termini a ritroso', t2.length === 3 && t2.every((t) => t.daConfermare && t.uncertain));
ok('udienza cita art. 32', t2.every((t) => /art\. 32/.test(t.norma)));

// evento senza dati utili → nessun termine forzato
ok('comunicazione generica → 0 termini', computeDeadlinesFromEvent({ eventType: 'comunicazione', category: 'ALTRO' }).length === 0);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
