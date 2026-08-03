/* Test BACKSCAN + preparazione/invio massivo (puro). Simula la pipeline su un set di PEC di
 * prova: quante SENTENZE VINTE e quante NOTIFICHE preparerebbe; l'invio massivo salta i
 * 'destinatari_da_verificare'; invariante: mai invio senza approvazione. Nessun invio reale. */
import { classifyOutcome, selectCounterpartyPec, composeNotificaText, extractSentenceRef,
  extractOrgano, extractSentenceDate, formatDateIT } from '../server/pec_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// Clamp mesi (min 2) — replica pura della regola dell'endpoint
const monthsClamp = (v?: any) => Math.max(2, Math.floor(Number(v) || 2));
ok('months default = 2', monthsClamp(undefined) === 2);
ok('months 1 → 2 (minimo)', monthsClamp(1) === 2);
ok('months 2 → 2', monthsClamp(2) === 2);
ok('months 5 → 5', monthsClamp(5) === 5);

const own = 'studiotributariobrancamariano@legalmail.it';
const sysSender = 'sigit@pec.mef.gov.it';

// Set di prova: 4 messaggi (3 sentenze vinte + 1 avviso udienza)
const messaggi = [
  { subject: 'Deposito sentenza', body: 'Corte di Giustizia Tributaria di primo grado di Messina — Sentenza n. 101/2026 del 10/02/2026. P.Q.M. accoglie il ricorso. Spese € 900,00. Controparte: avvocatura@pec.agenziariscossione.gov.it.', sender: sysSender },
  { subject: 'Deposito sentenza', body: 'Corte di Giustizia Tributaria di primo grado di Messina — Sentenza n. 102/2026 del 15/03/2026. P.Q.M. accoglie parzialmente il ricorso. Controparte: studio.rossi@pec.avvocatimessina.it.', sender: sysSender },
  { subject: 'Deposito sentenza', body: 'Corte di Giustizia Tributaria di Messina — Sentenza n. 103/2026 del 20/04/2026. P.Q.M. accoglie il ricorso. (nessuna PEC di controparte nel testo)', sender: sysSender },
  { subject: 'Avviso di trattazione', body: 'Il ricorso R.G.R. n. 500/2025 è fissato per l\'udienza del 15/09/2026.', sender: sysSender },
];

// Simula ciò che il backscan prepara per ogni messaggio
const notifiche = messaggi.map((m) => {
  const full = `${m.subject}\n${m.body}`;
  const oc = classifyOutcome(full);
  const vinta = oc.isSentenza && (oc.esito === 'favorevole' || oc.esito === 'parziale');
  if (!vinta) return null;
  const recipients = selectCounterpartyPec(full, own, m.sender);
  return {
    testo: composeNotificaText({ sentenceRef: extractSentenceRef(full), organo: extractOrgano(full), sentenceDateHuman: formatDateIT(extractSentenceDate(full)) }),
    recipients,
    status: recipients.length ? 'pronta' : 'destinatari_da_verificare',
  };
}).filter(Boolean) as Array<{ testo: string; recipients: string[]; status: string }>;

const sentenzeVinte = messaggi.filter((m) => { const oc = classifyOutcome(`${m.subject}\n${m.body}`); return oc.isSentenza && (oc.esito === 'favorevole' || oc.esito === 'parziale'); }).length;
ok('3 sentenze vinte sul set', sentenzeVinte === 3, String(sentenzeVinte));
ok('3 notifiche preparate (1 per sentenza)', notifiche.length === 3, String(notifiche.length));
const pronte = notifiche.filter((n) => n.status === 'pronta');
const daVerificare = notifiche.filter((n) => n.status === 'destinatari_da_verificare');
ok('2 notifiche PRONTE (destinatari certi)', pronte.length === 2, String(pronte.length));
ok('1 notifica destinatari_da_verificare', daVerificare.length === 1, String(daVerificare.length));
ok('ogni notifica ha il testo esatto L.53', notifiche.every((n) => n.testo.startsWith('Ai sensi e per gli effetti della Legge 21 gennaio 1994, n. 53,')));

// INVIO MASSIVO: invia SOLO 'pronta' con destinatari; salta 'destinatari_da_verificare'.
// Gate: invia solo se (approvazione umana esplicita) OPPURE (flag autosend on).
function invioTutte(items: Array<{ status: string; recipients: string[] }>, opts: { humanApproval?: boolean; autosend?: boolean }) {
  const gate = !!(opts.humanApproval || opts.autosend);
  let sent = 0, skipped = 0;
  for (const it of items) {
    if (gate && it.status === 'pronta' && it.recipients.length) sent++;
    else skipped++;
  }
  return { sent, skipped };
}
const conApprovazione = invioTutte(notifiche, { humanApproval: true });
ok('invio-tutte (approvato) invia 2, salta 1', conApprovazione.sent === 2 && conApprovazione.skipped === 1, JSON.stringify(conApprovazione));
const senzaGate = invioTutte(notifiche, {});
ok('INVARIANTE: senza approvazione né flag → 0 inviate', senzaGate.sent === 0, JSON.stringify(senzaGate));
const soloDaVerificare = invioTutte(daVerificare, { humanApproval: true });
ok('mai invio dei destinatari_da_verificare', soloDaVerificare.sent === 0 && soloDaVerificare.skipped === 1, JSON.stringify(soloDaVerificare));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
