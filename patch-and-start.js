#!/usr/bin/env node
// patch-and-start.js — patcha dist/index.cjs a runtime poi avvia server
const fs = require('fs'), path = require('path');
const bundle = path.join(__dirname, 'dist', 'index.cjs');
let src = fs.readFileSync(bundle, 'utf8');
const MARKER = '/* NO_SUBQUERY_PATCH */';
if (!src.includes(MARKER)) {
  const HIT = src.indexOf('FROM live_messages WHERE phone = conversations.phone');
  if (HIT >= 0) {
    // Trova l'inizio della route GET /conversations
    const START = src.lastIndexOf('router.get("/conversations"', HIT);
    // Trova la fine della route (}) dopo HIT
    let depth = 0, pos = START;
    while (pos < src.length) {
      if (src[pos] === '{') depth++;
      if (src[pos] === '}') { depth--; if (depth === 0) { pos++; break; } }
      pos++;
    }
    // Sostituisci l'intera route con versione senza subquery
    const NEW_ROUTE = `${MARKER}\nrouter.get("/conversations", (req, res) => {\n  try {\n    const { archived, search } = req.query;\n    let query = \`SELECT id, phone, contact_name AS contactName, COALESCE(is_group,0) AS isGroup, NULLIF(last_message,'') AS lastMessage, last_message_at AS lastMessageAt, unread_count AS unreadCount, total_received AS totalReceived, total_sent AS totalSent, auto_reply_enabled AS autoReplyEnabled, auto_reply_message AS autoReplyMessage, is_archived AS isArchived, priority, priority_label AS priorityLabel, created_at AS createdAt FROM conversations WHERE is_archived = ? AND phone NOT LIKE '%@newsletter%' AND phone NOT LIKE '%120363%' AND length(phone) >= 8\`;\n    const params = [archived === "1" ? 1 : 0];\n    if (search) { query += \` AND (contact_name LIKE ? OR phone LIKE ?)\`; params.push(\`%\${search}%\`, \`%\${search}%\`); }\n    query += \` ORDER BY CASE priority WHEN 'vip' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, COALESCE(last_message_at,'1970-01-01') DESC\`;\n    res.json(db_default.prepare(query).all(...params));\n  } catch (err) { res.status(500).json({ error: err.message }); }\n});\n`;
    src = src.slice(0, START) + NEW_ROUTE + src.slice(pos);
    fs.writeFileSync(bundle, src);
    console.log('[Patcher] ✅ Query conversations patchata (rimossa subquery correlata)');
  } else {
    console.log('[Patcher] Bundle già senza subquery correlate.');
  }
} else {
  console.log('[Patcher] Patch già applicata.');
}
require('./dist/index.cjs');
