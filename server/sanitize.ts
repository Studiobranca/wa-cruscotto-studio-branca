/*
 * sanitize.ts — Guardrail anti-leak del ragionamento del modello.
 *
 * PROBLEMA (rev. 03/07/2026): con l'auto-invio attivo il modello a volte
 * anteponeva al testo per il cliente la propria deliberazione interna
 * ("La cliente non ha confermato...", "Non chiamo confirm_appointment.",
 * "Avviso con garbo...") o citava nomi di strumenti interni (confirm_appointment,
 * propose_booking, ...). Questo testo finiva DIRETTO al cliente.
 *
 * Questa funzione è PURA e senza side-effect (nessun import del resto del server),
 * così è riutilizzabile e testabile a unità. I nomi dei tool vanno passati dal
 * chiamante, ricavati dalle definizioni reali (TOOLS in chatbot.ts) per non
 * doverli mantenere a mano.
 */

export interface SanitizeResult {
  clean: string;         // testo ripulito (best-effort)
  original: string;      // testo originale ricevuto
  removed: string[];     // blocchi (paragrafi) rimossi perché ragionamento
  residualTool: boolean; // dopo la pulizia resta ancora un nome-tool interno
  changed: boolean;      // è stato rimosso qualcosa
  safe: boolean;         // true = si può inviare `clean`; false = NON auto-inviare
}

// Marcatori di "ragionamento"/meta-commento ad alta confidenza (bassissimo
// rischio di falsi positivi su un messaggio realmente rivolto al cliente).
const META_MARKERS: RegExp[] = [
  /\b(la|il)\s+client[ei]\b/i,          // "la cliente"/"il cliente": 3ª persona sul destinatario
  /\bl['’]utente\b/i,
  /\bnon\s+(chiamo|invoco|chiamer[oò])\b/i, // meta sull'uso degli strumenti
  /\bnon\s+è\s+una\s+conferma\b/i,       // analisi del messaggio del cliente
  /\bavviso\s+con\s+garbo\b/i,           // "stage direction" del modello
  /\b(chiamo|invoco|uso)\s+(il\s+|lo\s+|la\s+)?(tool|strumento|funzione)\b/i,
  // Analisi dello storico riferita al cliente (leak del 06/07: "Dallo storico risulta
  // che Rossella ha parlato… non emerge che abbia inviato…") — meta-ragionamento, mai
  // testo per il cliente.
  /\bdallo\s+storico\b/i,
  /\bnello\s+storico\b/i,
  /\bdalla\s+conversazione\s+risulta\b/i,
  /\bnon\s+emerge\s+che\b/i,
];

function buildToolRe(toolNames: string[]): RegExp | null {
  const names = (toolNames || []).filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return null;
  return new RegExp('\\b(' + names.join('|') + ')\\b', 'i');
}

function isReasoning(par: string, toolRe: RegExp | null): boolean {
  const p = (par || '').trim();
  if (!p) return false;
  if (toolRe && toolRe.test(p)) return true;
  return META_MARKERS.some((re) => re.test(p));
}

/**
 * Ripulisce il testo destinato al cliente rimuovendo eventuali preamboli di
 * ragionamento (blocchi iniziali) e segnalando la presenza di nomi di tool.
 * NON invia nulla: restituisce solo l'esito. Decide il chiamante se inviare
 * `clean` (safe) o deviare a bozza (non safe).
 */
export function sanitizeClientText(raw: string, toolNames: string[]): SanitizeResult {
  const original = String(raw ?? '');
  const toolRe = buildToolRe(toolNames);
  const paras = original.split(/\n{2,}/);

  const removed: string[] = [];
  let i = 0;
  // Rimuove SOLO i blocchi di ragionamento in TESTA (il leak è sempre un preambolo).
  while (i < paras.length && isReasoning(paras[i], toolRe)) {
    removed.push(paras[i].trim());
    i++;
  }
  const clean = paras.slice(i).join('\n\n').trim();

  const residualTool = !!toolRe && toolRe.test(clean);
  const changed = removed.length > 0;
  const firstRemainingIsReasoning = clean ? isReasoning(clean.split(/\n{2,}/)[0], toolRe) : true;

  // "safe" = si può inviare in autonomia il testo ripulito:
  //  - resta testo di lunghezza sensata,
  //  - nessun nome-tool residuo,
  //  - il primo blocco rimasto non è a sua volta ragionamento (tutto ragionamento → NON safe).
  const safe = clean.length >= 20 && !residualTool && !firstRemainingIsReasoning;

  return { clean, original, removed, residualTool, changed, safe };
}
