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
    skills: { 侦查: 68, 图书馆使用: 55 }
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
        content: '我检查书桌下面有没有隐藏暗格。'
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
