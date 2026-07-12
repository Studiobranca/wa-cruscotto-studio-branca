/*
 * transcription.ts — Trascrizione dei messaggi vocali (STT) — rev. 11/07/2026.
 *
 * SCELTA STT: Deepgram nova-2 con `language=it` (italiano forzato). È il servizio
 * GIÀ integrato nel cruscotto e configurato in produzione (env DEEPGRAM_API_KEY):
 * affidabile sull'italiano, niente nuove dipendenze/modelli locali da gestire.
 *
 * PRIVACY: l'audio del vocale viene inviato a Deepgram (servizio STT esterno, USA)
 * per la sola trascrizione; il testo resta nel sistema dello studio. Nessun altro
 * terzo. (Vedi nota nella skill whatsapp-studio.)
 *
 * INVARIANTE: la trascrizione è SOLO lettura/visualizzazione. NON innesca alcun
 * auto-invio: la decisione di invio resta in server/autosend.ts (merito → bozza).
 *
 * La logica di parsing/classificazione è PURA (testabile); la chiamata di rete è
 * isolata e non lancia mai.
 */

export type TranscriptionStatus = 'ok' | 'empty' | 'failed' | 'no_key';
export interface TranscriptionResult { status: TranscriptionStatus; transcript: string | null; }

/** PURA: estrae il transcript dalla risposta JSON di Deepgram (null se assente/vuoto). */
export function parseDeepgramTranscript(json: any): string | null {
  const t = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof t !== 'string') return null;
  const trimmed = t.trim();
  return trimmed.length ? trimmed : null;
}

/** PURA: mappa (chiave presente, http ok, transcript) → esito con stato. */
export function classifyTranscription(hasKey: boolean, httpOk: boolean, transcript: string | null): TranscriptionResult {
  if (!hasKey) return { status: 'no_key', transcript: null };
  if (!httpOk) return { status: 'failed', transcript: null };
  if (!transcript) return { status: 'empty', transcript: null };
  return { status: 'ok', transcript };
}

/** PURA: etichetta leggibile per il frontend/diagnostica in base allo stato. */
export function transcriptionLabel(status?: string | null): string {
  switch (status) {
    case 'ok': return '';
    case 'empty': return 'Trascrizione non disponibile (audio silenzioso o non riconosciuto)';
    case 'failed': return 'Trascrizione non disponibile (errore del servizio)';
    case 'no_key': return 'Trascrizione non configurata';
    default: return 'Trascrizione non disponibile';
  }
}

const DG_URL = 'https://api.deepgram.com/v1/listen?model=nova-2&language=it&punctuate=true&smart_format=true';

/**
 * IMPURA: scarica l'audio dall'URL Z-API e lo trascrive con Deepgram.
 * Non lancia MAI: ritorna sempre un esito ({status, transcript}). Un errore qui
 * non deve mai rompere l'ingestion del messaggio.
 */
export async function transcribeAudioUrl(audioUrl: string, apiKey: string | undefined): Promise<TranscriptionResult> {
  if (!apiKey) return { status: 'no_key', transcript: null };
  try {
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) { console.error('[Deepgram] download audio HTTP', audioResp.status); return { status: 'failed', transcript: null }; }
    const buf = await audioResp.arrayBuffer();
    const dg = await fetch(DG_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/ogg; codecs=opus' },
      body: buf,
    });
    if (!dg.ok) { console.error('[Deepgram] API HTTP', dg.status); return { status: 'failed', transcript: null }; }
    const data = await dg.json();
    return classifyTranscription(true, true, parseDeepgramTranscript(data));
  } catch (e: any) {
    console.error('[Deepgram] errore trascrizione:', e?.message);
    return { status: 'failed', transcript: null };
  }
}
