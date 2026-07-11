/* Test unità dell'audit-log invii (logica pura buildSentEntry/hashText). */
import { buildSentEntry, hashText } from '../server/sentlog_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const nowISO = '2026-07-11T12:00:00.000Z';
const e = buildSentEntry(
  { phone: '393208143580', contactName: 'Giovanni', kind: 'courtesy', draftId: 42, text: 'Ciao!\n\nIl Dott. Branca è impegnato.   ' },
  nowISO,
);
ok('kind = courtesy', e.kind === 'courtesy');
ok('draft_id = 42', e.draft_id === 42);
ok('preview senza a capo/spazi doppi', e.text_preview === 'Ciao! Il Dott. Branca è impegnato.');
ok('hash 16 hex', /^[0-9a-f]{16}$/.test(e.text_hash));
ok('created_at propagato', e.created_at === nowISO);

// hash deterministico per stesso testo, diverso per testo diverso
ok('hash deterministico', hashText('abc') === hashText('abc'));
ok('hash sensibile al testo', hashText('abc') !== hashText('abd'));

// tipo appointment + campi opzionali assenti
const a = buildSentEntry({ phone: 'x', kind: 'appointment', text: 'ok' }, nowISO);
ok('appointment senza nome → contact_name null', a.contact_name === null && a.kind === 'appointment');
ok('draft_id assente → null', a.draft_id === null);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
