/*
 * sentlog_logic.ts — Logica PURA dell'audit-log degli invii autonomi del bot.
 *
 * Registriamo OGNI messaggio che il bot invia in autonomia, con il TIPO
 * ('appointment' | 'courtesy'): siccome il MERITO non viene MAI auto-inviato
 * (server/autosend.ts), il log conterrà solo questi due tipi → è la PROVA
 * osservabile dell'invariante di sicurezza. Nessun testo integrale del cliente
 * viene esposto: solo un'anteprima breve + un hash sha256 troncato per confronto.
 *
 * Modulo puro (nessun DB) → testabile a unità.
 */
import crypto from 'node:crypto';

export type SentKind = 'appointment' | 'courtesy';

export interface SentInput {
  phone: string;
  contactName?: string | null;
  kind: SentKind;
  draftId?: number | null;
  text: string;
}

export interface SentRow {
  phone: string;
  contact_name: string | null;
  kind: SentKind;
  draft_id: number | null;
  text_hash: string;     // sha256 troncato (16 hex): confronto senza esporre il testo
  text_preview: string;  // anteprima breve (<=140), niente a capo
  created_at: string;    // ISO
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** Costruisce la riga di audit da inserire (pura: nessuna scrittura). */
export function buildSentEntry(e: SentInput, nowISO: string): SentRow {
  const text = String(e.text ?? '');
  return {
    phone: String(e.phone ?? ''),
    contact_name: e.contactName ?? null,
    kind: e.kind,
    draft_id: e.draftId ?? null,
    text_hash: hashText(text),
    text_preview: text.replace(/\s+/g, ' ').trim().slice(0, 140),
    created_at: nowISO,
  };
}
