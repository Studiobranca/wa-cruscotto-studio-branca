// Z-API Configuration
export const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F439036DDF9C25F4C5C7AE31EDEB32B';
export const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '0AB4EBF088FF1F7AADA158F3';
export const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'F2bcb0c8154e74f3d9ff7b0482f6dd57bS';
export const ZAPI_BASE = process.env.ZAPI_BASE || `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/`;

export const zapiHeaders = {
  'Content-Type': 'application/json',
  'client-token': ZAPI_CLIENT_TOKEN,
};

export async function zapiGet(endpoint: string): Promise<any> {
  const url = `${ZAPI_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: zapiHeaders,
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
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Z-API POST ${endpoint} failed: ${response.status} - ${text}`);
  }
  return response.json();
}

export async function sendTextMessage(phone: string, message: string): Promise<any> {
  return zapiPost('send-text', { phone, message });
}

// ─── Riparazione flusso: (ri)registra il webhook di ricezione su Z-API ───────
export async function getReceivedWebhook(): Promise<string | null> {
  try {
    const r = await zapiGet('webhooks');
    return r?.value ?? r?.delivery ?? r?.received ?? null;
  } catch { return null; }
}

export async function setReceivedWebhook(url: string): Promise<boolean> {
  try {
    // Z-API: aggiorna l'URL su cui vengono inoltrati i messaggi in arrivo.
    await zapiPost('update-webhook-received', { value: url });
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
