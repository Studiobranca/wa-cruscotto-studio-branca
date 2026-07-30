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

// 7) Leak del 06/07 (Rossella): analisi dello storico che nomina il cliente → NON safe.
const rossanaLeak = `Dallo storico risulta che Rossella ha parlato più volte delle buste paga e del pignoramento, ma non emerge che abbia mai inviato fisicamente i documenti (buste paga, atto di pignoramento, comunicazioni Mediolanum).`;
r = sanitizeClientText(rossanaLeak, TOOLS);
check('rossanaLeak NON safe', r.safe === false, `clean="${r.clean.slice(0,40)}"`);

// 8) Stesso leak come preambolo prima del testo cliente → rimosso, resta il testo pulito.
const rossanaLeakPreambolo = `Dallo storico risulta che Rossella ha parlato più volte delle buste paga, ma non emerge che abbia inviato i documenti.

Ciao Rossella! Per procedere ho bisogno che tu ci invii le buste paga e l'atto di pignoramento su questa chat.

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(rossanaLeakPreambolo, TOOLS);
check('rossanaLeakPreambolo safe dopo pulizia', r.safe === true);
check('rossanaLeakPreambolo clean inizia con "Ciao Rossella!"', r.clean.startsWith('Ciao Rossella!'), r.clean.slice(0, 30));
check('rossanaLeakPreambolo SENZA "Dallo storico"', !/Dallo storico|non emerge/i.test(r.clean));

// 9) Leak REALE del 13/07 (Conti Domenico): preambolo di ragionamento SENZA i marcatori
//    storici ("Chiedo quale preferisce… glielo chiedo nel messaggio"), poi il vero
//    messaggio che inizia con "Buongiorno,". Deve essere ripulito (regola saluto).
const contiLeak = `Giovedì 16 luglio ci sono slot disponibili. Chiedo quale preferisce e nel frattempo noto che ha inviato la tessera sanitaria ma non è chiaro il contesto — glielo chiedo. Prima però noto che "la busta non so dove sia" potrebbe riferirsi a un atto/documento pertinente per la pratica: glielo chiedo nel messaggio.

Buongiorno,

grazie per aver inviato la Sua tessera sanitaria — è utile per identificarLa in modo univoco in studio.

Per quanto riguarda *giovedì 16 luglio* mattina, i seguenti slot sono liberi:
- ore 09:00
- ore 10:00

Quale preferisce?

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(contiLeak, TOOLS);
check('contiLeak changed (preambolo rimosso)', r.changed === true);
check('contiLeak safe dopo pulizia', r.safe === true);
check('contiLeak clean inizia con "Buongiorno,"', r.clean.startsWith('Buongiorno,'), r.clean.slice(0, 30));
check('contiLeak SENZA "glielo chiedo nel messaggio"', !/glielo chiedo nel messaggio/i.test(r.clean));
check('contiLeak SENZA "Chiedo quale preferisce"', !/Chiedo quale preferisce/i.test(r.clean));

// 10) Regola saluto: testo legittimo che inizia GIÀ col saluto → intatto.
const legittimo = `Buongiorno,

l'appuntamento di giovedì 16 luglio alle 10:00 è confermato.

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(legittimo, TOOLS);
check('legittimo NON cambiato', r.changed === false);
check('legittimo safe', r.safe === true);

// 11) Regola saluto: testo legittimo SENZA alcun saluto (conferma secca) → intatto.
const confermaSecca = `✅ Perfetto, *martedì 14 luglio alle ore 11:00* è confermato in agenda.

La aspettiamo in studio in Via Operai 102, Barcellona P.G. (ME).

Assistente Virtuale — Studio Tributario Branca`;
r = sanitizeClientText(confermaSecca, TOOLS);
check('confermaSecca NON cambiata', r.changed === false);
check('confermaSecca safe', r.safe === true);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
