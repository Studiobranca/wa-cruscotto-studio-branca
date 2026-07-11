/*
 * sms.ts — Adattatore SMS provider-agnostico (SCAFFOLD, rev. 11/07/2026).
 *
 * DISATTIVO DI DEFAULT. Si accende SOLO impostando le env:
 *   SMS_PROVIDER=skebby  SKEBBY_USER=...  SKEBBY_PASS=...  [SKEBBY_SENDER="Studio Branca"]
 * Senza queste, `smsEnabled()` è false e nessun SMS viene mai inviato.
 *
 * Usato SOLO come FALLBACK dei PROMEMORIA (appuntamenti/adempimenti), mai per merito/urgenze
 * e mai per l'auto-invio: l'invariante non cambia. Nessun import di DB → CI-friendly.
 */
import { toE164 } from './sms_logic.js';

export interface SmsResult { ok: boolean; id?: string; error?: string; skipped?: string }
export interface SmsProvider { name: string; send(toE164Number: string, text: string): Promise<SmsResult> }

/** true solo se è stata configurata la env SMS_PROVIDER (feature-flag). */
export function smsEnabled(): boolean {
  return !!(process.env.SMS_PROVIDER && String(process.env.SMS_PROVIDER).trim());
}

// ─── Implementazione Skebby (provider italiano consigliato) ──────────────────
class SkebbyProvider implements SmsProvider {
  name = 'skebby';
  async send(to: string, text: string): Promise<SmsResult> {
    const user = process.env.SKEBBY_USER, pass = process.env.SKEBBY_PASS;
    const sender = process.env.SKEBBY_SENDER || 'Studio Branca';
    if (!user || !pass) return { ok: false, error: 'SKEBBY_USER/SKEBBY_PASS mancanti' };
    try {
      const auth = await fetch(`https://api.skebby.it/API/v1.0/REST/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`);
      if (!auth.ok) return { ok: false, error: `login Skebby fallito (${auth.status})` };
      const [userKey, sessionKey] = (await auth.text()).split(';');
      const r = await fetch('https://api.skebby.it/API/v1.0/REST/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', user_key: userKey, Session_key: sessionKey },
        body: JSON.stringify({ message_type: 'GP', message: text, sender, recipient: [to] }),
      });
      const jd: any = await r.json().catch(() => null);
      return r.ok ? { ok: true, id: jd?.order_id } : { ok: false, error: `invio Skebby fallito (${r.status})` };
    } catch (e: any) { return { ok: false, error: e?.message }; }
  }
}

/** Ritorna il provider configurato, o null se SMS è disattivo/sconosciuto. */
export function getSmsProvider(): SmsProvider | null {
  if (!smsEnabled()) return null;
  if (String(process.env.SMS_PROVIDER).toLowerCase() === 'skebby') return new SkebbyProvider();
  return null;
}

/** Invia un SMS SOLO se abilitato e configurato; altrimenti ritorna skipped. Non lancia mai. */
export async function sendSmsIfEnabled(phone: string, text: string): Promise<SmsResult> {
  const p = getSmsProvider();
  if (!p) return { ok: false, skipped: 'sms-disabilitato (SMS_PROVIDER non impostato)' };
  const to = toE164(phone);
  if (!to) return { ok: false, error: 'numero non valido per E.164' };
  try { return await p.send(to, text); }
  catch (e: any) { return { ok: false, error: e?.message }; }
}

/** Stato configurazione SMS (diagnostica, nessun segreto esposto). */
export function smsStatus(): { enabled: boolean; provider: string | null; sender: string | null; hasCredentials: boolean } {
  return {
    enabled: smsEnabled(),
    provider: process.env.SMS_PROVIDER || null,
    sender: process.env.SKEBBY_SENDER || null,
    hasCredentials: !!(process.env.SKEBBY_USER && process.env.SKEBBY_PASS),
  };
}
