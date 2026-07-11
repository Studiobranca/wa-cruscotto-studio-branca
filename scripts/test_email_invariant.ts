/* Test invariante EMAIL: la decisione di auto-invio email usa decideWorkAutoSend, quindi
 * MERITO e URGENZE via email → 'draft' (bozza), MAI inviate; solo il flusso appuntamenti è
 * autonomo. Riproduce il comportamento di maybeAutoReply senza toccare rete/SMTP. */
import { decideWorkAutoSend } from '../server/autosend.js';

let fails = 0;
function eq(name: string, got: string, exp: string) {
  const ok = got === exp;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name} (atteso=${exp}, ottenuto=${got})`);
  if (!ok) fails++;
}
const base = { autoApptEnabled: true, sanitizerDiverted: false };

// EMAIL merito (nessun appointmentFlow) → BOZZA (prima veniva auto-inviata!)
eq('email merito → draft', decideWorkAutoSend({ ...base, appointmentFlow: false, needsHuman: false }), 'draft');
// EMAIL urgenza → BOZZA needs_human
eq('email urgenza → draft', decideWorkAutoSend({ ...base, appointmentFlow: false, needsHuman: true }), 'draft');
// EMAIL conferma documenti (non appuntamento) → BOZZA
eq('email documenti (non-appt) → draft', decideWorkAutoSend({ ...base, appointmentFlow: false, needsHuman: false }), 'draft');
// EMAIL appuntamento → autonomo (unico caso consentito)
eq('email appuntamento → appointment-auto', decideWorkAutoSend({ ...base, appointmentFlow: true, needsHuman: false }), 'appointment-auto');
// EMAIL appuntamento ma toggle OFF → BOZZA
eq('email appuntamento toggle OFF → draft', decideWorkAutoSend({ appointmentFlow: true, needsHuman: false, autoApptEnabled: false, sanitizerDiverted: false }), 'draft');

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
