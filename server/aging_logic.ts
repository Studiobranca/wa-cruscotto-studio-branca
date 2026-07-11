/*
 * aging_logic.ts — Logica PURA per l'AGING delle bozze in attesa (rev. 11/07/2026).
 *
 * Complementare allo SLA one-shot (runSlaCheck alza UN alert a ~4h per bozza, poi
 * marca sla_notified): quello NON ri-segnala le bozze che restano ferme per GIORNI.
 * Qui produciamo un DIGEST ricorrente (1×/giorno) del backlog ancora aperto, dando
 * priorità alle URGENZE (needs_human) ferme oltre la soglia. Non invia nulla ai
 * clienti: alimenta solo la notifica al numero di controllo e la vista /aging.
 *
 * Modulo puro (nessun DB) → testabile a unità.
 */

/** Parso robusto di timestamp SQLite ("YYYY-MM-DD HH:MM:SS", UTC) o ISO. */
export function parseTs(s: string): number {
  if (!s) return NaN;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + (s.length <= 19 ? 'Z' : '');
  const t = Date.parse(iso);
  return isNaN(t) ? Date.parse(s) : t;
}

export function ageHours(created_at: string, nowMs: number): number {
  const t = parseTs(created_at);
  return isNaN(t) ? 0 : (nowMs - t) / 3600000;
}

export interface DraftLite {
  id: number;
  needs_human?: number | boolean;
  created_at: string;
  contact_name?: string | null;
  phone: string;
}
export interface AgingOpts { urgentHours: number; normalHours: number; }
export interface AgingItem { id: number; who: string; ageH: number; needsHuman: boolean; }
export interface AgingSelection { urgent: AgingItem[]; normal: AgingItem[]; count: number; }

/**
 * Seleziona le bozze "vecchie": URGENZE (needs_human) oltre urgentHours, e le
 * altre oltre normalHours. Ordinate per anzianità decrescente.
 */
export function selectAgingDrafts(drafts: DraftLite[], nowMs: number, opts: AgingOpts = { urgentHours: 24, normalHours: 48 }): AgingSelection {
  const urgent: AgingItem[] = [];
  const normal: AgingItem[] = [];
  for (const d of drafts) {
    const h = ageHours(d.created_at, nowMs);
    const nh = d.needs_human === 1 || d.needs_human === true;
    const item: AgingItem = { id: d.id, who: (d.contact_name || d.phone) as string, ageH: Math.round(h), needsHuman: !!nh };
    if (nh && h >= opts.urgentHours) urgent.push(item);
    else if (!nh && h >= opts.normalHours) normal.push(item);
  }
  urgent.sort((a, b) => b.ageH - a.ageH);
  normal.sort((a, b) => b.ageH - a.ageH);
  return { urgent, normal, count: urgent.length + normal.length };
}

export interface OverdueAppt { who: string; date: string; start: string; }

/** Testo del digest per il numero di controllo (WhatsApp: *singolo asterisco*). */
export function agingDigestText(sel: AgingSelection, overdueAppts: OverdueAppt[], opts: AgingOpts): string {
  const L: string[] = ['⏳ *Bozze in attesa da tempo* — da revisionare nel Cruscotto (Bozze Bot).'];
  if (sel.urgent.length) {
    L.push(`\n🔴 *${sel.urgent.length} URGENZE* ferme da oltre ${opts.urgentHours}h:`);
    for (const u of sel.urgent.slice(0, 10)) L.push(`- #${u.id} ${u.who} (~${u.ageH}h)`);
  }
  if (sel.normal.length) {
    L.push(`\n🟡 *${sel.normal.length} bozze* ferme da oltre ${opts.normalHours}h:`);
    for (const n of sel.normal.slice(0, 10)) L.push(`- #${n.id} ${n.who} (~${n.ageH}h)`);
  }
  if (overdueAppts.length) {
    L.push(`\n📅 *${overdueAppts.length} appuntament${overdueAppts.length === 1 ? 'o' : 'i'} [DA CONFERMARE]* già passat${overdueAppts.length === 1 ? 'o' : 'i'} o in giornata:`);
    for (const a of overdueAppts.slice(0, 10)) L.push(`- ${a.who} — ${a.date} ${a.start}`);
  }
  return L.join('\n');
}
