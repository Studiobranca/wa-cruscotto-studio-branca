/* Test del PREDICATO SQL di deduplica eco fromMe (fix doppio log), su SQLite in-memory
 * reale (better-sqlite3). Nessun invio reale, nessun accesso al DB di produzione. */
// node:sqlite è disponibile su Node recenti; se assente nel runtime CI, SKIP pulito.
let DatabaseSync: any;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP — node:sqlite non disponibile in questo runtime'); process.exit(0); }

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE live_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT, phone TEXT, content TEXT, direction TEXT,
  timestamp TEXT, created_at TEXT
);`);

const now = new Date().toISOString();
const phone = '393892565507';
const testo = 'Buongiorno Rossana! Riguardo a lunedì dall\'agenda risulta disponibilità dal pomeriggio.';

// Simula la riga LOCALE creata dal bot al momento dell'invio (message_id bot_...).
db.prepare(`INSERT INTO live_messages (message_id, phone, content, direction, timestamp, created_at)
  VALUES (?, ?, ?, 'sent', ?, ?)`).run('bot_1783067957724', phone, testo, now, now);

// Il predicato ESATTO usato nel webhook per riconoscere l'eco Z-API.
const since = new Date(Date.now() - 180000).toISOString();
const isEcho = (p: string, c: string) => db.prepare(
  `SELECT id FROM live_messages WHERE phone = ? AND direction = 'sent' AND message_id LIKE 'bot_%'
     AND TRIM(content) = TRIM(?) AND created_at >= ? LIMIT 1`
).get(p, c, since) as any;

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`);
  if (!cond) fails++;
}

// 1) L'eco Z-API (stesso testo, stesso numero) → riconosciuta → NON va re-inserita.
ok('eco riconosciuta (dedup)', !!isEcho(phone, testo));
// 2) Stesso testo con spazi ai bordi (Z-API può aggiungerli) → comunque riconosciuta (TRIM).
ok('eco riconosciuta anche con spazi', !!isEcho(phone, `  ${testo}  `));
// 3) Risposta MANUALE di Mariano dal telefono (testo diverso) → NON deduplicata (va salvata).
ok('reply manuale diverso NON deduplicato', !isEcho(phone, 'Ci sentiamo domani, ci penso io.'));
// 4) Altro numero → non deduplicato.
ok('altro numero NON deduplicato', !isEcho('393333333333', testo));

// 5) Eco vecchia (oltre 3 min) → non deduplicata (fuori finestra).
db.prepare(`INSERT INTO live_messages (message_id, phone, content, direction, timestamp, created_at)
  VALUES ('bot_old', ?, 'testo vecchio', 'sent', ?, ?)`).run(phone, now, new Date(Date.now() - 600000).toISOString());
ok('eco fuori finestra (10 min) NON deduplicata', !isEcho(phone, 'testo vecchio'));

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
