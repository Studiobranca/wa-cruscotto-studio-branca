/*
 * agenda_logic.ts — Logica PURA dell'agenda (rev. 11/07/2026, mandato "parti con tutto").
 * Nessun DB, nessuna rete → testabile a unità.
 *
 * Copre: anti-overbooking fail-safe, selezione proposte scadute, appuntamenti in
 * attesa di esito (no-show). Rispetta l'invariante: queste funzioni NON inviano nulla.
 */

export interface SlotCheck { busy: boolean; checked: boolean; error?: boolean; }

/**
 * Decide se BLOCCARE l'auto-conferma di uno slot (→ bozza).
 * - errore/timeout nel controllo Google Calendar → BLOCCA (fail-safe anti-overbooking):
 *   meglio una bozza in più che una doppia prenotazione.
 * - occupato E verificato → BLOCCA.
 * - non verificabile perché Google NON configurato (checked=false, error assente) → NON blocca
 *   (comportamento storico: senza Calendar non si può sapere, non si paralizza l'agenda).
 */
export function shouldBlockSlot(c: SlotCheck): boolean {
  if (c.error) return true;
  return !!c.busy && !!c.checked;
}

export interface ApptRow { id: number; date: string; status: string; outcome?: string | null; }

/** Proposte [DA CONFERMARE] con data STRETTAMENTE passata (< oggi) → da far scadere. */
export function selectExpiredProposals(rows: ApptRow[], todayISO: string): ApptRow[] {
  return rows.filter((r) => r.status === 'da_confermare' && !!r.date && r.date < todayISO);
}

/** Appuntamenti CONFERMATI con data passata e SENZA esito registrato → in attesa di esito. */
export function selectPendingOutcome(rows: ApptRow[], todayISO: string): ApptRow[] {
  return rows.filter((r) => r.status === 'confermato' && !!r.date && r.date < todayISO && !r.outcome);
}

export const VALID_OUTCOMES = ['tenuto', 'no_show', 'annullato'] as const;
export type ApptOutcome = typeof VALID_OUTCOMES[number];
export function isValidOutcome(v: any): v is ApptOutcome {
  return typeof v === 'string' && (VALID_OUTCOMES as readonly string[]).includes(v);
}
