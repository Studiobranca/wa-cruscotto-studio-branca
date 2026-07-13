/*
 * pec_terms.ts — Calcolo PURO dei termini del processo tributario telematico (rev. 12/07/2026).
 *
 * ⚠️ ZERO ILLUSIONI: ogni termine è una PROPOSTA `daConfermare: true`, con la NORMA citata.
 * Il calcolo è un SUPPORTO, MAI una certezza: la data di notifica va sempre verificata
 * sull'atto e il computo (giorni liberi / decorrenza) confermato dal Dott. Branca.
 * Dove la regola è incerta (es. sospensione feriale sui termini "a ritroso") → `uncertain: true`
 * e NON si forza. Nessun invio: solo calcolo.
 */

function isoToUTC(iso: string): number { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function pad(n: number): string { return String(n).padStart(2, '0'); }
function utcToISO(ms: number): string { const dt = new Date(ms); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }

/** Il periodo [start,end] interseca la sospensione feriale 1–31 agosto (L. 742/1969)? */
export function ferialeOverlaps(startISO: string, endISO: string): boolean {
  const s = Math.min(isoToUTC(startISO), isoToUTC(endISO));
  const e = Math.max(isoToUTC(startISO), isoToUTC(endISO));
  for (let y = new Date(s).getUTCFullYear(); y <= new Date(e).getUTCFullYear(); y++) {
    const a1 = Date.UTC(y, 7, 1), a31 = Date.UTC(y, 7, 31);
    if (a1 <= e && a31 >= s) return true;
  }
  return false;
}

/** Aggiunge (o sottrae) giorni; se applyFeriale ed il periodo tocca agosto, +31 gg (L. 742/1969). */
export function addDaysForward(startISO: string, days: number, applyFeriale: boolean): string {
  let endMs = isoToUTC(startISO) + days * 86400000;
  if (applyFeriale && days > 0 && ferialeOverlaps(startISO, utcToISO(endMs))) endMs += 31 * 86400000;
  return utcToISO(endMs);
}

export interface TermProposal { tipo: string; dueDate: string; norma: string; note: string; daConfermare: boolean; uncertain: boolean }
export interface PecTermInput { eventType: string; category?: string; hearingDate?: string | null; baseDate?: string | null }

/** Proposte di termini a partire da un evento PEC. Sempre [DA CONFERMARE]. */
export function computeDeadlinesFromEvent(ev: PecTermInput): TermProposal[] {
  const out: TermProposal[] = [];
  const notiziaAtto = ev.eventType === 'notifica_atto'
    || (ev.eventType === 'comunicazione' && (ev.category === 'AGENZIA_ENTRATE' || ev.category === 'RISCOSSIONE'));

  if (notiziaAtto && ev.baseDate) {
    out.push({
      tipo: 'Ricorso/impugnazione — termine 60 gg',
      dueDate: addDaysForward(ev.baseDate, 60, true),
      norma: 'art. 21 D.Lgs 546/1992 (60 gg dalla notifica) + sospensione feriale L. 742/1969',
      note: 'VERIFICARE la data di notifica esatta sull\'atto (qui usata la data PEC come proxy). Sospensione feriale 1–31/8 applicata.',
      daConfermare: true, uncertain: false,
    });
  }

  if (ev.eventType === 'fissazione_udienza' && ev.hearingDate) {
    out.push({
      tipo: 'Deposito documenti (fino a 20 gg liberi prima dell\'udienza)',
      dueDate: addDaysForward(ev.hearingDate, -20, false),
      norma: 'art. 32 c.1 D.Lgs 546/1992',
      note: 'Termine A RITROSO: verificare il computo dei giorni LIBERI ed eventuale sospensione feriale (non applicata automaticamente).',
      daConfermare: true, uncertain: true,
    });
    out.push({
      tipo: 'Memorie illustrative (fino a 10 gg liberi prima)',
      dueDate: addDaysForward(ev.hearingDate, -10, false),
      norma: 'art. 32 c.1 D.Lgs 546/1992',
      note: 'Termine a ritroso: verificare giorni liberi/feriale.',
      daConfermare: true, uncertain: true,
    });
    out.push({
      tipo: 'Repliche (fino a 5 gg liberi prima)',
      dueDate: addDaysForward(ev.hearingDate, -5, false),
      norma: 'art. 32 c.2 D.Lgs 546/1992',
      note: 'Termine a ritroso: verificare giorni liberi/feriale.',
      daConfermare: true, uncertain: true,
    });
  }
  return out;
}


/** Scadenza "recupero somme" a +N gg (default 60) dalla notifica della sentenza alla controparte.
 *  Se la data di notifica alla controparte non è certa, il chiamante passa la data disponibile più
 *  prudente e lo segnala. SEMPRE [DA CONFERMARE]. */
export function computeRecoveryDeadline(baseDateISO: string, days = 60, importo?: string | null): TermProposal {
  return {
    tipo: `Richiesta somme / recupero compenso liquidato${importo ? ` (€ ${importo} [DA VERIFICARE])` : ''}`,
    dueDate: addDaysForward(baseDateISO, days, false),
    norma: `Termine prudenziale +${days} gg dalla notifica della sentenza alla controparte`,
    note: 'DECORRENZA DA CONFERMARE: verificare la data di notifica della sentenza alla controparte; qui usata la data disponibile più prudente (non inventata).',
    daConfermare: true,
    uncertain: true,
  };
}
