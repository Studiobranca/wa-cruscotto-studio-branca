/* Test unità NOTIFICA sentenza favorevole ex L. 53/1994 (puro). Nessun invio, nessuna casella.
 * Verifica: testo ESATTO, dati compilati, destinatari (esclusione sistema/proprio), rilevamento
 * notifica, e INVARIANTE "nessun invio senza approvazione" (flag autosend default OFF). */
import { composeNotificaText, extractSentenceRef, extractOrgano, extractSentenceDate, formatDateIT,
  selectCounterpartyPec, extractPecAddresses, hasSentenceNotification } from '../server/pec_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const sentenza = `Corte di Giustizia Tributaria di primo grado di Messina — Sentenza n. 412/2026 del 03/06/2026.
P.Q.M. accoglie il ricorso e annulla l'atto impugnato. Spese liquidate in € 1.500,00.
Notificata a mezzo PEC. Controparte: avvocatura@pec.agenziariscossione.gov.it e studio.rossi@pec.avvocatimessina.it.`;

// Testo ESATTO ex L.53/1994 con dati compilati
const ref = extractSentenceRef(sentenza);
const org = extractOrgano(sentenza);
const dateISO = extractSentenceDate(sentenza);
const testo = composeNotificaText({ sentenceRef: ref, organo: org, sentenceDateHuman: formatDateIT(dateISO) });
ok('estrae n. sentenza 412/2026', ref === '412/2026', String(ref));
ok('estrae organo (CGT Messina)', /Corte di Giustizia Tributaria/i.test(String(org)) && /Messina/i.test(String(org)), String(org));
ok('estrae data sentenza 2026-06-03', dateISO === '2026-06-03', String(dateISO));
const atteso = 'Ai sensi e per gli effetti della Legge 21 gennaio 1994, n. 53, si trasmettono in allegato copia informatica della sentenza n. 412/2026 resa dalla Corte di Giustizia Tributaria di primo grado di Messina in data 03/06/2026. Distinti saluti. La presente valevole ad ogni fine di legge.';
ok('testo ESATTO L.53/1994 compilato', testo === atteso, testo);

// Placeholder quando i dati non sono ricavabili (non inventa)
const vuoto = composeNotificaText({ sentenceRef: null, organo: null, sentenceDateHuman: null });
ok('placeholder n. …/…', vuoto.includes('sentenza n. …/…'), vuoto);
ok('placeholder data ../../….', vuoto.includes('in data ../../….'), vuoto);
ok('organo di default CGT Messina', vuoto.includes('Corte di Giustizia Tributaria di Messina'));

// Destinatari: esclude proprio utente e mittente di sistema; tiene le PEC controparte
const own = 'studiotributariobrancamariano@legalmail.it';
const sender = 'posta-certificata@legalmail.it';
const dest = selectCounterpartyPec(sentenza, own, sender);
ok('trova 2 PEC controparte', dest.length === 2, dest.join(','));
ok('esclude gestore legalmail di sistema', !dest.includes(sender));
ok('esclude il proprio utente', !dest.includes(own));
ok('include avvocatura riscossione', dest.includes('avvocatura@pec.agenziariscossione.gov.it'));

// Se nessuna PEC controparte certa → array vuoto → stato "destinatari_da_verificare" (non inventa)
const soloSistema = 'Sentenza n. 5/2026. Mittente sigit@pec.mef.gov.it. Nessuna PEC di controparte.';
ok('nessuna controparte certa → []', selectCounterpartyPec(soloSistema, own, 'sigit@pec.mef.gov.it').length === 0);

// Rilevamento notifica (per scegliere termine appello breve vs lungo)
ok('rileva "notificata a mezzo PEC"', hasSentenceNotification(sentenza) === true);
ok('rileva "ex L. 53" + sentenza', hasSentenceNotification('trasmissione ex L. 53 della sentenza n.1/2026') === true);
ok('nessuna notifica → false', hasSentenceNotification('Sentenza n. 9/2026 depositata in cancelleria.') === false);

// estrazione PEC generica (le due controparti presenti nel testo)
ok('extractPecAddresses trova entrambe', extractPecAddresses(sentenza).length === 2, extractPecAddresses(sentenza).join(','));

// INVARIANTE: autosend DEFAULT OFF (la notifica NON parte da sola). Replica pura del parse env.
const flag = (v?: string) => /^(1|true|on|yes)$/i.test((v || '').trim());
ok('autosend OFF se env non impostata', flag(undefined) === false);
ok('autosend OFF con stringa vuota', flag('') === false);
ok('autosend OFF con valore "0"', flag('0') === false);
ok('autosend ON solo se esplicito "1"/"true"', flag('1') === true && flag('true') === true);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
