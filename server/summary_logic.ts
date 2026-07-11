/*
 * summary_logic.ts — Helper PURI del riassunto conversazione (rev. 11/07/2026).
 * Nessun import di DB/rete → testabile a unità e importabile in CI senza il nativo.
 */

export interface SummaryMsg { direction: string; content: string; timestamp?: string; created_at?: string }

/** Costruisce il transcript da passare al modello (ordine cronologico, righe utili). */
export function buildSummaryTranscript(rows: SummaryMsg[]): string {
  return rows
    .map((r) => `[${r.direction === 'sent' ? 'STUDIO' : 'CLIENTE'}] ${String(r.content || '').replace(/\s+/g, ' ').trim()}`)
    .filter((l) => l.length > 12)
    .join('\n');
}

/** La cache è valida se copre lo STESSO ultimo messaggio ed è recente (ttlMin). */
export function isSummaryCacheFresh(
  cached: { last_ts?: string; created_at?: string } | null,
  latestTs: string, nowMs: number, ttlMin = 15,
): boolean {
  if (!cached || !cached.created_at) return false;
  if ((cached.last_ts || '') !== (latestTs || '')) return false;
  const age = nowMs - Date.parse(cached.created_at);
  return !isNaN(age) && age < ttlMin * 60000;
}

/** Estrae il testo dalla risposta Anthropic (messages API). */
export function parseAnthropicText(data: any): string {
  const blocks: any[] = data?.content || [];
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
}
