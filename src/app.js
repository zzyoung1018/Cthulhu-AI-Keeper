import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { buildDmMessages, streamChatCompletion } from './aiClient.js';
import { RoomAiQueue } from './aiQueue.js';
import { assertAiSettingsInput, roomRuntimeAiConfig } from './aiSettings.js';
import { getSkillTarget } from './character.js';
import { isAiConfigured } from './config.js';
import { createDatabase } from './db.js';
import { rollCocCheck, rollDiceExpression, rollSanityLoss } from './dice.js';
import { assertString, optionalString, HttpError } from './errors.js';
import { readJson, sendError, sendJson, serveStatic } from './http.js';
import { extractModuleText, scoreModuleSegment, segmentModuleText, validateModuleFile } from './moduleParser.js';
import { readMultipartForm } from './multipart.js';
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

const STATUS_LABELS = {
  PREPARING: '准备阶段',
  ACTIVE: '游玩阶段',
  PAUSED: '暂停阶段',
  ENDED: '已结束',
  ARCHIVED: '已归档'
};

class AiTaskCancelled extends Error {
  constructor() {
    super('AI task was cancelled');
    this.name = 'AiTaskCancelled';
  }
}

export function parseRequestUrl(request) {
  try {
    return new URL(request.url || '/', 'http://localhost');
  } catch {
    throw new HttpError(400, 'Invalid request URL');
  }
}

export function createApp({ config, database = createDatabase(config.dbPath), publicDir = resolve('public') }) {
  const hub = new RoomEventHub();
  const queue = new RoomAiQueue({
    onError: (error) => console.error('[ai-queue]', error)
  });

  function broadcastAiTask(code, task) {
    hub.broadcast(code, 'ai_task_updated', { task });
  }

  function setAiTaskStatus(code, taskUid, status, error = '') {
    const task = database.updateAiTaskStatus({ taskUid, status, error });
    if (task) broadcastAiTask(code, task);
    return task;
  }

  function assertTaskNotCancelled(taskUid) {
    const task = database.getAiTask(taskUid);
    if (task.cancelRequested || task.status === 'CANCELLED') {
      throw new AiTaskCancelled();
    }
    return task;
  }

  async function generateDmReply(code, taskUid) {
    try {
      assertTaskNotCancelled(taskUid);
    } catch (error) {
      if (error instanceof AiTaskCancelled) {
        setAiTaskStatus(code, taskUid, 'CANCELLED');
        return;
      }
      throw error;
    }

    setAiTaskStatus(code, taskUid, 'RETRIEVING');
    const state = database.getRoomState(code, 80);
    const moduleSegments = database.getRoomModuleSegments(code, 120);
    const query = [
      state.room.summary,
      ...state.messages.slice(-12).map((message) => message.content),
      ...state.diceRolls.slice(-8).map((roll) => `${roll.label} ${roll.expression} ${JSON.stringify(roll.result)}`)
    ].join('\n');
    state.moduleSegments = moduleSegments
      .map((segment) => ({ segment, score: scoreModuleSegment(segment, query) }))
      .sort((a, b) => b.score - a.score || a.segment.sortOrder - b.segment.sortOrder)
      .slice(0, 6)
      .map((item) => item.segment);

    setAiTaskStatus(code, taskUid, 'GENERATING');
    const dmMessage = database.createMessage({
      code,
      authorType: 'dm',
      messageType: 'AI_DM',
      displayName: 'AI DM',
      content: '',
      status: 'streaming'
    });
    broadcastAiTask(code, database.attachAiTaskMessage({ taskUid, messageId: dmMessage.id }));

    hub.broadcast(code, 'message_created', { message: dmMessage });
    setAiTaskStatus(code, taskUid, 'STREAMING');

    let content = '';
    let lastPersistedAt = Date.now();

    try {
      const aiMessages = buildDmMessages(state);
      const taskAiConfig = roomRuntimeAiConfig(config.ai, database.getRoomAiSettings(code));
      for await (const chunk of streamChatCompletion(taskAiConfig, aiMessages)) {
        assertTaskNotCancelled(taskUid);
        content += chunk;
        hub.broadcast(code, 'message_delta', { id: dmMessage.id, delta: chunk, content });

        if (Date.now() - lastPersistedAt > 750) {
          database.updateMessage({ id: dmMessage.id, content, status: 'streaming' });
          lastPersistedAt = Date.now();
        }
      }

      setAiTaskStatus(code, taskUid, 'VALIDATING');
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: content.trim() || '（DM 沉默片刻，等待玩家继续行动。）',
        status: 'complete'
      });
      setAiTaskStatus(code, taskUid, 'COMPLETED');
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      const cancelled = error instanceof AiTaskCancelled;
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: `${content}\n\n[AI DM ${cancelled ? '已取消' : `生成失败：${publicError(error)}`}]`.trim(),
        status: 'error'
      });
      setAiTaskStatus(code, taskUid, cancelled ? 'CANCELLED' : 'FAILED', cancelled ? '' : publicError(error));
      hub.broadcast(code, 'message_error', { message: failed });
    }
  }

  function enqueueDm(code, taskUid) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateDmReply(code, taskUid));
  }

  function createSystemMessage(code, content) {
    return database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '系统',
      content,
      status: 'complete'
    });
  }

  function saveModuleFile({ fileName, extension, buffer }) {
    const modulesDir = resolve(config.dataDir, 'modules');
    mkdirSync(modulesDir, { recursive: true });
    const storageName = `${randomUUID()}.${extension}`;
    const storagePath = join(modulesDir, storageName);
    writeFileSync(storagePath, buffer, { mode: 0o600 });
    return storagePath;
  }

  function parseUploadedModule({ ownerPlayerId, title, file }) {
    const metadata = validateModuleFile(file);
    const storagePath = saveModuleFile({
      fileName: metadata.originalName,
      extension: metadata.extension,
      buffer: file.buffer
    });

    let parsedText = '';
    let segments = [];
    let parseStatus = 'PARSED';
    let parseError = '';

    try {
      parsedText = extractModuleText({ extension: metadata.extension, buffer: file.buffer });
      segments = segmentModuleText(parsedText);
      if (segments.length === 0) throw new Error('No text segments were extracted');
    } catch (error) {
      parseStatus = 'FAILED';
      parseError = publicError(error);
    }

    return database.createModule({
      ownerPlayerId,
      title,
      originalName: metadata.originalName,
      fileType: metadata.extension,
      contentType: metadata.contentType,
      sizeBytes: metadata.size,
      storagePath,
      parsedText,
      parseStatus,
      parseError,
      segments
    });
  }

  function buildRollResult(body, participant = null) {
    try {
      const rollType = String(body.rollType || body.type || (body.target === undefined ? 'expression' : 'check')).toLowerCase();

      if (rollType === 'skill' || rollType === 'skill_check') {
        if (!participant) throw new Error('participant is required');
        const skillName = assertString(body.skillName || body.label, 'skillName', 80);
        const target = getSkillTarget(participant.characterSheet, skillName);
        if (!Number.isInteger(target)) throw new Error('Unknown skill');
        const check = rollCocCheck({
          target,
          difficulty: body.difficulty || 'REGULAR',
          bonusDice: Number(body.bonusDice || 0),
          penaltyDice: Number(body.penaltyDice || 0)
        });
        return { ...check, type: 'skill_check', skillName };
      }

      if (rollType === 'check' || rollType === 'coc_check') {
        const target = Number(body.target);
        if (!Number.isInteger(target)) throw new Error('target is required');
        return rollCocCheck({
          target,
          difficulty: body.difficulty || 'REGULAR',
          bonusDice: Number(body.bonusDice || 0),
          penaltyDice: Number(body.penaltyDice || 0)
        });
      }

      if (rollType === 'sanity' || rollType === 'sanity_loss') {
        return rollSanityLoss(assertString(body.expression, 'expression', 40), Boolean(body.passed));
      }

      return rollDiceExpression(assertString(body.expression || '1d100', 'expression', 40));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error.message || 'Invalid roll');
    }
  }

  function rollSummary({ participant, label, result }) {
    const prefix = `${participant.characterName || participant.displayName} · ${label || '骰子'}`;

    if (result.type === 'coc_check' || result.type === 'skill_check') {
      const skill = result.skillName ? `${result.skillName} ` : '';
      return `${prefix}：${skill}1d100 = ${result.total} / ${result.target}，${result.successLevel}，${result.passed ? '通过' : '未通过'}`;
    }

    if (result.type === 'sanity_loss') {
      return `${prefix}：理智损失 ${result.expression}，结果 ${result.total}`;
    }

    const modifier = result.modifier ? ` ${result.modifier > 0 ? '+' : '-'} ${Math.abs(result.modifier)}` : '';
    return `${prefix}：${result.expression} = [${result.rolls.join(', ')}]${modifier}，合计 ${result.total}`;
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

    if (parts[1] === 'modules') {
      if (request.method === 'GET' && parts.length === 2) {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        sendJson(response, 200, { modules: database.listModules(playerId) });
        return;
      }

      if (request.method === 'POST' && parts.length === 2) {
        const { fields, files } = await readMultipartForm(request);
        const playerId = assertString(fields.playerId, 'playerId', 80);
        const title = assertString(fields.title || files.file?.fileName || '未命名模组', 'title', 120);
        const file = files.file || files.module;
        if (!file) throw new HttpError(400, 'Module file is required');
        const module = parseUploadedModule({ ownerPlayerId: playerId, title, file });
        sendJson(response, 201, { module });
        return;
      }

      if (request.method === 'GET' && parts.length === 4 && parts[3] === 'preview') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const moduleId = Number(parts[2]);
        if (!Number.isInteger(moduleId)) throw new HttpError(400, 'Invalid module id');
        const preview = database.getModuleForOwner(moduleId, playerId, {
          includeText: true,
          includeSegments: true,
          limit: 60
        });
        sendJson(response, 200, preview);
        return;
      }
    }

    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      const body = await readJson(request);
      const name = assertString(body.roomName || '新的冒险', 'roomName', 80);
      const playerId = assertString(body.playerId, 'playerId', 80);
      const displayName = assertString(body.displayName, 'displayName', 40);
      const moduleId = Number(body.moduleId);
      if (!Number.isInteger(moduleId)) throw new HttpError(400, 'moduleId is required');
      const result = database.createRoom({ name, playerId, displayName, moduleId });
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

      if (request.method === 'PATCH' && parts[3] === 'status') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const room = database.setRoomStatus({
          code,
          playerId,
          status: assertString(body.status, 'status', 20)
        });
        const message = createSystemMessage(code, `房间状态变更为：${STATUS_LABELS[room.status] || room.status}`);
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        hub.broadcast(code, 'message_created', { message });
        sendJson(response, 200, { ...state, message });
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

      if (request.method === 'PATCH' && parts[3] === 'character') {
        const body = await readJson(request);
        const participant = database.updateCharacterSheet({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          displayName: optionalString(body.displayName, 40),
          characterSheet: body.characterSheet || {}
        });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { participant });
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'ready') {
        const body = await readJson(request);
        const participant = database.setParticipantReady({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          isReady: Boolean(body.isReady)
        });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { participant });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'character' && parts[4] === 'history') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const targetPlayerId = optionalString(url.searchParams.get('targetPlayerId'), 80) || playerId;
        const history = database.getCharacterHistory({
          code,
          playerId,
          targetPlayerId,
          limit: Number(url.searchParams.get('limit') || 80)
        });
        sendJson(response, 200, { history });
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

      if (request.method === 'PATCH' && parts[3] === 'ai-config') {
        const body = await readJson(request);
        const room = database.updateRoomAiConfig({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          aiConfig: assertAiSettingsInput(body.aiConfig || {})
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
        const submitToDm = Boolean(body.submitToDm);
        const messageType = String(body.messageType || (submitToDm ? 'ACTION' : 'IC')).trim().toUpperCase();
        const { room } = database.getParticipant(code, playerId);
        const triggersAi = messageType === 'ACTION' || submitToDm;
        if (triggersAi && room.status !== 'ACTIVE') {
          throw new HttpError(409, 'Game is not active');
        }

        const message = database.createPlayerMessage({ code, playerId, content, messageType });
        hub.broadcast(code, 'message_created', { message });
        let aiTask = null;
        if (triggersAi) {
          const idempotencyKey = body.actionId
            ? `action:${playerId}:${String(body.actionId).slice(0, 80)}`
            : `message:${message.id}`;
          const result = database.createAiTask({
            code,
            playerId,
            triggerMessageId: message.id,
            idempotencyKey
          });
          aiTask = result.task;
          broadcastAiTask(code, aiTask);
          if (result.created) enqueueDm(code, aiTask.uid);
        }
        sendJson(response, 201, { message, aiQueued: Boolean(aiTask), aiTask });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'ai-tasks' && parts[4] && parts[5] === 'cancel') {
        const body = await readJson(request);
        const task = database.requestAiTaskCancel({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          taskUid: parts[4]
        });
        broadcastAiTask(code, task);
        if (task.status === 'QUEUED') {
          setAiTaskStatus(code, task.uid, 'CANCELLED');
        }
        sendJson(response, 200, { task: database.getAiTask(task.uid) });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'ai-tasks' && parts[4] && parts[5] === 'regenerate') {
        const body = await readJson(request);
        const result = database.createRegenerationTask({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          sourceTaskUid: parts[4]
        });
        broadcastAiTask(code, result.task);
        if (result.created) enqueueDm(code, result.task.uid);
        sendJson(response, 201, { task: result.task });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'rolls') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const { participant } = database.getParticipant(code, playerId);
        const result = buildRollResult(body, participant);
        const label = optionalString(body.label || result.skillName, 80);
        const isPrivate = Boolean(body.isPrivate);
        const roll = database.createDiceRoll({
          code,
          playerId,
          rollType: result.type,
          expression: result.expression,
          label,
          isPrivate,
          result
        });

        let message = null;
        if (!isPrivate) {
          message = createSystemMessage(code, rollSummary({ participant, label, result }));
          hub.broadcast(code, 'message_created', { message });
          hub.broadcast(code, 'dice_rolled', { roll });
        }

        sendJson(response, 201, { roll, message });
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
    try {
      const url = parseRequestUrl(request);
      const parts = route(url.pathname);

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
