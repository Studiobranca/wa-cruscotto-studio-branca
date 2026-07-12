/*
 * sms_logic.ts — Logica PURA del canale SMS (rev. 11/07/2026). Nessuna rete → testabile.
 * SMS è OFF di default: lo abilita solo la env SMS_PROVIDER (+ credenziali provider).
 */

/** Normalizza un numero in formato E.164 (default Italia +39). Ritorna null se non valido. */
export function toE164(raw: string, defaultCC = '39'): string | null {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!d) return null;
  // già con prefisso internazionale (es. 39XXXXXXXXXX)
  if (d.startsWith(defaultCC) && d.length >= 11) return `+${d}`;
  // mobile IT senza prefisso (3XXXXXXXXX, 9–10 cifre)
  if (d.startsWith('3') && d.length >= 9 && d.length <= 10) return `+${defaultCC}${d}`;
  if (d.length >= 8) return `+${d}`;
  return null;
}

/** Decide se usare l'SMS come FALLBACK: solo se WhatsApp NON è andato a buon fine E l'SMS è attivo. */
export function shouldFallbackToSms(whatsappOk: boolean, smsEnabled: boolean): boolean {
  return !whatsappOk && smsEnabled;
}
