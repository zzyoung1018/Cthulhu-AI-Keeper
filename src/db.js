import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';

const MAX_ROOM_PLAYERS = 5;

function now() {
  return new Date().toISOString();
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function rowToRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    summary: row.summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToParticipant(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    playerId: row.player_id,
    displayName: row.display_name,
    characterName: row.character_name || '',
    characterCard: row.character_card || '',
    state: row.state || '',
    joinedAt: row.joined_at,
    updatedAt: row.updated_at
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    authorType: row.author_type,
    participantId: row.participant_id,
    playerId: row.player_id || '',
    displayName: row.display_name,
    content: row.content || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      character_name TEXT NOT NULL DEFAULT '',
      character_card TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(room_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK(author_type IN ('player', 'dm', 'system')),
      participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
      player_id TEXT,
      display_name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'complete',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_story_summaries_room ON story_summaries(room_id, created_at);
  `);

  const statements = {
    getRoomByCode: db.prepare('SELECT * FROM rooms WHERE code = ?'),
    getRoomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    createRoom: db.prepare('INSERT INTO rooms (code, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    participantCount: db.prepare('SELECT COUNT(*) AS total FROM participants WHERE room_id = ?'),
    getParticipant: db.prepare('SELECT * FROM participants WHERE room_id = ? AND player_id = ?'),
    getParticipantById: db.prepare('SELECT * FROM participants WHERE id = ?'),
    createParticipant: db.prepare(`
      INSERT INTO participants (room_id, player_id, display_name, joined_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    touchParticipantName: db.prepare(`
      UPDATE participants SET display_name = ?, updated_at = ? WHERE room_id = ? AND player_id = ?
    `),
    updateParticipantProfile: db.prepare(`
      UPDATE participants
      SET display_name = ?, character_name = ?, character_card = ?, state = ?, updated_at = ?
      WHERE room_id = ? AND player_id = ?
    `),
    listParticipants: db.prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY joined_at ASC, id ASC'),
    createMessage: db.prepare(`
      INSERT INTO messages (room_id, author_type, participant_id, player_id, display_name, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateMessage: db.prepare('UPDATE messages SET content = ?, status = ?, updated_at = ? WHERE id = ?'),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    listMessages: db.prepare(`
      SELECT * FROM messages
      WHERE room_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `),
    updateSummary: db.prepare('UPDATE rooms SET summary = ?, updated_at = ? WHERE id = ?'),
    createSummaryVersion: db.prepare(`
      INSERT INTO story_summaries (room_id, participant_id, summary, created_at)
      VALUES (?, ?, ?, ?)
    `)
  };

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function ensureRoom(code) {
    const room = rowToRoom(statements.getRoomByCode.get(code.toUpperCase()));
    if (!room) throw new HttpError(404, 'Room not found');
    return room;
  }

  function createParticipant(roomId, playerId, displayName) {
    const created = now();
    statements.createParticipant.run(roomId, playerId, displayName, created, created);
    return rowToParticipant(statements.getParticipant.get(roomId, playerId));
  }

  return {
    db,

    close() {
      db.close();
    },

    createRoom({ name, playerId, displayName }) {
      let code = roomCode();
      while (statements.getRoomByCode.get(code)) {
        code = roomCode();
      }

      const created = now();
      return transaction(() => {
        const result = statements.createRoom.run(code, name, '', created, created);
        const participant = createParticipant(Number(result.lastInsertRowid), playerId, displayName);
        const room = rowToRoom(statements.getRoomById.get(Number(result.lastInsertRowid)));
        return { room, participant };
      });
    },

    joinRoom({ code, playerId, displayName }) {
      const room = ensureRoom(code);
      const participant = transaction(() => {
        const existing = rowToParticipant(statements.getParticipant.get(room.id, playerId));
        if (existing) {
          statements.touchParticipantName.run(displayName, now(), room.id, playerId);
          return rowToParticipant(statements.getParticipant.get(room.id, playerId));
        }

        const count = Number(statements.participantCount.get(room.id).total);
        if (count >= MAX_ROOM_PLAYERS) {
          throw new HttpError(409, 'Room is full');
        }
        return createParticipant(room.id, playerId, displayName);
      });

      return { room, participant };
    },

    getRoomState(code, messageLimit = 80) {
      const room = ensureRoom(code);
      const participants = statements.listParticipants.all(room.id).map(rowToParticipant);
      const messages = statements.listMessages
        .all(room.id, messageLimit)
        .map(rowToMessage)
        .reverse();
      return { room, participants, messages };
    },

    getParticipant(code, playerId) {
      const room = ensureRoom(code);
      const participant = rowToParticipant(statements.getParticipant.get(room.id, playerId));
      if (!participant) throw new HttpError(403, 'Join the room first');
      return { room, participant };
    },

    updateProfile({ code, playerId, displayName, characterName, characterCard, state }) {
      const { room } = this.getParticipant(code, playerId);
      statements.updateParticipantProfile.run(
        displayName,
        characterName,
        characterCard,
        state,
        now(),
        room.id,
        playerId
      );
      return rowToParticipant(statements.getParticipant.get(room.id, playerId));
    },

    updateSummary({ code, playerId, summary }) {
      const { room, participant } = this.getParticipant(code, playerId);
      const updated = now();
      statements.updateSummary.run(summary, updated, room.id);
      statements.createSummaryVersion.run(room.id, participant.id, summary, updated);
      return rowToRoom(statements.getRoomById.get(room.id));
    },

    createMessage({ code, authorType, playerId = '', participantId = null, displayName, content, status = 'complete' }) {
      const room = ensureRoom(code);
      const created = now();
      const result = statements.createMessage.run(
        room.id,
        authorType,
        participantId,
        playerId,
        displayName,
        content,
        status,
        created,
        created
      );
      return rowToMessage(statements.getMessageById.get(Number(result.lastInsertRowid)));
    },

    createPlayerMessage({ code, playerId, content }) {
      const { participant } = this.getParticipant(code, playerId);
      return this.createMessage({
        code,
        authorType: 'player',
        playerId,
        participantId: participant.id,
        displayName: participant.characterName || participant.displayName,
        content,
        status: 'complete'
      });
    },

    updateMessage({ id, content, status }) {
      statements.updateMessage.run(content, status, now(), id);
      return rowToMessage(statements.getMessageById.get(id));
    }
  };
}

export { MAX_ROOM_PLAYERS };
