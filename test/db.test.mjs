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

test('creates rooms, joins players, and enforces the five-player limit', () => {
  const { database, cleanup } = withDb();
  try {
    const created = database.createRoom({
      name: 'Test Table',
      playerId: 'p1',
      displayName: 'Player 1'
    });

    assert.equal(created.room.code.length, 6);
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

test('persists chat, character profile, state, and story summary', () => {
  const { database, cleanup } = withDb();
  try {
    const { room } = database.createRoom({
      name: 'Archive',
      playerId: 'p1',
      displayName: 'Keeper'
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
      content: 'I inspect the sigils.'
    });
    assert.equal(message.displayName, 'Lina');

    const state = database.getRoomState(room.code);
    assert.equal(state.messages[0].content, 'I inspect the sigils.');
    assert.equal(state.room.summary, 'The party reached the ruined gate.');
    assert.equal(state.participants[0].characterName, 'Lina');
  } finally {
    cleanup();
  }
});
