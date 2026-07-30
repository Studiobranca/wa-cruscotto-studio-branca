/* Test unità estensioni PEC: udienza telematica/link, esito sentenza+importo, recupero +Ngg. */
import { extractHearingLink, classifyOutcome, extractLiquidatedAmount } from '../server/pec_logic.js';
import { computeRecoveryDeadline } from '../server/pec_terms.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// CASO 1 — udienza telematica + link Teams
const rem = 'Udienza da remoto in videoconferenza. Collegamento Microsoft Teams: https://teams.microsoft.com/l/meetup-join/xyz?p=1';
let l = extractHearingLink(rem);
ok('remote true', l.remote === true);
ok('provider Teams', l.provider === 'Teams');
ok('url estratto', l.url === 'https://teams.microsoft.com/l/meetup-join/xyz?p=1', String(l.url));
// remoto senza link → linkDaVerificare
l = extractHearingLink('Udienza da remoto; il collegamento sarà comunicato.');
ok('remote senza url', l.remote === true && l.url === null);
// non remoto
l = extractHearingLink('Udienza in presenza presso la sede della Corte.');
ok('non remoto', l.remote === false && l.url === null);

// CASO 2 — esito sentenza + importo
const fav = 'SENTENZA. Per questi motivi la Corte accoglie il ricorso e condanna l\'Ufficio al pagamento delle spese liquidate in € 1.500,00.';
const oc = classifyOutcome(fav);
ok('è sentenza', oc.isSentenza === true);
ok('esito favorevole', oc.esito === 'favorevole', oc.esito);
ok('importo 1.500,00', extractLiquidatedAmount(fav) === '1.500,00', String(extractLiquidatedAmount(fav)));
ok('rigetta → sfavorevole', classifyOutcome('La Corte rigetta il ricorso.').esito === 'sfavorevole');
ok('parziale', classifyOutcome('accoglie in parte il ricorso').esito === 'parziale');
ok('no importo senza euro → null', extractLiquidatedAmount('nessuna somma indicata') === null);

// CASO 3 — recupero somme +60gg (default)
const rec = computeRecoveryDeadline('2026-07-01', 60, '1.500,00');
ok('recupero +60gg → 2026-08-30', rec.dueDate === '2026-08-30', rec.dueDate);
ok('recupero cita importo [DA VERIFICARE]', /1\.500,00/.test(rec.tipo) && /DA VERIFICARE/.test(rec.tipo));
ok('recupero daConfermare/uncertain', rec.daConfermare === true && rec.uncertain === true);
// soglia configurabile
ok('recupero +90gg configurabile', computeRecoveryDeadline('2026-07-01', 90).dueDate === '2026-09-29', computeRecoveryDeadline('2026-07-01', 90).dueDate);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
