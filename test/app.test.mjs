import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, parseRequestUrl } from '../src/app.js';
import { exportGameJson } from '../src/export.js';

test('handles malformed Host headers without crashing', () => {
  const url = parseRequestUrl({
    url: '/',
    headers: { host: '008.example.invalid' }
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

function createIntroJsonModule(database, ownerPlayerId) {
  const moduleJson = {
    schema_version: '1.0',
    module_info: {
      title: '现实的荒原',
      system: 'Call of Cthulhu 7th Edition',
      recommended_players: '1-6名调查员',
      estimated_duration: '8-20小时',
      setting: '2008年次贷危机后的美国。',
      time_period: '2008年末至2009年初',
      location: '美国底特律郊区一座废弃汽车工会大厅。',
      themes: ['经济崩溃', '绝望', '现实缺失'],
      tone: '文学化、压抑、冷幽默。',
      content_warnings: ['经济危机与失业', '精神崩溃']
    },
    player_opening: {
      initial_public_information: '调查员是被现实碾碎的人。一个富有银行家在底特律近郊酒吧给出现金预付款和一张模糊照片，要求调查废弃汽车工会大厅里直径一米的完美球形空缺。',
      initial_scene_id: 'bar_commission',
      initial_objective: '前往废弃汽车工会大厅，观察直径一米的完美球形空缺，弄清它是什么、是否会扩张、能否填上。',
      suggested_intro_text: '门口风铃响起，炭灰色西装的中年人把厚厚的牛皮纸信封放在你的桌前。照片显示一个圆形空缺，委托指向工会大厅里直径一米的完美球形空缺。',
      known_npcs: ['npc_patron'],
      known_locations: ['bar_commission', 'union_hall_void'],
      known_handouts: ['asset_blurry_void_photo', 'asset_cash_envelope']
    },
    keeper_overview: {
      truth: '委托人是奈亚拉托提普化身。',
      investigation_goal: '回答空洞的三个问题。',
      default_opening: '调查员在底特律近郊酒吧收到委托。'
    },
    scenes: [
      {
        scene_id: 'bar_commission',
        name: '底特律近郊酒吧委托',
        player_visible_description: '即将倒闭的酒吧里，富有银行家用现金信封和模糊照片雇佣绝望中的调查员。'
      },
      {
        scene_id: 'union_hall_void',
        name: '废弃汽车工会大厅与空洞',
        player_visible_description: '主厅中央有直径一米的完美球形空缺。'
      }
    ],
    npcs: [
      {
        npc_id: 'npc_patron',
        name: '富有的银行家',
        role: '委托人，奈亚拉托提普化身'
      }
    ],
    visual_assets: [
      {
        asset_id: 'asset_blurry_void_photo',
        name: '模糊的空洞照片',
        player_visible_description: '照片里有一个完美圆形空缺，像某物被精确切走。'
      },
      {
        asset_id: 'asset_cash_envelope',
        name: '预付款牛皮纸信封',
        player_visible_description: '里面现金大概够调查员生活一周。'
      }
    ],
    checks: [
      { check_id: 'spot_void', skill: '侦查' },
      { check_id: 'listen_hall', skill: '聆听' },
      { check_id: 'read_records', skill: '图书馆使用' }
    ]
  };

  return database.createModule({
    ownerPlayerId,
    title: moduleJson.module_info.title,
    originalName: 'lina.json',
    fileType: 'json',
    contentType: 'application/json',
    sizeBytes: 1000,
    storagePath: '/tmp/lina.json',
    parsedText: JSON.stringify(moduleJson, null, 2),
    parseStatus: 'PARSED',
    segments: [
      { title: '现实的荒原', scene: '模组概览', content: moduleJson.module_info.setting },
      { title: '开场信息', scene: '玩家开场', content: moduleJson.player_opening.initial_public_information }
    ]
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
    skills: { 侦查: 68, 聆听: 45, 图书馆使用: 55, 话术: 60, 心理学: 50 }
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

async function activateRoom(baseUrl, code, playerId) {
  const payload = await jsonRequest(baseUrl, `/api/rooms/${code}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ playerId, status: 'ACTIVE' })
  });
  if (payload.openingTask) {
    await waitForState(
      baseUrl,
      code,
      playerId,
      (roomState) => roomState.aiTasks.some((task) =>
        task.uid === payload.openingTask.uid &&
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)
      )
    );
  }
  return payload;
}

function findAiRequest(requests, predicate) {
  return requests.find((request) => predicate(request.body.messages || []));
}

async function waitForPredicate(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for predicate');
}

async function startFakeAiServer(responseText, { chunkDelayMs = 0 } = {}) {
  const requests = [];
  const responses = Array.isArray(responseText) ? responseText.map(String) : [String(responseText)];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const responseTextForRequest = responses[Math.min(requests.length, responses.length - 1)] || '';
    const encoderChunks = responseTextForRequest.match(/.{1,24}/gs) || [''];
    requests.push({ url: request.url, method: request.method, body: JSON.parse(body || '{}') });

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    for (const chunk of encoderChunks) {
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
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

test('module intro keeps a natural synopsis while preserving core hook facts', async () => {
  const fakeAi = await startFakeAiServer([
    '## 剧情简介',
    '',
    '经济危机像沉重的灰尘落在每个人肩上，调查员会被一项关于废弃汽车工会大厅里直径一米的完美球形空缺的委托卷入。这个故事的压力来自贫困、现实缺失，以及那个无法用常识命名的问题。',
    '',
    '## 玩家公开前提',
    '你已经知道：银行家给了现金和照片。'
  ].join('\n'));
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

    const module = createIntroJsonModule(app.database, 'keeper');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'keeper',
        displayName: 'Keeper',
        roomName: 'Intro Room',
        moduleId: module.id
      })
    });

    const queued = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/start-intro`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'keeper' })
    });
    assert.equal(queued.created, true);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'keeper',
      (roomState) => roomState.aiTasks.some((task) => task.uid === queued.task.uid && task.status === 'COMPLETED')
    );

    const intro = state.messages.find((message) => message.displayName === 'AI 守秘人');
    assert.ok(intro);
    assert.match(intro.content, /## 剧情简介/);
    assert.doesNotMatch(intro.content, /## 模组简介/);
    assert.doesNotMatch(intro.content, /## 玩家公开前提/);
    assert.doesNotMatch(intro.content, /## 调查员创建指南/);
    assert.doesNotMatch(intro.content, /## 注意事项/);
    assert.doesNotMatch(intro.content, /## 开局场景/);
    assert.match(intro.content, /废弃汽车工会大厅/);
    assert.match(intro.content, /直径一米的完美球形空缺/);
    assert.doesNotMatch(intro.content, /你已经知道/);
    assert.doesNotMatch(intro.content, /预付款牛皮纸信封|牛皮纸信封|模糊照片|现金和照片/);
    assert.doesNotMatch(intro.content, /球形凹陷|凹陷|坑洞|黑洞/);
    assert.doesNotMatch(intro.content, /奈亚拉托提普化身/);
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'user' &&
      /准备阶段剧情简介素材/.test(message.content) &&
      /只允许输出一个标题：## 剧情简介/.test(message.content) &&
      /直径一米的完美球形空缺/.test(message.content) &&
      /前往废弃汽车工会大厅/.test(message.content) &&
      !/玩家已知NPC|玩家已知地点|玩家已知道具/.test(message.content) &&
      !/建议开场文本/.test(message.content)
    ));
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('starting the game automatically queues the opening scene', async () => {
  const fakeAi = await startFakeAiServer('门口风铃响起，炭灰色西装的中年人把信封放下。照片里提到的地方，在西边七英里的工会大厅中呈现为直径约一米的完美球形凹陷。');
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

    const module = createIntroJsonModule(app.database, 'keeper');
    const created = await jsonRequest(baseUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'keeper',
        displayName: 'Keeper',
        roomName: 'Opening Room',
        moduleId: module.id
      })
    });

    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'keeper',
        displayName: 'Keeper',
        characterSheet: characterSheet()
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'keeper', isReady: true })
    });

    const started = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId: 'keeper', status: 'ACTIVE' })
    });
    assert.equal(started.openingCreated, true);
    assert.ok(started.openingTask);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'keeper',
      (roomState) => roomState.aiTasks.some((task) => task.uid === started.openingTask.uid && task.status === 'COMPLETED')
    );

    const opening = state.messages.find((message) => message.displayName === 'AI DM');
    assert.ok(opening);
    assert.match(opening.content, /炭灰色西装/);
    assert.match(opening.content, /直径一米的完美球形空缺/);
    assert.doesNotMatch(opening.content, /球形凹陷|直径约一米/);
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'system' &&
      /刚从准备阶段进入游玩阶段/.test(message.content) &&
      /不要输出 structured JSON/.test(message.content)
    ));
    assert.ok(fakeAi.requests[0].body.messages.some((message) =>
      message.role === 'user' &&
      /建议开场文本/.test(message.content) &&
      /炭灰色西装/.test(message.content)
    ));
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    await activateRoom(baseUrl, created.room.code, 'p1');

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
  const fakeAi = await startFakeAiServer(['开场叙事。', aiText]);
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
    await activateRoom(baseUrl, created.room.code, 'p1');

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
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
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 2);
    const structuredRequest = findAiRequest(fakeAi.requests, (messages) => messages.some((message) =>
      message.role === 'system' && /required_checks/.test(message.content) && /JSON\.parse/.test(message.content)
    ));
    assert.ok(structuredRequest);
    assert.equal(structuredRequest.url, '/v1/chat/completions');

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
  const fakeAi = await startFakeAiServer([
    '开场叙事。',
    '骰点结果出来后，书桌下沿的划痕显得更清楚。\n\n```json\n{}\n```'
  ]);
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
    await activateRoom(baseUrl, created.room.code, 'p1');

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。'
      })
    });

    assert.equal(submitted.preflightCheck, null);
    assert.equal(submitted.aiTask.triggerMessageId, submitted.message.id);
    assert.match(submitted.aiTask.idempotencyKey, /^message:/);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 2);
    const continuationRequest = findAiRequest(fakeAi.requests, (messages) => messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.ok(continuationRequest);

    const rolls = state.diceRolls.filter((roll) => roll.label === '侦查');
    assert.equal(rolls.length, 1);
    assert.equal(rolls[0].playerId, 'p1');

    const checkMessages = state.messages.filter((message) => message.displayName === '必要检定');
    assert.equal(checkMessages.length, 1);
    assert.match(checkMessages[0].content, /侦查\(68\)/);

    const completedTask = state.aiTasks.find((task) => task.uid === submitted.aiTask.uid);
    assert.equal(completedTask.triggerMessageId, checkMessages[0].id);

    const dmMessage = state.messages.find((message) => message.authorType === 'dm');
    assert.ok(dmMessage);
    assert.doesNotMatch(dmMessage.content, /```json/);

    const rolledBack = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/rollback/${submitted.aiTask.uid}`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'p1' })
    });

    assert.equal(rolledBack.rolledBack, true);
    assert.equal(rolledBack.messages.some((message) => message.displayName === '必要检定'), false);
    assert.equal(rolledBack.messages.some((message) =>
      message.authorType === 'dm' && /骰点结果出来后/.test(message.content)
    ), false);
    assert.equal(rolledBack.diceRolls.some((roll) => roll.label === '侦查'), false);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI assisted mode waits for owner adjudication before narration', async () => {
  const fakeAi = await startFakeAiServer([
    [
      '骰点结果出来后，书桌下沿的划痕显得更清楚。',
      '',
      '```json',
      JSON.stringify({
        required_checks: [
          { targetPlayerId: 'p1', skill: '聆听', difficulty: 'HARD', reason: 'AI 不应在辅助模式自行追加检定' }
        ]
      }),
      '```'
    ].join('\n')
  ]);
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
        roomName: 'Assisted Room',
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
    app.database.setRoomStatus({ code: created.room.code, playerId: 'p1', status: 'ACTIVE' });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ai-config`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: 'p1',
        aiConfig: { triggerMode: 'ASSISTED' }
      })
    });

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。'
      })
    });

    assert.equal(submitted.aiQueued, false);
    assert.equal(submitted.assistedPending, true);
    assert.equal(submitted.aiTask, null);
    assert.equal(fakeAi.requests.length, 0);

    const adjudicated = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/adjudications`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        actionMessageId: submitted.message.id,
        decision: 'REQUIRED_CHECK',
        targetPlayerId: 'p1',
        skillName: '侦查',
        difficulty: 'HARD',
        bonusDice: 1,
        reason: '房主认为需要细查'
      })
    });

    assert.equal(adjudicated.aiQueued, true);
    assert.equal(adjudicated.adjudicationMessage.displayName, '必要检定');
    assert.match(adjudicated.adjudicationMessage.content, /奖励骰/);
    assert.match(adjudicated.adjudicationMessage.content, /候选/);
    assert.equal(adjudicated.roll.label, '侦查');
    assert.equal(adjudicated.roll.result.target, 68);

    const completed = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === adjudicated.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 1);
    const continuationRequest = findAiRequest(fakeAi.requests, (messages) => messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.ok(continuationRequest);

    const action = completed.messages.find((message) => message.id === submitted.message.id);
    assert.equal(action.aiProcessedTaskUid, adjudicated.aiTask.uid);
    assert.equal(completed.diceRolls.filter((roll) => roll.label === '侦查').length, 1);
    assert.equal(completed.diceRolls.some((roll) => roll.label === '聆听'), false);

    const dmMessage = completed.messages.find((message) => message.authorType === 'dm');
    assert.ok(dmMessage);
    assert.match(dmMessage.content, /划痕显得更清楚/);
    assert.doesNotMatch(dmMessage.content, /此处触发/);

    const logs = app.database.listAiLogs({ code: created.room.code, limit: 20 });
    const structured = logs.find((entry) => entry.stage === 'structured-events');
    assert.equal(structured.detection.checkEventsSuppressed, true);
    assert.equal(structured.detection.suppressedCheckEventCount, 1);

    const duplicate = await fetch(`${baseUrl}/api/rooms/${created.room.code}/adjudications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'p1',
        actionMessageId: submitted.message.id,
        decision: 'NO_CHECK'
      })
    });
    assert.equal(duplicate.status, 409);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regenerating a preflighted task keeps check continuation context', async () => {
  const fakeAi = await startFakeAiServer([
    '开场叙事。',
    '骰点结果被重新整理成更清晰的叙事。\n\n```json\n{}\n```'
  ]);
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
        roomName: 'Regenerate Preflight Room',
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
    await activateRoom(baseUrl, created.room.code, 'p1');

    const submitted = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。'
      })
    });

    await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    const regenerated = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/ai-tasks/${submitted.aiTask.uid}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ playerId: 'p1' })
    });

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) =>
        task.uid === regenerated.task.uid && task.status === 'COMPLETED'
      )
    );

    assert.equal(fakeAi.requests.length, 3);
    assert.ok(fakeAi.requests[2].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.equal(state.messages.filter((message) => message.displayName === '必要检定').length, 1);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight opposed checks use recent NPC context before AI narration', async () => {
  const fakeAi = await startFakeAiServer([
    '开场叙事。',
    '检定结果让陈友的态度出现了细微变化。\n\n```json\n{}\n```'
  ]);
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
    await activateRoom(baseUrl, created.room.code, 'p1');

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

    assert.equal(submitted.preflightCheck, null);
    assert.equal(submitted.aiTask.triggerMessageId, submitted.message.id);
    assert.match(submitted.aiTask.idempotencyKey, /^message:/);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) => roomState.aiTasks.some((task) => task.uid === submitted.aiTask.uid && task.status === 'COMPLETED')
    );

    const continuationRequest = findAiRequest(fakeAi.requests, (messages) => messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.ok(continuationRequest);

    const opposedRolls = state.diceRolls.filter((roll) => roll.rollType === 'contested_check');
    assert.equal(opposedRolls.length, 1);
    assert.match(opposedRolls[0].label, /话术 vs 陈友/);

    const checkMessage = state.messages.find((message) => message.displayName === '对抗检定');
    assert.ok(checkMessage);
    assert.match(checkMessage.content, /陈友/);
    assert.match(checkMessage.content, /话术\(60\)/);

    const completedTask = state.aiTasks.find((task) => task.uid === submitted.aiTask.uid);
    assert.equal(completedTask.triggerMessageId, checkMessage.id);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued actions run preflight checks when their AI turn starts', async () => {
  const fakeAi = await startFakeAiServer(
    [
      '开场叙事。',
      '检定结果推动场景继续发展，AI 根据服务器骰点补上后续叙事。\n\n```json\n{}\n```'
    ],
    { chunkDelayMs: 60 }
  );
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
        roomName: 'Queued Preflight Room',
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
    await activateRoom(baseUrl, created.room.code, 'p1');

    const first = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。'
      })
    });
    await waitForPredicate(() => fakeAi.requests.length === 2);

    const second = await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'p1',
        messageType: 'ACTION',
        content: '第一轮还没结束时，我停下聆听走廊里的脚步声。'
      })
    });

    assert.equal(first.preflightCheck, null);
    assert.equal(second.preflightCheck, null);
    assert.equal(second.aiTask.triggerMessageId, second.message.id);

    const state = await waitForState(
      baseUrl,
      created.room.code,
      'p1',
      (roomState) =>
        fakeAi.requests.length === 3 &&
        roomState.aiTasks.filter((task) =>
          [first.aiTask.uid, second.aiTask.uid].includes(task.uid) &&
          task.status === 'COMPLETED'
        ).length === 2,
      6000
    );

    const requiredChecks = state.messages.filter((message) => message.displayName === '必要检定');
    const spotHidden = requiredChecks.find((message) => /侦查\(68\)/.test(message.content));
    const listenHallway = requiredChecks.find((message) => /聆听\(45\)/.test(message.content));
    assert.ok(spotHidden);
    assert.ok(listenHallway);

    const firstTask = state.aiTasks.find((task) => task.uid === first.aiTask.uid);
    const secondTask = state.aiTasks.find((task) => task.uid === second.aiTask.uid);
    assert.equal(firstTask.triggerMessageId, spotHidden.id);
    assert.equal(secondTask.triggerMessageId, listenHallway.id);
    assert.ok(fakeAi.requests[1].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.ok(fakeAi.requests[2].body.messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));

    const logs = app.database.listAiLogs({ code: created.room.code, limit: 80 });
    assert.ok(logs.some((entry) =>
      entry.stage === 'preflight-check' &&
      entry.taskUid === second.aiTask.uid &&
      entry.detection?.skill === '聆听'
    ));
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    await fakeAi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continue endpoint queues AI without creating a visible player action', async () => {
  const fakeAi = await startFakeAiServer([
    '开场叙事。',
    '陈友看着刚才的检定结果，态度随之改变。\n\n```json\n{}\n```'
  ]);
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
    await activateRoom(baseUrl, created.room.code, 'p1');

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
      (roomState) => roomState.aiTasks.some((task) => task.uid === queued.aiTask.uid && task.status === 'COMPLETED')
    );

    assert.equal(fakeAi.requests.length, 2);
    const continuationRequest = findAiRequest(fakeAi.requests, (messages) => messages.some((message) =>
      message.role === 'system' && /检定结果后的继续叙事/.test(message.content)
    ));
    assert.ok(continuationRequest);
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

test('playtest import endpoint creates a replay room from owner export', async () => {
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
        roomName: 'Original',
        moduleId: module.id
      })
    });
    await jsonRequest(baseUrl, `/api/rooms/${created.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'owner',
        messageType: 'IC',
        content: '这是一条需要复现的记录。'
      })
    });
    app.database.createAiLog({
      code: created.room.code,
      taskUid: 'task-import-api',
      stage: 'preflight-check',
      entry: { type: 'required', reason: 'preflight-generic-侦查' }
    });

    const exported = JSON.parse(exportGameJson(app.database.getExportState(created.room.code, 'owner')));
    const imported = await jsonRequest(baseUrl, '/api/imports/playtest', {
      method: 'POST',
      body: JSON.stringify({
        playerId: 'new-owner',
        displayName: 'Importer',
        roomName: 'Replay Room',
        export: exported
      })
    });

    assert.notEqual(imported.room.code, created.room.code);
    assert.equal(imported.room.name, 'Replay Room');
    assert.equal(imported.room.ownerPlayerId, 'new-owner');
    assert.equal(imported.room.roomMeta.replay.isReplay, true);
    assert.equal(imported.room.roomMeta.replay.sourceRoomCode, created.room.code);
    assert.equal(imported.importSummary.importedMessages, 1);
    assert.equal(imported.importSummary.importedAiLogs, 1);
    assert.equal(imported.messages[0].content, '这是一条需要复现的记录。');

    const roomState = await jsonRequest(baseUrl, `/api/rooms/${imported.room.code}?playerId=new-owner`);
    assert.equal(roomState.room.name, 'Replay Room');
    assert.equal(roomState.room.roomMeta.replay.importedAiLogs, 1);
    assert.equal(roomState.messages[0].content, '这是一条需要复现的记录。');
    const logs = await jsonRequest(baseUrl, `/api/rooms/${imported.room.code}/ai-log?playerId=new-owner`);
    assert.equal(logs.logs[0].stage, 'preflight-check');

    const fixtureResponse = await fetch(`${baseUrl}/api/rooms/${imported.room.code}/replay-fixture?playerId=new-owner`);
    assert.equal(fixtureResponse.status, 200);
    assert.match(fixtureResponse.headers.get('content-disposition') || '', /fixture\.json/);
    const fixture = await fixtureResponse.json();
    assert.equal(fixture.schemaVersion, 'dm-online-replay-fixture/1.0');
    assert.equal(fixture.room.replay.sourceRoomCode, created.room.code);
    assert.equal(fixture.participants[0].ref, 'P1');
    assert.equal(fixture.aiLogs[0].stage, 'preflight-check');
    assert.equal(fixture.testHints.aiLogCount, 1);

    const forbidden = await fetch(`${baseUrl}/api/rooms/${imported.room.code}/replay-fixture?playerId=owner`);
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    app.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
