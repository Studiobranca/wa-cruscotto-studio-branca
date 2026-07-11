/*
 * briefing_logic.ts — Composizione PURA del "Briefing del mattino" (rev. 11/07/2026).
 * Nessun DB/rete → testabile a unità. Il testo va SOLO al numero di controllo di Mariano,
 * MAI ai clienti.
 */

export interface BriefingData {
  dateIT: string;
  urgentDrafts: { id: number; who: string; ageH: number }[];
  todayAppointments: { start: string; who: string; reason?: string; status: string }[];
  pendingOutcome: { who: string; date: string }[];
  transcribedVoices: number;
}

/** Compone il testo del briefing (WhatsApp: *singolo asterisco*). Restituisce anche un
 *  flag `empty` quando non c'è nulla di rilevante (il chiamante può evitare l'invio). */
export function composeBriefing(d: BriefingData): { text: string; empty: boolean } {
  const L: string[] = [`☀️ *Buongiorno Dott. Branca* — riepilogo di ${d.dateIT}`];
  const nUrg = d.urgentDrafts.length;
  const nApp = d.todayAppointments.length;
  const nOut = d.pendingOutcome.length;
  const empty = nUrg === 0 && nApp === 0 && nOut === 0 && d.transcribedVoices === 0;

  if (nApp) {
    L.push(`\n📅 *Appuntamenti di oggi* (${nApp}):`);
    for (const a of d.todayAppointments.slice(0, 12)) {
      const tag = a.status === 'da_confermare' ? ' [da confermare]' : '';
      L.push(`- ${a.start} — ${a.who}${a.reason ? ` (${a.reason})` : ''}${tag}`);
    }
  } else {
    L.push(`\n📅 Nessun appuntamento in agenda per oggi.`);
  }

  if (nUrg) {
    L.push(`\n🔴 *Bozze URGENTI da approvare* (${nUrg}):`);
    for (const u of d.urgentDrafts.slice(0, 10)) L.push(`- #${u.id} ${u.who} (in attesa ~${u.ageH}h)`);
  }

  if (nOut) {
    L.push(`\n📋 *Appuntamenti passati da chiudere* (esito, ${nOut}):`);
    for (const p of d.pendingOutcome.slice(0, 10)) L.push(`- ${p.who} — ${p.date}`);
  }

  if (d.transcribedVoices) {
    L.push(`\n🎤 *${d.transcribedVoices} vocal${d.transcribedVoices === 1 ? 'e' : 'i'}* trascritt${d.transcribedVoices === 1 ? 'o' : 'i'} da leggere nel Cruscotto.`);
  }

  L.push(`\nApri il Cruscotto per gestire bozze, agenda e messaggi.`);
  return { text: L.join('\n'), empty };
}
