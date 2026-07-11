/* Test unità dell'aging bozze (backlog). Nessun invio reale, logica pura. */
import { selectAgingDrafts, agingDigestText, ageHours } from '../server/aging_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

const now = Date.UTC(2026, 6, 11, 12, 0, 0); // 2026-07-11 12:00Z
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600000).toISOString().replace('T', ' ').slice(0, 19);

const drafts = [
  { id: 1, needs_human: 1, created_at: iso(30), phone: 'a', contact_name: 'Dario' },   // urgente 30h → urgent
  { id: 2, needs_human: 1, created_at: iso(10), phone: 'b', contact_name: 'Paola' },    // urgente 10h → NO (<24)
  { id: 3, needs_human: 0, created_at: iso(60), phone: 'c', contact_name: 'Nino' },     // normale 60h → normal
  { id: 4, needs_human: 0, created_at: iso(30), phone: 'd', contact_name: 'Salvo' },    // normale 30h → NO (<48)
  { id: 5, needs_human: 1, created_at: iso(100), phone: 'e', contact_name: 'Giacomo' }, // urgente 100h → urgent (più vecchio)
];
const sel = selectAgingDrafts(drafts, now, { urgentHours: 24, normalHours: 48 });

ok('2 urgenze selezionate', sel.urgent.length === 2, `ids=${sel.urgent.map((u) => u.id)}`);
ok('urgenze ordinate per anzianità (100h prima di 30h)', sel.urgent[0].id === 5 && sel.urgent[1].id === 1);
ok('1 normale selezionata (60h)', sel.normal.length === 1 && sel.normal[0].id === 3);
ok('conteggio totale = 3', sel.count === 3);
ok('esclusa urgenza 10h', !sel.urgent.some((u) => u.id === 2));
ok('esclusa normale 30h', !sel.normal.some((n) => n.id === 4));

// ageHours robusto su formato SQLite
ok('ageHours ~30h', Math.round(ageHours(iso(30), now)) === 30);

// Testo digest
const txt = agingDigestText(sel, [{ who: 'Tizio', date: '2026-07-09', start: '10:00' }], { urgentHours: 24, normalHours: 48 });
ok('digest cita 2 URGENZE', /2 URGENZE/.test(txt));
ok('digest cita appuntamento da confermare', /DA CONFERMARE/.test(txt) && /Tizio/.test(txt));
ok('digest NON è vuoto', txt.length > 40);

// Caso vuoto
const empty = selectAgingDrafts([{ id: 9, needs_human: 0, created_at: iso(1), phone: 'x' }], now);
ok('nessuna bozza vecchia → count 0', empty.count === 0);

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
