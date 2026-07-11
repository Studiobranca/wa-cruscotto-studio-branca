/*
 * deadlines_logic.ts — Logica PURA dello scadenzario adempimenti (rev. 11/07/2026).
 * Nessun DB/rete → testabile. I promemoria vanno SOLO al numero di controllo di Mariano.
 */

export interface DeadlineRow { id: number; tipo?: string; description?: string; who?: string; due_date: string; status: string }

/** Adempimenti imminenti o scaduti ancora aperti (entro `withinDays` da oggi). */
export function selectImminentDeadlines(rows: DeadlineRow[], todayISO: string, withinDays = 7): (DeadlineRow & { overdue: boolean })[] {
  const limit = addDaysISO(todayISO, withinDays);
  return rows
    .filter((r) => r.status === 'aperto' && !!r.due_date && r.due_date <= limit)
    .map((r) => ({ ...r, overdue: r.due_date < todayISO }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Digest per il numero di controllo (WhatsApp: *singolo asterisco*). */
export function composeDeadlineDigest(list: (DeadlineRow & { overdue: boolean })[]): { text: string; empty: boolean } {
  if (!list.length) return { text: '', empty: true };
  const L: string[] = ['📌 *Scadenze adempimenti in arrivo* (o già scadute):'];
  for (const d of list.slice(0, 20)) {
    const tag = d.overdue ? ' ⚠️ SCADUTA' : '';
    const who = d.who ? ` — ${d.who}` : '';
    L.push(`- ${d.due_date} · *${d.tipo || 'adempimento'}*${who}${d.description ? ` (${d.description})` : ''}${tag}`);
  }
  L.push('\nApri il Cruscotto per gestire lo scadenzario.');
  return { text: L.join('\n'), empty: false };
}

export const VALID_DEADLINE_STATUS = ['aperto', 'completato'] as const;
