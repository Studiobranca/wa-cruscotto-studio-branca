/* Test unità della guardia di coerenza data/testo (server/date_guard.ts).
 * Riproduce l'incidente REALE del 13/07/2026 (Conti Domenico): testo "giovedì 16 luglio"
 * con appuntamento registrato al 2026-07-17 (venerdì).
 * Eseguire: npx tsx scripts/test_date_guard.ts (funzione pura, nessun invio reale). */
import { dateCoherenceIssue } from '../server/date_guard.js';

let fails = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// 1) INCIDENTE 13/07: testo dice "giovedì 16 luglio", registrato 2026-07-17 (venerdì) → BLOCCA.
const proposta1626 = `Perfetto, ho registrato la proposta per *giovedì 16 luglio alle ore 10:00* in studio.

Le chiedo di confermarmi quando ha la certezza di poter venire.`;
check('incidente 13/07: 16 nel testo vs 17 registrato → problema',
  dateCoherenceIssue(proposta1626, '2026-07-17') !== null,
  String(dateCoherenceIssue(proposta1626, '2026-07-17')));

// 2) INCIDENTE 13/07 (conferma): "giovedì 17 luglio" ma il 17 è venerdì → BLOCCA.
const conferma17 = `✅ Perfetto, *giovedì 17 luglio alle ore 10:00* è confermato in agenda.`;
check('incidente 13/07: "giovedì" su data di venerdì → problema',
  dateCoherenceIssue(conferma17, '2026-07-17') !== null,
  String(dateCoherenceIssue(conferma17, '2026-07-17')));

// 3) Testo corretto → nessun problema.
const corretta = `✅ Perfetto, *giovedì 16 luglio alle ore 10:00* è confermato in agenda.`;
check('testo coerente → ok', dateCoherenceIssue(corretta, '2026-07-16') === null);

// 4) Spostamento legittimo: cita ANCHE la data vecchia (annullata) ma pure quella vera → ok.
const spostamento = `✅ Ho registrato la proposta per *martedì 14 luglio alle ore 11:00* (il precedente appuntamento del 17 luglio è stato annullato in automatico).`;
check('spostamento con data vecchia citata → ok', dateCoherenceIssue(spostamento, '2026-07-14') === null);

// 5) Testo senza alcuna data/giorno (es. solo ora) → non verificabile → ok.
check('testo senza date → ok', dateCoherenceIssue('Perfetto, alle ore 10:00 La aspettiamo in studio.', '2026-07-16') === null);

// 6) Giorno senza accento ("giovedi") → riconosciuto comunque.
check('giorno senza accento riconosciuto',
  dateCoherenceIssue('Confermato per giovedi 17 luglio alle 10:00.', '2026-07-17') !== null);

// 7) Solo giorno-settimana giusto, senza numero → ok.
check('solo giorno-settimana corretto → ok', dateCoherenceIssue('La aspettiamo venerdì alle 10:00.', '2026-07-17') === null);

// 8) Data ISO malformata → non verificabile → ok (nessun crash).
check('data ISO non valida → ok', dateCoherenceIssue('giovedì 16 luglio', 'boh') === null);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
