/**
 * Analisi automatica di documenti — Studio Tributario Branca.
 *
 * Legge le foto/allegati che i clienti inviano (WhatsApp o email) prima che il bot risponda,
 * così la risposta non è più generica ma tiene conto di COSA è stato ricevuto davvero.
 *
 * Compito delimitato e a basso rischio (tier Haiku, coerente con la policy modelli AI dello
 * studio — estrazione/triage, non redazione): identifica tipo di documento, mittente/ente e
 * riferimenti visibili (numero atto, date, oggetto). NON calcola né deduce importi, scadenze
 * o conseguenze legali: quella valutazione resta al modello che genera la risposta (Sonnet),
 * con le stesse regole di zero-errori già in vigore (mai inventare, mai quantificare il caso).
 *
 * Isolato: qualunque errore qui ritorna null, non blocca mai l'ingestion del messaggio/email.
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const VISION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_BYTES = 8 * 1024 * 1024; // 8MB, coerente con la soglia già usata da memoria_ricorsi.py

const DOC_PROMPT = `Analizza questo documento (foto o scansione) inviato da un cliente allo Studio Tributario Branca.
Riporta in 3-5 righe SOLO ciò che è chiaramente leggibile nel documento:
- Tipo di documento (es. cartella esattoriale, avviso di accertamento, F24, fattura, contratto, busta paga, sentenza, PEC, altro).
- Ente/mittente indicato, se visibile.
- Riferimenti principali visibili: numero atto/protocollo, data del documento, oggetto.
NON calcolare né dedurre importi, scadenze o conseguenze legali: riporta SOLO ciò che leggi testualmente.
Se il documento è illeggibile, sfocato, o non è un documento di lavoro (es. una foto personale), dillo chiaramente in una riga.
Output: SOLO la descrizione, nessuna premessa né commento.`;

async function callVision(contentBlock: Record<string, unknown>): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: DOC_PROMPT }] }],
      }),
    });
    if (!resp.ok) {
      console.error('[DocVision] Anthropic HTTP', resp.status, (await resp.text()).slice(0, 200));
      return null;
    }
    const data = await resp.json() as any;
    const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return text || null;
  } catch (e: any) {
    console.error('[DocVision] errore chiamata:', e.message);
    return null;
  }
}

const SUPPORTED_IMAGE = /^image\/(jpeg|png|gif|webp)$/;

/** Foto WhatsApp: scarica dall'URL Z-API e analizza. */
export async function analyzeImageUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    const mediaType = (resp.headers.get('content-type') || '').split(';')[0].trim() || 'image/jpeg';
    if (!SUPPORTED_IMAGE.test(mediaType)) return null;
    return await callVision({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
  } catch (e: any) {
    console.error('[DocVision] fetch immagine WhatsApp:', e.message);
    return null;
  }
}

/** Allegato immagine email (buffer già in memoria da mailparser). */
export async function analyzeImageBuffer(buf: Buffer, mediaType: string): Promise<string | null> {
  if (buf.length > MAX_BYTES || !SUPPORTED_IMAGE.test(mediaType)) return null;
  return callVision({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
}

/** Allegato PDF email (buffer già in memoria da mailparser). */
export async function analyzePdfBuffer(buf: Buffer): Promise<string | null> {
  if (buf.length > MAX_BYTES) return null;
  return callVision({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
}
