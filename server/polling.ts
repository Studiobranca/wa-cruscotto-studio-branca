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
  
  // Run immediately
  runPollingCycle();

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
