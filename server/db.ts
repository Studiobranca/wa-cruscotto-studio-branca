import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data.db');

console.log(`[DB] Using database at: ${DB_PATH}`);

// Crea la directory se non esiste (necessario per Railway con volume /data)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`[DB] Created directory: ${dbDir}`);
}

export const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    contact_name TEXT,
    last_message TEXT,
    last_message_at TEXT,
    unread_count INTEGER DEFAULT 0,
    total_received INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    auto_reply_enabled INTEGER DEFAULT 0,
    auto_reply_message TEXT,
    is_archived INTEGER DEFAULT 0,
    priority TEXT DEFAULT 'none',
    priority_label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS live_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    phone TEXT NOT NULL,
    contact_name TEXT,
    content TEXT,
    direction TEXT DEFAULT 'received',
    timestamp TEXT,
    is_read INTEGER DEFAULT 0,
    is_audio INTEGER DEFAULT 0,
    audio_url TEXT,
    is_image INTEGER DEFAULT 0,
    image_url TEXT,
    caption TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: aggiungi colonne nuove se non esistono
try { db.exec(`ALTER TABLE live_messages ADD COLUMN is_image INTEGER DEFAULT 0`); } catch {}  
try { db.exec(`ALTER TABLE live_messages ADD COLUMN image_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE live_messages ADD COLUMN caption TEXT`); } catch {}

// Migration: correggi messaggi con audioUrl ma isAudio=0 (dati pre-fix)
try { db.exec(`UPDATE live_messages SET is_audio = 1 WHERE audio_url IS NOT NULL AND audio_url != '' AND is_audio = 0`); } catch {}
// Migration: correggi messaggi con imageUrl ma isImage=0
try { db.exec(`UPDATE live_messages SET is_image = 1 WHERE image_url IS NOT NULL AND image_url != '' AND is_image = 0`); } catch {}
// Migration: colonne traduzione
try { db.exec(`ALTER TABLE live_messages ADD COLUMN original_content TEXT`); } catch {}
try { db.exec(`ALTER TABLE live_messages ADD COLUMN detected_language TEXT`); } catch {}
// Migration: supporto gruppi
try { db.exec(`ALTER TABLE conversations ADD COLUMN is_group INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE live_messages ADD COLUMN is_group INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE live_messages ADD COLUMN sender_name TEXT`); } catch {}

// ─── Automazioni (ripristino dal progetto iniziale wa-cruscotto) ─────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS auto_reply_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    is_global INTEGER DEFAULT 1,
    specific_phone TEXT,
    enabled INTEGER DEFAULT 1,
    trigger_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    shortcut TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed risposte rapide originali (solo se la tabella è vuota)
try {
  const qrCount = db.prepare(`SELECT COUNT(*) as c FROM quick_replies`).get() as { c: number };
  if (qrCount.c === 0) {
    const ins = db.prepare(`INSERT INTO quick_replies (label, text, shortcut) VALUES (?, ?, ?)`);
    ins.run('Orari', 'Ciao! Il nostro orario di apertura è: Lun-Ven 9:00-18:00, Sab 9:00-13:00.', '/orari');
    ins.run('Info contatto', 'Per maggiori informazioni puoi contattarci a: info@studiobranca.it o chiamarci.', '/info');
    ins.run('Appuntamento', 'Posso fissare un appuntamento per te! Dimmi quale giorno preferisci e ti confermerò la disponibilità.', '/app');
    console.log('[DB] Seed risposte rapide originali inserito');
  }
} catch (e) { console.error('[DB] Seed quick_replies:', e); }

console.log('[DB] Tables created/verified');

export default db;
