/* Test unità del guardrail sanitizeClientText — input REALI (Salvina/Rossana) + caso normale.
 * Eseguire: npx tsx scripts/test_sanitize.ts  (nessun invio reale: solo funzione pura). */
import { sanitizeClientText } from '../server/sanitize.js';

const TOOLS = ['get_availability','check_walkin_now','propose_booking','confirm_appointment',
  'need_human','ignore_personal','note_documents','already_handled','find_previous_requests'];

let fails = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// 1) Salvina "Porto tutto quel giorno" (ragionamento + testo reale)
const salvina1 = `Il messaggio "Porto tutto quel giorno" non è una conferma esplicita di presenza, ma un'indicazione che porterà i documenti il giorno stesso — il che in realtà va *contro* la richiesta di inviare i documenti in anticipo. Non è una conferma del tipo "sì confermo, ci sarò". Non chiamo confirm_appointment.

Salvina, capito! Ti chiedo però di inviare la documentazione *prima* di lunedì, non il giorno stesso: così il Dott. Branca può già dare un'occhiata con calma.

Assistente Virtuale — Studio Tributario Branca`;
let r = sanitizeClientText(salvina1, TOOLS);
check('salvina1 safe', r.safe);
check('salvina1 changed', r.changed);
check('salvina1 clean inizia con "Salvina, capito!"', r.clean.startsWith('Salvina, capito!'), r.clean.slice(0, 30));
check('salvina1 clean SENZA "confirm_appointment"', !/confirm_appointment/.test(r.clean));
check('salvina1 clean SENZA "Non chiamo"', !/Non chiamo/i.test(r.clean));

// 2) Salvina "Va bene" (ragionamento)
const salvina2 = `Il "Va bene" di Salvina è ambiguo: potrebbe essere una conferma dell'appuntamento oppure solo un'accettazione della richiesta di inviare i documenti prima. Non è una conferma esplicita di presenza. Non chiamo confirm_appointment.

Perfetto Salvina, grazie! Ti aspettiamo lunedì 6 luglio alle 14:00.

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(salvina2, TOOLS);
check('salvina2 safe', r.safe);
check('salvina2 clean inizia con "Perfetto Salvina, grazie!"', r.clean.startsWith('Perfetto Salvina, grazie!'), r.clean.slice(0, 30));
check('salvina2 SENZA tool/ragionamento', !/confirm_appointment|Non chiamo|è ambiguo/i.test(r.clean));

// 3) Rossana "lunedì mattina va bene?" (ragionamento + testo reale)
const rossana = `Lunedì 6 luglio la prima disponibilità è dalle 13:00. Non risultano slot al mattino. Dato che la cliente ha detto "lunedì mattina" ma l'agenda non mostra disponibilità mattutine quel giorno, non posso proporre o confermare un orario mattutino. Non faccio propose_booking su uno slot non disponibile. Avviso con garbo e propongo gli slot reali disponibili.

Buongiorno Rossana! Riguardo a *lunedì 6 luglio* dall'agenda risultano disponibilità solo dal pomeriggio (13:00, 14:00 o 15:00): al mattino non ci sono slot liberi.

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(rossana, TOOLS);
check('rossana safe', r.safe);
check('rossana clean inizia con "Buongiorno Rossana!"', r.clean.startsWith('Buongiorno Rossana!'), r.clean.slice(0, 30));
check('rossana SENZA "propose_booking"', !/propose_booking/.test(r.clean));
check('rossana SENZA "la cliente"/"Avviso con garbo"', !/la cliente|Avviso con garbo/i.test(r.clean));

// 4) Messaggio NORMALE (nessun ragionamento) — NON deve tagliare nulla
const buono = `✅ Perfetto Salvina, appuntamento confermato per *lunedì 6 luglio alle 14:00*!

Appena ci fai avere la documentazione in giornata (CU, spese mediche, eventuale mutuo, ecc.), il Dott. Branca potrà darci un'occhiata prima dell'incontro.

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(buono, TOOLS);
check('buono safe', r.safe);
check('buono NON modificato (changed=false)', r.changed === false);
check('buono clean === originale', r.clean === buono.trim());

// 5) TUTTO ragionamento (nessun testo-cliente) → NON safe (deve deviare a bozza)
const soloRagionamento = `La cliente non ha confermato. Non chiamo confirm_appointment e non faccio propose_booking. Avviso con garbo.`;
r = sanitizeClientText(soloRagionamento, TOOLS);
check('soloRagionamento NON safe', r.safe === false, `clean="${r.clean.slice(0,40)}"`);

// 6) Nome-tool in coda al testo cliente → residuo rilevato → NON safe
const toolInCoda = `Buongiorno! La ricontattiamo a breve per fissare tutto.

Nota interna: valutare need_human se urgente.`;
r = sanitizeClientText(toolInCoda, TOOLS);
check('toolInCoda residualTool rilevato', r.residualTool === true);
check('toolInCoda NON safe', r.safe === false);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
