/*
 * monitor_logic.ts — Logica PURA del monitoraggio (rev. 11/07/2026).
 * Nessun DB/rete → testabile. Gli alert vanno SOLO a Mariano (email Brevo/controllo).
 */

export interface ZapiStatus { connected?: boolean; smartphoneConnected?: boolean; error?: string }

/**
 * Valuta la salute della sessione Z-API. ATTENZIONE: lo status Z-API riporta un campo
 * `error` ("You are already connected") anche quando è SANO → NON usarlo come segnale.
 * Alziamo l'allarme SOLO quando un booleano è esplicitamente false (device disconnesso).
 */
export function evaluateZapiHealth(s: ZapiStatus | null | undefined): { healthy: boolean; reason: string } {
  if (!s) return { healthy: true, reason: 'stato non disponibile (nessun allarme: possibile blip di rete)' };
  if (s.connected === false) return { healthy: false, reason: 'sessione Z-API disconnessa (connected=false)' };
  if (s.smartphoneConnected === false) return { healthy: false, reason: 'telefono scollegato (smartphoneConnected=false)' };
  return { healthy: true, reason: 'ok' };
}

/**
 * Decide se INVIARE un nuovo alert: quando è unhealthy e non è già stato allertato di
 * recente (cooldown), oppure quando serve il messaggio di RIPRISTINO (era down, ora up).
 */
export function decideMonitorAlert(
  healthy: boolean, lastState: 'up' | 'down' | undefined, lastAlertMs: number | null, nowMs: number, cooldownMin = 180,
): { action: 'none' | 'alert-down' | 'alert-recovered'; newState: 'up' | 'down' } {
  if (!healthy) {
    const cool = lastAlertMs != null && (nowMs - lastAlertMs) < cooldownMin * 60000;
    if (lastState === 'down' && cool) return { action: 'none', newState: 'down' };
    return { action: 'alert-down', newState: 'down' };
  }
  // healthy
  if (lastState === 'down') return { action: 'alert-recovered', newState: 'up' };
  return { action: 'none', newState: 'up' };
}
