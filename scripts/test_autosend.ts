/* Test unità della decisione di auto-invio (riproduce l'incidente 06/07).
 * Regola: autonomia SOLO appuntamenti; merito e urgenze → bozza. Nessun invio reale. */
import { decideWorkAutoSend } from '../server/autosend.js';

let fails = 0;
function eq(name: string, got: string, exp: string) {
  const ok = got === exp;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name} (atteso=${exp}, ottenuto=${got})`);
  if (!ok) fails++;
}
const base = { autoApptEnabled: true, sanitizerDiverted: false };

// INCIDENTE: risposta di MERITO non urgente (nessun flusso agenda) → DEVE restare BOZZA
// (prima con autoSend ON partiva da sola: casi Serena/Giovanni/Rossella).
eq('merito non urgente → draft',
  decideWorkAutoSend({ ...base, appointmentFlow: false, needsHuman: false }), 'draft');

// URGENZA (need_human) → sempre bozza
eq('urgenza → draft',
  decideWorkAutoSend({ ...base, appointmentFlow: false, needsHuman: true }), 'draft');

// APPUNTAMENTO (flusso agenda) non urgente → auto-invio consentito
eq('appuntamento → appointment-auto',
  decideWorkAutoSend({ ...base, appointmentFlow: true, needsHuman: false }), 'appointment-auto');

// Appuntamento ma toggle appuntamenti OFF → bozza
eq('appuntamento con toggle OFF → draft',
  decideWorkAutoSend({ appointmentFlow: true, needsHuman: false, autoApptEnabled: false, sanitizerDiverted: false }), 'draft');

// Appuntamento ma il guardrail ha deviato (testo non sicuro) → bozza (fail-safe)
eq('appuntamento con sanitizerDiverted → draft',
  decideWorkAutoSend({ ...base, appointmentFlow: true, needsHuman: false, sanitizerDiverted: true }), 'draft');

// Appuntamento E urgenza insieme → bozza (l'urgenza vince)
eq('appuntamento+urgenza → draft',
  decideWorkAutoSend({ ...base, appointmentFlow: true, needsHuman: true }), 'draft');

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
