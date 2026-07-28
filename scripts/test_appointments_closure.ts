/**
 * TEST fix auto-appuntamenti oltre chiusura estiva (28/07/2026).
 * Verifica che getAvailability proponga date anche quando la finestra richiesta
 * cade interamente nella chiusura estiva (26/07–31/08), guardando OLTRE e
 * restituendo le prime date di riapertura (reopening=true), restando nel flusso
 * appuntamento. Niente credenziali Google in locale → calendarChecked=false,
 * busy=[] → slot teorici deterministici.
 */
import { getAvailability, formatAvailabilityIT } from '../server/appointments.js';

let fail = 0;
function check(cond: boolean, msg: string) {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) fail++;
}

async function scenario(label: string, from: string, days: number) {
  const { slots, reopening } = await getAvailability(days, new Date(`${from}T09:00:00`));
  console.log(`\n=== ${label}  (oggi=${from}, finestra ${days}gg) ===`);
  console.log(`  slots=${slots.length}  reopening=${!!reopening}  primo=${slots[0] ? slots[0].date + ' ' + slots[0].start : '—'}`);
  console.log('  Testo cliente:\n' + formatAvailabilityIT(slots).split('\n').map(l => '    ' + l).join('\n'));
  return { slots, reopening };
}

(async () => {
  // 1) CHIUSURA: oggi dentro la chiusura, finestra 30gg tutta chiusa → deve guardare oltre
  //    e proporre la RIAPERTURA (01/09/2026, martedì). Prima del fix: 0 slot → lista d'attesa.
  // oggi=01/08 con finestra 30gg → 02/08–31/08 TUTTI chiusi → deve guardare OLTRE (reopening=true).
  const s1 = await scenario('CHIUSURA (bug storico)', '2026-08-01', 30);
  check(s1.slots.length > 0, 'chiusura: propone comunque delle date (non lista d\'attesa)');
  check(s1.reopening === true, 'chiusura: flag reopening=true (date oltre la chiusura)');
  check(!!s1.slots[0] && s1.slots[0].date === '2026-09-01', 'chiusura: prima data utile = 2026-09-01 (riapertura)');
  check(s1.slots.every(s => s.date >= '2026-09-01'), 'chiusura: nessuno slot dentro la chiusura');

  // 2) IN ORARIO / periodo estivo unico (10–25/07: feriali 9–14): finestra aperta,
  //    date vicine, reopening=false.
  const s2 = await scenario('ESTIVO IN ORARIO', '2026-07-13', 14);
  check(s2.slots.length > 0, 'estivo: ci sono slot vicini');
  check(!s2.reopening, 'estivo: reopening=false (finestra già aperta)');
  check(s2.slots.every(s => Number(s.start.slice(0,2)) >= 9 && Number(s.start.slice(0,2)) < 14), 'estivo: orario unico 9–14 rispettato');

  // 3) STANDARD (settembre, fuori chiusura): date vicine, reopening=false.
  const s3 = await scenario('STANDARD SETTEMBRE', '2026-09-15', 14);
  check(s3.slots.length > 0, 'standard: ci sono slot vicini');
  check(!s3.reopening, 'standard: reopening=false');

  // 4) LIVE: comportamento reale di OGGI (in produzione oggi è 28/07 → chiusura).
  const live = await getAvailability(30);
  console.log(`\n=== LIVE OGGI ===\n  slots=${live.slots.length} reopening=${!!live.reopening} primo=${live.slots[0] ? live.slots[0].date + ' ' + live.slots[0].start : '—'}`);
  check(live.slots.length > 0, 'live: oggi propone comunque delle date');

  console.log(`\n${fail === 0 ? '✅ TUTTI I TEST OK' : '❌ ' + fail + ' TEST FALLITI'}`);
  process.exit(fail === 0 ? 0 : 1);
})();
