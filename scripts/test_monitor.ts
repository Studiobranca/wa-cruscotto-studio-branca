/* Test unità monitoraggio Z-API (pura). Nessun invio. */
import { evaluateZapiHealth, decideMonitorAlert } from '../server/monitor_logic.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// La quirk: error="You are already connected" NON deve far scattare l'allarme.
ok('sano con error quirk', evaluateZapiHealth({ connected: true, smartphoneConnected: true, error: 'You are already connected.' }).healthy === true);
ok('connected=false → down', evaluateZapiHealth({ connected: false, smartphoneConnected: true }).healthy === false);
ok('smartphoneConnected=false → down', evaluateZapiHealth({ connected: true, smartphoneConnected: false }).healthy === false);
ok('status null → nessun allarme (blip)', evaluateZapiHealth(null).healthy === true);

const now = Date.UTC(2026, 6, 11, 12, 0, 0);
// Prima caduta → alert-down
let d = decideMonitorAlert(false, undefined, null, now);
ok('prima caduta → alert-down', d.action === 'alert-down' && d.newState === 'down');
// Ancora down entro cooldown → none
d = decideMonitorAlert(false, 'down', now - 30 * 60000, now, 180);
ok('down entro cooldown → none', d.action === 'none');
// Ancora down oltre cooldown → nuovo alert
d = decideMonitorAlert(false, 'down', now - 200 * 60000, now, 180);
ok('down oltre cooldown → alert-down', d.action === 'alert-down');
// Ripresa dopo down → alert-recovered
d = decideMonitorAlert(true, 'down', now - 10 * 60000, now);
ok('ripresa → alert-recovered', d.action === 'alert-recovered' && d.newState === 'up');
// Sano e già up → none
d = decideMonitorAlert(true, 'up', null, now);
ok('sano stabile → none', d.action === 'none');

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
