/* Test unità composizione briefing del mattino (pura). Nessun invio. */
import { composeBriefing } from '../server/briefing_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const full = composeBriefing({
  dateIT: 'sabato 11 luglio',
  urgentDrafts: [{ id: 57, who: 'Dario', ageH: 30 }, { id: 80, who: 'Paola', ageH: 26 }],
  todayAppointments: [{ start: '10:00', who: 'Rossi', reason: '730', status: 'confermato' }, { start: '14:00', who: 'Bianchi', status: 'da_confermare' }],
  pendingOutcome: [{ who: 'Verdi', date: '2026-07-08' }],
  transcribedVoices: 3,
});
ok('non vuoto', full.empty === false);
ok('cita appuntamenti oggi', /Appuntamenti di oggi/.test(full.text) && /Rossi/.test(full.text));
ok('marca da confermare', /\[da confermare\]/.test(full.text));
ok('cita bozze urgenti con id/anzianità', /Bozze URGENTI/.test(full.text) && /#57 Dario/.test(full.text) && /~30h/.test(full.text));
ok('cita appuntamenti da chiudere', /da chiudere/.test(full.text) && /Verdi/.test(full.text));
ok('cita vocali', /3 vocali/.test(full.text));

const empty = composeBriefing({ dateIT: 'domenica 12 luglio', urgentDrafts: [], todayAppointments: [], pendingOutcome: [], transcribedVoices: 0 });
ok('empty=true quando non c\'è nulla', empty.empty === true);
ok('anche vuoto dice "nessun appuntamento"', /Nessun appuntamento/.test(empty.text));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
