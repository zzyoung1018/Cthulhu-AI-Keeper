import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import { exportGameJson } from '../src/export.js';
import { computeRollback } from '../src/rounds.js';

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
    },
    skillAllocations: {
      侦查: {
        occupation: Math.max(0, skillValue - 25),
        interest: 0
      }
    }
  };
}

test('creates rooms with configurable player limit and enforces it', () => {
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

    // Create a 2-player room and verify limit
    const mod2 = createModule(database, 'p1');
    const small = database.createRoom({
      name: '2p room', playerId: 'p1', displayName: 'Host', moduleId: mod2.id, maxPlayers: 2
    });
    assert.equal(small.room.maxPlayers, 2);
    database.joinRoom({ code: small.room.code, playerId: 'guest', displayName: 'Guest' });
    assert.throws(
      () => database.joinRoom({ code: small.room.code, playerId: 'extra', displayName: 'Extra' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );

    const mod3 = createModule(database, 'solo');
    const solo = database.createRoom({
      name: 'Solo debug room',
      playerId: 'solo',
      displayName: 'Solo Keeper',
      moduleId: mod3.id,
      maxPlayers: 1
    });
    assert.equal(solo.room.maxPlayers, 1);
    assert.throws(
      () => database.joinRoom({ code: solo.room.code, playerId: 'guest2', displayName: 'Guest 2' }),
      (error) => error instanceof HttpError && error.statusCode === 409
    );

    const mod4 = createModule(database, 'cap');
    const capped = database.createRoom({
      name: 'Capped room',
      playerId: 'cap',
      displayName: 'Cap Keeper',
      moduleId: mod4.id,
      maxPlayers: 99
    });
    assert.equal(capped.room.maxPlayers, 5);
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
    assert.deepEqual(saved.characterSheet.skillAllocations.侦查, { occupation: 47, interest: 0 });
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

test('runtime character state updates preserve ready flag and history', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'p1');
    const { room } = database.createRoom({
      name: 'Runtime State',
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
    database.setParticipantReady({ code: room.code, playerId: 'p1', isReady: true });

    const runtimeSheet = structuredClone(saved.characterSheet);
    runtimeSheet.status.hp = 5;
    const updated = database.updateCharacterRuntimeState({
      code: room.code,
      playerId: 'p1',
      characterSheet: runtimeSheet
    });

    assert.equal(updated.isReady, true);
    assert.equal(updated.characterSheet.status.hp, 5);
    assert.match(updated.state, /HP 5\/11/);

    const history = database.getCharacterHistory({ code: room.code, playerId: 'p1' });
    assert.ok(history.some((entry) => entry.fieldPath === 'status.hp' && entry.newValue === 5));
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

test('stores room AI settings without exposing API keys', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'AI Config',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: module.id
    });
    database.joinRoom({ code: room.code, playerId: 'player', displayName: 'Player' });

    assert.throws(
      () => database.updateRoomAiConfig({
        code: room.code,
        playerId: 'player',
        aiConfig: { model: 'bad' }
      }),
      (error) => error instanceof HttpError && error.statusCode === 403
    );

    const updated = database.updateRoomAiConfig({
      code: room.code,
      playerId: 'keeper',
      aiConfig: {
        baseUrl: 'https://example.test/v1/',
        apiKey: 'room-secret',
        model: 'keeper-model',
        dmStyle: '冷静、克制。',
        narrativeDetail: 'RICH',
        rulesStrictness: 'STRICT',
        allowModuleExpansion: true,
        triggerMode: 'ROUND',
        keeperReviewRequired: true,
        contentBoundaries: '不描述血腥细节。'
      }
    });

    assert.equal(updated.aiConfig.baseUrl, 'https://example.test/v1');
    assert.equal(updated.aiConfig.model, 'keeper-model');
    assert.equal(updated.aiConfig.apiKeyConfigured, true);
    assert.equal(updated.aiConfig.apiKey, undefined);
    assert.equal(database.getRoomAiSettings(room.code).apiKey, 'room-secret');
    assert.equal(database.getRoomState(room.code).room.aiConfig.apiKey, undefined);
  } finally {
    cleanup();
  }
});

test('persists AI task lifecycle, idempotency, and cancellation permissions', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'AI Tasks',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: module.id
    });
    database.joinRoom({ code: room.code, playerId: 'player', displayName: 'Player' });
    const message = database.createPlayerMessage({
      code: room.code,
      playerId: 'keeper',
      content: '我推门。',
      messageType: 'ACTION'
    });

    const first = database.createAiTask({
      code: room.code,
      playerId: 'keeper',
      triggerMessageId: message.id,
      idempotencyKey: `message:${message.id}`
    });
    const duplicate = database.createAiTask({
      code: room.code,
      playerId: 'keeper',
      triggerMessageId: message.id,
      idempotencyKey: `message:${message.id}`
    });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.task.uid, first.task.uid);
    assert.equal(database.getRoomState(room.code).activeAiTask.uid, first.task.uid);

    const streaming = database.updateAiTaskStatus({ taskUid: first.task.uid, status: 'STREAMING' });
    assert.equal(streaming.status, 'STREAMING');
    assert.ok(streaming.startedAt);

    assert.throws(
      () => database.requestAiTaskCancel({ code: room.code, playerId: 'player', taskUid: first.task.uid }),
      (error) => error instanceof HttpError && error.statusCode === 403
    );

    const cancelled = database.requestAiTaskCancel({ code: room.code, playerId: 'keeper', taskUid: first.task.uid });
    assert.equal(cancelled.cancelRequested, true);
    const completed = database.updateAiTaskStatus({ taskUid: first.task.uid, status: 'CANCELLED' });
    assert.equal(completed.status, 'CANCELLED');
    assert.ok(completed.completedAt);
    assert.equal(database.getRoomState(room.code).activeAiTask, null);

    const processedMessage = database.markAiTriggerProcessed({ taskUid: first.task.uid });
    assert.equal(processedMessage.id, message.id);
    assert.equal(processedMessage.aiProcessedTaskUid, first.task.uid);
    assert.ok(processedMessage.aiProcessedAt);

    const regenerated = database.createRegenerationTask({
      code: room.code,
      playerId: 'keeper',
      sourceTaskUid: first.task.uid
    });
    assert.equal(regenerated.created, true);
    assert.equal(regenerated.task.triggerMessageId, message.id);
  } finally {
    cleanup();
  }
});

test('persists AI detection logs in SQLite', () => {
  const { database, cleanup } = withDb();
  try {
    const module = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'AI Logs',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: module.id
    });

    const log = database.createAiLog({
      code: room.code,
      taskUid: 'task-1',
      stage: 'structured-events',
      entry: {
        stage: 'structured-events',
        taskUid: 'task-1',
        validKeys: ['required_checks'],
        detection: { inferredRequiredReason: 'generic-侦查' }
      }
    });

    assert.ok(log.id > 0);
    const logs = database.listAiLogs({ code: room.code });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].stage, 'structured-events');
    assert.equal(logs[0].taskUid, 'task-1');
    assert.deepEqual(logs[0].validKeys, ['required_checks']);
  } finally {
    cleanup();
  }
});

test('filters private messages from other players in room state', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Private Msg',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });
    database.joinRoom({ code: room.code, playerId: 'player1', displayName: 'Alice' });
    database.joinRoom({ code: room.code, playerId: 'player2', displayName: 'Bob' });

    // Keeper sends private message to player1
    const { participant: keeperP } = database.getParticipant(room.code, 'keeper');
    database.createMessage({
      code: room.code,
      authorType: 'player',
      messageType: 'PRIVATE',
      playerId: 'keeper',
      participantId: keeperP.id,
      displayName: 'Keeper',
      content: 'secret for Alice',
      status: 'complete',
      privateTarget: 'player1'
    });

    // Public message
    database.createPlayerMessage({ code: room.code, playerId: 'keeper', content: 'public msg', messageType: 'IC' });

    // Player1 sees both messages (public + their private)
    const state1 = database.getRoomState(room.code, { playerId: 'player1' });
    assert.equal(state1.messages.length, 2);
    assert.ok(state1.messages.some((m) => m.content === 'secret for Alice'));
    assert.ok(state1.messages.some((m) => m.content === 'public msg'));

    // Player2 only sees public message
    const state2 = database.getRoomState(room.code, { playerId: 'player2' });
    assert.equal(state2.messages.length, 1);
    assert.equal(state2.messages[0].content, 'public msg');

    // Anonymous viewer (no playerId) sees only public
    const state3 = database.getRoomState(room.code);
    assert.equal(state3.messages.length, 1);
  } finally {
    cleanup();
  }
});

test('filters private dice rolls from other players', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Dice Priv',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });
    database.joinRoom({ code: room.code, playerId: 'player1', displayName: 'Alice' });

    database.createDiceRoll({
      code: room.code,
      playerId: 'keeper',
      rollType: 'coc_check',
      expression: '1d100',
      label: '秘密侦察',
      isPrivate: true,
      result: { type: 'coc_check', total: 41, target: 50, successLevel: 'REGULAR', passed: true }
    });
    database.createDiceRoll({
      code: room.code,
      playerId: 'keeper',
      rollType: 'expression',
      expression: '2d6',
      label: '公开伤害',
      result: { type: 'expression', total: 7, rolls: [3, 4] }
    });

    const keeperState = database.getRoomState(room.code, { playerId: 'keeper' });
    assert.equal(keeperState.diceRolls.length, 2);

    const playerState = database.getRoomState(room.code, { playerId: 'player1' });
    assert.equal(playerState.diceRolls.length, 1);
    assert.equal(playerState.diceRolls[0].label, '公开伤害');
  } finally {
    cleanup();
  }
});

test('creates and lists round states for rollback tracking', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Rounds',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });

    const round = database.createRoundState({
      roomId: room.id,
      aiTaskUid: 'test-task-uid',
      dmMessageId: null,
      snapshotJson: JSON.stringify({ participants: [], summary: 'test' })
    });

    assert.ok(round.id > 0);
    assert.equal(round.roomId, room.id);
    assert.equal(round.aiTaskUid, 'test-task-uid');
    assert.equal(round.isRolledBack, false);

    const rounds = database.listRoundStates(room.id);
    assert.equal(rounds.length, 1);
    assert.equal(database.getRoundStateByTaskUid(room.id, 'test-task-uid').id, round.id);

    database.markRoundRolledBack(round.id);
    const rolled = database.getRoundState(round.id);
    assert.equal(rolled.isRolledBack, true);
  } finally {
    cleanup();
  }
});

test('rollback by task uid restores snapshots, summary, scene state, and marks messages rolled back', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Rollback',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });

    // Set initial character
    database.updateCharacterSheet({
      code: room.code,
      playerId: 'keeper',
      displayName: 'Keeper',
      characterSheet: characterSheet('林娜', 60)
    });

    // Create a message
    const msg = database.createPlayerMessage({
      code: room.code,
      playerId: 'keeper',
      content: 'test',
      messageType: 'IC'
    });
    const sideEffectMessage = database.createMessage({
      code: room.code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '必要检定',
      content: '侦查检定结果',
      status: 'complete'
    });
    const sideEffectRoll = database.createDiceRoll({
      code: room.code,
      playerId: 'keeper',
      rollType: 'skill_check',
      expression: '1d100',
      label: '侦查',
      result: { total: 41, target: 60, successLevel: 'REGULAR', passed: true }
    });

    // Create round state with pre-change snapshot
    const round = database.createRoundState({
      roomId: room.id,
      aiTaskUid: 'rollback-test',
      dmMessageId: msg.id,
      snapshotJson: JSON.stringify({
        participants: [{
          playerId: 'keeper',
          characterSheet: characterSheet('旧名', 50),
          characterRevision: 0
        }],
        summary: 'old summary',
        sceneState: JSON.stringify({ currentScene: 'old_scene' }),
        rollbackRefs: {
          messageIds: [sideEffectMessage.id],
          diceRollIds: [sideEffectRoll.id]
        }
      })
    });

    database.forceUpdateSummary(room.id, 'new summary');
    database.forceUpdateSceneState(room.id, { currentScene: 'new_scene' });
    const result = computeRollback({
      database,
      roomCode: room.code,
      playerId: 'keeper',
      taskUid: 'rollback-test'
    });

    // Verify rollback
    assert.equal(result.roundId, round.id);
    assert.equal(result.aiTaskUid, 'rollback-test');
    const rolledMsg = database.getMessageById(msg.id);
    assert.equal(rolledMsg.isRolledBack, true);
    const rolledSideEffect = database.getMessageById(sideEffectMessage.id);
    assert.equal(rolledSideEffect.isRolledBack, true);

    const state = database.getRoomState(room.code);
    assert.equal(state.messages.length, 0); // Rolled back messages are filtered
    assert.equal(state.diceRolls.length, 0);
    assert.equal(state.room.summary, 'old summary');
    assert.equal(JSON.parse(state.room.sceneState).currentScene, 'old_scene');
  } finally {
    cleanup();
  }
});

test('export state includes full owner context and hides private module from non-owners', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Export',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });
    database.joinRoom({ code: room.code, playerId: 'player2', displayName: 'Player 2' });
    database.forceUpdateSceneState(room.id, { currentScene: 'old_house' });
    database.updateSummary({ code: room.code, playerId: 'keeper', summary: '调查开始。' });

    database.createPlayerMessage({ code: room.code, playerId: 'keeper', content: 'msg1', messageType: 'IC' });
    database.createPlayerMessage({ code: room.code, playerId: 'keeper', content: 'msg2', messageType: 'ACTION' });
    database.createDiceRoll({
      code: room.code,
      playerId: 'keeper',
      rollType: 'coc_check',
      expression: '1d100',
      label: '侦察',
      result: { total: 41, target: 60, successLevel: 'REGULAR', passed: true }
    });
    database.createAiLog({
      code: room.code,
      taskUid: 'task-1',
      stage: 'structured-events',
      entry: { eventKeys: ['summary_update'] }
    });

    const exportState = database.getExportState(room.code, 'keeper');
    assert.equal(exportState.messages.length, 2);
    assert.equal(exportState.diceRolls.length, 1);
    assert.equal(exportState.room.code, room.code);
    assert.equal(exportState.room.summary, '调查开始。');
    assert.equal(JSON.parse(exportState.room.sceneState).currentScene, 'old_house');
    assert.equal(exportState.participants.length, 2);
    assert.equal(exportState.isOwnerExport, true);
    assert.equal(exportState.module.title, '死亡之光');
    assert.match(exportState.module.parsedText, /旧宅/);
    assert.equal(exportState.moduleSegments.length, 1);
    assert.equal(exportState.aiLogs.length, 1);
    const exportedJson = JSON.parse(exportGameJson(exportState));
    assert.equal(exportedJson.isOwnerExport, true);
    assert.equal(exportedJson.room.sceneState, exportState.room.sceneState);
    assert.match(exportedJson.module.parsedText, /旧宅/);
    assert.equal(exportedJson.moduleSegments[0].content, '调查员来到旧宅。');
    assert.equal(exportedJson.aiLogs[0].stage, 'structured-events');

    const playerExport = database.getExportState(room.code, 'player2');
    assert.equal(playerExport.isOwnerExport, false);
    assert.equal(playerExport.module, null);
    assert.deepEqual(playerExport.moduleSegments, []);
    assert.deepEqual(playerExport.aiLogs, []);
  } finally {
    cleanup();
  }
});

test('getRoomByCode returns room without participant lookup', () => {
  const { database, cleanup } = withDb();
  try {
    const mod = createModule(database, 'keeper');
    const { room } = database.createRoom({
      name: 'Lookup',
      playerId: 'keeper',
      displayName: 'Keeper',
      moduleId: mod.id
    });

    const found = database.getRoomByCode(room.code);
    assert.ok(found);
    assert.equal(found.code, room.code);
  } finally {
    cleanup();
  }
});
