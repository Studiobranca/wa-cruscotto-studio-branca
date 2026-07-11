/* Test unità scadenzario adempimenti (pura). Promemoria solo interni, nessun invio. */
import { selectImminentDeadlines, addDaysISO, composeDeadlineDigest } from '../server/deadlines_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const today = '2026-07-11';
ok('addDaysISO +7', addDaysISO(today, 7) === '2026-07-18');
ok('addDaysISO cambio mese', addDaysISO('2026-07-28', 5) === '2026-08-02');

const rows = [
  { id: 1, tipo: 'F24', due_date: '2026-07-09', status: 'aperto' },   // scaduto → incluso, overdue
  { id: 2, tipo: 'IVA', due_date: '2026-07-14', status: 'aperto' },   // entro 7gg → incluso
  { id: 3, tipo: '730', due_date: '2026-07-30', status: 'aperto' },   // oltre 7gg → escluso
  { id: 4, tipo: 'CU', due_date: '2026-07-12', status: 'completato' },// completato → escluso
];
const imm = selectImminentDeadlines(rows, today, 7);
ok('inclusi 2 (scaduto + entro 7gg)', imm.length === 2, `ids=${imm.map((i) => i.id)}`);
ok('ordinati per data (scaduto prima)', imm[0].id === 1 && imm[1].id === 2);
ok('scaduto marcato overdue', imm[0].overdue === true && imm[1].overdue === false);
ok('escluso oltre finestra', !imm.some((i) => i.id === 3));
ok('escluso completato', !imm.some((i) => i.id === 4));

const dig = composeDeadlineDigest(imm);
ok('digest non vuoto', dig.empty === false);
ok('digest cita F24 e SCADUTA', /F24/.test(dig.text) && /SCADUTA/.test(dig.text));
ok('digest vuoto quando lista vuota', composeDeadlineDigest([]).empty === true);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
