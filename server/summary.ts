/*
 * summary.ts — Riassunto AI di una conversazione (rev. 11/07/2026).
 *
 * SOLO lettura interna per il Cruscotto: on-demand, NESSUN invio ai clienti. Usa il
 * modello già in uso (claude-sonnet via ANTHROPIC_API_KEY). Cache breve per non
 * ripetere la chiamata se la conversazione non è cambiata.
 *
 * Le parti PURE (composizione input, validità cache) sono testabili a unità; la
 * chiamata di rete è isolata e non lancia mai.
 */
import db from './db.js';
import { getBotModel } from './chatbot.js';
import { buildSummaryTranscript, isSummaryCacheFresh, parseAnthropicText, type SummaryMsg } from './summary_logic.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    phone TEXT PRIMARY KEY,
    summary TEXT,
    last_ts TEXT,
    created_at TEXT
  );
`);

const SUMMARY_SYSTEM = `Sei l'assistente dello Studio Tributario Branca. Riassumi in ITALIANO, in 4-6 righe,
i PUNTI CHIAVE e soprattutto le RICHIESTE ANCORA APERTE del cliente in questa conversazione WhatsApp/email.
Sii concreto e sintetico. NON inventare nulla che non sia nel testo. Restituisci SOLO il riassunto, senza
premesse, senza elenco di istruzioni, senza nominare strumenti.`;

export interface SummaryResult { phone: string; summary: string; cached: boolean; at: string; model?: string }

/** Riassume la conversazione di `phone`. On-demand, con cache breve. Non lancia mai. */
export async function summarizeConversation(phone: string): Promise<SummaryResult> {
  const rows = db.prepare(`
    SELECT direction, content, COALESCE(timestamp, created_at) AS timestamp
    FROM live_messages
    WHERE phone = ? AND content IS NOT NULL AND content != ''
    ORDER BY COALESCE(timestamp, created_at) DESC, id DESC LIMIT 40
  `).all(phone) as any[];
  if (!rows.length) return { phone, summary: '(nessun messaggio in questa conversazione)', cached: false, at: new Date().toISOString() };
  rows.reverse();
  const latestTs = rows[rows.length - 1].timestamp || '';

  const cached = db.prepare(`SELECT summary, last_ts, created_at FROM conversation_summaries WHERE phone = ?`).get(phone) as any;
  if (cached && isSummaryCacheFresh(cached, latestTs, Date.now())) {
    return { phone, summary: cached.summary, cached: true, at: cached.created_at };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { phone, summary: '(riassunto non disponibile: ANTHROPIC_API_KEY non configurata)', cached: false, at: new Date().toISOString() };

  const transcript = buildSummaryTranscript(rows);
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ model: getBotModel(), max_tokens: 400, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: transcript }] }),
    });
    if (!resp.ok) { console.error('[Summary] Anthropic HTTP', resp.status); return { phone, summary: '(riassunto non disponibile in questo momento)', cached: false, at: new Date().toISOString() }; }
    const data = await resp.json();
    const summary = parseAnthropicText(data) || '(riassunto vuoto)';
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO conversation_summaries (phone, summary, last_ts, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET summary = excluded.summary, last_ts = excluded.last_ts, created_at = excluded.created_at`)
      .run(phone, summary, latestTs, at);
    return { phone, summary, cached: false, at, model: getBotModel() };
  } catch (e: any) {
    console.error('[Summary] errore:', e?.message);
    return { phone, summary: '(riassunto non disponibile: errore di rete)', cached: false, at: new Date().toISOString() };
  }
}
