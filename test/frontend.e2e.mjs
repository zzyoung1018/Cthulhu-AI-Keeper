import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { exportGameJson } from '../src/export.js';

function characterSheet() {
  return {
    investigator: { name: '林娜', occupation: '记者', age: '28', residence: '省城' },
    characteristics: {
      STR: 50,
      CON: 55,
      SIZ: 45,
      DEX: 60,
      APP: 55,
      INT: 70,
      POW: 65,
      EDU: 60,
      Luck: 55
    },
    status: { hp: 10, mp: 13, san: 65, luck: 55 },
    skills: {
      侦查: 68,
      图书馆使用: 55,
      话术: 45,
      心理学: 40
    },
    skillAllocations: {
      侦查: { occupation: 43, interest: 0 },
      图书馆使用: { occupation: 30, interest: 0 },
      话术: { occupation: 40, interest: 0 },
      心理学: { occupation: 0, interest: 30 }
    }
  };
}

async function startFakeAiServer(responses = []) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body || '{}') });

    const text = responses.shift() || '检定后的后果逐渐清晰。\n\n```json\n{}\n```';
    const chunks = String(text).match(/.{1,18}/gs) || [''];
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const chunk of chunks) {
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

async function startFixture(responses = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-e2e-'));
  const fakeAi = await startFakeAiServer(responses);
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

  const baseUrl = await new Promise((resolveListen) => {
    app.server.listen(0, '127.0.0.1', () => {
      const address = app.server.address();
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    app,
    baseUrl,
    fakeAi,
    dir,
    async close() {
      app.server.closeIdleConnections?.();
      app.server.closeAllConnections?.();
      await new Promise((resolveClose) => app.server.close(resolveClose));
      app.database.close();
      await fakeAi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedModule(database, ownerPlayerId = 'owner', title = 'E2E 模组') {
  return database.createModule({
    ownerPlayerId,
    title: 'E2E 模组',
    originalName: 'module.json',
    fileType: 'json',
    contentType: 'application/json',
    sizeBytes: 2,
    storagePath: '/tmp/module.json',
    parsedText: JSON.stringify({ module_info: { title: 'E2E 模组' }, scenes: [], npcs: [], clues: [], checks: [] }),
    parseStatus: 'PARSED',
    segments: [{ title: '大厅', scene: 'lobby', content: '大厅里有一本登记簿。' }]
  });
}

function seedPreparingRoom(database, { ownerPlayerId = 'owner', displayName = 'Keeper', maxPlayers = 5 } = {}) {
  const module = seedModule(database, ownerPlayerId);
  return database.createRoom({
    name: 'E2E Room',
    playerId: ownerPlayerId,
    displayName,
    moduleId: module.id,
    maxPlayers
  });
}

function seedActiveRoom(database, extraPlayers = []) {
  const module = seedModule(database, 'owner');

  const { room } = database.createRoom({
    name: 'E2E Room',
    playerId: 'owner',
    displayName: 'Keeper',
    moduleId: module.id
  });

  for (const player of extraPlayers) {
    database.joinRoom({
      code: room.code,
      playerId: player.playerId,
      displayName: player.displayName
    });
  }

  const players = [{ playerId: 'owner', displayName: 'Keeper' }, ...extraPlayers];
  for (const player of players) {
    database.updateCharacterSheet({
      code: room.code,
      playerId: player.playerId,
      displayName: player.displayName,
      characterSheet: {
        ...characterSheet(),
        investigator: {
          ...characterSheet().investigator,
          name: player.displayName === 'Keeper' ? '林娜' : player.displayName
        }
      }
    });
    database.setParticipantReady({ code: room.code, playerId: player.playerId, isReady: true });
  }
  database.setRoomStatus({ code: room.code, playerId: 'owner', status: 'ACTIVE' });

  const action = database.createPlayerMessage({
    code: room.code,
    playerId: 'owner',
    messageType: 'ACTION',
    content: '我检查登记簿。'
  });
  const task = database.createAiTask({
    code: room.code,
    playerId: 'owner',
    triggerMessageId: action.id,
    idempotencyKey: `message:${action.id}`
  }).task;
  database.updateAiTaskStatus({ taskUid: task.uid, status: 'STREAMING' });
  const dmMessage = database.createMessage({
    code: room.code,
    authorType: 'dm',
    messageType: 'AI_DM',
    displayName: 'AI DM',
    content: '登记簿纸页潮湿，边缘有新鲜涂改痕迹。',
    status: 'complete'
  });
  database.attachAiTaskMessage({ taskUid: task.uid, messageId: dmMessage.id });
  database.updateAiTaskStatus({ taskUid: task.uid, status: 'COMPLETED' });
  database.markAiTriggerProcessed({ taskUid: task.uid });
  const participant = database.getParticipant(room.code, 'owner').participant;
  database.createRoundState({
    roomId: room.id,
    aiTaskUid: task.uid,
    dmMessageId: dmMessage.id,
    snapshotJson: JSON.stringify({
      participants: [{
        playerId: 'owner',
        characterSheet: participant.characterSheet,
        characterRevision: participant.characterRevision
      }],
      summary: '',
      sceneState: '{}'
    })
  });

  const checkMessage = database.createMessage({
    code: room.code,
    authorType: 'system',
    messageType: 'SYSTEM',
    displayName: '必要检定',
    content: '🎲 必要检定：林娜 的 侦查(68)\n1d100 = 22 → HARD（成功）',
    status: 'complete'
  });

  database.createAiLog({
    code: room.code,
    taskUid: task.uid,
    stage: 'preflight-check',
    entry: {
      stage: 'preflight-check',
      taskUid: task.uid,
      actionMessageId: action.id,
      playerId: 'owner',
      type: 'required',
      reason: 'preflight-generic-侦查',
      eventKeys: ['required_checks'],
      detection: {
        source: 'generic',
        kind: 'required',
        ruleId: 'generic:侦查',
        skill: '侦查',
        confidence: 0.74,
        notes: ['keyword']
      }
    }
  });
  database.createAiLog({
    code: room.code,
    taskUid: task.uid,
    stage: 'structured-events',
    entry: {
      stage: 'structured-events',
      taskUid: task.uid,
      hasJsonBlock: false,
      validKeys: ['required_checks'],
      enhancedEventKeys: ['required_checks'],
      detection: {
        inferredRequiredReason: 'generic-侦查',
        strippedDecisiveOutcome: true,
        detectionNotes: [{
          source: 'generic',
          kind: 'required',
          ruleId: 'generic:侦查',
          skill: '侦查',
          confidence: 0.74,
          notes: ['keyword']
        }]
      },
      rawResponseSnippet: '你发现了登记簿。'
    }
  });
  database.createAiLog({
    code: room.code,
    taskUid: task.uid,
    stage: 'npc-skill-fallback',
    entry: {
      stage: 'npc-skill-fallback',
      taskUid: task.uid,
      npcName: '陈友',
      passiveSkill: '心理学',
      fallback: 50,
      time: new Date().toISOString()
    }
  });

  return { room, checkMessage, task };
}

function seedBusyAiQueue(database, roomCode) {
  const active = database.createAiTask({
    code: roomCode,
    playerId: 'owner',
    triggerMessageId: null,
    idempotencyKey: 'e2e:active-task'
  }).task;
  database.updateAiTaskStatus({ taskUid: active.uid, status: 'GENERATING' });

  const queued = database.createAiTask({
    code: roomCode,
    playerId: 'owner',
    triggerMessageId: null,
    idempotencyKey: 'e2e:queued-task'
  }).task;

  return { active, queued };
}

async function setIdentity(page, { playerId, displayName, roomCode = '', roomName = 'E2E Room' }) {
  await page.addInitScript(({ id, name, code, lastRoomName }) => {
    localStorage.setItem('dm-online-player-id', id);
    localStorage.setItem('dm-online-display-name', name);
    if (code) {
      localStorage.setItem('dm-online-last-room-code', code);
      localStorage.setItem('dm-online-last-room-name', lastRoomName);
    }
  }, { id: playerId, name: displayName, code: roomCode, lastRoomName: roomName });
}

async function openRoomAs(page, baseUrl, roomCode, { playerId = 'owner', displayName = 'Keeper' } = {}) {
  await setIdentity(page, { playerId, displayName, roomCode });
  await page.goto(baseUrl);
  await expect(page.locator('#roomTitle')).toHaveText('E2E Room');
}

async function openSeededRoom(page, baseUrl, roomCode) {
  await openRoomAs(page, baseUrl, roomCode);
}

test('continues narrative from a check result without creating a player action', async ({ page }) => {
  const fixture = await startFixture(['检定后的后果逐渐清晰。\n\n```json\n{}\n```']);
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    await expect(page.getByRole('button', { name: '继续叙事' })).toBeVisible();
    await page.getByRole('button', { name: '继续叙事' }).click();
    await expect(page.getByText('检定后的后果逐渐清晰')).toBeVisible();
    await expect(page.getByRole('button', { name: '继续叙事' })).toHaveCount(0);
    await expect(page.locator('.message.action').filter({ hasText: '继续' })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('renders readable AI detection logs for the owner', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    await page.locator('#btnAiLog').click();
    const dialog = page.locator('#aiLogDialog');
    await expect(dialog).toContainText('服务器预检定');
    await expect(dialog).toContainText('服务器已在 AI 回复前完成必要检定');
    await expect(dialog).toContainText('触发来源：通用规则：侦查');
    await expect(dialog).toContainText('结构化事件检测');
    await expect(dialog).toContainText('模型 JSON：无');
    await expect(dialog).toContainText('后端补充必要检定：generic-侦查');
    await expect(dialog).toContainText('通用规则 · 必要');
    await expect(dialog.locator('summary')).toContainText('查看原始回复片段');
  } finally {
    await fixture.close();
  }
});

test('shows clear AI queue and log status summaries', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    seedBusyAiQueue(fixture.app.database, room.code);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    const queue = page.locator('#aiQueueSummary');
    await expect(queue).toContainText('当前');
    await expect(queue).toContainText('生成中');
    await expect(queue).toContainText('等待');
    await expect(queue).toContainText('1');

    await page.locator('#btnAiLog').click();
    const stats = page.locator('#aiLogStats');
    await expect(stats).toContainText('总数');
    await expect(stats).toContainText('3');
    await expect(stats).toContainText('命中');
    await expect(stats).toContainText('警告');
    await expect(stats).toContainText('1');
    await expect(stats).toContainText('任务');
    await expect(stats).toContainText('预检');

    await page.locator('#aiLogWarningOnly').check();
    await expect(stats).toContainText('命中');
    await expect(stats).toContainText('1');
  } finally {
    await fixture.close();
  }
});

test('filters, groups, and exports AI detection logs', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    await page.locator('#btnAiLog').click();
    await page.locator('#aiLogWarningOnly').check();
    await expect(page.locator('.ai-log-entry')).toHaveCount(1);
    await expect(page.locator('.ai-log-entry')).toContainText('NPC 技能回退');

    await page.locator('#aiLogWarningOnly').uncheck();
    await page.locator('#aiLogStageFilter').selectOption('structured-events');
    await expect(page.locator('.ai-log-entry')).toHaveCount(1);
    await expect(page.locator('.ai-log-entry')).toContainText('结构化事件检测');

    await page.locator('#aiLogStageFilter').selectOption('');
    await page.locator('#aiLogGroupByTask').check();
    await expect(page.locator('.ai-log-task-heading')).toContainText('任务');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportAiLog').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`dm-online-${room.code}-ai-log.json`);
  } finally {
    await fixture.close();
  }
});

test('sends chat actions with Ctrl+Enter', async ({ page }) => {
  const fixture = await startFixture(['门缝里透出一线冷光。\n\n```json\n{}\n```']);
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    const textarea = page.locator('#messageForm textarea');
    await textarea.fill('我查看门缝。');
    await page.keyboard.press('Control+Enter');

    await expect(page.locator('.message.action').filter({ hasText: '我查看门缝。' })).toBeVisible();
    await expect(textarea).toHaveValue('');
    await expect(page.getByText('门缝里透出一线冷光')).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('creates and joins rooms through the UI while enforcing the player cap', async ({ browser }) => {
  const fixture = await startFixture();
  const pages = [];
  try {
    const module = seedModule(fixture.app.database, 'owner');
    const owner = await browser.newPage();
    pages.push(owner);
    await setIdentity(owner, { playerId: 'owner', displayName: 'Keeper' });
    await owner.goto(fixture.baseUrl);

    await owner.locator('#btnCreateRoom').click();
    await expect(owner.locator('#moduleSelect')).toContainText('E2E 模组');
    await owner.locator('#createRoomForm input[name="displayName"]').fill('Keeper');
    await owner.locator('#createRoomForm input[name="roomName"]').fill('Two Seat Room');
    await owner.locator('#maxPlayersSelect').selectOption('2');
    await owner.locator('#moduleSelect').selectOption(String(module.id));
    await owner.locator('#createRoomForm button[type="submit"]').click();

    await expect(owner.locator('#roomTitle')).toHaveText('Two Seat Room');
    await expect(owner.locator('#playerCount')).toHaveText('1/2');
    const roomCode = (await owner.locator('#roomCode').textContent()).trim();

    const guest = await browser.newPage();
    pages.push(guest);
    await setIdentity(guest, { playerId: 'guest', displayName: 'Guest' });
    await guest.goto(fixture.baseUrl);
    await guest.locator('#btnJoinRoom').click();
    await guest.locator('#joinRoomForm input[name="displayName"]').fill('Guest');
    await guest.locator('#joinRoomForm input[name="roomCode"]').fill(roomCode);
    await guest.locator('#joinRoomForm button[type="submit"]').click();

    await expect(guest.locator('#roomTitle')).toHaveText('Two Seat Room');
    await expect(owner.locator('#playerCount')).toHaveText('2/2');
    await expect(owner.locator('#players')).toContainText('Guest');

    const extra = await browser.newPage();
    pages.push(extra);
    await setIdentity(extra, { playerId: 'extra', displayName: 'Extra' });
    await extra.goto(fixture.baseUrl);
    await extra.locator('#btnJoinRoom').click();
    await extra.locator('#joinRoomForm input[name="displayName"]').fill('Extra');
    await extra.locator('#joinRoomForm input[name="roomCode"]').fill(roomCode);
    await extra.locator('#joinRoomForm button[type="submit"]').click();
    await expect(extra.locator('#toast')).toContainText('Room is full');
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await fixture.close();
  }
});

test('imports owner playtest exports through the create dialog', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    const exported = exportGameJson(fixture.app.database.getExportState(room.code, 'owner'));
    const exportPath = join(fixture.dir, 'dm-online-export.json');
    writeFileSync(exportPath, exported);

    await setIdentity(page, { playerId: 'importer', displayName: 'Importer' });
    await page.goto(fixture.baseUrl);
    await page.locator('#btnCreateRoom').click();
    await page.locator('#createRoomForm input[name="displayName"]').fill('Importer');
    await page.locator('#createRoomForm input[name="roomName"]').fill('Imported Replay');
    await page.locator('#playtestImportFile').setInputFiles(exportPath);
    await page.locator('#importPlaytest').click();

    await expect(page.locator('#roomTitle')).toHaveText('Imported Replay');
    await expect(page.locator('#playerCount')).toHaveText('1/5');
    await expect(page.locator('#replayBanner')).toBeVisible();
    await expect(page.locator('#replayBanner')).toContainText('调试回放');
    await expect(page.locator('#replayBanner')).toContainText(`来源 E2E Room #${room.code}`);
    await expect(page.locator('#replayBanner')).toContainText('消息');
    await expect(page.locator('#replayBanner')).toContainText('日志');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportReplayFixture').click();
    const download = await downloadPromise;
    const fixturePath = await download.path();
    const fixtureJson = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(fixtureJson.schemaVersion).toBe('dm-online-replay-fixture/1.0');
    expect(fixtureJson.room.replay.sourceRoomCode).toBe(room.code);
    expect(fixtureJson.testHints.hasPreflightChecks).toBe(true);
    await expect(page.locator('#chatLog')).toContainText('登记簿纸页潮湿');
    await expect(page.locator('#btnAiLog')).toBeVisible();
    await page.locator('#btnAiLog').click();
    await expect(page.locator('#aiLogDialog')).toContainText('服务器预检定');
  } finally {
    await fixture.close();
  }
});

test('owner adjudicates checks in AI assisted mode', async ({ page }) => {
  const fixture = await startFixture(['检定后的后果逐渐清晰。\n\n```json\n{}\n```']);
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    fixture.app.database.updateRoomAiConfig({
      code: room.code,
      playerId: 'owner',
      aiConfig: { triggerMode: 'ASSISTED' }
    });

    await openSeededRoom(page, fixture.baseUrl, room.code);
    await expect(page.locator('#roomStatus')).toContainText('AI辅助');

    await page.locator('#messageForm textarea').fill('我检查窗台上的灰尘。');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.assist-controls').last()).toContainText('AI 辅助模式');
    await expect(page.getByRole('button', { name: '免检交给 AI' })).toBeVisible();

    await page.getByRole('button', { name: '裁定检定' }).last().click();
    await expect(page.locator('#assistDialog')).toBeVisible();
    await page.locator('#assistForm input[name="skillName"]').fill('侦查');
    await page.locator('#assistForm select[name="difficulty"]').selectOption('HARD');
    await page.locator('#assistForm input[name="reason"]').fill('窗台灰尘需要仔细观察');
    await page.locator('#assistForm button[type="submit"]').click();

    await expect(page.locator('#chatLog')).toContainText('房主裁定：必要检定');
    await expect(page.locator('#chatLog')).toContainText('侦查(68)');
    await expect(page.locator('#chatLog')).toContainText('检定后的后果逐渐清晰');
    expect(fixture.fakeAi.requests.length).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('syncs player messages in real time and keeps private messages scoped', async ({ browser }) => {
  const fixture = await startFixture(['脚步声在走廊另一端停住。\n\n```json\n{}\n```']);
  const pages = [];
  try {
    const { room } = seedActiveRoom(fixture.app.database, [
      { playerId: 'guest', displayName: 'Guest' },
      { playerId: 'bystander', displayName: 'Bystander' }
    ]);

    const owner = await browser.newPage();
    const guest = await browser.newPage();
    const bystander = await browser.newPage();
    pages.push(owner, guest, bystander);

    await openRoomAs(owner, fixture.baseUrl, room.code, { playerId: 'owner', displayName: 'Keeper' });
    await openRoomAs(guest, fixture.baseUrl, room.code, { playerId: 'guest', displayName: 'Guest' });
    await openRoomAs(bystander, fixture.baseUrl, room.code, { playerId: 'bystander', displayName: 'Bystander' });

    await owner.locator('#messageForm textarea').fill('我轻轻敲门。');
    await owner.keyboard.press('Control+Enter');
    await expect(guest.locator('.message.action').filter({ hasText: '我轻轻敲门。' })).toBeVisible();

    await owner.evaluate(async ({ code }) => {
      const response = await fetch(`/api/rooms/${code}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: 'owner',
          content: '只告诉 Guest 的线索。',
          messageType: 'PRIVATE',
          privateTarget: 'guest'
        })
      });
      if (!response.ok) throw new Error(await response.text());
    }, { code: room.code });

    await expect(owner.locator('.message.private').filter({ hasText: '只告诉 Guest 的线索。' })).toBeVisible();
    await expect(guest.locator('.message.private').filter({ hasText: '只告诉 Guest 的线索。' })).toBeVisible();
    await expect(bystander.locator('.message.private').filter({ hasText: '只告诉 Guest 的线索。' })).toHaveCount(0);
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await fixture.close();
  }
});

test('preserves character skill allocations after saving and reopening the sheet', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedPreparingRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    await page.locator('#btnEditCharacter').click();
    await page.locator('input[name="investigator.name"]').fill('沈秋');
    await page.locator('#occupationSelect').selectOption('记者');
    await page.locator('.skill-row[data-skill-name="侦查"] [data-skill-kind="occupation"]').fill('40');
    await page.locator('.skill-row[data-skill-name="侦查"] [data-skill-kind="interest"]').fill('5');
    await page.locator('#profileForm button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('角色已保存');

    await page.locator('#btnEditCharacter').click();
    await expect(page.locator('input[name="investigator.name"]')).toHaveValue('沈秋');
    await expect(page.locator('.skill-row[data-skill-name="侦查"] [data-skill-kind="occupation"]')).toHaveValue('40');
    await expect(page.locator('.skill-row[data-skill-name="侦查"] [data-skill-kind="interest"]')).toHaveValue('5');
  } finally {
    await fixture.close();
  }
});

test('shows rollback and character skill allocation shortcuts', async ({ page }) => {
  const fixture = await startFixture();
  try {
    const { room } = seedActiveRoom(fixture.app.database);
    await openSeededRoom(page, fixture.baseUrl, room.code);

    await expect(page.locator('#rollbackRound')).toBeVisible();

    await page.locator('#btnCharSheet').click();
    await expect(page.locator('#charSheetDialog')).toContainText('MOV');
    await page.locator('#closeCharSheet').click();

    await page.locator('[data-open-skill-allocations]').click();
    await expect(page.locator('#charSheetDialog')).toContainText('技能加点');
    await expect(page.locator('#charSheetDialog')).toContainText('职业点');
    await page.locator('#closeCharSheet').click();

    await page.locator('#rollbackRound').click();
    await expect(page.locator('#toast')).toContainText('已撤回');
  } finally {
    await fixture.close();
  }
});
