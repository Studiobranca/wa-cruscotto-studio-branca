/* Test unità checklist documenti (pura). La richiesta al cliente è sempre BOZZA. */
import { missingDocs, checklistProgress, composeDocRequest } from '../server/practices_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const rows = [
  { id: 1, doc_name: 'CU 2025', status: 'ricevuto' },
  { id: 2, doc_name: 'Spese mediche', status: 'richiesto' },
  { id: 3, doc_name: 'Interessi mutuo', status: 'richiesto' },
];
const miss = missingDocs(rows);
ok('mancanti = 2', miss.length === 2 && miss.every((m) => m.status !== 'ricevuto'));

const p = checklistProgress(rows);
ok('progress: total 3 / received 1 / missing 2', p.total === 3 && p.received === 1 && p.missing === 2);
ok('progress: non completa', p.complete === false);
ok('progress: completa quando tutto ricevuto', checklistProgress([{ status: 'ricevuto' }, { status: 'ricevuto' }]).complete === true);
ok('progress: vuota non è completa', checklistProgress([]).complete === false);

const text = composeDocRequest('730/2026', ['Spese mediche', 'Interessi mutuo'], 'Sig. Rossi');
ok('richiesta cita la pratica', /730\/2026/.test(text));
ok('richiesta elenca i documenti mancanti', /- Spese mediche/.test(text) && /- Interessi mutuo/.test(text));
ok('richiesta ha firma assistente (bozza)', /Assistente Virtuale — Studio Tributario Branca/.test(text));
ok('richiesta indirizza il contatto', /Sig\. Rossi/.test(text));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
