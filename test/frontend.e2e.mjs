import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';

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

function seedActiveRoom(database) {
  const module = database.createModule({
    ownerPlayerId: 'owner',
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

  const { room } = database.createRoom({
    name: 'E2E Room',
    playerId: 'owner',
    displayName: 'Keeper',
    moduleId: module.id
  });

  database.updateCharacterSheet({
    code: room.code,
    playerId: 'owner',
    displayName: 'Keeper',
    characterSheet: characterSheet()
  });
  database.setParticipantReady({ code: room.code, playerId: 'owner', isReady: true });
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

  return { room, checkMessage, task };
}

async function openSeededRoom(page, baseUrl, roomCode) {
  await page.addInitScript(({ code }) => {
    localStorage.setItem('dm-online-player-id', 'owner');
    localStorage.setItem('dm-online-display-name', 'Keeper');
    localStorage.setItem('dm-online-last-room-code', code);
    localStorage.setItem('dm-online-last-room-name', 'E2E Room');
  }, { code: roomCode });
  await page.goto(baseUrl);
  await expect(page.locator('#roomTitle')).toHaveText('E2E Room');
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
    await expect(dialog).toContainText('结构化事件检测');
    await expect(dialog).toContainText('模型 JSON：无');
    await expect(dialog).toContainText('后端补充必要检定：generic-侦查');
    await expect(dialog).toContainText('通用规则 · 必要');
    await expect(dialog.locator('summary')).toContainText('查看原始回复片段');
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
