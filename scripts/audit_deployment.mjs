#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const requireAi = args.includes('--require-ai');
const baseArg = args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:4173';
const baseUrl = baseArg.replace(/\/+$/, '');
const aiStreamTimeoutMs = Number(process.env.DEPLOYMENT_AUDIT_AI_TIMEOUT_MS || 300_000);

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

async function jsonRequest(path, options = {}) {
  const timeout = timeoutSignal(options.timeoutMs || 15_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: timeout.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.error ? `: ${payload.error}` : '';
      throw new Error(`${options.method || 'GET'} ${path} failed with ${response.status}${detail}`);
    }
    return payload;
  } finally {
    timeout.cancel();
  }
}

async function expectHttpError(path, expectedStatus, options = {}) {
  const timeout = timeoutSignal(options.timeoutMs || 15_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: timeout.signal
    });
    await response.text();
    assert.equal(response.status, expectedStatus);
  } finally {
    timeout.cancel();
  }
}

async function multipartRequest(path, { fields = {}, file }) {
  const timeout = timeoutSignal(15_000);
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    if (file) {
      form.set('file', new Blob([file.content], { type: file.contentType }), file.name);
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      body: form,
      signal: timeout.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.error ? `: ${payload.error}` : '';
      throw new Error(`POST ${path} failed with ${response.status}${detail}`);
    }
    return payload;
  } finally {
    timeout.cancel();
  }
}

function parseSseChunk(buffer, onEvent) {
  const blocks = buffer.split(/\n\n/);
  const rest = blocks.pop() || '';
  for (const block of blocks) {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length > 0) {
      onEvent(event, JSON.parse(data.join('\n')));
    }
  }
  return rest;
}

function auditCharacterSheet(name, skill = 55) {
  return {
    investigator: {
      name,
      occupation: '部署审计员'
    },
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
    skills: {
      侦查: skill,
      聆听: 45,
      图书馆使用: 50
    },
    equipment: '提灯、铅笔、审计记录本'
  };
}

function auditModuleContent() {
  return JSON.stringify({
    schema_version: '1.0',
    module_info: {
      title: '部署审计模组',
      system: 'Call of Cthulhu 7th Edition',
      time_period: '现代',
      location: '审计走廊',
      setting: '调查员站在一条狭窄走廊中，墙面潮湿，尽头有一扇半掩的门。',
      themes: ['调查', '部署验证'],
      tone: '克制悬疑',
      recommended_players: '1-5'
    },
    keeper_overview: {
      truth: '走廊尽头的书房里放着一本记录异常梦境的皮面笔记。',
      investigation_goal: '确认房间、聊天、AI 流式回复和持久化链路正常。',
      default_opening: '调查员抵达审计走廊入口。'
    },
    player_opening: {
      initial_public_information: '走廊潮湿、安静，尽头有一扇半掩的门。',
      initial_objective: '观察走廊并确认是否有异常。',
      suggested_intro_text: '提灯亮起时，墙面水痕映出细碎的反光。'
    },
    scenes: [
      {
        scene_id: 'audit_corridor',
        name: '审计走廊',
        type: 'location',
        player_visible_description: '一条狭窄走廊，墙面潮湿，尽头有一扇半掩的门。',
        keeper_secret: '门后是隐藏书房。',
        when_players_enter: '提灯照亮潮湿墙面，远处门缝里没有光。',
        when_players_search: '墙面水痕旁能发现新的脚印。'
      },
      {
        scene_id: 'hidden_study',
        name: '隐藏书房',
        type: 'location',
        player_visible_description: '书桌上放着一本皮面笔记。',
        keeper_secret: '笔记记录了异常梦境。'
      }
    ],
    npcs: [
      {
        npc_id: 'audit_keeper',
        name: '沉默管理员',
        role: '部署审计中的观察者',
        player_visible_info: '他站在走廊尽头，等待调查员说明来意。',
        skills: { 心理学: 50, 侦查: 50, 聆听: 45 }
      }
    ],
    clues: [
      {
        clue_id: 'wet_footprints',
        name: '潮湿脚印',
        scene_id: 'audit_corridor',
        is_core_clue: true,
        reveal_condition: '侦查检定成功',
        player_visible_text: '脚印从半掩的门后延伸到走廊中央。'
      }
    ],
    checks: [
      {
        check_id: 'audit_spot_hidden',
        scene_id: 'audit_corridor',
        skill: '侦查',
        difficulty: 'regular',
        trigger: '玩家观察走廊尽头',
        success: '发现潮湿脚印',
        failure: '只看到普通水痕'
      }
    ],
    ai_dm_global_rules: {
      role: 'CoC Keeper',
      must_follow: ['不泄露守秘人秘密', '不替玩家做决定'],
      style: { narration_length: '1-2 paragraphs', tone: 'suspenseful' }
    }
  }, null, 2);
}

async function waitForStreamedDm(code, playerId, sendMessage) {
  const timeout = timeoutSignal(aiStreamTimeoutMs);
  const events = [];
  let buffer = '';
  let sawDelta = false;
  let completedMessage = null;
  let errorMessage = null;
  let reader = null;

  try {
    const response = await fetch(`${baseUrl}/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}`, {
      signal: timeout.signal
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sent = sendMessage();

    while (!completedMessage) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, (event, data) => {
        events.push(event);
        if (event === 'message_delta') sawDelta = true;
        if (event === 'message_error' && data.message?.authorType === 'dm') {
          errorMessage = data.message;
        }
        if (event === 'message_completed' && data.message?.authorType === 'dm') {
          completedMessage = data.message;
        }
      });
      if (errorMessage) break;
    }

    await sent;
    if (errorMessage) {
      throw new Error(`DM generation failed: ${errorMessage.content || 'unknown error'}`);
    }
    assert.ok(events.includes('message_created'), 'expected message_created event');
    assert.equal(sawDelta, true, 'expected streaming message_delta event');
    assert.ok(completedMessage?.content, 'expected completed DM message content');
    if (requireAi) {
      assert.ok(
        !completedMessage.content.includes('外部大模型还没有完成配置'),
        'strict AI mode must not use local fallback text'
      );
      assert.notEqual(
        completedMessage.content,
        '（DM 沉默片刻，等待玩家继续行动。）',
        'strict AI mode must receive non-empty model content'
      );
    }
    return completedMessage;
  } finally {
    await reader?.cancel().catch(() => undefined);
    timeout.abort();
  }
}

async function main() {
  const health = await jsonRequest('/api/health');
  assert.equal(health.ok, true);
  if (requireAi) {
    assert.equal(health.aiConfigured, true, 'health check must report aiConfigured=true');
  }

  const ownerId = randomUUID();
  const uploadedModule = await multipartRequest('/api/modules', {
    fields: {
      playerId: ownerId,
      title: '部署审计模组'
    },
    file: {
      name: 'audit-module.json',
      contentType: 'application/json',
      content: auditModuleContent()
    }
  });
  assert.equal(uploadedModule.module.parseStatus, 'PARSED');

  const created = await jsonRequest('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      playerId: ownerId,
      displayName: 'Audit Owner',
      roomName: `Audit ${Date.now()}`,
      moduleId: uploadedModule.module.id
    })
  });
  assert.equal(created.room.code.length, 6);
  assert.equal(created.room.moduleId, uploadedModule.module.id);
  assert.equal(created.participants.length, 1);

  const participantIds = [ownerId];
  for (let index = 2; index <= 5; index += 1) {
    const playerId = randomUUID();
    participantIds.push(playerId);
    await jsonRequest(`/api/rooms/${created.room.code}/join`, {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        displayName: `Audit Player ${index}`
      })
    });
  }

  const fullRoom = await jsonRequest(`/api/rooms/${created.room.code}?playerId=${ownerId}`);
  assert.equal(fullRoom.participants.length, 5);

  await expectHttpError(`/api/rooms/${created.room.code}/join`, 409, {
    method: 'POST',
    body: JSON.stringify({
      playerId: randomUUID(),
      displayName: 'Audit Overflow'
    })
  });

  for (const [index, playerId] of participantIds.entries()) {
    await jsonRequest(`/api/rooms/${created.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId,
        displayName: index === 0 ? 'Audit Owner' : `Audit Player ${index + 1}`,
        characterSheet: auditCharacterSheet(index === 0 ? '审计员' : `审计员${index + 1}`, 55 + index)
      })
    });
    await jsonRequest(`/api/rooms/${created.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId,
        isReady: true
      })
    });
  }

  await jsonRequest(`/api/rooms/${created.room.code}/summary`, {
    method: 'PATCH',
    body: JSON.stringify({
      playerId: ownerId,
      summary: '审计房间已创建，队伍准备进行一次短行动验证。'
    })
  });

  const activeRoom = await jsonRequest(`/api/rooms/${created.room.code}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      playerId: ownerId,
      status: 'ACTIVE'
    })
  });
  assert.equal(activeRoom.room.status, 'ACTIVE');

  const dmMessage = await waitForStreamedDm(created.room.code, ownerId, () => jsonRequest(
    `/api/rooms/${created.room.code}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        playerId: ownerId,
        content: '我点亮提灯，观察走廊尽头。',
        messageType: 'ACTION',
        submitToDm: true
      })
    }
  ));

  const finalRoom = await jsonRequest(`/api/rooms/${created.room.code}?playerId=${ownerId}`);
  assert.ok(finalRoom.messages.some((message) => message.id === dmMessage.id));
  assert.ok(finalRoom.room.summary.includes('审计房间'));
  assert.ok(finalRoom.aiTasks.some((task) => task.dmMessageId === dmMessage.id && task.status === 'COMPLETED'));
  assert.equal(finalRoom.activeAiTask, null);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    roomCode: created.room.code,
    aiConfigured: health.aiConfigured,
    strictAi: requireAi,
    dmMessageId: dmMessage.id
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
