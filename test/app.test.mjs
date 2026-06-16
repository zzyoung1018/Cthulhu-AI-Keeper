import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, parseRequestUrl } from '../src/app.js';

test('handles malformed Host headers without crashing', () => {
  const url = parseRequestUrl({
    url: '/',
    headers: { host: '008.153.147.137' }
  });

  assert.equal(url.pathname, '/');
  assert.equal(url.origin, 'http://localhost');
});

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function createModule(database, ownerPlayerId) {
  return database.createModule({
    ownerPlayerId,
    title: '测试模组',
    originalName: 'module.txt',
    fileType: 'txt',
    contentType: 'text/plain',
    sizeBytes: 12,
    storagePath: '/tmp/module.txt',
    parsedText: '场景：测试',
    parseStatus: 'PARSED',
    segments: [{ title: '测试', scene: '测试 #1', content: '测试场景。' }]
  });
}

function characterSheet() {
  return {
    investigator: { name: '林娜', occupation: '记者' },
    characteristics: {
      STR: 50,
      CON: 50,
      SIZ: 50,
      DEX: 50,
      APP: 50,
      INT: 50,
      POW: 50,
      EDU: 50,
      Luck: 50
    },
    skills: { 侦查: 68, 图书馆使用: 55, 话术: 60, 心理学: 50 }
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForState(baseUrl, code, playerId, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await jsonRequest(baseUrl, `/api/rooms/${code}?playerId=${playerId}`);
    if (predicate(latest)) return latest;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for room state. Latest task: ${JSON.stringify(latest?.activeAiTask || null)}`);
}

async function startFakeAiServer(responseText) {
  const requests = [];
  const encoderChunks = String(responseText).match(/.{1,24}/gs) || [''];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, body: JSON.parse(body || '{}') });

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    for (const chunk of encoderChunks) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });

  const baseUrl = await new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListen(`http://127.0.0.1:${address.port}/v1`);
    });
  });

  return {
    baseUrl,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

test('skill rolls use the server-side character sheet target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: { localFallback: true }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'p1');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        roomName: 'Skill Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', isReady: true })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', status: 'ACTIVE' })
    });

    const rolled = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/rolls`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        rollType: 'skill',
        skillName: '侦查',
        target: 5
      })
    });

    assert.equal(rolled.roll.rollType, 'skill_check');
    assert.equal(rolled.roll.result.skillName, '侦查');
    assert.equal(rolled.roll.result.target, 68);
    assert.match(rolled.message.content, /侦查/);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private messages require a valid room participant target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: { localFallback: true }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'owner');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'owner',
        displayName: 'Keeper',
        roomName: 'Private Target Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'guest', displayName: 'Guest' })
    });

    const missingTarget = await fetch(`${baseUrl}/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'owner',
        messageType: 'PRIVATE',
        content: 'secret'
      })
    });
    const missingBody = await missingTarget.json();
    assert.equal(missingTarget.status, 400);
    assert.match(missingBody.error, /privateTarget is required/);

    const unknownTarget = await fetch(`${baseUrl}/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'owner',
        messageType: 'PRIVATE',
        privateTarget: 'missing-player',
        content: 'secret'
      })
    });
    const unknownBody = await unknownTarget.json();
    assert.equal(unknownTarget.status, 400);
    assert.match(unknownBody.error, /room participant/);

    const valid = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'owner',
        messageType: 'PRIVATE',
        privateTarget: 'guest',
        content: 'secret'
      })
    });
    assert.equal(valid.message.privateTarget, 'guest');
    assert.equal(valid.aiQueued, false);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI required_checks are executed as server-side rolls', async () => {
  const aiText = [
    '书桌边缘的潮气让木板微微翘起，你的手停在抽屉下沿。',
    '',
    '```json',
    JSON.stringify({
      required_checks: [
        {
          skill: '侦查',
          difficulty: 'HARD',
          reason: '检查书桌下方是否有隐藏暗格',
          playerHint: '你需要判断那些划痕是否只是潮气造成的痕迹。'
        }
      ],
      summary_update: '调查员开始检查招待所房间里的书桌。'
    }, null, 2),
    '```'
  ].join('\n');
  const fakeAi = await startFakeAiServer(aiText);
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: {
        baseUrl: fakeAi.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.1,
        timeoutMs: 10_000,
        localFallback: false
      }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'p1');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        roomName: 'AI Check Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', isReady: true })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', status: 'ACTIVE' })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我把注意力放在书桌边缘，等 DM 判断。'
      })
    });

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 1);
    assert.equal(fakeAi.requests[0].url, '/v1/chat/completions');
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'system' && /required_checks/.test(message.content) && /JSON\.parse/.test(message.content)
    ));

    const roll = state.diceRolls.find((item) => item.label === '侦查');
    assert.ok(roll);
    assert.equal(roll.playerId, 'p1');
    assert.equal(roll.rollType, 'skill_check');
    assert.equal(roll.result.target, 68);
    assert.equal(roll.result.difficulty, 'HARD');

    const checkMessage = state.messages.find((message) => message.displayName === '必要检定');
    assert.ok(checkMessage);
    assert.match(checkMessage.content, /侦查\(68\)/);
    assert.match(checkMessage.content, /难度：困难/);

    const dmMessage = state.messages.find((message) => message.authorType === 'dm');
    assert.ok(dmMessage);
    assert.doesNotMatch(dmMessage.content, /```json/);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight required checks roll before AI continuation', async () => {
  const fakeAi = await startFakeAiServer('骰点结果出来后，书桌下沿的划痕显得更清楚。\n\n```json\n{}\n```');
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: {
        baseUrl: fakeAi.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.1,
        timeoutMs: 10_000,
        localFallback: false
      }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'p1');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        roomName: 'Preflight Check Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', isReady: true })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', status: 'ACTIVE' })
    });

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。'
      })
    });

    assert.equal(submitted.preflightCheck.type, 'required');
    assert.equal(submitted.preflightCheck.messageId, submitted.aiTask.triggerMessageId);
    assert.match(submitted.aiTask.idempotencyKey, /^precheck:/);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 1);
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));

    const rolls = state.diceRolls.filter((roll) => roll.label === '侦查');
    assert.equal(rolls.length, 1);
    assert.equal(rolls[0].playerId, 'p1');

    const checkMessages = state.messages.filter((message) => message.displayName === '必要检定');
    assert.equal(checkMessages.length, 1);
    assert.match(checkMessages[0].content, /侦查\(68\)/);

    const dmMessage = state.messages.find((message) => message.authorType === 'dm');
    assert.ok(dmMessage);
    assert.doesNotMatch(dmMessage.content, /```json/);

    const rolledBack = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/rollback/${submitted.aiTask.uid}`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'p1' })
    });

    assert.equal(rolledBack.rolledBack, true);
    assert.equal(rolledBack.messages.some((message) => message.displayName === '必要检定'), false);
    assert.equal(rolledBack.messages.some((message) => message.authorType === 'dm'), false);
    assert.equal(rolledBack.diceRolls.some((roll) => roll.label === '侦查'), false);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight opposed checks use recent NPC context before AI narration', async () => {
  const fakeAi = await startFakeAiServer('检定结果让陈友的态度出现了细微变化。\n\n```json\n{}\n```');
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: {
        baseUrl: fakeAi.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.1,
        timeoutMs: 10_000,
        localFallback: false
      }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'p1');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        roomName: 'Preflight Opposed Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', isReady: true })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', status: 'ACTIVE' })
    });

    app.database.createMessage({
      code: created.room.code,
      authorType: 'dm',
      messageType: 'AI_DM',
      displayName: 'AI DM',
      content: '陈友把茶缸放在柜台边，抬头等你继续解释。'
    });

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '其实我祖上也是我们村的人'
      })
    });

    assert.equal(submitted.preflightCheck.type, 'opposed');
    assert.equal(submitted.preflightCheck.messageId, submitted.aiTask.triggerMessageId);
    assert.match(submitted.aiTask.idempotencyKey, /^precheck:/);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));

    const opposedRolls = state.diceRolls.filter((roll) => roll.rollType === 'contested_check');
    assert.equal(opposedRolls.length, 1);
    assert.match(opposedRolls[0].label, /话术 vs 陈友/);

    const checkMessage = state.messages.find((message) => message.displayName === '对抗检定');
    assert.ok(checkMessage);
    assert.match(checkMessage.content, /陈友/);
    assert.match(checkMessage.content, /话术\(60\)/);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continue endpoint queues AI without creating a visible player action', async () => {
  const fakeAi = await startFakeAiServer('陈友看着刚才的检定结果，态度随之改变。\n\n```json\n{}\n```');
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: {
        baseUrl: fakeAi.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.1,
        timeoutMs: 10_000,
        localFallback: false
      }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'p1');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        roomName: 'Continue Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', isReady: true })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'p1', status: 'ACTIVE' })
    });

    const checkMessage = app.database.createMessage({
      code: created.room.code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '必要检定',
      content: '🎲 必要检定：林娜 的 侦查(68)\n1d100 = 22 → HARD（成功）',
      status: 'complete'
    });

    const queued = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/continue`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        checkMessageId: checkMessage.id
      })
    });
    assert.equal(queued.created, true);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 1);
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.equal(state.messages.some((message) =>
      message.authorType === 'player' &&
      message.messageType === 'ACTION' &&
      /继续/.test(message.content)
    ), false);
    assert.ok(state.messages.some((message) => message.authorType === 'dm'));
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI log endpoint is only visible to the room owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-app-test-'));
  const app = createApp({
    config: {
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      publicDir: resolve('public'),
      ai: { localFallback: true }
    },
    publicDir: resolve('public')
  });

  try {
    const baseUrl = await new Promise((resolveListen) => {
      app.server.listen(0, '127.0.0.1', () => {
        const address = app.server.address();
        resolveListen(`http://127.0.0.1:${address.port}`);
      });
    });

    const module = createModule(app.database, 'owner');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'owner',
        displayName: 'Keeper',
        roomName: 'Log Room',
        moduleId: module.id
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'player2', displayName: 'Player 2' })
    });

    const ownerPayload = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ai-log?playerId=owner`);
    assert.deepEqual(ownerPayload.logs, []);

    const response = await fetch(`${baseUrl}/api/rooms/${created.room.code}/ai-log?playerId=player2`);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.match(body.error, /Only the room owner/);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
