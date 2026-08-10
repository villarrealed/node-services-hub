import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = process.env.DATABASE_PATH || './data/bridge.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sms_rooms (
    phone_number TEXT PRIMARY KEY,
    room_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function getRoomByPhone(phoneNumber) {
  return db.prepare('SELECT room_id FROM sms_rooms WHERE phone_number = ?').get(phoneNumber)?.room_id ?? null;
}

export function getPhoneByRoom(roomId) {
  return db.prepare('SELECT phone_number FROM sms_rooms WHERE room_id = ?').get(roomId)?.phone_number ?? null;
}

export function saveMapping(phoneNumber, roomId) {
  db.prepare('INSERT OR REPLACE INTO sms_rooms (phone_number, room_id) VALUES (?, ?)').run(phoneNumber, roomId);
}
