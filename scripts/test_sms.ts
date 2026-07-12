/* Test unità SMS scaffold (pura + stato). OFF di default → nessun invio possibile nei test. */
import { toE164, shouldFallbackToSms } from '../server/sms_logic.js';
import { smsEnabled, smsStatus, getSmsProvider } from '../server/sms.js';

let fails = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
}

// Normalizzazione E.164
ok('E164 già con 39', toE164('393892565507') === '+393892565507');
ok('E164 mobile IT senza prefisso', toE164('3892565507') === '+393892565507');
ok('E164 con spazi/segni', toE164('+39 389 256 5507') === '+393892565507');
ok('E164 numero troppo corto → null', toE164('123') === null);

// Scelta canale fallback
ok('fallback se WA fallito e SMS on', shouldFallbackToSms(false, true) === true);
ok('no fallback se WA ok', shouldFallbackToSms(true, true) === false);
ok('no fallback se SMS off', shouldFallbackToSms(false, false) === false);

// Feature-flag: OFF di default (ambiente di test senza SMS_PROVIDER)
delete process.env.SMS_PROVIDER;
ok('smsEnabled false senza SMS_PROVIDER', smsEnabled() === false);
ok('getSmsProvider null quando disattivo', getSmsProvider() === null);
ok('smsStatus.enabled false di default', smsStatus().enabled === false);

// Con flag skebby ma senza credenziali: enabled true, hasCredentials false
process.env.SMS_PROVIDER = 'skebby';
ok('smsEnabled true con SMS_PROVIDER', smsEnabled() === true);
ok('provider skebby istanziato', getSmsProvider()?.name === 'skebby');
ok('smsStatus senza credenziali', smsStatus().hasCredentials === false);
delete process.env.SMS_PROVIDER;

console.log(`\n${fails === 0 ? 'TUTTI I TEST OK' : fails + ' TEST FALLITI'}`);
process.exit(fails === 0 ? 0 : 1);
