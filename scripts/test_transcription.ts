/* Test unità della logica pura di trascrizione (parsing/classificazione/idempotenza logica).
 * Nessuna chiamata di rete, nessun audio reale. */
import { parseDeepgramTranscript, classifyTranscription, transcriptionLabel } from '../server/transcription.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// parseDeepgramTranscript
const good = { results: { channels: [{ alternatives: [{ transcript: '  Buongiorno Dottore  ' }] }] } };
ok('parse: transcript valido (trim)', parseDeepgramTranscript(good) === 'Buongiorno Dottore');
ok('parse: transcript vuoto → null', parseDeepgramTranscript({ results: { channels: [{ alternatives: [{ transcript: '   ' }] }] } }) === null);
ok('parse: struttura assente → null', parseDeepgramTranscript({}) === null);
ok('parse: json null → null', parseDeepgramTranscript(null) === null);

// classifyTranscription
ok('classify: no key', classifyTranscription(false, false, null).status === 'no_key');
ok('classify: http fallito', classifyTranscription(true, false, null).status === 'failed');
ok('classify: ok ma vuoto → empty', classifyTranscription(true, true, null).status === 'empty');
const okRes = classifyTranscription(true, true, 'ciao');
ok('classify: ok con testo', okRes.status === 'ok' && okRes.transcript === 'ciao');

// transcriptionLabel
ok('label ok → vuota', transcriptionLabel('ok') === '');
ok('label empty → non disponibile', /non disponibile/i.test(transcriptionLabel('empty')));
ok('label failed → errore', /errore/i.test(transcriptionLabel('failed')));
ok('label no_key → non configurata', /non configurata/i.test(transcriptionLabel('no_key')));
ok('label sconosciuto → non disponibile', /non disponibile/i.test(transcriptionLabel(null)));

// INVARIANTE: la trascrizione non produce mai un esito che "autorizza" un invio:
// è solo testo. (documentale) — nessun campo di invio è presente nel risultato.
ok('risultato STT non contiene flag di invio', !('send' in okRes) && !('autoSend' in okRes));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
