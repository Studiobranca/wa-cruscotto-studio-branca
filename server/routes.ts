import { Router, Request, Response } from 'express';
import db from './db.js';
import { sendTextMessage, syncContacts } from './zapi.js';
import { addSSEClient, broadcastEvent, getClientCount } from './sse.js';
import { startPolling, stopPolling, isPollingRunning } from './polling.js';

const router = Router();

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/analytics/overview', (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const totalReceived = (db.prepare(`SELECT COALESCE(SUM(total_received), 0) as val FROM conversations`).get() as any).val;
    const totalSent = (db.prepare(`SELECT COALESCE(SUM(total_sent), 0) as val FROM conversations`).get() as any).val;
    const todayReceived = (db.prepare(`SELECT COUNT(*) as val FROM live_messages WHERE direction='received' AND DATE(created_at) = ?`).get(today) as any).val;
    const unread = (db.prepare(`SELECT COALESCE(SUM(unread_count), 0) as val FROM conversations`).get() as any).val;
    const activeAlerts = (db.prepare(`SELECT COUNT(*) as val FROM conversations WHERE priority IN ('vip', 'high')`).get() as any).val;
    const conversations = (db.prepare(`SELECT COUNT(*) as val FROM conversations WHERE is_archived = 0`).get() as any).val;

    res.json({ totalReceived, totalSent, todayReceived, unread, activeAlerts, conversations });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/today-report', (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = db.prepare(`
      SELECT 
        phone,
        contact_name,
        COUNT(CASE WHEN direction='received' THEN 1 END) as received,
        COUNT(CASE WHEN direction='sent' THEN 1 END) as sent,
        MAX(created_at) as last_activity
      FROM live_messages
      WHERE DATE(created_at) = ?
      GROUP BY phone
      ORDER BY last_activity DESC
      LIMIT 50
    `).all(today);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/weekly', (req: Request, res: Response) => {
  try {
    const rows = db.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(CASE WHEN direction='received' THEN 1 END) as received,
        COUNT(CASE WHEN direction='sent' THEN 1 END) as sent
      FROM live_messages
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all();
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/hourly', (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = db.prepare(`
      SELECT 
        CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as count
      FROM live_messages
      WHERE DATE(created_at) = ? AND direction='received'
      GROUP BY hour
      ORDER BY hour ASC
    `).all(today);
    // Fill all 24 hours
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const found = (rows as any[]).find(r => r.hour === h);
      return { hour: h, count: found ? found.count : 0 };
    });
    res.json(hourly);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Conversations ────────────────────────────────────────────────────────────

router.get('/conversations', (req: Request, res: Response) => {
  try {
    const { archived, search } = req.query;
    let query = `
      SELECT 
        id, phone, contact_name as contactName,
        COALESCE(
          (SELECT content FROM live_messages WHERE phone = conversations.phone ORDER BY created_at DESC LIMIT 1),
          last_message
        ) as lastMessage,
        COALESCE(
          (SELECT created_at FROM live_messages WHERE phone = conversations.phone ORDER BY created_at DESC LIMIT 1),
          last_message_at
        ) as lastMessageAt,
        COALESCE((SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone AND is_read = 0 AND direction = 'received'), unread_count) as unreadCount,
        COALESCE((SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone AND direction = 'received'), total_received) as totalReceived,
        total_sent as totalSent,
        auto_reply_enabled as autoReplyEnabled, auto_reply_message as autoReplyMessage,
        is_archived as isArchived, priority, priority_label as priorityLabel, created_at as createdAt
      FROM conversations
      WHERE is_archived = ?
    `;
    const params: any[] = [archived === '1' ? 1 : 0];

    if (search) {
      query += ` AND (contact_name LIKE ? OR phone LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY 
      CASE priority 
        WHEN 'vip' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'normal' THEN 3 
        ELSE 4 
      END,
      CASE WHEN (SELECT COUNT(*) FROM live_messages lm WHERE lm.phone = conversations.phone) > 0 THEN 0 ELSE 1 END,
      COALESCE(last_message_at, created_at) DESC
    `;

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:phone/messages', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const messages = db.prepare(`
      SELECT 
        id, message_id as messageId, phone, contact_name as contactName,
        content, direction, timestamp, is_read as isRead,
        is_audio as isAudio, audio_url as audioUrl, created_at as createdAt
      FROM live_messages
      WHERE phone = ?
      ORDER BY COALESCE(timestamp, created_at) DESC
      LIMIT ? OFFSET ?
    `).all(phone, parseInt(limit as string), parseInt(offset as string));

    // Mark messages as read
    db.prepare(`UPDATE live_messages SET is_read = 1 WHERE phone = ? AND is_read = 0`).run(phone);
    db.prepare(`UPDATE conversations SET unread_count = 0 WHERE phone = ?`).run(phone);

    res.json(messages.reverse());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:phone/send', async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { message } = req.body;

    if (!message || !phone) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    // Send via Z-API
    const result = await sendTextMessage(phone, message);

    // Save to DB
    const messageId = `sent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO live_messages 
        (message_id, phone, content, direction, timestamp, is_read, created_at)
      VALUES (?, ?, ?, 'sent', ?, 1, ?)
    `).run(messageId, phone, message, now, now);

    // Update conversation
    db.prepare(`
      INSERT INTO conversations (phone, contact_name, last_message, last_message_at, total_sent)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(phone) DO UPDATE SET
        last_message = excluded.last_message,
        last_message_at = excluded.last_message_at,
        total_sent = total_sent + 1
    `).run(phone, phone, message, now);

    broadcastEvent('message', {
      type: 'sent',
      phone,
      message,
      timestamp: now,
    });

    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/conversations/:phone/priority', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { priority, priorityLabel } = req.body;

    db.prepare(`
      UPDATE conversations SET priority = ?, priority_label = ? WHERE phone = ?
    `).run(priority || 'none', priorityLabel || null, phone);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:phone/auto-reply', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { enabled, message } = req.body;

    db.prepare(`
      UPDATE conversations SET auto_reply_enabled = ?, auto_reply_message = ? WHERE phone = ?
    `).run(enabled ? 1 : 0, message || null, phone);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/conversations/:phone/archive', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { archived } = req.body;
    db.prepare(`UPDATE conversations SET is_archived = ? WHERE phone = ?`).run(archived ? 1 : 0, phone);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

router.post('/webhook/message', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    console.log('[Webhook] Received:', JSON.stringify(body).substring(0, 200));

    // Extract fields
    const phone = body.phone || body.sender || '';
    const senderName = body.senderName || body.pushName || '';
    const text = body.text?.message || body.body || body.text || '';
    const momment = body.momment || body.timestamp || Date.now() / 1000;
    const messageId = body.messageId || body.id || `wh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const isGroup = body.isGroup === true || (phone && phone.includes('@g.us'));
    const fromMe = body.fromMe === true;
    const msgType = body.type || 'text';
    const isAudio = msgType === 'audio' || msgType === 'ptt';
    const audioUrl = body.audio?.audioUrl || null;

    // Ignore groups
    if (isGroup || (phone && phone.includes('-'))) {
      return res.json({ ignored: true, reason: 'group' });
    }

    // Ignore if no phone
    if (!phone) {
      return res.json({ ignored: true, reason: 'no phone' });
    }

    const direction = fromMe ? 'sent' : 'received';
    const content = isAudio ? '[Messaggio audio]' : (text || '');
    const timestamp = new Date(momment * 1000).toISOString();
    const now = new Date().toISOString();

    // Save message
    db.prepare(`
      INSERT OR IGNORE INTO live_messages 
        (message_id, phone, contact_name, content, direction, timestamp, is_read, is_audio, audio_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, phone, senderName || phone, content, direction, timestamp, fromMe ? 1 : 0, isAudio ? 1 : 0, audioUrl, now);

    // Upsert conversation
    db.prepare(`
      INSERT INTO conversations (phone, contact_name, last_message, last_message_at, unread_count, total_received, total_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        contact_name = CASE WHEN excluded.contact_name != '' AND excluded.contact_name != excluded.phone THEN excluded.contact_name ELSE contact_name END,
        last_message = excluded.last_message,
        last_message_at = excluded.last_message_at,
        unread_count = CASE WHEN ? = 'received' THEN unread_count + 1 ELSE unread_count END,
        total_received = CASE WHEN ? = 'received' THEN total_received + 1 ELSE total_received END,
        total_sent = CASE WHEN ? = 'sent' THEN total_sent + 1 ELSE total_sent END
    `).run(
      phone, senderName || phone, content, timestamp,
      fromMe ? 0 : 1, fromMe ? 0 : 1, fromMe ? 1 : 0,
      direction, direction, direction
    );

    // Auto-reply
    if (!fromMe) {
      const conv = db.prepare(`SELECT auto_reply_enabled, auto_reply_message FROM conversations WHERE phone = ?`).get(phone) as any;
      if (conv?.auto_reply_enabled && conv?.auto_reply_message) {
        try {
          await sendTextMessage(phone, conv.auto_reply_message);
          const arId = `ar_${Date.now()}`;
          const arNow = new Date().toISOString();
          db.prepare(`
            INSERT OR IGNORE INTO live_messages 
              (message_id, phone, contact_name, content, direction, timestamp, is_read, created_at)
            VALUES (?, ?, ?, ?, 'sent', ?, 1, ?)
          `).run(arId, phone, senderName || phone, conv.auto_reply_message, arNow, arNow);
        } catch (e) {
          console.error('[Auto-reply] Error:', e);
        }
      }
    }

    // Broadcast SSE
    broadcastEvent('message', {
      type: direction,
      phone,
      contactName: senderName || phone,
      content,
      timestamp,
      messageId,
      isAudio,
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error('[Webhook] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/webhook/url', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:5000';
  const protocol = req.get('x-forwarded-proto') || 'http';
  const webhookUrl = `${protocol}://${host}/api/webhook/message`;
  res.json({ url: webhookUrl, webhookUrl });
});

// ─── SSE ──────────────────────────────────────────────────────────────────────

router.get('/events', (req: Request, res: Response) => {
  addSSEClient(res);
});

// ─── Polling ─────────────────────────────────────────────────────────────────

router.post('/polling/start', (req: Request, res: Response) => {
  if (!isPollingRunning()) {
    startPolling(30000);
    res.json({ success: true, message: 'Polling started' });
  } else {
    res.json({ success: true, message: 'Polling already running' });
  }
});

router.post('/polling/stop', (req: Request, res: Response) => {
  stopPolling();
  res.json({ success: true, message: 'Polling stopped' });
});

router.get('/polling/status', (req: Request, res: Response) => {
  res.json({
    running: isPollingRunning(),
    clients: getClientCount(),
  });
});

// ─── Z-API Sync ───────────────────────────────────────────────────────────────

router.post('/zapi/sync-contacts', async (req: Request, res: Response) => {
  try {
    const synced = await syncContacts();
    res.json({ success: true, synced });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get('/settings', (req: Request, res: Response) => {
  try {
    const rows = db.prepare(`SELECT key, value FROM app_settings`).all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings', (req: Request, res: Response) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(key, value);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
