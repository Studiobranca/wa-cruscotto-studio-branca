import { Router, Request, Response } from 'express';
import db from './db.js';
import { sendTextMessage, syncContacts } from './zapi.js';
import { addSSEClient, broadcastEvent, getClientCount } from './sse.js';
import { startPolling, stopPolling, isPollingRunning } from './polling.js';
import {
  findGoogleContact,
  createGoogleContact,
  createCalendarEvent,
  saveToNotionComunicazioni,
  detectAppointmentRequest,
  getIntegrationLogs,
  getIntegrationStats,
  enqueueEvent,
  getPendingEvents,
  markEventProcessed,
  getQueueStats,
} from './integrations.js';

const router = Router();

// ─── Version ─────────────────────────────────────────────────────────────────
router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: '2.9.1', built: new Date().toISOString() });
});

// ─── Debug ───────────────────────────────────────────────────────────────────
router.get('/debug/laura', (_req: Request, res: Response) => {
  try {
    const lm = db.prepare(`SELECT COUNT(*) as c FROM live_messages WHERE phone = '393713499168'`).get() as any;
    const conv = db.prepare(`SELECT id, phone, total_received, last_message FROM conversations WHERE phone = '393713499168' LIMIT 1`).get() as any;
    const msg = db.prepare(`SELECT content, created_at FROM live_messages WHERE phone = '393713499168' ORDER BY created_at DESC LIMIT 1`).get() as any;
    res.json({ live_messages_count: lm.c, conversation: conv, last_live_msg: msg });
  } catch(e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/analytics/overview', (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const totalReceived = (db.prepare(`SELECT COUNT(*) as val FROM live_messages WHERE direction='received'`).get() as any).val;
    const totalSent = (db.prepare(`SELECT COUNT(*) as val FROM live_messages WHERE direction='sent'`).get() as any).val;
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
        AND phone NOT LIKE '%@newsletter%'
        AND phone NOT LIKE '%120363%'
        AND phone != '393457050479'
        AND length(phone) >= 8
      GROUP BY phone
      ORDER BY last_activity DESC
      LIMIT 50
    `).all(today);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Daily Email Report ───────────────────────────────────────────────────────
router.get('/analytics/daily-email-report', (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // Messaggi di oggi con dettaglio per ogni contatto
    const contacts = db.prepare(`
      SELECT 
        lm.phone,
        lm.contact_name,
        COUNT(CASE WHEN lm.direction='received' THEN 1 END) as received,
        COUNT(CASE WHEN lm.direction='sent' THEN 1 END) as sent,
        MAX(lm.created_at) as last_activity
      FROM live_messages lm
      WHERE DATE(lm.created_at) = ?
        AND lm.phone NOT LIKE '%@newsletter%'
        AND lm.phone NOT LIKE '%120363%'
        AND lm.phone != '393457050479'
        AND length(lm.phone) >= 8
      GROUP BY lm.phone
      ORDER BY last_activity DESC
    `).all(today) as any[];

    // Per ogni contatto, recupera i messaggi completi di oggi
    const result = contacts.map((c: any) => {
      const messages = db.prepare(`
        SELECT content, direction, created_at, is_audio, is_image, original_content
        FROM live_messages
        WHERE phone = ? AND DATE(created_at) = ?
        ORDER BY created_at ASC
      `).all(c.phone, today) as any[];

      const received = messages.filter((m: any) => m.direction === 'received');
      const replied = messages.some((m: any) => m.direction === 'sent');

      return {
        phone: c.phone,
        contactName: c.contact_name || c.phone,
        received: c.received,
        sent: c.sent,
        lastActivity: c.last_activity,
        replied,
        messages: received.map((m: any) => ({
          content: m.content,
          time: m.created_at,
          isAudio: m.is_audio === 1,
          isImage: m.is_image === 1,
          originalContent: m.original_content,
        })),
      };
    });

    res.json(result);
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
        COALESCE(is_group, 0) as isGroup,
        CASE 
          WHEN (SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone) > 0
          THEN (SELECT content FROM live_messages WHERE phone = conversations.phone ORDER BY created_at DESC LIMIT 1)
          ELSE NULLIF(last_message, '')
        END as lastMessage,
        CASE 
          WHEN (SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone) > 0
          THEN (SELECT created_at FROM live_messages WHERE phone = conversations.phone ORDER BY created_at DESC LIMIT 1)
          ELSE last_message_at
        END as lastMessageAt,
        (SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone AND is_read = 0 AND direction = 'received') + unread_count as unreadCount,
        (SELECT COUNT(*) FROM live_messages WHERE phone = conversations.phone AND direction = 'received') + total_received as totalReceived,
        total_sent as totalSent,
        auto_reply_enabled as autoReplyEnabled, auto_reply_message as autoReplyMessage,
        is_archived as isArchived, priority, priority_label as priorityLabel, created_at as createdAt
      FROM conversations
      WHERE is_archived = ?
      AND phone NOT LIKE '%@newsletter%'
      AND phone NOT LIKE '%120363%'
      AND length(phone) >= 8
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
      MAX(
        COALESCE((SELECT created_at FROM live_messages WHERE phone = conversations.phone ORDER BY created_at DESC LIMIT 1), '1970-01-01'),
        COALESCE(last_message_at, '1970-01-01')
      ) DESC
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
        is_audio as isAudio, audio_url as audioUrl,
        is_image as isImage, image_url as imageUrl, caption,
        original_content as originalContent, detected_language as detectedLanguage,
        created_at as createdAt
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

// Log globale messaggi (ricevuti + inviati) per l'agenda del cruscotto.
// GET /api/messages/log?from=YYYY-MM-DD&to=YYYY-MM-DD (date locali Europe/Rome non gestite
// qui: il client converte i timestamp UTC; il filtro server usa un margine di 1 giorno).
router.get('/messages/log', (req: Request, res: Response) => {
  try {
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from/to richiesti in formato YYYY-MM-DD' });
    }
    const rows = db.prepare(`
      SELECT phone, contact_name as contactName, content, direction,
             COALESCE(timestamp, created_at) as timestamp,
             is_audio as isAudio
      FROM live_messages
      WHERE date(COALESCE(timestamp, created_at)) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
      ORDER BY COALESCE(timestamp, created_at)
      LIMIT 5000
    `).all(from, to);
    res.json(rows);
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
    const msgType = (body.type || '').toLowerCase();
    // Riconoscimento audio: tipo OPPURE presenza del campo body.audio
    const audioUrl = body.audio?.audioUrl || body.audio?.url || body.audio?.mediaUrl || null;
    const isAudio = msgType === 'audio' || msgType === 'ptt' || msgType === 'audiomessage' || !!audioUrl;
    // Riconoscimento immagine: tipo OPPURE presenza del campo body.image
    const imageUrl = body.image?.imageUrl || body.image?.url || body.image?.mediaUrl || body.imageUrl || null;
    const isImage = msgType === 'image' || msgType === 'imagemessage' || !!imageUrl;
    const caption = body.image?.caption || body.caption || '';
    console.log(`[Webhook] type=${msgType} isAudio=${isAudio} isImage=${isImage} audioUrl=${audioUrl?.substring(0,60)} imageUrl=${imageUrl?.substring(0,60)} body.keys=${Object.keys(body).join(',')}`);

    // Ignora solo newsletter
    if (phone && phone.includes('@newsletter')) {
      return res.json({ ignored: true, reason: 'newsletter' });
    }
    // I numeri con '-' sono vecchio formato gruppi Z-API (non @g.us), gestiti come gruppi
    const isLegacyGroup = phone && phone.includes('-') && !phone.includes('@g.us');

    // Ignore if no phone
    if (!phone) {
      return res.json({ ignored: true, reason: 'no phone' });
    }

    const direction = fromMe ? 'sent' : 'received';
    let content: string;
    if (isImage) content = caption ? `[Immagine: ${caption}]` : '[Immagine]';
    else if (isAudio) content = '[Messaggio vocale 🎤]';
    else content = text || '';

    // Trascrizione Deepgram (richiede DEEPGRAM_API_KEY env var)
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (isAudio && audioUrl && deepgramKey) {
      try {
        // Scarica audio
        const audioResp = await fetch(audioUrl);
        const audioBuffer = await audioResp.arrayBuffer();
        // Invia a Deepgram nova-2 forzando l'italiano: detect_language sbagliava
        // sui vocali brevi/rumorosi e produceva trascrizioni in inglese
        const dgResp = await fetch(
          'https://api.deepgram.com/v1/listen?model=nova-2&language=it&punctuate=true&smart_format=true',
          {
            method: 'POST',
            headers: {
              'Authorization': `Token ${deepgramKey}`,
              'Content-Type': 'audio/ogg; codecs=opus',
            },
            body: audioBuffer,
          }
        );
        if (dgResp.ok) {
          const dgData = await dgResp.json() as any;
          const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
          if (transcript) {
            content = `🎤 ${transcript}`;
            console.log(`[Deepgram] Trascritto: ${transcript.substring(0, 80)}`);
          } else {
            console.log('[Deepgram] Audio ricevuto ma trascrizione vuota (silenzio o rumore)');
          }
        } else {
          const errText = await dgResp.text();
          console.error('[Deepgram] Errore API:', dgResp.status, errText.substring(0, 100));
        }
      } catch (e) {
        console.error('[Deepgram] Error:', e);
      }
    }

    // Traduzione automatica in italiano (solo messaggi ricevuti con testo)
    let originalContent: string | null = null;
    let detectedLanguage: string | null = null;
    const textToTranslate = !isImage && !isAudio && content && content.trim().length > 2 && !fromMe ? content : null;
    if (textToTranslate) {
      try {
        const tmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=autodetect|it&de=studiobranca.mariano@gmail.com`;
        const tmResp = await fetch(tmUrl);
        if (tmResp.ok) {
          const tmData = await tmResp.json() as any;
          const translated = tmData?.responseData?.translatedText?.trim();
          const status = tmData?.responseStatus;
          // 403 o 'PLEASE SELECT TWO DISTINCT LANGUAGES' = già italiano
          if (status === 200 && translated && !translated.includes('PLEASE SELECT')) {
            // Verifica che la traduzione sia diversa dall'originale
            if (translated.toLowerCase() !== textToTranslate.toLowerCase()) {
              originalContent = textToTranslate;
              detectedLanguage = 'auto';
              content = `${translated}\n\n_(Originale: ${textToTranslate})_`;
              console.log(`[Translator] Tradotto: '${textToTranslate.substring(0,40)}' → '${translated.substring(0,40)}'`);
            }
          }
        }
      } catch (e) {
        console.error('[Translator] Error:', e);
      }
    }

    const timestamp = new Date(momment * 1000).toISOString();
    const now = new Date().toISOString();

    // Save message
    const groupName = isGroup ? (body.groupName || body.name || phone) : null;
    const effectiveSenderName = isGroup ? (senderName || body.participantPhone || phone) : (senderName || phone);
    db.prepare(`
      INSERT OR IGNORE INTO live_messages 
        (message_id, phone, contact_name, content, direction, timestamp, is_read, is_audio, audio_url, is_image, image_url, caption, original_content, detected_language, is_group, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, phone, groupName || effectiveSenderName, content, direction, timestamp, fromMe ? 1 : 0, isAudio ? 1 : 0, audioUrl, isImage ? 1 : 0, imageUrl, caption || null, originalContent, detectedLanguage, isGroup ? 1 : 0, effectiveSenderName, now);

    // Upsert conversation
    const convName = isGroup ? (body.groupName || body.name || phone) : (senderName || phone);
    db.prepare(`
      INSERT INTO conversations (phone, contact_name, last_message, last_message_at, unread_count, total_received, total_sent, is_group)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        contact_name = CASE WHEN excluded.contact_name != '' AND excluded.contact_name != excluded.phone THEN excluded.contact_name ELSE contact_name END,
        last_message = excluded.last_message,
        last_message_at = excluded.last_message_at,
        unread_count = CASE WHEN ? = 'received' THEN unread_count + 1 ELSE unread_count END,
        total_received = CASE WHEN ? = 'received' THEN total_received + 1 ELSE total_received END,
        total_sent = CASE WHEN ? = 'sent' THEN total_sent + 1 ELSE total_sent END,
        is_group = COALESCE(is_group, excluded.is_group)
    `).run(
      phone, convName, content, timestamp,
      fromMe ? 0 : 1, fromMe ? 0 : 1, fromMe ? 1 : 0, isGroup ? 1 : 0,
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

    // Broadcast SSE — includi priority per suono VIP nel frontend
    const convForSSE = db.prepare(`SELECT priority FROM conversations WHERE phone = ?`).get(phone) as any;
    broadcastEvent('message', {
      type: direction,
      phone,
      contactName: senderName || phone,
      content,
      timestamp,
      messageId,
      isAudio,
      priority: convForSSE?.priority || 'none',
    });

    // ─── INTEGRAZIONI AUTOMATICHE (async, non bloccante) ────────────────────
    if (!fromMe && !isGroup && content && content.trim().length > 2) {
      setImmediate(async () => {
        try {
          const intEnabled = db.prepare(`SELECT value FROM app_settings WHERE key = 'integrations_enabled'`).get() as any;
          if (intEnabled?.value === '0') return;

          const existingConv = db.prepare(`SELECT contact_name, priority FROM conversations WHERE phone = ?`).get(phone) as any;
          const isUnknown = !existingConv?.contact_name || existingConv.contact_name === phone;
          const cName = existingConv?.contact_name || senderName || phone;
          const googleOK = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);
          const notionOK = !!process.env.NOTION_API_KEY;

          // 1. Google Contacts: risolvi nome contatti sconosciuti
          if (isUnknown) {
            if (googleOK) {
              const gName = await findGoogleContact(phone);
              if (gName) {
                db.prepare(`UPDATE conversations SET contact_name = ? WHERE phone = ?`).run(gName, phone);
                console.log(`[Int] Contatto da Google Contacts: ${gName}`);
              }
            } else {
              enqueueEvent('google_contacts_lookup', { phone, senderName });
            }
          }

          // 2. Rilevamento appuntamento → Google Calendar
          const calOn = db.prepare(`SELECT value FROM app_settings WHERE key = 'integration_calendar'`).get() as any;
          if (calOn?.value === '1' && detectAppointmentRequest(content)) {
            if (googleOK) {
              const s = new Date(Date.now() + 86400000); s.setHours(10,0,0,0);
              const e = new Date(s.getTime() + 3600000);
              await createCalendarEvent({
                title: `📱 Richiesta appuntamento — ${cName}`,
                description: `Da ${cName} (${phone}):\n\n"${content.substring(0,500)}"\n\nDa confermare.`,
                startDate: s.toISOString(), endDate: e.toISOString(),
              });
            } else {
              enqueueEvent('calendar_appointment', { phone, contactName: cName, content: content.substring(0,500), timestamp });
            }
          }

          // 3. Notion: messaggi fiscali o VIP
          const notionOn = db.prepare(`SELECT value FROM app_settings WHERE key = 'integration_notion'`).get() as any;
          if (notionOn?.value === '1') {
            const FK = ['730','dichiarazione','iva','irpef','unico','scadenza','fattura','detra','bonus','f24','agenzia entrate'];
            const isFiscal = FK.some(kw => content.toLowerCase().includes(kw));
            const isVIP = existingConv?.priority === 'high';
            if (isVIP || isFiscal) {
              const today = new Date().toISOString().split('T')[0];
              if (notionOK) {
                await saveToNotionComunicazioni({
                  oggetto: `WA da ${cName} — ${isFiscal ? 'Argomento fiscale' : 'Contatto VIP'}`,
                  estratto: content.substring(0,500), canale: 'WhatsApp',
                  direzione: 'Ricevuto', data: today, stato: 'Da rispondere',
                  note: `Telefono: ${phone}`,
                });
              } else {
                enqueueEvent('notion_comunicazione', { phone, contactName: cName, content: content.substring(0,500), isFiscal, isVIP, date: today });
              }
            }
          }
        } catch (intErr: any) {
          console.error('[Int] Error:', intErr.message);
        }
      });
    }
    // ────────────────────────────────────────────────────────────────────────

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

// ─── Riepilogo Richieste ─────────────────────────────────────────────────────
// Identifica messaggi-richiesta ricevuti e verifica se sono stati evasi
router.get('/conversations/:phone/requests', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;

    // Recupera tutti i messaggi del contatto in ordine cronologico
    const messages = db.prepare(`
      SELECT id, content, direction, timestamp, created_at, is_audio, is_image
      FROM live_messages
      WHERE phone = ?
      ORDER BY COALESCE(timestamp, created_at) ASC
    `).all(phone) as any[];

    // Pattern per rilevare richieste in italiano e non
    const requestPatterns = [
      /\?/,                                                              // qualsiasi domanda
      /\b(puoi|potresti|potete|potreste|riesci|riesce)\b/i,
      /\b(ho bisogno|avrei bisogno|mi serve|mi servirebbe|mi servono)\b/i,
      /\b(vorrei|voglio|desidero|avrei|avere|avrei)\b/i,
      /\b(quando|dove|come|quanto|quante|quanti|quale|quali|chi|perché|perche)\b/i,
      /\b(appuntamento|prenotare|prenotazione|disponibil|orario|info|informazioni|preventivo|preventivo|offerta|sconto)\b/i,
      /\b(mandami|mandatemi|inviatemi|spedisci|spedite|inviami|invia)\b/i,
      /\b(can you|could you|please|i need|do you|is it|are you|when|how much|how many|available)\b/i,
    ];

    const isRequest = (content: string): boolean => {
      if (!content || content.startsWith('[') || content.startsWith('🎤')) return false;
      return requestPatterns.some(p => p.test(content));
    };

    // Estrai parole chiave rilevanti dal testo (escludi stopwords)
    const stopwords = new Set(['il','lo','la','i','gli','le','un','una','uno','di','da','in','con','su','per','tra','fra','e','o','ma','se','che','non','ho','ha','hai','mi','ti','si','ci','vi','a','è','ai','al','del','della','dei','degli','delle','nel','nella','nei','negli','nelle','sul','sulla','sui','sugli','sulle','col','coi','qual','quale','quali','come','when','the','and','for','you','are','can','not','with','this','that','have','has']);
    const extractKeywords = (content: string): string[] => {
      return content
        .toLowerCase()
        .replace(/[^a-zà-ùA-ZÀ-Ù0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopwords.has(w))
        .slice(0, 6);
    };

    // Costruisci lista richieste con evasione
    const requests: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.direction !== 'received') continue;
      if (!isRequest(msg.content)) continue;

      // Cerca la prima risposta inviata DOPO questo messaggio (entro 72h)
      const msgTime = new Date(msg.timestamp || msg.created_at).getTime();
      const deadline = msgTime + 72 * 60 * 60 * 1000;
      const reply = messages.find((m, j) =>
        j > i &&
        m.direction === 'sent' &&
        new Date(m.timestamp || m.created_at).getTime() <= deadline
      );

      // Cerca richieste identiche/simili in precedenza (stesso contatto)
      const keywords = extractKeywords(msg.content);
      const previousSimilar = requests.filter(r => {
        const overlap = r.keywords.filter((k: string) => keywords.includes(k)).length;
        return overlap >= 2;
      });

      requests.push({
        id: msg.id,
        content: msg.content,
        timestamp: msg.timestamp || msg.created_at,
        keywords,
        evaded: !!reply,
        reply: reply ? {
          content: reply.content,
          timestamp: reply.timestamp || reply.created_at,
          delayMinutes: Math.round((new Date(reply.timestamp || reply.created_at).getTime() - msgTime) / 60000),
        } : null,
        repeated: previousSimilar.length > 0,
        repeatCount: previousSimilar.length,
        previousOccurrences: previousSimilar.map((r: any) => ({
          timestamp: r.timestamp,
          evaded: r.evaded,
          replyTimestamp: r.reply?.timestamp || null,
        })),
      });
    }

    // Raggruppa per argomento (cluster di keyword)
    const topics: Record<string, any[]> = {};
    for (const r of requests) {
      const topicKey = r.keywords.slice(0, 2).join('-') || 'varie';
      if (!topics[topicKey]) topics[topicKey] = [];
      topics[topicKey].push(r);
    }

    const topicsList = Object.entries(topics).map(([key, items]) => ({
      topic: key.replace(/-/g, ' '),
      count: items.length,
      evadedCount: items.filter(r => r.evaded).length,
      pendingCount: items.filter(r => !r.evaded).length,
      requests: items,
    })).sort((a, b) => b.count - a.count);

    res.json({
      phone,
      totalRequests: requests.length,
      evaded: requests.filter(r => r.evaded).length,
      pending: requests.filter(r => !r.evaded).length,
      repeated: requests.filter(r => r.repeated).length,
      topics: topicsList,
      requests,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

// ─── INTEGRAZIONI ───────────────────────────────────────────────────────────

// Stato e log integrazioni
router.get('/integrations/status', (_req: Request, res: Response) => {
  try {
    const stats = getIntegrationStats();
    const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);
    const notionConfigured = !!process.env.NOTION_API_KEY;

    // Leggi toggle dal db settings
    const calEnabled = (db.prepare(`SELECT value FROM app_settings WHERE key = 'integration_calendar'`).get() as any)?.value === '1';
    const notionEnabled = (db.prepare(`SELECT value FROM app_settings WHERE key = 'integration_notion'`).get() as any)?.value === '1';
    const intEnabled = (db.prepare(`SELECT value FROM app_settings WHERE key = 'integrations_enabled'`).get() as any)?.value !== '0';

    const qStats = getQueueStats();
    const pendingCount = (qStats as any[]).find((r: any) => r.status === 'pending')?.count || 0;

    res.json({
      integrations_enabled: intEnabled,
      google_contacts: { configured: googleConfigured, enabled: intEnabled },
      google_calendar: { configured: googleConfigured, enabled: calEnabled },
      notion: { configured: notionConfigured, enabled: notionEnabled },
      queue_pending: pendingCount,
      stats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Log integrazioni
router.get('/integrations/logs', (_req: Request, res: Response) => {
  try {
    const limit = 100;
    const logs = getIntegrationLogs(limit);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle integrazione specifica
router.post('/integrations/toggle', (req: Request, res: Response) => {
  try {
    const { key, value } = req.body;
    const allowed = ['integrations_enabled', 'integration_calendar', 'integration_notion'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Key non valida' });
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(key, value ? '1' : '0');
    res.json({ success: true, key, value });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Crea contatto Google manualmente
router.post('/integrations/google-contacts/create', async (req: Request, res: Response) => {
  try {
    const { phone, name, note } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const result = await createGoogleContact({ phone, name, note });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Crea evento calendario manualmente
router.post('/integrations/calendar/create', async (req: Request, res: Response) => {
  try {
    const { title, description, startDate, endDate } = req.body;
    if (!title || !startDate || !endDate) {
      return res.status(400).json({ error: 'title, startDate, endDate obbligatori' });
    }
    const result = await createCalendarEvent({ title, description: description || '', startDate, endDate });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Salva messaggio in Notion manualmente
router.post('/integrations/notion/save', async (req: Request, res: Response) => {
  try {
    const { oggetto, estratto, canale, direzione, data, stato, note } = req.body;
    if (!oggetto) return res.status(400).json({ error: 'oggetto is required' });
    const result = await saveToNotionComunicazioni({
      oggetto,
      estratto: estratto || '',
      canale: canale || 'WhatsApp',
      direzione: direzione || 'Ricevuto',
      data: data || new Date().toISOString().split('T')[0],
      stato: stato || 'Da rispondere',
      note,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Leggi coda eventi pending (per cron Perplexity)
router.get('/integrations/queue', (_req: Request, res: Response) => {
  try {
    const events = getPendingEvents(100);
    const stats = getQueueStats();
    res.json({ events, stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Segna evento come processato (chiamato da cron Perplexity)
router.post('/integrations/queue/:id/done', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { success, error } = req.body;
    markEventProcessed(id, success !== false, error);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Admin: pulizia contatti test/fittizi ────────────────────────────────────────────
router.post('/admin/cleanup-test-data', (req: Request, res: Response) => {
  try {
    // Rimuovi messaggi e conversazioni da numeri fittizi usati nei test
    const testPhones = ['393001234567', '393001234568', '393001234569'];
    let deleted = 0;
    for (const phone of testPhones) {
      const r1 = db.prepare(`DELETE FROM live_messages WHERE phone = ?`).run(phone);
      const r2 = db.prepare(`DELETE FROM conversations WHERE phone = ?`).run(phone);
      deleted += r1.changes + r2.changes;
    }
    // Rimuovi anche conversazioni newsletter rimaste
    const r3 = db.prepare(`DELETE FROM conversations WHERE phone LIKE '%120363%'`).run();
    const r4 = db.prepare(`DELETE FROM live_messages WHERE phone LIKE '%120363%'`).run();
    deleted += r3.changes + r4.changes;
    res.json({ success: true, deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
