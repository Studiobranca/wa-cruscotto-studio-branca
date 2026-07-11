/*
 * practices_logic.ts — Logica PURA della checklist documenti per pratica (rev. 11/07/2026).
 * Nessun DB/rete → testabile a unità. La richiesta al cliente è SEMPRE una bozza (invariante).
 */

export interface DocRow { id: number; doc_name: string; status: string }

/** Documenti ancora mancanti (non 'ricevuto'). */
export function missingDocs(rows: DocRow[]): DocRow[] {
  return rows.filter((r) => r.status !== 'ricevuto');
}

/** Avanzamento della checklist. */
export function checklistProgress(rows: { status: string }[]): { total: number; received: number; missing: number; complete: boolean } {
  const total = rows.length;
  const received = rows.filter((r) => r.status === 'ricevuto').length;
  return { total, received, missing: total - received, complete: total > 0 && received === total };
}

/** Testo (BOZZA) di richiesta documenti mancanti per una pratica. WhatsApp: prosa semplice. */
export function composeDocRequest(pratica: string, missing: string[], contactName?: string | null): string {
  const nome = contactName ? ` ${contactName}` : '';
  const lista = missing.map((d) => `- ${d}`).join('\n');
  return `Gentile${nome}, per procedere con la pratica "${pratica}" ci servono ancora questi documenti:\n${lista}\n\n`
    + `Può inviarli su questa chat WhatsApp oppure via email a studiobranca@tiscali.it o studiobranca@icloud.com.\n\n`
    + `Per qualsiasi necessità può chiamare lo 0909797187 negli orari di segreteria.\n`
    + `Assistente Virtuale — Studio Tributario Branca`;
}
