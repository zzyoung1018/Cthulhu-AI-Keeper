import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';

const MAX_ROOM_PLAYERS = 5;
const ROOM_STATUSES = ['PREPARING', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED'];
const MESSAGE_TYPES = ['IC', 'OOC', 'ACTION', 'SYSTEM', 'AI_DM', 'PRIVATE'];
const ROOM_STATUS_TRANSITIONS = {
  PREPARING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: ['ARCHIVED'],
  ARCHIVED: []
};

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
    status: row.status || 'PREPARING',
    ownerPlayerId: row.owner_player_id || '',
    summary: row.summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToParticipant(row, room = null) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    playerId: row.player_id,
    displayName: row.display_name,
    isOwner: Boolean(room && row.player_id === room.ownerPlayerId),
    isReady: Boolean(row.is_ready),
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
    messageType: row.message_type || legacyMessageType(row.author_type),
    participantId: row.participant_id,
    playerId: row.player_id || '',
    displayName: row.display_name,
    content: row.content || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToDiceRoll(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    participantId: row.participant_id,
    playerId: row.player_id,
    rollType: row.roll_type,
    expression: row.expression,
    label: row.label || '',
    isPrivate: Boolean(row.is_private),
    result: JSON.parse(row.result_json),
    createdAt: row.created_at
  };
}

function legacyMessageType(authorType) {
  if (authorType === 'dm') return 'AI_DM';
  if (authorType === 'system') return 'SYSTEM';
  return 'IC';
}

function normalizeRoomStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  if (!ROOM_STATUSES.includes(value)) {
    throw new HttpError(400, 'Invalid room status');
  }
  return value;
}

function normalizeMessageType(messageType) {
  const value = String(messageType || 'IC').trim().toUpperCase();
  if (!MESSAGE_TYPES.includes(value)) {
    throw new HttpError(400, 'Invalid message type');
  }
  return value;
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
      status TEXT NOT NULL DEFAULT 'PREPARING',
      owner_player_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_ready INTEGER NOT NULL DEFAULT 0,
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
      message_type TEXT NOT NULL DEFAULT 'IC',
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

    CREATE TABLE IF NOT EXISTS dice_rolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
      player_id TEXT NOT NULL,
      roll_type TEXT NOT NULL,
      expression TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      is_private INTEGER NOT NULL DEFAULT 0,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_story_summaries_room ON story_summaries(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dice_rolls_room_created ON dice_rolls(room_id, created_at, id);
  `);

  function hasColumn(table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  }

  if (!hasColumn('rooms', 'status')) {
    db.exec("ALTER TABLE rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'PREPARING'");
  }
  if (!hasColumn('rooms', 'owner_player_id')) {
    db.exec("ALTER TABLE rooms ADD COLUMN owner_player_id TEXT NOT NULL DEFAULT ''");
    db.exec(`
      UPDATE rooms
      SET owner_player_id = COALESCE((
        SELECT player_id
        FROM participants
        WHERE participants.room_id = rooms.id
        ORDER BY joined_at ASC, id ASC
        LIMIT 1
      ), '')
      WHERE owner_player_id = ''
    `);
  }
  if (!hasColumn('participants', 'is_ready')) {
    db.exec('ALTER TABLE participants ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn('messages', 'message_type')) {
    db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'IC'");
    db.exec(`
      UPDATE messages
      SET message_type = CASE
        WHEN author_type = 'dm' THEN 'AI_DM'
        WHEN author_type = 'system' THEN 'SYSTEM'
        ELSE 'IC'
      END
    `);
  }

  const statements = {
    getRoomByCode: db.prepare('SELECT * FROM rooms WHERE code = ?'),
    getRoomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    createRoom: db.prepare(`
      INSERT INTO rooms (code, name, status, owner_player_id, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateRoomStatus: db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?'),
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
      INSERT INTO messages (room_id, author_type, message_type, participant_id, player_id, display_name, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateMessage: db.prepare('UPDATE messages SET content = ?, status = ?, updated_at = ? WHERE id = ?'),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    listMessages: db.prepare(`
      SELECT * FROM messages
      WHERE room_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `),
    listDiceRolls: db.prepare(`
      SELECT * FROM dice_rolls
      WHERE room_id = ? AND is_private = 0
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `),
    createDiceRoll: db.prepare(`
      INSERT INTO dice_rolls (room_id, participant_id, player_id, roll_type, expression, label, is_private, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getDiceRollById: db.prepare('SELECT * FROM dice_rolls WHERE id = ?'),
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
    return statements.getParticipant.get(roomId, playerId);
  }

  function assertOwner(room, playerId) {
    if (room.ownerPlayerId !== playerId) {
      throw new HttpError(403, 'Only the room owner can do that');
    }
  }

  function assertTransition(room, nextStatus) {
    const allowed = ROOM_STATUS_TRANSITIONS[room.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new HttpError(409, `Cannot move room from ${room.status} to ${nextStatus}`);
    }
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
        const result = statements.createRoom.run(code, name, 'PREPARING', playerId, '', created, created);
        const room = rowToRoom(statements.getRoomById.get(Number(result.lastInsertRowid)));
        const participant = rowToParticipant(createParticipant(Number(result.lastInsertRowid), playerId, displayName), room);
        return { room, participant };
      });
    },

    joinRoom({ code, playerId, displayName }) {
      const room = ensureRoom(code);
      const participant = transaction(() => {
        const existing = rowToParticipant(statements.getParticipant.get(room.id, playerId));
        if (existing) {
          statements.touchParticipantName.run(displayName, now(), room.id, playerId);
          return rowToParticipant(statements.getParticipant.get(room.id, playerId), room);
        }

        if (room.status !== 'PREPARING') {
          throw new HttpError(409, 'Room is not accepting new players');
        }
        const count = Number(statements.participantCount.get(room.id).total);
        if (count >= MAX_ROOM_PLAYERS) {
          throw new HttpError(409, 'Room is full');
        }
        return rowToParticipant(createParticipant(room.id, playerId, displayName), room);
      });

      return { room, participant };
    },

    getRoomState(code, messageLimit = 80) {
      const room = ensureRoom(code);
      const participants = statements.listParticipants.all(room.id).map((row) => rowToParticipant(row, room));
      const messages = statements.listMessages
        .all(room.id, messageLimit)
        .map(rowToMessage)
        .reverse();
      const diceRolls = statements.listDiceRolls
        .all(room.id, 40)
        .map(rowToDiceRoll)
        .reverse();
      return { room, participants, messages, diceRolls };
    },

    getParticipant(code, playerId) {
      const room = ensureRoom(code);
      const participant = rowToParticipant(statements.getParticipant.get(room.id, playerId), room);
      if (!participant) throw new HttpError(403, 'Join the room first');
      return { room, participant };
    },

    setRoomStatus({ code, playerId, status }) {
      const nextStatus = normalizeRoomStatus(status);
      const { room } = this.getParticipant(code, playerId);
      assertOwner(room, playerId);
      assertTransition(room, nextStatus);
      statements.updateRoomStatus.run(nextStatus, now(), room.id);
      return rowToRoom(statements.getRoomById.get(room.id));
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

    createMessage({
      code,
      authorType,
      messageType,
      playerId = '',
      participantId = null,
      displayName,
      content,
      status = 'complete'
    }) {
      const room = ensureRoom(code);
      const type = normalizeMessageType(messageType || legacyMessageType(authorType));
      const created = now();
      const result = statements.createMessage.run(
        room.id,
        authorType,
        type,
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

    createPlayerMessage({ code, playerId, content, messageType = 'IC' }) {
      const type = normalizeMessageType(messageType);
      const { participant } = this.getParticipant(code, playerId);
      return this.createMessage({
        code,
        authorType: 'player',
        messageType: type,
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
    },

    createDiceRoll({ code, playerId, rollType, expression, label = '', isPrivate = false, result }) {
      const { room, participant } = this.getParticipant(code, playerId);
      const created = now();
      const inserted = statements.createDiceRoll.run(
        room.id,
        participant.id,
        playerId,
        rollType,
        expression,
        label,
        isPrivate ? 1 : 0,
        JSON.stringify(result),
        created
      );
      return rowToDiceRoll(statements.getDiceRollById.get(Number(inserted.lastInsertRowid)));
    }
  };
}

export { MAX_ROOM_PLAYERS, MESSAGE_TYPES, ROOM_STATUSES, ROOM_STATUS_TRANSITIONS };
