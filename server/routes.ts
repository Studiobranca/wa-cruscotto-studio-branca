import { Router, Request, Response } from 'express';
import db from './db.js';
import { getAvailability, formatAvailabilityIT, isSlotBusy } from './appointments.js';
import { sendTextMessage, syncContacts, zapiGet, getReceivedWebhook } from './zapi.js';
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
import {
  generateDraft,
  saveDraft,
  getPendingDrafts,
  getDraft,
  markDraftSent,
  markDraftRejected,
  isBotEnabled,
  getBotModel,
  setSetting as setBotSetting,
  recordClassification,
  getControlNumber,
  getNotifyMode,
  shouldNotifyControl,
  notifyDraftToControl,
  handleControlCommand,
  approveDraftCore,
  isAutoSendEnabled,
  isAutoAppointmentsEnabled,
  waCommandsEnabled,
  getPendingAppointments,
  getAppointmentById,
  confirmAppointmentRow,
  cancelAppointmentRow,
  courtesySentToday,
  markCourtesySent,
  notifyUrgentByEmail,
} from './chatbot.js';
import { runDailyDigest, getFlowHealth, repairWebhook, runSelfCheck, getLastSelfCheck } from './maintenance.js';

const router = Router();

// ─── Riparazione one-shot timestamp corrotti ─────────────────────────────────
// Il vecchio webhook moltiplicava per 1000 un momment già in ms → anni a 6 cifre
// (es. "+058413-06-24..."). Ricalcola il valore originale dividendo per 1000.
try {
  const bad = db.prepare(`SELECT id, timestamp FROM live_messages WHERE timestamp LIKE '+%'`).all() as any[];
  let fixed = 0;
  for (const r of bad) {
    const ms = Date.parse(r.timestamp);
    if (!isNaN(ms) && ms > 1e15) {
      db.prepare(`UPDATE live_messages SET timestamp = ? WHERE id = ?`).run(new Date(ms / 1000).toISOString(), r.id);
      fixed++;
    }
  }
  if (fixed) console.log(`[Repair] Corretti ${fixed} timestamp corrotti in live_messages`);
} catch (e) {
  console.error('[Repair] Errore riparazione timestamp:', e);
}

// ─── Version ─────────────────────────────────────────────────────────────────
router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: '2.9.13', built: new Date().toISOString() });
});

// ─── Autocheck (self-test + autocorrezione) ──────────────────────────────────
router.get('/selftest', (_req: Request, res: Response) => {
  res.json(getLastSelfCheck() || { note: 'mai eseguito' });
});
router.post('/selftest', async (_req: Request, res: Response) => {
  try { res.json(await runSelfCheck()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Posta in arrivo (IMAP, sola lettura) ────────────────────────────────────
// Import LAZY del modulo email: imapflow resta fuori dal percorso di caricamento
// critico; se manca o fallisce, queste rotte rispondono errore ma il resto vive.
router.get('/emails', async (req: Request, res: Response) => {
  try {
    const m = await import('./email.js');
    const limit = parseInt(String(req.query.limit || '100'), 10) || 100;
    const category = req.query.category ? String(req.query.category) : undefined;
    res.json({ emails: m.getRecentEmails(limit, category) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get('/emails/status', async (_req: Request, res: Response) => {
  try {
    const m = await import('./email.js');
    res.json(m.getEmailStatus());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post('/emails/:id/seen', async (req: Request, res: Response) => {
  try {
    const m = await import('./email.js');
    m.markEmailSeen(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// ─── Rubrica contatti (clienti / fornitori / ignorati) ───────────────────────
// Fonte di verità per la classificazione email; collega in automatico un numero
// WhatsApp per raffronto (nome) quando un contatto viene marcato cliente/fornitore.
router.get('/contacts', async (req: Request, res: Response) => {
  try {
    const c = await import('./contacts.js');
    const type = req.query.type ? String(req.query.type) as any : undefined;
    res.json({ contacts: c.listContacts(type) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// Aggiunta manuale (es. un intero dominio "@fornitoreX.it" come fornitore, senza
// dover aspettare che arrivi un'email da smistare).
router.post('/contacts', async (req: Request, res: Response) => {
  try {
    const c = await import('./contacts.js');
    const { value, name, type } = req.body || {};
    if (!value) return res.status(400).json({ error: 'value richiesto' });
    const t = type === 'fornitore' || type === 'ignorato' ? type : 'cliente';
    c.setContactType(String(value), name ? String(name) : undefined, t);
    res.json({ ok: true, contacts: c.listContacts() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get('/contacts/:value/profile', async (req: Request, res: Response) => {
  try {
    const c = await import('./contacts.js');
    const profile = c.getContactProfile(decodeURIComponent(req.params.value));
    if (!profile) return res.status(404).json({ error: 'contatto non trovato' });
    res.json(profile);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.patch('/contacts/:value', async (req: Request, res: Response) => {
  try {
    const c = await import('./contacts.js');
    const { phone } = req.body || {};
    c.setContactPhone(decodeURIComponent(req.params.value), phone ? String(phone) : null);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete('/contacts/:value', async (req: Request, res: Response) => {
  try { const c = await import('./contacts.js'); c.removeContact(decodeURIComponent(req.params.value)); res.json({ ok: true, contacts: c.listContacts() }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
// Alias compatibili con la UI email esistente (whitelist clienti / blacklist ignorati).
router.get('/emails/clients', async (_req: Request, res: Response) => {
  try { const c = await import('./contacts.js'); res.json({ clients: c.listContacts('cliente') }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get('/emails/fornitori', async (_req: Request, res: Response) => {
  try { const c = await import('./contacts.js'); res.json({ fornitori: c.listContacts('fornitore') }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get('/emails/ignored', async (_req: Request, res: Response) => {
  try { const c = await import('./contacts.js'); res.json({ ignored: c.listContacts('ignorato') }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
// Segna una email (e il suo mittente) come cliente / fornitore / non-cliente:
// aggiorna la rubrica (con raffronto WhatsApp) e riclassifica le email di quel mittente.
router.post('/emails/:id/mark-client', async (req: Request, res: Response) => {
  try { const m = await import('./email.js'); res.json({ ok: m.markEmailAsClient(parseInt(req.params.id, 10)) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post('/emails/:id/mark-fornitore', async (req: Request, res: Response) => {
  try { const m = await import('./email.js'); res.json({ ok: m.markEmailAsFornitore(parseInt(req.params.id, 10)) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post('/emails/:id/mark-not-client', async (req: Request, res: Response) => {
  try { const m = await import('./email.js'); res.json({ ok: m.markEmailAsNotClient(parseInt(req.params.id, 10)) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
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

// ─── Appuntamenti: disponibilità da Google Calendar + regole studio ──────────
// Regole: lun–ven 9–13; pomeriggio 15–18 solo lun/mar/gio (NO mer e ven pom.);
// esclusi sabato, domenica, feste comandate e chiusura 10/07–20/08.
router.get('/appointments/availability', async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(String(req.query.days || '14')) || 14, 60);
    const { slots, calendarChecked } = await getAvailability(days);
    if (String(req.query.format) === 'text') {
      res.json({ text: formatAvailabilityIT(slots), calendarChecked, count: slots.length });
    } else {
      res.json({ slots, calendarChecked, count: slots.length });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Automazioni: regole keyword ─────────────────────────────────────────────
router.get('/rules', (_req: Request, res: Response) => {
  try {
    res.json(db.prepare(`
      SELECT id, name, keyword, reply_text as replyText, is_global as isGlobal,
             specific_phone as specificPhone, enabled, trigger_count as triggerCount
      FROM auto_reply_rules ORDER BY id
    `).all());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/rules', (req: Request, res: Response) => {
  try {
    const { name, keyword, replyText, isGlobal = true, specificPhone = null, enabled = true } = req.body;
    if (!name || !keyword || !replyText) return res.status(400).json({ error: 'name, keyword e replyText obbligatori' });
    const r = db.prepare(`
      INSERT INTO auto_reply_rules (name, keyword, reply_text, is_global, specific_phone, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, keyword, replyText, isGlobal ? 1 : 0, specificPhone || null, enabled ? 1 : 0);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/rules/:id', (req: Request, res: Response) => {
  try {
    const { name, keyword, replyText, isGlobal, specificPhone, enabled } = req.body;
    db.prepare(`
      UPDATE auto_reply_rules SET name = ?, keyword = ?, reply_text = ?, is_global = ?, specific_phone = ?, enabled = ?
      WHERE id = ?
    `).run(name, keyword, replyText, isGlobal ? 1 : 0, specificPhone || null, enabled ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/rules/:id', (req: Request, res: Response) => {
  try {
    db.prepare(`DELETE FROM auto_reply_rules WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Automazioni: risposte rapide (template) ─────────────────────────────────
router.get('/quick-replies', (_req: Request, res: Response) => {
  try {
    res.json(db.prepare(`SELECT id, label, text, shortcut FROM quick_replies ORDER BY id`).all());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/quick-replies', (req: Request, res: Response) => {
  try {
    const { label, text, shortcut = null } = req.body;
    if (!label || !text) return res.status(400).json({ error: 'label e text obbligatori' });
    const r = db.prepare(`INSERT INTO quick_replies (label, text, shortcut) VALUES (?, ?, ?)`).run(label, text, shortcut || null);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/quick-replies/:id', (req: Request, res: Response) => {
  try {
    db.prepare(`DELETE FROM quick_replies WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
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

// ─── Eliminazione DEFINITIVA (non è un semplice "archivia") ──────────────────────
// Rimuove i dati dalla banca dati del cruscotto in modo permanente e non reversibile.
// NB: NON ritira il messaggio da WhatsApp/Z-API né dal telefono del destinatario:
// pulisce solo ciò che è memorizzato qui (inbox/dashboard).

// Elimina un singolo messaggio per id.
router.delete('/messages/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
    const row = db.prepare(`SELECT phone FROM live_messages WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: 'Messaggio non trovato' });
    const r = db.prepare(`DELETE FROM live_messages WHERE id = ?`).run(id);
    // I contatori della lista conversazioni sono ricalcolati dinamicamente dai
    // live_messages, quindi non serve correggerli a mano.
    broadcastEvent('sync', { action: 'message-deleted', id, phone: row.phone, timestamp: new Date().toISOString() });
    res.json({ success: true, deleted: r.changes, phone: row.phone });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Elimina un'intera conversazione: tutti i suoi messaggi + la riga conversazione.
router.delete('/conversations/:phone', (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: 'phone richiesto' });
    const r1 = db.prepare(`DELETE FROM live_messages WHERE phone = ?`).run(phone);
    const r2 = db.prepare(`DELETE FROM conversations WHERE phone = ?`).run(phone);
    broadcastEvent('sync', { action: 'conversation-deleted', phone, timestamp: new Date().toISOString() });
    res.json({ success: true, deletedMessages: r1.changes, deletedConversation: r2.changes });
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
    // Z-API manda `momment` in MILLISECONDI; vecchi payload/fallback in secondi.
    // Normalizza a ms: valori > 1e12 sono già ms, altrimenti secondi.
    const mommentRaw = body.momment || body.timestamp || Date.now();
    const momment = mommentRaw > 1e12 ? mommentRaw : mommentRaw * 1000;
    const messageId = body.messageId || body.id || `wh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const isGroup = body.isGroup === true || (phone && phone.includes('@g.us'));
    const fromMe = body.fromMe === true;
    // Il NUMERO DI CONTROLLO (es. con AI auto-risposta) è solo un canale di notifica:
    // i suoi messaggi in arrivo NON vanno trattati come cliente (niente integrazioni,
    // niente bozze, niente auto-reply) → evita eventi/Notion fantasma e loop.
    const isControl = !!phone && phone.replace(/\D/g, '') === getControlNumber();
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

    // Lettura automatica del documento (rev. 01/07/2026): prima il bot vedeva solo un
    // segnaposto "[Immagine]" e rispondeva in modo generico. Ora analizza la foto (tipo di
    // documento, mittente/ente, riferimenti visibili) così la risposta può essere pertinente
    // a quanto ricevuto. Isolato: se l'analisi fallisce, resta il segnaposto testuale.
    if (isImage && imageUrl && !fromMe) {
      try {
        const { analyzeImageUrl } = await import('./docvision.js');
        const desc = await analyzeImageUrl(imageUrl);
        if (desc) {
          content = `📄 Documento ricevuto${caption ? ` (didascalia cliente: "${caption}")` : ''} — analisi automatica: ${desc}`;
        }
      } catch (e: any) {
        console.error('[DocVision] webhook immagine:', e.message);
      }
    }

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

    const timestamp = new Date(momment).toISOString();
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

    // Auto-reply: prima le regole keyword (progetto iniziale), poi il messaggio
    // fisso per conversazione come fallback. Entrambe scattano SOLO se il
    // contatto ha l'auto-risposta attiva (auto_reply_enabled).
    if (!fromMe && !isControl) {
      const conv = db.prepare(`SELECT auto_reply_enabled, auto_reply_message FROM conversations WHERE phone = ?`).get(phone) as any;
      if (conv?.auto_reply_enabled) {
        let replyText: string | null = null;
        let ruleName: string | null = null;
        try {
          const rules = db.prepare(`SELECT * FROM auto_reply_rules WHERE enabled = 1`).all() as any[];
          const lower = (content || '').toLowerCase();
          for (const rule of rules) {
            if (!rule.is_global && rule.specific_phone !== phone) continue;
            if (rule.keyword && lower.includes(rule.keyword.toLowerCase())) {
              replyText = rule.reply_text;
              ruleName = rule.name;
              db.prepare(`UPDATE auto_reply_rules SET trigger_count = trigger_count + 1 WHERE id = ?`).run(rule.id);
              break;
            }
          }
        } catch (e) { console.error('[Auto-reply] Errore regole:', e); }
        if (!replyText && conv.auto_reply_message) replyText = conv.auto_reply_message;
        if (replyText) {
          try {
            // Segnaposto {DISPONIBILITA}: sostituito con i prossimi slot liberi
            // calcolati da Google Calendar + regole orario studio
            if (replyText.includes('{DISPONIBILITA}')) {
              try {
                const { slots } = await getAvailability(14);
                replyText = replyText.replace(/\{DISPONIBILITA\}/g, formatAvailabilityIT(slots));
              } catch (e) {
                replyText = replyText.replace(/\{DISPONIBILITA\}/g, 'la ricontatteremo a breve con le disponibilità');
              }
            }
            await sendTextMessage(phone, replyText);
            const arId = `ar_${Date.now()}`;
            const arNow = new Date().toISOString();
            db.prepare(`
              INSERT OR IGNORE INTO live_messages
                (message_id, phone, contact_name, content, direction, timestamp, is_read, created_at)
              VALUES (?, ?, ?, ?, 'sent', ?, 1, ?)
            `).run(arId, phone, senderName || phone, replyText, arNow, arNow);
            if (ruleName) console.log(`[Auto-reply] Regola "${ruleName}" → ${phone}`);
          } catch (e) {
            console.error('[Auto-reply] Error:', e);
          }
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
    if (!fromMe && !isGroup && !isControl && content && content.trim().length > 2) {
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

    // ─── CHATBOT: bozza di risposta (draft mode, async non bloccante) ────────
    // Genera una bozza SOLO per i clienti di lavoro: niente messaggi propri,
    // gruppi o VIP/high (viplist gestita da Mariano). Non invia nulla: la bozza
    // resta in attesa di approvazione nel Cruscotto.
    // ─── Comando di controllo da Mariano via WhatsApp ───────────────────────
    // Funziona sia se lo studio WhatsApp è il NUMERO STESSO di Mariano (il comando
    // arriva come 'fromMe'), sia se il numero di controllo è separato (comando
    // 'received'). handleControlCommand ignora i messaggi che non sono comandi.
    if (!isGroup && content && content.trim().length > 2) {
      const fromControl = fromMe || phone === getControlNumber();
      if (fromControl) {
        setImmediate(async () => {
          try {
            const reply = await handleControlCommand(content);
            if (reply) await sendTextMessage(getControlNumber(), reply);
          } catch (e: any) { console.error('[Chatbot] Comando controllo:', e.message); }
        });
      }
    }

    if (!fromMe && !isGroup && !isControl && content && content.trim().length > 2 && isBotEnabled()) {
      setImmediate(async () => {
        try {
          // Mai generare bozze per il numero di controllo (Mariano stesso).
          if (isControl || phone === getControlNumber()) return;
          const c = db.prepare(`SELECT contact_name, priority FROM conversations WHERE phone = ?`).get(phone) as any;
          const pr = (c?.priority || 'none');
          if (pr === 'vip' || pr === 'high') return; // viplist → gestisce Mariano
          const cName = c?.contact_name || senderName || phone;
          const day = (timestamp || new Date().toISOString()).slice(0, 10);
          const outcome = await generateDraft(phone, cName);
          if (outcome?.kind === 'personal') {
            // Messaggio NON di lavoro: resta marcato "personale" così il digest non lo
            // riporta. Inviamo però un breve messaggio di cortesia (impegnato, ricontatto),
            // auto e al massimo 1 volta al giorno per contatto, se il modello l'ha prodotto.
            recordClassification(messageId, phone, day, 'personal');
            // Messaggio di cortesia auto SOLO se autoSend è attivo. Con autoSend OFF
            // (default) il bot NON scrive nulla di propria iniziativa ai clienti.
            if (isAutoSendEnabled() && outcome.result?.draftText && !courtesySentToday(phone)) {
              const id = saveDraft({ phone, contactName: cName, incoming: content, result: outcome.result });
              const r = await approveDraftCore(id, { force: true });
              if (r.ok) markCourtesySent(phone);
              broadcastEvent('bot_draft', { id, phone, contactName: cName, needsHuman: false, autoSent: r.ok, personal: true });
              console.log(`[Chatbot] Cortesia (non-lavoro) ${r.ok ? 'inviata' : 'NON inviata'} a ${cName} (${phone})`);
            } else {
              console.log(`[Chatbot] Messaggio personale — ${cName} (${phone}) (nessun invio: autoSend off o cortesia già inviata)`);
            }
          } else if (outcome?.kind === 'work' && outcome.result) {
            recordClassification(messageId, phone, day, 'work');
            const res = outcome.result;
            const id = saveDraft({ phone, contactName: cName, incoming: content, result: res });
            // APPUNTAMENTI in autonomia: il flusso agenda (proposta/conferma/spostamento)
            // parte da solo DOPO aver incrociato Google Calendar — automatismo voluto e
            // circoscritto, governato da isAutoAppointmentsEnabled (default ON). Le altre
            // risposte di merito restano BOZZA salvo autoSend globale (lucchettato). Le
            // urgenze (need_human) non partono mai da sole.
            const isUrgent = res.needsHuman;
            const autonomousAppt = !!res.appointmentFlow && !isUrgent && isAutoAppointmentsEnabled();
            const globalAuto = isAutoSendEnabled() && !isUrgent;
            if (autonomousAppt || globalAuto) {
              // Appuntamento autonomo: NON forzare (l'agenda viene ricontrollata in
              // approveDraftCore → niente sovrapposizioni). autoSend globale: invio forzato.
              const r = await approveDraftCore(id, { force: globalAuto && !autonomousAppt });
              if (r.ok) {
                broadcastEvent('bot_draft', { id, phone, contactName: cName, needsHuman: false, autoSent: true });
                console.log(`[Chatbot] ${autonomousAppt ? 'Appuntamento autonomo' : 'Auto-risposta'} a ${cName} (${phone})${r.hadEvent ? ' + appuntamento DA CONFERMARE' : ''}`);
              } else if (r.conflict) {
                // Slot occupatosi tra la proposta e l'invio: lascia la bozza in attesa nel Cruscotto.
                broadcastEvent('bot_draft', { id, phone, contactName: cName, needsHuman: false, conflict: true });
                console.warn(`[Chatbot] Slot in conflitto per ${cName} (${phone}): bozza #${id} resta in attesa di revisione.`);
              } else {
                broadcastEvent('bot_draft', { id, phone, contactName: cName, needsHuman: false });
                console.error(`[Chatbot] Invio bozza #${id} a ${cName} (${phone}) fallito: ${r.message || 'errore'}`);
              }
            } else {
              broadcastEvent('bot_draft', { id, phone, contactName: cName, needsHuman: res.needsHuman });
              console.log(`[Chatbot] Bozza #${id} per ${cName} (${phone})${res.needsHuman ? ' [need_human]' : ''}`);
              // Urgenze: alert EMAIL a Mariano (canale affidabile, sempre attivo).
              if (res.needsHuman) await notifyUrgentByEmail(id);
              // Notifica WhatsApp a Mariano (inaffidabile: numero controllo == device).
              if (shouldNotifyControl()) await notifyDraftToControl(id);
            }
          }
        } catch (botErr: any) {
          console.error('[Chatbot] Error:', botErr.message);
        }
      });
    }

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

// ─── CHATBOT / BOZZE ─────────────────────────────────────────────────────────
router.get('/bot/drafts', (_req: Request, res: Response) => {
  try {
    res.json(getPendingDrafts());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bot/config', (_req: Request, res: Response) => {
  res.json({ enabled: isBotEnabled(), model: getBotModel(), notifyMode: getNotifyMode(), controlNumber: getControlNumber(), autoSend: isAutoSendEnabled(), waCommands: waCommandsEnabled() });
});

router.post('/bot/config', (req: Request, res: Response) => {
  try {
    const { enabled, model, notifyMode, controlNumber, autoSend } = req.body || {};
    if (enabled !== undefined) setBotSetting('bot_enabled', enabled ? '1' : '0');
    // BLINDATURA: l'auto-invio si può attivare SOLO se l'env BOT_ALLOW_AUTOSEND=1
    // è presente su Railway. Una richiesta che prova ad accenderlo senza il lucchetto
    // viene ignorata (resta '0') e segnalata, così l'interfaccia non illude.
    let autoSendRejected = false;
    if (autoSend !== undefined) {
      if (autoSend && process.env.BOT_ALLOW_AUTOSEND !== '1') {
        autoSendRejected = true;
        setBotSetting('bot_auto_send', '0');
      } else {
        setBotSetting('bot_auto_send', autoSend ? '1' : '0');
      }
    }
    if (model) setBotSetting('bot_model', String(model));
    if (notifyMode && ['off', 'outside_hours', 'always'].includes(notifyMode)) setBotSetting('notify_mode', notifyMode);
    if (controlNumber) setBotSetting('control_number', String(controlNumber).replace(/\D/g, ''));
    const { waCommands } = req.body || {};
    if (waCommands !== undefined) setBotSetting('wa_commands', waCommands ? '1' : '0');
    res.json({ enabled: isBotEnabled(), model: getBotModel(), notifyMode: getNotifyMode(), controlNumber: getControlNumber(), autoSend: isAutoSendEnabled(), waCommands: waCommandsEnabled(), ...(autoSendRejected ? { autoSendRejected: true, reason: 'autoSend bloccato: imposta BOT_ALLOW_AUTOSEND=1 su Railway per abilitarlo' } : {}) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/drafts/:id/reject', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const d = getDraft(id);
    if (!d) return res.status(404).json({ error: 'Bozza non trovata' });
    markDraftRejected(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/drafts/:id/approve', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await approveDraftCore(id, { text: req.body?.text, force: req.body?.force === true });
    if (!r.ok) {
      return res.status(r.status).json({ conflict: r.conflict, message: r.message, error: r.message });
    }
    res.json({ success: true, calendar: r.calendar });
  } catch (err: any) {
    console.error('[Bot approve] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── APPUNTAMENTI: lista da confermare + conferma/annulla manuale ─────────────
router.get('/bot/appointments', (_req: Request, res: Response) => {
  try {
    res.json(getPendingAppointments());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/appointments/:id/confirm', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const appt = getAppointmentById(id);
    if (!appt) return res.status(404).json({ error: 'Appuntamento non trovato' });
    if (appt.status !== 'da_confermare') return res.status(400).json({ error: 'Appuntamento già gestito' });
    const r = await confirmAppointmentRow(appt, { notify: false });
    res.json({ success: true, calendarUpdated: r.calendarUpdated });
  } catch (err: any) {
    console.error('[Bot appointment confirm] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/appointments/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const appt = getAppointmentById(id);
    if (!appt) return res.status(404).json({ error: 'Appuntamento non trovato' });
    await cancelAppointmentRow(appt);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Bot appointment cancel] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── MANUTENZIONE: digest giornaliero + watchdog flusso ──────────────────────
router.post('/bot/daily-digest', async (req: Request, res: Response) => {
  try {
    const date = (req.query.date as string) || undefined;
    res.json(await runDailyDigest(date));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Backfill: annota sull'agenda anche i giorni passati (arretrato). Salta i giorni
// senza messaggi di lavoro. days = quanti giorni indietro (oggi incluso).
router.post('/bot/backfill-digest', async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(String((req.query.days as string) || req.body?.days || '60'), 10) || 60, 1), 366);
  const written: any[] = [];
  const today = new Date();
  for (let i = 0; i <= days; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
    try {
      const r = await runDailyDigest(iso);
      if (r.ok && r.total > 0) written.push({ date: iso, total: r.total });
    } catch (e: any) { written.push({ date: iso, error: e.message }); }
  }
  res.json({ daysScanned: days + 1, eventsWritten: written.length, days: written });
});

router.get('/bot/flow-health', (_req: Request, res: Response) => {
  res.json(getFlowHealth());
});

// Diagnostica: numero WhatsApp collegato + webhook configurato (per capire se i
// comandi di Mariano arrivano come 'fromMe' — studio = suo numero — o 'received').
router.get('/bot/zapi-info', async (_req: Request, res: Response) => {
  const out: any = { controlNumber: getControlNumber() };
  for (const ep of ['device', 'status']) {
    try { out[ep] = await zapiGet(ep); } catch (e: any) { out[ep] = { error: e.message }; }
  }
  try { out.receivedWebhook = await getReceivedWebhook(); } catch (e: any) { out.receivedWebhook = { error: e.message }; }
  try { out.webhooksRaw = await zapiGet('webhooks'); } catch (e: any) { out.webhooksRaw = { error: e.message }; }
  res.json(out);
});

// Riparazione: abilita su Z-API l'inoltro dei messaggi inviati da Mariano stesso
// (fromMe) al webhook, così i comandi OK/NO arrivano al sistema. Imposta anche
// l'URL del webhook ricevuti. Idempotente.
router.post('/bot/enable-self-commands', async (_req: Request, res: Response) => {
  const base = process.env.PUBLIC_BASE_URL || 'https://wa-cruscotto-v2-production.up.railway.app';
  const url = `${base}/api/webhook/message`;
  const results: any = {};
  const { zapiPut } = await import('./zapi.js');
  // Z-API usa PUT. notifySentByMe = inoltra al webhook anche i messaggi inviati da
  // Mariano (così i comandi OK/NO e le risposte dal telefono arrivano al cruscotto).
  // FIX 18/06/2026: prima c'erano DUE chiamate eseguite in sequenza e la 2ª, SENZA
  // notifySentByMe, SOVRASCRIVEVA la 1ª riportando il flag a false → rispondere da
  // WhatsApp non aggiornava più la gestione messaggi. Ora il flag c'è in ENTRAMBE le
  // varianti e ci si ferma al PRIMO successo (mai sovrascrivere con una variante che
  // azzera il flag).
  const attempts: Array<[string, any]> = [
    ['update-webhook-received', { value: url, notifySentByMe: true }],
    ['update-webhook-received', { value: url, notifySentByMe: true }],
  ];
  for (const [path, body] of attempts) {
    try {
      results[`PUT ${path} ${JSON.stringify(body)}`] = await zapiPut(path, body);
      break; // primo successo basta: non riregistrare con varianti successive
    } catch (e: any) {
      results[`PUT ${path} ${JSON.stringify(body)}`] = { error: e.message };
    }
  }
  res.json({ webhook: url, results });
});

router.post('/bot/repair-webhook', async (_req: Request, res: Response) => {
  try {
    res.json(await repairWebhook());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
