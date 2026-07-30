/* Test unità parsing/classificazione PEC (pura). Nessun invio, nessuna casella reale. */
import { classifyPec, extractDates, extractHearingDate, extractRG } from '../server/pec_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// PEC realistica: avviso di trattazione (SIGIT/CGT)
const udienza = `Corte di Giustizia Tributaria di primo grado di Messina — Avviso di trattazione.
Si comunica che il ricorso R.G.R. n. 245/2025 è stato fissato per l'udienza del 15/09/2026 ore 9:30.`;
let c = classifyPec('sigit@pec.mef.gov.it', 'Avviso di trattazione', udienza);
ok('udienza → CGT_PTT', c.category === 'CGT_PTT', c.category);
ok('udienza → fissazione_udienza', c.eventType === 'fissazione_udienza', c.eventType);
ok('udienza → confident', c.confident === true);
ok('estrae data udienza 2026-09-15', extractHearingDate(udienza) === '2026-09-15', String(extractHearingDate(udienza)));
ok('estrae R.G.R. 245/2025', extractRG(udienza) === '245/2025', String(extractRG(udienza)));

// Ricevute PEC di sistema
ok('accettazione', classifyPec('posta-certificata@legalmail.it', 'ACCETTAZIONE: ricorso', 'Ricevuta di accettazione').eventType === 'accettazione');
ok('consegna', classifyPec('posta-certificata@legalmail.it', 'CONSEGNA', 'Ricevuta di avvenuta consegna').eventType === 'consegna');

// Deposito PTT
const dep = 'Attestazione di deposito telematico del ricorso. Iscrizione a ruolo avvenuta con R.G. n. 300/2026.';
ok('deposito → ricevuta_deposito', classifyPec('sigit@pec.mef.gov.it', 'Deposito', dep).eventType === 'ricevuta_deposito');
ok('estrae R.G. 300/2026', extractRG(dep) === '300/2026', String(extractRG(dep)));

// Agenzia Entrate / Riscossione
ok('riscossione', classifyPec('protocollo@pec.agenziariscossione.gov.it', 'Comunicazione', 'cartella').category === 'RISCOSSIONE');
ok('agenzia entrate', classifyPec('x@pec.agenziaentrate.it', 'Avviso', 'agenzia delle entrate accertamento').category === 'AGENZIA_ENTRATE');

// Oggetto con "trattazione" (senza data) + corpo con "udienza del ..." → deve prendere la data del corpo
const misto = 'Avviso di trattazione\nCorte di Giustizia Tributaria di Messina. Il ricorso R.G.R. n. 245/2025 è fissato per l\'udienza del 15/09/2026 ore 9:30.';
ok('hearing dal corpo nonostante "trattazione" nell\'oggetto', extractHearingDate(misto) === '2026-09-15', String(extractHearingDate(misto)));

// Data testuale + incerto
ok('data testuale 15 settembre 2026', extractDates('udienza del 15 settembre 2026').includes('2026-09-15'));
ok('ignoto → non confident', classifyPec('tizio@gmail.com', 'ciao', 'testo qualsiasi').confident === false);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
