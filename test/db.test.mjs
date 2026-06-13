import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { HttpError } from '../src/errors.js';

function withDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-test-'));
  const database = createDatabase(join(dir, 'test.db'));
  return {
    database,
    cleanup() {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createModule(database, ownerPlayerId = 'p1') {
  return database.createModule({
    ownerPlayerId,
    title: '死亡之光',
    originalName: 'light.txt',
    fileType: 'txt',
    contentType: 'text/plain',
    sizeBytes: 42,
    storagePath: '/tmp/light.txt',
    parsedText: '场景：旧宅\n调查员来到旧宅。',
    parseStatus: 'PARSED',
    segments: [{ title: '旧宅', scene: '旧宅 #1', content: '调查员来到旧宅。' }]
  });
}

function characterSheet(name, skillValue = 60) {
  return {
    investigator: { name, occupation: '调查员' },
    characteristics: {
      STR: 55,
      CON: 60,
      SIZ: 50,
      DEX: 65,
      APP: 50,
      INT: 70,
      POW: 45,
      EDU: 60,
      Luck: 55
    },
    skills: {
      侦查: skillValue
    }
  };
}

test('creates rooms, joins players, and enforces the five-player limit', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'p1');
    const created = database.createRoom({
      name: 'Test Table',
      playerId: 'p1',
      displayName: 'Player 1',
      moduleId: module.id
    });

    assert.equal(created.room.code.length, 6);
    assert.equal(created.room.moduleId, module.id);
    assert.equal(created.room.moduleTitle, '死亡之光');
    assert.equal(created.room.status, 'PREPARING');
    assert.equal(created.room.ownerPlayerId, 'p1');
    assert.equal(created.participant.isOwner, true);
    for (let i = 2; i <= 5; i += 1) {
      database.joinRoom({
        code: created.room.code,
        playerId: `p${i}`,
        displayName: `Player ${i}`
      });
    }

    assert.equal(database.getRoomState(created.room.code).participants.length, 5);
    assert.throws(
      () => database.joinRoom({ code: created.room.code, playerId: 'p6', displayName: 'Player 6' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );

    const returning = database.joinRoom({
      code: created.room.code,
      playerId: 'p1',
      displayName: 'Renamed'
    });
    assert.equal(returning.participant.displayName, 'Renamed');
  } finally {
    cleanup();
  }
});

test('enforces room lifecycle transitions and owner permissions', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Lifecycle',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: module.id
    });
    database.joinRoom({ code: room.code, playerId: 'player', displayName: 'Player' });

    assert.throws(
      () => database.setRoomStatus({ code: room.code, playerId: 'player', status: 'ACTIVE' }),
      (error) => error instanceof HttpError && error.statusCode === 403
    );

    assert.throws(
      () => database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ACTIVE' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );
    database.updateCharacterSheet({
      code: room.code,
      playerId: 'keeper',
      displayName: 'Keeper',
      characterSheet: characterSheet('守秘人代理')
    });
    database.updateCharacterSheet({
      code: room.code,
      playerId: 'player',
      displayName: 'Player',
      characterSheet: characterSheet('玩家角色')
    });
    database.setParticipantReady({ code: room.code, playerId: 'keeper', isReady: true });
    database.setParticipantReady({ code: room.code, playerId: 'player', isReady: true });
    assert.equal(database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ACTIVE' }).status, 'ACTIVE');
    assert.throws(
      () => database.joinRoom({ code: room.code, playerId: 'late', displayName: 'Late Player' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );
    assert.equal(database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'PAUSED' }).status, 'PAUSED');
    assert.equal(database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ACTIVE' }).status, 'ACTIVE');
    assert.equal(database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ENDED' }).status, 'ENDED');
    assert.equal(database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ARCHIVED' }).status, 'ARCHIVED');
    assert.throws(
      () => database.setRoomStatus({ code: room.code, playerId: 'keeper', status: 'ACTIVE' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );
  } finally {
    cleanup();
  }
});

test('persists chat, character profile, state, and story summary', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'p1');
    const { room } = database.createRoom({
      name: 'Archive',
      playerId: 'p1',
      displayName: 'Keeper',
      moduleId: module.id
    });

    const profile = database.updateProfile({
      code: room.code,
      playerId: 'p1',
      displayName: 'Keeper',
      characterName: 'Lina',
      characterCard: 'Rogue, level 3',
      state: 'HP 18/24'
    });
    assert.equal(profile.characterCard, 'Rogue, level 3');
    assert.equal(profile.state, 'HP 18/24');

    const summary = database.updateSummary({
      code: room.code,
      playerId: 'p1',
      summary: 'The party reached the ruined gate.'
    });
    assert.equal(summary.summary, 'The party reached the ruined gate.');

    const message = database.createPlayerMessage({
      code: room.code,
      playerId: 'p1',
      content: 'I inspect the sigils.',
      messageType: 'ACTION'
    });
    assert.equal(message.displayName, 'Lina');
    assert.equal(message.messageType, 'ACTION');

    const state = database.getRoomState(room.code);
    assert.equal(state.messages[0].content, 'I inspect the sigils.');
    assert.equal(state.messages[0].messageType, 'ACTION');
    assert.equal(state.room.summary, 'The party reached the ruined gate.');
    assert.equal(state.participants[0].characterName, 'Lina');
  } finally {
    cleanup();
  }
});

test('saves structured character sheets, derived state, ready flag, and field history', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'p1');
    const { room } = database.createRoom({
      name: 'Characters',
      playerId: 'p1',
      displayName: 'Keeper',
      moduleId: module.id
    });

    const saved = database.updateCharacterSheet({
      code: room.code,
      playerId: 'p1',
      displayName: 'Keeper',
      characterSheet: characterSheet('林娜', 72)
    });
    assert.equal(saved.characterName, '林娜');
    assert.equal(saved.characterSheet.skills.侦查, 72);
    assert.match(saved.state, /HP 11\/11/);
    assert.equal(saved.isReady, false);

    const ready = database.setParticipantReady({ code: room.code, playerId: 'p1', isReady: true });
    assert.equal(ready.isReady, true);

    const updated = database.updateCharacterSheet({
      code: room.code,
      playerId: 'p1',
      displayName: 'Keeper',
      characterSheet: characterSheet('林娜', 80)
    });
    assert.equal(updated.isReady, false);

    const history = database.getCharacterHistory({ code: room.code, playerId: 'p1' });
    assert.ok(history.some((entry) => entry.fieldPath === 'skills.侦查' && entry.newValue === 80));
  } finally {
    cleanup();
  }
});

test('persists public dice rolls with room state', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'p1');
    const { room } = database.createRoom({
      name: 'Dice',
      playerId: 'p1',
      displayName: 'Keeper',
      moduleId: module.id
    });

    const roll = database.createDiceRoll({
      code: room.code,
      playerId: 'p1',
      rollType: 'coc_check',
      expression: '1d100',
      label: '侦查',
      result: { type: 'coc_check', total: 41, target: 50, successLevel: 'REGULAR', passed: true }
    });

    assert.equal(roll.label, '侦查');
    assert.equal(roll.result.successLevel, 'REGULAR');
    assert.equal(database.getRoomState(room.code).diceRolls[0].id, roll.id);
  } finally {
    cleanup();
  }
});

test('stores reusable private modules and exposes preview only to owner', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'owner');
    assert.equal(database.listModules('owner')[0].id, module.id);

    const preview = database.getModuleForOwner(module.id, 'owner', {
      includeText: true,
      includeSegments: true
    });
    assert.match(preview.module.parsedText, /旧宅/);
    assert.equal(preview.segments.length, 1);

    assert.throws(
      () => database.getModuleForOwner(module.id, 'other', { includeSegments: true }),
      (error) => error instanceof HttpError && error.statusCode === 403
    );

    assert.throws(
      () => database.createRoom({
        name: 'Private',
        playerId: 'other',
        displayName: 'Other',
        moduleId: module.id
      }),
      (error) => error instanceof HttpError && error.statusCode === 403
    );
  } finally {
    cleanup();
  }
});
