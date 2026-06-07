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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

console.log('[DB] Tables created/verified');

export default db;
