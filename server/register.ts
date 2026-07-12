/*
 * register.ts — Rilevazione del registro (tu / Lei) dai messaggi del CLIENTE.
 *
 * Regola 3 dello studio: rispecchiare SEMPRE il tu/Lei usato dal cliente. Il solo
 * prompt non bastava (a Rossana, che dava del "tu", il bot rispondeva col "Lei").
 * Qui rileviamo il registro in modo deterministico dai messaggi del cliente e il
 * chiamante inietta una direttiva esplicita nel system prompt. Nel dubbio → 'lei'
 * (default prudente, coerente col prompt).
 *
 * Funzione PURA e senza side-effect → testabile a unità.
 */

// Segnali di "tu" (2ª persona singolare): pronomi/clitici e verbi tipici.
const TU_MARKERS: RegExp[] = [
  /\bti\b/i, /\btu\b/i, /\btuo\b/i, /\btua\b/i, /\btuoi\b/i, /\btue\b/i, /\bte\b/i,
  /\bciao\b/i, /\bsei\b/i, /\bhai\b/i, /\bpuoi\b/i, /\bfai\b/i, /\bvuoi\b/i, /\bdevi\b/i,
  /\bsai\b/i, /\bdimmi\b/i, /\bfammi\b/i, /\bscusami\b/i, /\bfacci\b/i, /\bmandami\b/i,
];

// Segnali di "Lei" (cortesia): forme di cortesia e 3ª persona di cortesia.
const LEI_MARKERS: RegExp[] = [
  /\blei\b/i, /\bpuò\b/i, /\bla ringrazio\b/i, /\ble allego\b/i, /\ble invio\b/i,
  /\bla prego\b/i, /\bla saluto\b/i, /\bmi dica\b/i, /\bvoglia\b/i, /\bgentile\b/i,
  /\bsalve\b/i, /\bcortese/i, /\bdistinti saluti\b/i, /\bcordiali saluti\b/i,
  /\ble chiedo\b/i, /\ble sarei grato\b/i, /\battendo un suo\b/i,
];

function count(text: string, markers: RegExp[]): number {
  return markers.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

export type Register = 'tu' | 'lei' | 'unknown';

/**
 * Rileva il registro dal testo dei SOLI messaggi del cliente.
 * Ritorna 'tu' / 'lei' / 'unknown' (quest'ultimo → il chiamante usa 'lei').
 */
export function detectRegister(clientText: string): Register {
  const t = String(clientText || '');
  if (!t.trim()) return 'unknown';
  const tu = count(t, TU_MARKERS);
  const lei = count(t, LEI_MARKERS);
  if (tu > lei) return 'tu';
  if (lei > tu) return 'lei';
  return 'unknown';
}

/** Estrae il testo dei messaggi marcati [CLIENTE] da un transcript e ne rileva il registro. */
export function detectRegisterFromTranscript(transcript: string): Register {
  const lines = String(transcript || '').match(/\[CLIENTE\][^\n]*/g) || [];
  const clientText = lines.map((l) => l.replace(/^\[CLIENTE\]\s*/, '')).join('\n');
  return detectRegister(clientText);
}
