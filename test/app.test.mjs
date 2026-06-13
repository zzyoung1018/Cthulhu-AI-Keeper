import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
    skills: { 侦查: 68 }
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
