#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const requireAi = args.includes('--require-ai');
const baseArg = args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:4173';
const baseUrl = baseArg.replace(/\/+$/, '');
const aiStreamTimeoutMs = Number(process.env.DEPLOYMENT_AUDIT_AI_TIMEOUT_MS || 120_000);

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

async function waitForStreamedDm(code, playerId, sendMessage) {
  const timeout = timeoutSignal(aiStreamTimeoutMs);
  const events = [];
  let buffer = '';
  let sawDelta = false;
  let completedMessage = null;
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
        if (event === 'message_completed' && data.message?.authorType === 'dm') {
          completedMessage = data.message;
        }
      });
    }

    await sent;
    assert.ok(events.includes('message_created'), 'expected message_created event');
    assert.equal(sawDelta, true, 'expected streaming message_delta event');
    assert.ok(completedMessage?.content, 'expected completed DM message content');
    if (requireAi) {
      assert.ok(
        !completedMessage.content.includes('外部大模型还没有完成配置'),
        'strict AI mode must not use local fallback text'
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
  const created = await jsonRequest('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      playerId: ownerId,
      displayName: 'Audit Owner',
      roomName: `Audit ${Date.now()}`
    })
  });
  assert.equal(created.room.code.length, 6);
  assert.equal(created.participants.length, 1);

  for (let index = 2; index <= 5; index += 1) {
    await jsonRequest(`/api/rooms/${created.room.code}/join`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: randomUUID(),
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

  await jsonRequest(`/api/rooms/${created.room.code}/profile`, {
    method: 'PATCH',
    body: JSON.stringify({
      playerId: ownerId,
      displayName: 'Audit Owner',
      characterName: '审计员',
      characterCard: '用于验证部署的临时角色。',
      state: '状态良好。'
    })
  });

  await jsonRequest(`/api/rooms/${created.room.code}/summary`, {
    method: 'PATCH',
    body: JSON.stringify({
      playerId: ownerId,
      summary: '审计房间已创建，队伍准备进行一次短行动验证。'
    })
  });

  const dmMessage = await waitForStreamedDm(created.room.code, ownerId, () => jsonRequest(
    `/api/rooms/${created.room.code}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        playerId: ownerId,
        content: '我点亮提灯，观察走廊尽头。'
      })
    }
  ));

  const finalRoom = await jsonRequest(`/api/rooms/${created.room.code}?playerId=${ownerId}`);
  assert.ok(finalRoom.messages.some((message) => message.id === dmMessage.id));
  assert.ok(finalRoom.room.summary.includes('审计房间'));

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
