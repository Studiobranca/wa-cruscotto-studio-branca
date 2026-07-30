/* Test unitari parser NL appuntamenti (ponte conferma→agenda). now = mer 2026-07-29 12:00. */
import { detectApptIntent, extractDateTimeIT } from '../server/appt_nlp.js';

const NOW = new Date(2026, 6, 29, 12, 0, 0); // mese 0-based: 6 = luglio
let ok = 0, ko = 0;
const canon = (o: any) => JSON.stringify(o, o && typeof o === 'object' ? Object.keys(o).sort() : undefined);
function eq(label: string, got: any, exp: any) {
  const g = canon(got), e = canon(exp);
  if (g === e) { ok++; } else { ko++; console.error(`✗ ${label}\n   got=${g}\n   exp=${e}`); }
}

// Intento
eq('intent ok va bene', detectApptIntent('ok va bene'), 'confirm');
eq('intent confermo', detectApptIntent('Confermo per martedì alle 15'), 'confirm');
eq('intent annulla', detectApptIntent('annulla tutto'), 'cancel');
eq('intent disdici', detectApptIntent('dobbiamo disdire'), 'cancel');
eq('intent grazie', detectApptIntent('grazie mille a presto'), null);
eq('intent ci vediamo', detectApptIntent('ci vediamo giovedì'), 'confirm');

// Data/ora
eq('martedì alle 15', extractDateTimeIT('confermo martedì alle 15', NOW), { date: '2026-08-04', time: '15:00' });
eq('3 settembre alle 10', extractDateTimeIT('va bene il 3 settembre alle 10', NOW), { date: '2026-09-03', time: '10:00' });
eq('domani alle 9', extractDateTimeIT('ci vediamo domani alle 9', NOW), { date: '2026-07-30', time: '09:00' });
eq('dopodomani', extractDateTimeIT('facciamo dopodomani', NOW), { date: '2026-07-31' });
eq('03/09 16:30', extractDateTimeIT('ok per il 03/09 alle 16:30', NOW), { date: '2026-09-03', time: '16:30' });
eq('giovedì', extractDateTimeIT('giovedì', NOW), { date: '2026-07-30' });
eq('martedì prossimo', extractDateTimeIT('martedì prossimo', NOW), { date: '2026-08-11' });
eq('pomeriggio 3', extractDateTimeIT('alle 3 del pomeriggio', NOW), { time: '15:00' });
eq('bare 15', extractDateTimeIT('alle 15', NOW), { time: '15:00' });
eq('bare 4 studio', extractDateTimeIT('alle 4', NOW), { time: '16:00', ambiguousTime: true });
eq('solo ok', extractDateTimeIT('ok', NOW), {});
eq('oggi alle 18', extractDateTimeIT('oggi alle 18', NOW), { date: '2026-07-29', time: '18:00' });
eq('mezzogiorno', extractDateTimeIT('a mezzogiorno', NOW), { time: '12:00' });

console.log(`\nappt_nlp: ${ok} OK, ${ko} KO`);
if (ko > 0) process.exit(1);
