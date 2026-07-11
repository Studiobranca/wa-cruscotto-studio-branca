/* Test unità helper puri del riassunto (transcript/cache/parse). Nessuna rete. */
import { buildSummaryTranscript, isSummaryCacheFresh, parseAnthropicText } from '../server/summary_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// transcript: etichette e filtro righe brevi
const t = buildSummaryTranscript([
  { direction: 'received', content: 'Buongiorno, ho ricevuto una cartella esattoriale, cosa devo fare?' },
  { direction: 'sent', content: 'ok' }, // troppo breve → scartata
  { direction: 'received', content: 'Posso passare domani in studio?' },
]);
ok('transcript etichetta CLIENTE', /\[CLIENTE\] Buongiorno/.test(t));
ok('transcript filtra righe brevi', !/\[STUDIO\] ok/.test(t));

// cache fresca solo se stesso last_ts e recente
const now = Date.UTC(2026, 6, 11, 12, 0, 0);
ok('cache fresca (stesso ts, 5 min)', isSummaryCacheFresh({ last_ts: 'T1', created_at: new Date(now - 5 * 60000).toISOString() }, 'T1', now) === true);
ok('cache stale (nuovo messaggio)', isSummaryCacheFresh({ last_ts: 'T1', created_at: new Date(now - 1 * 60000).toISOString() }, 'T2', now) === false);
ok('cache stale (troppo vecchia)', isSummaryCacheFresh({ last_ts: 'T1', created_at: new Date(now - 30 * 60000).toISOString() }, 'T1', now) === false);
ok('cache assente → false', isSummaryCacheFresh(null, 'T1', now) === false);

// parse risposta Anthropic
ok('parse testo', parseAnthropicText({ content: [{ type: 'text', text: '  Riepilogo.  ' }] }) === 'Riepilogo.');
ok('parse vuoto → ""', parseAnthropicText({}) === '');

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
