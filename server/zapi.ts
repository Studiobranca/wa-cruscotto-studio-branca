// Z-API Configuration
export const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F439036DDF9C25F4C5C7AE31EDEB32B';
export const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '0AB4EBF088FF1F7AADA158F3';
export const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'F2bcb0c8154e74f3d9ff7b0482f6dd57bS';
export const ZAPI_BASE = process.env.ZAPI_BASE || `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/`;

export const zapiHeaders = {
  'Content-Type': 'application/json',
  'client-token': ZAPI_CLIENT_TOKEN,
};

// ─── GUARDIA anti-hang (rev. 27/07/2026, incidente egress ~20:00) ────────────
// Ogni fetch verso Z-API ha un timeout DURO (AbortSignal.timeout): durante un
// blackout di rete in uscita (connect-timeout ~10s per chiamata) il polling
// contatti ogni 30s accumulava socket appesi e saturava il processo, rendendo
// il server HTTP intermittente (health/UI in timeout). Con il timeout la
// chiamata fallisce in fretta e il ciclo non resta bloccato. Configurabile via
// env ZAPI_TIMEOUT_MS (default 6000).
const ZAPI_TIMEOUT_MS = Number(process.env.ZAPI_TIMEOUT_MS) || 6000;
function zapiSignal(): AbortSignal | undefined {
  try { return AbortSignal.timeout(ZAPI_TIMEOUT_MS); } catch { return undefined; }
}

export async function zapiGet(endpoint: string): Promise<any> {
  const url = `${ZAPI_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: zapiHeaders,
    signal: zapiSignal(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Z-API GET ${endpoint} failed: ${response.status} - ${text}`);
  }
  return response.json();
}

export async function zapiPost(endpoint: string, body: any): Promise<any> {
  const url = `${ZAPI_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: zapiHeaders,
    body: JSON.stringify(body),
    signal: zapiSignal(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Z-API POST ${endpoint} failed: ${response.status} - ${text}`);
  }
  return response.json();
}

export async function zapiPut(endpoint: string, body: any): Promise<any> {
  const url = `${ZAPI_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: zapiHeaders,
    body: JSON.stringify(body),
    signal: zapiSignal(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Z-API PUT ${endpoint} failed: ${response.status} - ${text}`);
  }
  return response.json();
}

// ─── Numero del dispositivo (cache) ──────────────────────────────────────────
// Il numero WhatsApp dell'istanza Z-API. Serve al guard anti-auto-invio sotto.
let _devicePhone: string | null = null;
let _devicePhoneAt = 0;
const DEVICE_PHONE_TTL_MS = 60 * 60 * 1000; // 1h
export async function getDevicePhone(): Promise<string | null> {
  if (_devicePhone && Date.now() - _devicePhoneAt < DEVICE_PHONE_TTL_MS) return _devicePhone;
  try {
    const r = await zapiGet('me');
    const p = String(r?.phone ?? r?.connectedPhone ?? '').replace(/\D/g, '');
    if (p) { _devicePhone = p; _devicePhoneAt = Date.now(); }
    return _devicePhone;
  } catch { return _devicePhone; }
}

// ─── BLINDATURA: invio testo con guard anti-auto-invio a sé stessi ───────────
// Punto di uscita UNICO di ogni messaggio WhatsApp. Blocca STRUTTURALMENTE
// qualsiasi invio al numero STESSO del dispositivo (caso "numero di controllo ==
// numero device": le notifiche di controllo private finirebbero sulla linea dello
// Studio). Indipendente da qualsiasi impostazione del Cruscotto: vale sempre.
export async function sendTextMessage(phone: string, message: string): Promise<any> {
  const target = String(phone || '').replace(/\D/g, '');
  if (!target) { console.error('[ZAPI] Invio bloccato: destinatario vuoto.'); return { skipped: true, reason: 'empty-recipient' }; }
  const dev = await getDevicePhone();
  if (dev && (target === dev || target.endsWith(dev) || dev.endsWith(target))) {
    console.warn(`[ZAPI] 🛡️ Invio BLOCCATO a sé stessi (${target} == device ${dev}). Messaggio NON inviato. Estratto: "${message.slice(0, 80)}"`);
    return { skipped: true, reason: 'self-send-blocked', target };
  }
  return zapiPost('send-text', { phone, message });
}

// ─── Riparazione flusso: (ri)registra il webhook di ricezione su Z-API ───────
export async function getReceivedWebhook(): Promise<string | null> {
  try {
    // Z-API non espone un GET per-tipo dei webhook (GET /webhooks → NOT_FOUND).
    // Lo stato REALE del webhook di ricezione si legge da GET /me →
    // campo `receivedCallbackUrl` (vedi developer.z-api.io/instance/me).
    const r = await zapiGet('me');
    return r?.receivedCallbackUrl ?? null;
  } catch { return null; }
}

export async function setReceivedWebhook(url: string): Promise<boolean> {
  try {
    // 1) Registra l'URL dei messaggi in arrivo (metodo PUT).
    await zapiPut('update-webhook-received', { value: url, notifySentByMe: true });
    // 2) Abilita ESPLICITAMENTE l'inoltro dei messaggi inviati da Mariano stesso
    //    (fromMe). Su Z-API questo flag NON si imposta dal body di
    //    update-webhook-received: serve l'endpoint dedicato update-notify-sent-by-me
    //    (vedi developer.z-api.io/webhooks/update-notify-sent-by-me). Senza, il
    //    Cruscotto non vede le risposte date dal telefono di Mariano (regola #10).
    await zapiPut('update-notify-sent-by-me', { notifySentByMe: true });
    return true;
  } catch (e) {
    console.error('[ZAPI] setReceivedWebhook fallito:', (e as any).message);
    return false;
  }
}

export async function syncContacts(): Promise<number> {
  const { db } = await import('./db.js');
  let page = 1;
  const pageSize = 100;
  let totalSynced = 0;

  const insertConv = db.prepare(`
    INSERT INTO conversations 
      (phone, contact_name, last_message, last_message_at, unread_count, is_group, created_at)
    VALUES 
      (@phone, @contact_name, @last_message, @last_message_at, @unread_count, @is_group, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      contact_name = excluded.contact_name,
      last_message = excluded.last_message,
      last_message_at = excluded.last_message_at,
      unread_count = excluded.unread_count,
      is_group = COALESCE(is_group, excluded.is_group)
  `);

  while (true) {
    try {
      const data = await zapiGet(`chats?page=${page}&pageSize=${pageSize}`);
      const chats = Array.isArray(data) ? data : (data.chats || data.data || []);

      if (!chats || chats.length === 0) break;

      const insertMany = db.transaction((items: any[]) => {
        for (const chat of items) {
          const phone = chat.id || chat.phone || '';
          if (!phone) continue;
          const isGroup = phone.includes('@g.us') || (phone.includes('-') && !phone.match(/^\d+$/));

          let lastMessageAt = new Date().toISOString();
          try {
            if (chat.lastMessageTime && chat.lastMessageTime > 0) {
              const d = new Date(chat.lastMessageTime);
              if (!isNaN(d.getTime())) lastMessageAt = d.toISOString();
            }
          } catch {}


          insertConv.run({
            phone,
            contact_name: chat.name || chat.contactName || chat.pushName || phone,
            last_message: chat.lastMessage || chat.body || '',
            last_message_at: lastMessageAt,
            unread_count: parseInt(chat.messagesUnread || chat.unreadMessages || chat.unread || '0', 10) || 0,
            is_group: isGroup ? 1 : 0,
          });
          totalSynced++;
        }
      });

      insertMany(chats);

      if (chats.length < pageSize) break;
      page++;
    } catch (err) {
      console.error(`[ZAPI] Sync error page ${page}:`, err);
      break;
    }
  }

  console.log(`[ZAPI] Synced ${totalSynced} contacts`);
  return totalSynced;
}
