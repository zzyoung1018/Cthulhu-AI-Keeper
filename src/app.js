import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildDmMessages, streamChatCompletion } from './aiClient.js';
import { RoomAiQueue } from './aiQueue.js';
import { isAiConfigured } from './config.js';
import { createDatabase } from './db.js';
import { assertString, optionalString, HttpError } from './errors.js';
import { readJson, sendError, sendJson, serveStatic } from './http.js';
import { RoomEventHub } from './sse.js';

function route(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  return parts;
}

function publicError(error) {
  const text = error?.message || 'unknown error';
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

export function createApp({ config, database = createDatabase(config.dbPath), publicDir = resolve('public') }) {
  const hub = new RoomEventHub();
  const queue = new RoomAiQueue({
    onError: (error) => console.error('[ai-queue]', error)
  });

  async function generateDmReply(code) {
    const state = database.getRoomState(code, 80);
    const dmMessage = database.createMessage({
      code,
      authorType: 'dm',
      displayName: 'AI DM',
      content: '',
      status: 'streaming'
    });

    hub.broadcast(code, 'message_created', { message: dmMessage });

    let content = '';
    let lastPersistedAt = Date.now();

    try {
      const aiMessages = buildDmMessages(state);
      for await (const chunk of streamChatCompletion(config.ai, aiMessages)) {
        content += chunk;
        hub.broadcast(code, 'message_delta', { id: dmMessage.id, delta: chunk, content });

        if (Date.now() - lastPersistedAt > 750) {
          database.updateMessage({ id: dmMessage.id, content, status: 'streaming' });
          lastPersistedAt = Date.now();
        }
      }

      const completed = database.updateMessage({
        id: dmMessage.id,
        content: content.trim() || '（DM 沉默片刻，等待玩家继续行动。）',
        status: 'complete'
      });
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: `${content}\n\n[AI DM 生成失败：${publicError(error)}]`.trim(),
        status: 'error'
      });
      hub.broadcast(code, 'message_error', { message: failed });
    }
  }

  function enqueueDm(code) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateDmReply(code));
  }

  async function handleApi(request, response, parts, url) {
    if (request.method === 'GET' && parts[1] === 'health') {
      sendJson(response, 200, {
        ok: true,
        aiConfigured: isAiConfigured(config.ai),
        localFallback: config.ai.localFallback,
        time: new Date().toISOString()
      });
      return;
    }

    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      const body = await readJson(request);
      const name = assertString(body.roomName || '新的冒险', 'roomName', 80);
      const playerId = assertString(body.playerId, 'playerId', 80);
      const displayName = assertString(body.displayName, 'displayName', 40);
      const result = database.createRoom({ name, playerId, displayName });
      sendJson(response, 201, {
        ...result,
        participants: [result.participant],
        messages: []
      });
      return;
    }

    if (parts[1] === 'rooms' && parts[2]) {
      const code = parts[2].toUpperCase();

      if (request.method === 'GET' && parts.length === 3) {
        const playerId = url.searchParams.get('playerId');
        if (playerId) database.getParticipant(code, playerId);
        sendJson(response, 200, database.getRoomState(code));
        return;
      }

      if (request.method === 'POST' && parts[3] === 'join') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const displayName = assertString(body.displayName, 'displayName', 40);
        const result = database.joinRoom({ code, playerId, displayName });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { ...result, participants: state.participants, messages: state.messages });
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'profile') {
        const body = await readJson(request);
        const participant = database.updateProfile({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          displayName: assertString(body.displayName, 'displayName', 40),
          characterName: optionalString(body.characterName, 80),
          characterCard: optionalString(body.characterCard, 4000),
          state: optionalString(body.state, 2000)
        });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { participant });
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'summary') {
        const body = await readJson(request);
        const room = database.updateSummary({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          summary: optionalString(body.summary, 6000)
        });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { room });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'messages') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const content = assertString(body.content, 'content', 4000);
        const message = database.createPlayerMessage({ code, playerId, content });
        hub.broadcast(code, 'message_created', { message });
        enqueueDm(code);
        sendJson(response, 201, { message, aiQueued: true });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'events') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) throw new HttpError(400, 'playerId is required');
        database.getParticipant(code, playerId);

        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        response.write('\n');
        hub.subscribe(code, response);
        hub.send(response, 'connected', { ok: true });

        const heartbeat = setInterval(() => {
          if (!response.destroyed) hub.send(response, 'heartbeat', { time: Date.now() });
        }, 25_000);
        response.on('close', () => clearInterval(heartbeat));
        return;
      }
    }

    throw new HttpError(404, 'Not found');
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const parts = route(url.pathname);

    try {
      if (parts) {
        await handleApi(request, response, parts, url);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        serveStatic(request, response, publicDir);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.destroy(error);
      }
    }
  });

  return { server, database, hub, queue };
}
