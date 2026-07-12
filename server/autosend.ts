/*
 * autosend.ts — Decisione PURA di auto-invio per le risposte di LAVORO.
 *
 * REGOLA PERMANENTE (rev. 03/07/2026, dopo l'incidente del 06/07): in AUTONOMIA
 * parte SOLO il flusso APPUNTAMENTI (l'agenda è già stata incrociata:
 * get_availability / check_walkin_now / propose_booking / confirm_appointment,
 * che impostano `appointmentFlow`). OGNI risposta di MERITO e OGNI URGENZA
 * (`needsHuman`) restano SEMPRE BOZZA. Nel dubbio → BOZZA (fail-safe).
 *
 * Il vecchio auto-invio generale del merito (legato a `bot_auto_send`/`globalAuto`)
 * è stato RIMOSSO: causava invii non voluti — risposte di merito partite da sole,
 * incluso un caso con ragionamento interno finito al cliente.
 *
 * Funzione pura e senza side-effect → testabile a unità e riproduce l'incidente.
 */

export interface WorkAutoSendInput {
  appointmentFlow: boolean;   // true se la risposta nasce dal flusso agenda
  needsHuman: boolean;        // true = urgenza / da gestire a mano
  autoApptEnabled: boolean;   // toggle bot_auto_appointments (default ON)
  sanitizerDiverted: boolean; // true = il guardrail ha deviato a bozza (testo non sicuro)
}

export type WorkAutoSendDecision = 'appointment-auto' | 'draft';

/**
 * Decide se una risposta di LAVORO può partire in autonomia.
 * Ritorna 'appointment-auto' SOLO per il flusso appuntamenti (non urgente, non
 * deviato dal guardrail, con toggle appuntamenti attivo). In ogni altro caso
 * (merito, urgenza, dubbio) → 'draft'.
 */
export function decideWorkAutoSend(i: WorkAutoSendInput): WorkAutoSendDecision {
  if (i.needsHuman) return 'draft';                 // urgenze → SEMPRE bozza
  if (i.sanitizerDiverted) return 'draft';          // testo non isolabile in sicurezza → bozza
  if (i.appointmentFlow && i.autoApptEnabled) return 'appointment-auto';
  return 'draft';                                   // merito e qualunque altro caso → bozza (fail-safe)
}
