import { syncContacts } from './zapi.js';
import { broadcastEvent } from './sse.js';

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

export async function runPollingCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log('[Polling] Starting cycle...');
    const synced = await syncContacts();
    broadcastEvent('sync', { synced, timestamp: new Date().toISOString() });
    console.log(`[Polling] Cycle complete. Synced: ${synced}`);
  } catch (err) {
    console.error('[Polling] Error:', err);
  } finally {
    isRunning = false;
  }
}

export function startPolling(intervalMs = 30000): void {
  if (pollingInterval) {
    console.log('[Polling] Already running');
    return;
  }

  console.log(`[Polling] Starting with interval ${intervalMs}ms`);

  // INCIDENTE 29/07/2026 — il primo ciclo partiva SUBITO all'avvio: il sync
  // contatti (1779 contatti su 19 pagine verso Z-API) teneva occupato l'event
  // loop ben oltre i 30s di `healthcheckTimeout`, quindi Railway non
  // instradava mai il traffico e il servizio restava irraggiungibile — con
  // redeploy automatici che ripetevano lo stesso blocco all'infinito.
  // Il primo ciclo ora è differito: prima l'app deve risultare viva.
  const primoRitardoMs = Number(process.env.POLL_FIRST_DELAY_MS) || 90000;
  setTimeout(runPollingCycle, primoRitardoMs);
  console.log(`[Polling] primo ciclo differito di ${primoRitardoMs}ms (health check prima di tutto)`);

  pollingInterval = setInterval(runPollingCycle, intervalMs);
}

export function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[Polling] Stopped');
  }
}

export function isPollingRunning(): boolean {
  return pollingInterval !== null;
}
