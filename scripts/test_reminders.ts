/* Test unità della logica PURA di promemoria/lista d'attesa/SLA (reminders_logic.ts).
 * Nessun I/O, nessun invio reale — come scripts/test_autosend.ts. */
import {
  channelOfKey, inReminderWindow, inRecallWindow, inSlaWindow,
  sqliteToMs, isTooFresh, humanDateIT, reminderMessageIT, waitlistRecallMessageIT, slaAlertText,
} from '../server/reminders_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) fails++;
}

// Canale dalla chiave contatto (convenzione generateReplyCore)
ok('chiave telefono → whatsapp', channelOfKey('393331234567').channel === 'whatsapp');
ok('chiave telefono → indirizzo intatto', channelOfKey('393331234567').address === '393331234567');
ok('chiave email → email', channelOfKey('email:pippo@pec.it').channel === 'email');
ok('chiave email → indirizzo estratto', channelOfKey('email:pippo@pec.it').address === 'pippo@pec.it');

// Finestre orarie (Rome)
ok('promemoria: 17 fuori finestra', !inReminderWindow(17));
ok('promemoria: 18 in finestra', inReminderWindow(18));
ok('promemoria: 21 fuori finestra', !inReminderWindow(21));
ok('richiamo: 8 fuori finestra', !inRecallWindow(8));
ok('richiamo: 9 in finestra', inRecallWindow(9));
ok('SLA: 7 fuori finestra', !inSlaWindow(7));
ok('SLA: 19 in finestra', inSlaWindow(19));
ok('SLA: 20 fuori finestra (niente notifiche serali)', !inSlaWindow(20));

// created_at sqlite (UTC "YYYY-MM-DD HH:MM:SS") → epoch, e guardia anti-freschezza
const now = Date.parse('2026-07-08T12:00:00Z');
ok('sqliteToMs interpreta come UTC', sqliteToMs('2026-07-08 11:00:00') === Date.parse('2026-07-08T11:00:00Z'));
ok('appuntamento preso 1h fa → troppo fresco', isTooFresh('2026-07-08 11:00:00', now));
ok('appuntamento preso 7h fa → non fresco', !isTooFresh('2026-07-08 05:00:00', now));
ok('created_at mancante → non blocca', !isTooFresh(null, now));

// Data umana (2026-07-09 è un giovedì)
ok('humanDateIT', humanDateIT('2026-07-09') === 'giovedì 9 luglio', humanDateIT('2026-07-09'));

// Promemoria: contenuti chiave e vincoli di formattazione WhatsApp
const conf = reminderMessageIT({ date: '2026-07-09', start: '10:00', status: 'confermato', reason: 'avviso di accertamento', contact_name: 'Mario Rossi' }, 'whatsapp');
ok('promemoria contiene data umana', conf.includes('giovedì 9 luglio'));
ok('promemoria contiene ora', conf.includes('10:00'));
ok('promemoria contiene motivo', conf.includes('avviso di accertamento'));
ok('promemoria invita a inviare documenti PRIMA', conf.includes('PRIMA dell\'appuntamento'));
ok('promemoria WhatsApp firmato', conf.includes('Assistente Virtuale — Studio Tributario Branca'));
ok('promemoria senza doppio asterisco (no Markdown)', !conf.includes('**'));
const daConf = reminderMessageIT({ date: '2026-07-09', start: '10:00', status: 'da_confermare', contact_name: null }, 'whatsapp');
ok('da_confermare chiede conferma', daConf.includes('DA CONFERMARE'));
ok('senza nome → "Gentile cliente"', daConf.startsWith('Gentile cliente,'));
const perEmail = reminderMessageIT({ date: '2026-07-09', start: '10:00', status: 'confermato', contact_name: 'X' }, 'email');
ok('promemoria email senza firma WA (la aggiunge SIGN di email.ts)', !perEmail.includes('Assistente Virtuale'));

// Richiamo lista d'attesa
const rec = waitlistRecallMessageIT('Anna Bianchi', 'dichiarazione redditi', '• lunedì 1 settembre: ore 09:00, 10:00', 'whatsapp');
ok('richiamo cita il motivo', rec.includes('dichiarazione redditi'));
ok('richiamo include le disponibilità', rec.includes('lunedì 1 settembre'));
ok('richiamo invita a rispondere', rec.toLowerCase().includes('rispondere'));

// Alert SLA
const sla = slaAlertText(
  [{ id: 42, who: 'Mario Rossi', ageMin: 300 }],
  [{ who: 'Anna Bianchi', subject: 'Cartella esattoriale', ageMin: 70 }],
  4,
);
ok('SLA cita la soglia', sla.includes('4h'));
ok('SLA elenca la bozza con comando OK', sla.includes('OK 42'));
ok('SLA elenca l\'email', sla.includes('Cartella esattoriale'));
ok('SLA età in ore per attese lunghe', sla.includes('5 h'));
const slaSoloBozze = slaAlertText([{ id: 7, who: 'X', ageMin: 250 }], [], 4);
ok('SLA senza email non stampa sezione email', !slaSoloBozze.includes('Email di lavoro'));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
