/*
 * pec_logic.ts — Logica PURA di classificazione ed estrazione dalle PEC del contenzioso
 * tributario (rev. 12/07/2026). Nessun DB/rete → testabile a unità.
 *
 * SICUREZZA: qui non si invia NULLA. Solo lettura/estrazione. I dati estratti sono un
 * SUPPORTO: date/riferimenti sono soggetti a verifica umana. Nessuna certezza automatica.
 */

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

export type PecCategory = 'CGT_PTT' | 'AGENZIA_ENTRATE' | 'RISCOSSIONE' | 'CONTROPARTE' | 'ALTRO';
export type PecEventType = 'fissazione_udienza' | 'ricevuta_deposito' | 'accettazione' | 'consegna' | 'notifica_atto' | 'comunicazione' | 'incerto';

export interface PecClassification { category: PecCategory; eventType: PecEventType; confident: boolean }

/** Classifica mittente+oggetto+corpo. `confident=false` → l'evento va marcato "da rivedere". */
export function classifyPec(sender: string, subject: string, body: string): PecClassification {
  const s = String(sender || '').toLowerCase();
  const t = `${subject || ''} ${body || ''}`.toLowerCase();
  const all = `${s} ${t}`;

  let category: PecCategory = 'ALTRO';
  if (/sigit|processo tributario telematico|\bptt\b|giustiziatributaria|corte di giustizia tributaria|commissione tributaria|\bcgt\b|mef\.gov/.test(all)) category = 'CGT_PTT';
  else if (/agenzia.?entrate.?riscossione|agenzia delle entrate-riscossione|riscossione|\bader\b|agenziariscossione/.test(all)) category = 'RISCOSSIONE';
  else if (/agenzia delle entrate|agenziaentrate|\bade\b/.test(all)) category = 'AGENZIA_ENTRATE';
  else if (/avvocatura|studio legale|\bavv\.|controparte|@pec\./.test(s)) category = 'CONTROPARTE';

  let eventType: PecEventType = 'incerto';
  if (/fissazione|avviso di trattazione|avviso di udienza|udienza .*(fissat|del )|data (di )?udienza|trattazione .*fissat/.test(t)) eventType = 'fissazione_udienza';
  else if (/ricevuta di accettazione/.test(t)) eventType = 'accettazione';
  else if (/ricevuta di (avvenuta )?consegna/.test(t)) eventType = 'consegna';
  else if (/deposito|iscrizione a ruolo|attestazione di deposito|nir\b|numero informatico di registrazione/.test(t)) eventType = 'ricevuta_deposito';
  else if (/notific|ricorso|appello|controdeduzioni|memoria|atto di/.test(t)) eventType = 'notifica_atto';
  else if (/comunicazione|avviso/.test(t)) eventType = 'comunicazione';

  const confident = category !== 'ALTRO' && eventType !== 'incerto';
  return { category, eventType, confident };
}

/** Estrae tutte le date (ISO YYYY-MM-DD) presenti nel testo: numeriche e testuali. */
export function extractDates(text: string): string[] {
  const out: string[] = [];
  const t = String(text || '');
  const push = (y: number, m: number, d: number) => {
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) {
      out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  };
  for (const mm of t.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g)) push(+mm[3], +mm[2], +mm[1]);
  const rx = new RegExp(`\\b(\\d{1,2})\\s+(${MESI.join('|')})\\s+(\\d{4})\\b`, 'gi');
  for (const mm of t.matchAll(rx)) push(+mm[3], MESI.indexOf(mm[2].toLowerCase()) + 1, +mm[1]);
  return [...new Set(out)];
}

/** Data d'udienza: la prima data che compare vicino a una parola "udienza"/"trattazione".
 *  Scandisce TUTTE le occorrenze (l'oggetto può contenere "trattazione" senza data, mentre
 *  la data reale è vicino a "udienza" nel corpo). */
export function extractHearingDate(text: string): string | null {
  const t = String(text || '');
  const re = /(udienza|trattazione)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const near = extractDates(t.slice(m.index, m.index + 160));
    if (near.length) return near[0];
  }
  return null;
}

/** Riferimento di ruolo / R.G.R. (es. "R.G.R. n. 123/2025"). */
export function extractRG(text: string): string | null {
  const t = String(text || '');
  const m = t.match(/R\.?\s*G\.?\s*R?\.?\s*(?:n\.?\s*)?(\d+\s*\/\s*\d{4})/i)
    || t.match(/ruolo\s+generale[^\d]{0,20}(\d+\s*\/\s*\d{4})/i)
    || t.match(/\bn\.?\s*(\d+\s*\/\s*\d{4})\s*R\.?G/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}


// ─── ESTENSIONI (rev. 13/07/2026): udienza telematica, esito sentenza, importo ──

const REMOTE_MARKERS = /(udienza\s+(?:da|a)\s+(?:remoto|distanza)|da\s+remoto|videoconferenz|collegament|microsoft\s+teams|\bteams\b|skype(?:\s+for\s+business)?|\bzoom\b|meet\.google|a\s+distanza)/i;

/** Udienza telematica: rileva marcatori "da remoto" ed estrae il LINK di collegamento. */
export function extractHearingLink(text: string): { remote: boolean; url: string | null; provider: string | null } {
  const t = String(text || '');
  const urlm = t.match(/https?:\/\/[^\s"'<>()\]]+/i);
  const url = urlm ? urlm[0].replace(/[.,;:)\]]+$/, '') : null;
  let provider: string | null = null;
  if (url) {
    if (/teams\.microsoft\.com|teams\.live|teams\.gov/i.test(url)) provider = 'Teams';
    else if (/skype/i.test(url)) provider = 'Skype';
    else if (/zoom\.us/i.test(url)) provider = 'Zoom';
    else if (/meet\.google/i.test(url)) provider = 'Google Meet';
    else provider = 'URL';
  } else if (/microsoft\s+teams|\bteams\b/i.test(t)) provider = 'Teams';
  else if (/skype/i.test(t)) provider = 'Skype';
  const remote = REMOTE_MARKERS.test(t) || !!url;
  return { remote, url, provider };
}

/** Classifica una sentenza e il suo ESITO (dal dispositivo). Estrazione da testo/PDF: da verificare. */
export function classifyOutcome(text: string): { isSentenza: boolean; esito: 'favorevole' | 'parziale' | 'sfavorevole' | 'incerto' } {
  const t = String(text || '').toLowerCase();
  const isSentenza = /sentenza|dispositivo|p\.?\s?q\.?\s?m\.?|per questi motivi/.test(t);
  let esito: 'favorevole' | 'parziale' | 'sfavorevole' | 'incerto' = 'incerto';
  if (/accoglie\s+parzialment|parzialment\w*\s+.*accogli|accoglie\s+in\s+parte|in\s+parte\s+il\s+ricorso/.test(t)) esito = 'parziale';
  else if (/accoglie\s+il\s+ricorso|in\s+accoglimento|annulla\s+l['’ ]?atto|dichiara\s+illegittim|accoglie\s+l['’ ]?appello/.test(t)) esito = 'favorevole';
  else if (/rigetta\s+il\s+ricorso|respinge\s+il\s+ricorso|dichiara\s+inammissibil|rigetta\s+l['’ ]?appello|respinge\s+l['’ ]?appello/.test(t)) esito = 'sfavorevole';
  return { isSentenza, esito };
}

/** Importo delle spese/compenso liquidato (dispositivo). Ritorna la stringa italiana (es. "1.500,00")
 *  o null. È un'estrazione: SEMPRE [DA VERIFICARE] dal Dott. Branca. */
export function extractLiquidatedAmount(text: string): string | null {
  const t = String(text || '');
  const ctx = t.match(/(?:spese[\s\S]{0,60}?liquidat[ei][\s\S]{0,40}?|condann[a-z]+[\s\S]{0,80}?pagamento[\s\S]{0,60}?)(?:€|euro|eur)\s*([\d.]+,\d{2})/i);
  if (ctx) return ctx[1];
  const any = t.match(/(?:€|euro|eur)\s*([\d.]+,\d{2})/i);
  return any ? any[1] : null;
}
