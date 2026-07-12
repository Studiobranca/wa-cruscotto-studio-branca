/* Test unità del rilevatore di registro tu/Lei (regola 3). Nessun invio reale. */
import { detectRegister, detectRegisterFromTranscript } from '../server/register.js';

let fails = 0;
function eq(name: string, got: unknown, exp: unknown) {
  const ok = got === exp;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name} (atteso=${exp}, ottenuto=${got})`);
  if (!ok) fails++;
}

// Rossana: dava del TU ("ti ha risposto", "Ti auguro") — il bot aveva risposto col Lei (BUG)
const rossana = `[CLIENTE] Buongiorno Mariano
[CLIENTE] Novità riguardo la rottamazione? Il comune di mi Milazzo ti ha risposto?
[CLIENTE] Lunedì mattina va bene?
[CLIENTE] Perfetto. A lunedì. Ti auguro un buon fine settimana
[STUDIO] Buongiorno Rossana! ...`;
eq('rossana → tu', detectRegisterFromTranscript(rossana), 'tu');

// Salvina: "Ciao Mariano" → tu (il bot infatti usava il tu, corretto)
const salvina = `[CLIENTE] Ciao Mariano, posso venire dopo il 15 a fare il 730?
[CLIENTE] Va bene per lunedì alle 14`;
eq('salvina → tu', detectRegisterFromTranscript(salvina), 'tu');

// Cliente formale → lei
const formale = `[CLIENTE] Buongiorno, Le allego la documentazione richiesta. La ringrazio, distinti saluti.`;
eq('formale → lei', detectRegisterFromTranscript(formale), 'lei');

// Neutro (nessun segnale) → unknown (il chiamante userà il Lei)
eq('neutro → unknown', detectRegisterFromTranscript(`[CLIENTE] Buongiorno, grazie.`), 'unknown');

// Le righe [STUDIO] non devono influenzare: cliente formale, studio col tu
const soloStudioTu = `[CLIENTE] Buongiorno, Le invio quanto richiesto. La ringrazio.
[STUDIO] Ciao! Ti confermo che va bene, puoi passare quando vuoi.`;
eq('ignora [STUDIO] → lei', detectRegisterFromTranscript(soloStudioTu), 'lei');

// detectRegister diretto
eq('diretto tu', detectRegister('ok grazie, ci sei domani? fammi sapere'), 'tu');
eq('diretto lei', detectRegister('Gentile Dottore, Le sarei grato se potesse ricontattarmi'), 'lei');

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
