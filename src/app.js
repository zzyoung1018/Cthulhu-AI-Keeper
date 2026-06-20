import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { buildDmMessages, streamChatCompletion } from './aiClient.js';
import { createEventApplier } from './aiEvents.js';
import { enhanceStructuredEvents, extractStructuredEvents, planPreflightCheck, validateStructuredEvents } from './aiOutput.js';
import {
  buildIntroPublicGuide,
  buildIntroSystemPrompt,
  buildIntroUserContext,
  buildOpeningSceneSystemPrompt,
  buildOpeningSceneUserContext,
  buildStructuredOutputPrompt,
  ensureCompleteIntroContent,
  ensureOpeningSceneContent
} from './prompts.js';
import { RoomAiQueue } from './aiQueue.js';
import { assertAiSettingsInput, roomRuntimeAiConfig } from './aiSettings.js';
import { getCheckTarget, getSkillTarget } from './character.js';
import { isAiConfigured } from './config.js';
import { createDatabase } from './db.js';
import { dispatchDiceRoll, formatD100RollDetail, formatRollSummary, rollContestedCheck } from './dice.js';
import { assertString, optionalString, HttpError } from './errors.js';
import { exportGameJson, exportGameMarkdown, exportReplayFixtureJson } from './export.js';
import { readJson, sendError, sendJson, serveStatic } from './http.js';
import { extractModuleText, scoreModuleSegment, segmentModuleText, validateModuleFile } from './moduleParser.js';
import { readMultipartForm } from './multipart.js';
import { capturePreRoundState, computeRollback, createRoundRecord } from './rounds.js';
import { buildAllPlayerStates } from './playerState.js';
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

const CHECK_DIFFICULTY_LABELS = {
  REGULAR: '普通',
  NORMAL: '普通',
  HARD: '困难',
  EXTREME: '极难'
};

const SUCCESS_LEVEL_LABELS = {
  CRITICAL: '大成功',
  EXTREME: '极难成功',
  HARD: '困难成功',
  REGULAR: '成功',
  FAIL: '失败',
  FUMBLE: '大失败'
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

  function addAiLog(code, entry) {
    const payload = { ...entry, time: new Date().toISOString() };
    try {
      database.createAiLog({
        code,
        taskUid: payload.taskUid || '',
        stage: payload.stage || 'log',
        entry: payload
      });
    } catch (logError) {
      console.error('[ai-log] failed to persist:', logError.message);
    }
    console.error(`[ai-log ${code}] ${payload.stage}: ${JSON.stringify(payload.summary || payload)}`);
  }

  const { applyStructuredEvents } = createEventApplier({ database, hub, addAiLog });

  function loadRoomModuleJson(room) {
    if (!room?.moduleId) return null;
    try {
      const preview = database.getModuleForOwner(
        room.moduleId,
        room.ownerPlayerId,
        { includeText: true, includeSegments: false }
      );
      const parsedText = preview?.module?.parsedText || '';
      return parsedText.trim().startsWith('{') ? JSON.parse(parsedText) : null;
    } catch {
      return null;
    }
  }

  function roomStateWithModuleJson(code, options = {}) {
    const state = database.getRoomState(code, options);
    state.moduleJson = loadRoomModuleJson(state.room);
    return state;
  }

  function isAssistedMode(room) {
    return String(room?.aiConfig?.triggerMode || '').toUpperCase() === 'ASSISTED';
  }

  function difficultyLabel(value) {
    const key = String(value || 'REGULAR').trim().toUpperCase();
    return CHECK_DIFFICULTY_LABELS[key] || key;
  }

  function successLevelLabel(value) {
    const key = String(value || '').trim().toUpperCase();
    return SUCCESS_LEVEL_LABELS[key] || key || '未知';
  }

  function clampBonusPenalty(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(2, Math.round(number)));
  }

  function shortActionText(message) {
    return String(message?.content || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  }

  function buildRequiredCheckMessage({ actionMessage, participant, checkTarget, result, difficulty, reason }) {
    const lines = [
      '🎲 房主裁定：必要检定',
      `行动：${shortActionText(actionMessage)}`,
      `调查员：${participant.characterName || participant.displayName}`,
      `项目：${checkTarget.label}(${checkTarget.target})，难度：${difficultyLabel(difficulty)}`,
      `掷骰：${formatD100RollDetail(result)}`,
      `结果：${successLevelLabel(result.successLevel)}，${result.passed ? '通过' : '未通过'}`
    ];
    if (reason) lines.push(`原因：${reason}`);
    lines.push('', '（检定结果已交给 AI DM，等待生成后续剧情。）');
    return lines.join('\n');
  }

  function buildOpposedCheckMessage({ actionMessage, participant, activeCheck, passiveName, passiveSkill, passiveTarget, result, contestType, reason }) {
    const contestTypeLabel = {
      social: '社交对抗',
      stealth: '潜行对抗',
      combat: '战斗对抗',
      item: '技术对抗'
    }[String(contestType || '').toLowerCase()] || '对抗检定';
    const playerWon = result.winner === 'player';
    const lines = [
      `🎭 房主裁定：${contestTypeLabel}`,
      `行动：${shortActionText(actionMessage)}`,
      `${participant.characterName || participant.displayName} 的 ${activeCheck.label}(${activeCheck.target}) vs ${passiveName} 的 ${passiveSkill}(${passiveTarget})`,
      `调查员 ${formatD100RollDetail(result.player)} → ${successLevelLabel(result.player.successLevel)}`,
      `${passiveName} ${formatD100RollDetail(result.npc)} → ${successLevelLabel(result.npc.successLevel)}`,
      `判定：${result.reason}`,
      `结果：${playerWon ? '调查员胜' : (result.winner === 'npc' ? 'NPC胜' : '平局')}`
    ];
    if (reason) lines.push(`原因：${reason}`);
    lines.push('', '（对抗结果已交给 AI DM，等待生成后续剧情。）');
    return lines.join('\n');
  }

  function firstAppliedCheckMessage(applied) {
    return applied?.opposedChecks?.[0]?.message || applied?.requiredChecks?.[0]?.message || null;
  }

  function firstAppliedCheckRoll(applied) {
    return applied?.opposedChecks?.[0]?.roll || applied?.requiredChecks?.[0]?.roll || null;
  }

  function appliedRollbackRefs(applied) {
    return {
      messageIds: [...new Set((applied?.messageIds || []).map(Number).filter(Number.isInteger))],
      diceRollIds: [...new Set((applied?.diceRollIds || []).map(Number).filter(Number.isInteger))]
    };
  }

  function preflightRollbackRefsFromTask(task) {
    const parts = String(task?.idempotencyKey || '').split(':');
    if (parts[0] !== 'precheck') return { messageIds: [], diceRollIds: [] };
    const messageId = Number(parts[2]);
    const rollId = Number(parts[3]);
    return {
      messageIds: Number.isInteger(messageId) ? [messageId] : [],
      diceRollIds: Number.isInteger(rollId) ? [rollId] : []
    };
  }

  function mergeRollbackRefs(...refs) {
    return {
      messageIds: [...new Set(refs.flatMap((ref) => ref?.messageIds || []).map(Number).filter(Number.isInteger))],
      diceRollIds: [...new Set(refs.flatMap((ref) => ref?.diceRollIds || []).map(Number).filter(Number.isInteger))]
    };
  }

  function isCheckContinuationTask(task) {
    const key = String(task?.idempotencyKey || '');
    return key.startsWith('continue:') || key.startsWith('precheck:');
  }

  function taskTriggerIsCheckResult(task) {
    if (!task?.triggerMessageId) return false;
    try {
      return isCheckResultMessage(database.getMessageById(task.triggerMessageId));
    } catch {
      return false;
    }
  }

  function shouldUseCheckContinuationPrompt(task, queuedPreflight) {
    return isCheckContinuationTask(task) ||
      queuedPreflight?.continuedFromCheck ||
      taskTriggerIsCheckResult(task);
  }

  function canRunQueuedPreflight(task) {
    if (!task?.triggerMessageId || isCheckContinuationTask(task)) return false;
    const key = String(task.idempotencyKey || '');
    if (key.startsWith('assisted:')) return false;
    return key.startsWith('message:') || key.startsWith('action:');
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

  function maybeRunQueuedPreflight(code, task) {
    if (!canRunQueuedPreflight(task)) {
      return { task, applied: null, continuedFromCheck: false };
    }

    const actionMessage = database.getMessageById(task.triggerMessageId);
    if (!actionMessage || actionMessage.authorType !== 'player' || actionMessage.messageType !== 'ACTION') {
      return { task, applied: null, continuedFromCheck: false };
    }
    if (actionMessage.aiProcessedTaskUid) {
      addAiLog(code, {
        stage: 'preflight-skipped',
        taskUid: task.uid,
        actionMessageId: actionMessage.id,
        playerId: actionMessage.playerId,
        reason: 'action-already-processed'
      });
      return { task, applied: null, continuedFromCheck: false };
    }

    const preflightState = roomStateWithModuleJson(code, {
      playerId: task.requestedByPlayerId || actionMessage.playerId || '',
      messageLimit: 100
    });
    const plan = planPreflightCheck({ actionMessage, roomState: preflightState });
    if (plan.type === 'none') {
      if (plan.issues?.length > 0) {
        addAiLog(code, {
          stage: 'preflight-skipped',
          taskUid: task.uid,
          actionMessageId: actionMessage.id,
          playerId: actionMessage.playerId,
          reason: plan.reason,
          detection: plan.detection,
          issues: plan.issues,
          warnings: plan.warnings || []
        });
      }
      return { task, applied: null, continuedFromCheck: false };
    }

    addAiLog(code, {
      stage: 'preflight-check',
      taskUid: task.uid,
      actionMessageId: actionMessage.id,
      playerId: actionMessage.playerId,
      type: plan.type,
      reason: plan.reason,
      eventKeys: Object.keys(plan.events || {}),
      detection: plan.detection,
      issues: plan.issues || [],
      warnings: plan.warnings || []
    });

    const applied = applyStructuredEvents(code, task.uid, plan.events, null, preflightState.moduleJson);
    const checkMessage = firstAppliedCheckMessage(applied);
    const checkRoll = firstAppliedCheckRoll(applied);
    if (!checkMessage) {
      addAiLog(code, {
        stage: 'preflight-skipped',
        taskUid: task.uid,
        actionMessageId: actionMessage.id,
        playerId: actionMessage.playerId,
        reason: 'no-check-message-created',
        type: plan.type
      });
      return { task, applied: null, continuedFromCheck: false };
    }

    const updatedTask = database.updateAiTaskTrigger({
      taskUid: task.uid,
      triggerMessageId: checkMessage.id
    });
    if (updatedTask) {
      task = updatedTask;
      broadcastAiTask(code, task);
    }

    return {
      task,
      applied,
      continuedFromCheck: true,
      checkMessage,
      checkRoll
    };
  }

  async function generateDmReply(code, taskUid) {
    let task;
    try {
      task = assertTaskNotCancelled(taskUid);
    } catch (error) {
      if (error instanceof AiTaskCancelled) {
        setAiTaskStatus(code, taskUid, 'CANCELLED');
        return;
      }
      throw error;
    }

    setAiTaskStatus(code, taskUid, 'RETRIEVING');
    const queuedPreflight = maybeRunQueuedPreflight(code, task);
    task = queuedPreflight.task || task;
    const state = roomStateWithModuleJson(code, 80);
    const moduleSegments = database.getRoomModuleSegments(code, 120);

    // Capture pre-round state for rollback
    const preState = capturePreRoundState(state);

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

    // Build per-player state JSONs
    state.playerStates = buildAllPlayerStates(state.participants, state.room);

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
      // 结构化输出指令作为 system 消息，优先级最高
      aiMessages.splice(1, 0, { role: 'system', content: buildStructuredOutputPrompt() });
      if (shouldUseCheckContinuationPrompt(task, queuedPreflight)) {
        aiMessages.splice(2, 0, {
          role: 'system',
          content: [
            '本轮是“检定结果后的继续叙事”。',
            '必须根据最近的骰子/系统检定消息推进结果，不要重复要求同一个检定。',
            '如果最近检定失败，描述失败后果；如果成功，描述成功获得的信息、位置或 NPC 反应。',
            '不要改写、重掷或补编服务器已经给出的 d100 点数和胜负。',
            '本轮通常不需要再返回 required_checks 或 opposed_checks，除非玩家在检定后已经做了新的正式行动。',
            '若根据成功检定揭示线索，请用 clues_revealed；若 NPC 态度/位置变化，请用 npc_state_changes。'
          ].join('\n')
        });
      }
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

      // Parse and validate structured events
      const { narrative, events } = extractStructuredEvents(content);
      const enhanced = enhanceStructuredEvents({
        events,
        narrative,
        roomState: state,
        triggerMessageId: task?.triggerMessageId || null,
        disableCheckInference: isAssistedMode(state.room)
      });
      const { valid, rejected, issues, warnings } = validateStructuredEvents(enhanced.events, {
        roomState: state,
        defaultPlayerId: task?.requestedByPlayerId || ''
      });

      // 诊断日志
      addAiLog(code, {
        stage: 'structured-events',
        taskUid,
        hasJsonBlock: Object.keys(events).length > 0,
        eventKeys: Object.keys(events),
        enhancedEventKeys: Object.keys(enhanced.events),
        validKeys: Object.keys(valid),
        rejectedKeys: rejected,
        issues,
        warnings,
        hasOpposedChecks: Array.isArray(enhanced.events.opposed_checks) && enhanced.events.opposed_checks.length > 0,
        opposedCount: Array.isArray(enhanced.events.opposed_checks) ? enhanced.events.opposed_checks.length : 0,
        detection: enhanced.diagnostics,
        rawResponseSnippet: content.slice(-500)
      });

      const narrationContent = enhanced.narrative || narrative || content.trim() || '（DM 沉默片刻，等待玩家继续行动。）';
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: narrationContent,
        status: 'complete'
      });

      // Apply valid structured events
      let appliedEvents = null;
      if (Object.keys(valid).length > 0) {
        addAiLog(code, { stage: 'apply-events', taskUid, keys: Object.keys(valid) });
        appliedEvents = applyStructuredEvents(code, taskUid, valid, dmMessage.id, state.moduleJson);
      }

      if (rejected.length > 0) {
        addAiLog(code, { stage: 'rejected-events', taskUid, rejected, issues });
        console.error('[ai-output] rejected events:', rejected, issues);
      }

      // Save round record for rollback
      try {
        const rollbackRefs = mergeRollbackRefs(
          preflightRollbackRefsFromTask(task),
          appliedRollbackRefs(queuedPreflight.applied),
          appliedRollbackRefs(appliedEvents)
        );
        createRoundRecord({
          database,
          roomId: state.room.id,
          aiTaskUid: taskUid,
          dmMessageId: dmMessage.id,
          preState: {
            ...preState,
            rollbackRefs
          }
        });
      } catch (roundError) {
        console.error('[ai-output] round record failed:', roundError.message);
      }

      database.markAiTriggerProcessed({ taskUid });
      addAiLog(code, { stage: 'dm-completed', taskUid });
      setAiTaskStatus(code, taskUid, 'COMPLETED');
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      const cancelled = error instanceof AiTaskCancelled;
      addAiLog(code, { stage: 'dm-failed', taskUid, cancelled, error: publicError(error) });
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: `${content}\n\n[AI DM ${cancelled ? '已取消' : '生成失败：' + publicError(error)}]`.trim(),
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

  function enqueueModuleIntro(code, taskUid) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateModuleIntro(code, taskUid));
  }

  function enqueueOpeningScene(code, taskUid) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateOpeningScene(code, taskUid));
  }

  function loadPublicModuleGuide(code, state, { segmentLimit = 40, includeOpening = false } = {}) {
    const moduleSegments = database.getRoomModuleSegments(code, segmentLimit);

    // Try to extract structured JSON module data
    let jsonData = null;
    try {
      const preview = database.getModuleForOwner(
        state.room.moduleId,
        state.room.ownerPlayerId,
        { includeText: true, includeSegments: false }
      );
      const pt = preview?.module?.parsedText || '';
      if (pt.trim().startsWith('{')) {
        jsonData = JSON.parse(pt);
      }
    } catch { /* not JSON, use text segments */ }

    // Build context from JSON or text segments
    let moduleContext = '';
    if (jsonData) {
      const mi = jsonData.module_info || {};
      const po = jsonData.player_opening || {};

      moduleContext = [
        '=== 模组玩家公开结构化信息 ===',
        `标题：${mi.title || state.room.moduleTitle}`,
        mi.time_period ? `时代：${mi.time_period}` : '',
        mi.location ? `地点：${mi.location}` : '',
        mi.setting ? `设定：${mi.setting}` : '',
        mi.themes?.length ? `主题：${mi.themes.join('、')}` : '',
        mi.tone ? `氛围：${mi.tone}` : '',
        mi.recommended_players ? `建议人数：${mi.recommended_players}` : '',
        mi.estimated_duration ? `预计时长：${mi.estimated_duration}` : '',
        mi.content_warnings?.length ? `内容警告：${mi.content_warnings.join('、')}` : '',
        '',
        po.initial_public_information ? `=== 玩家公开信息 ===\n${po.initial_public_information}` : '',
        po.initial_objective ? `初始目标：${po.initial_objective}` : '',
        includeOpening && po.suggested_intro_text ? `建议开场文本：${po.suggested_intro_text}` : '',
        po.known_npcs?.length ? `已知NPC：${po.known_npcs.join('、')}` : '',
        po.known_locations?.length ? `已知地点：${po.known_locations.join('、')}` : '',
        po.known_handouts?.length ? `已知资料/物件：${po.known_handouts.join('、')}` : ''
      ].filter(Boolean).join('\n');
    } else {
      moduleContext = moduleSegments.slice(0, includeOpening ? 10 : 8)
        .map((s) => `[${s.scene || s.title}]\n${s.content}`).join('\n\n');
    }

    const introGuide = buildIntroPublicGuide({
      moduleTitle: state.room.moduleTitle,
      maxPlayers: state.room.maxPlayers,
      moduleJson: jsonData,
      moduleContext
    });

    return { jsonData, moduleContext, introGuide };
  }

  async function generateModuleIntro(code, taskUid) {
    setAiTaskStatus(code, taskUid, 'RETRIEVING');

    const state = database.getRoomState(code, 80);
    const roomCfg = state.room.aiConfig || {};
    const { moduleContext, introGuide } = loadPublicModuleGuide(code, state, {
      segmentLimit: 40,
      includeOpening: false
    });

    const systemMsg = buildIntroSystemPrompt(roomCfg);
    const userMsg = buildIntroUserContext({
      moduleTitle: state.room.moduleTitle,
      maxPlayers: state.room.maxPlayers,
      moduleContext,
      introGuide
    });

    setAiTaskStatus(code, taskUid, 'GENERATING');

    const dmMessage = database.createMessage({
      code,
      authorType: 'dm',
      messageType: 'AI_DM',
      displayName: 'AI 守秘人',
      content: '',
      status: 'streaming'
    });
    broadcastAiTask(code, database.attachAiTaskMessage({ taskUid, messageId: dmMessage.id }));
    hub.broadcast(code, 'message_created', { message: dmMessage });
    setAiTaskStatus(code, taskUid, 'STREAMING');

    let content = '';
    let lastPersistedAt = Date.now();

    try {
      const taskAiConfig = roomRuntimeAiConfig(config.ai, database.getRoomAiSettings(code));
      for await (const chunk of streamChatCompletion(taskAiConfig, [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ])) {
        content += chunk;
        hub.broadcast(code, 'message_delta', { id: dmMessage.id, delta: chunk, content });

        if (Date.now() - lastPersistedAt > 750) {
          database.updateMessage({ id: dmMessage.id, content, status: 'streaming' });
          lastPersistedAt = Date.now();
        }
      }

      setAiTaskStatus(code, taskUid, 'VALIDATING');
      const completedContent = ensureCompleteIntroContent(content.trim(), introGuide);
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: completedContent || '（AI 未能生成模组介绍，请房主手动说明。）',
        status: 'complete'
      });
      addAiLog(code, { stage: 'intro-completed', taskUid });
      setAiTaskStatus(code, taskUid, 'COMPLETED');
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      addAiLog(code, { stage: 'intro-failed', taskUid, error: publicError(error) });
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: (content + '\n\n[生成失败：' + publicError(error) + ']').trim(),
        status: 'error'
      });
      setAiTaskStatus(code, taskUid, 'FAILED', publicError(error));
      hub.broadcast(code, 'message_error', { message: failed });
    }
  }

  async function generateOpeningScene(code, taskUid) {
    setAiTaskStatus(code, taskUid, 'RETRIEVING');

    const state = database.getRoomState(code, 80);
    const roomCfg = state.room.aiConfig || {};
    const { moduleContext, introGuide } = loadPublicModuleGuide(code, state, {
      segmentLimit: 40,
      includeOpening: true
    });

    const systemMsg = buildOpeningSceneSystemPrompt(roomCfg);
    const userMsg = buildOpeningSceneUserContext({
      moduleTitle: state.room.moduleTitle,
      maxPlayers: state.room.maxPlayers,
      moduleContext,
      introGuide
    });

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
      const taskAiConfig = roomRuntimeAiConfig(config.ai, database.getRoomAiSettings(code));
      for await (const chunk of streamChatCompletion(taskAiConfig, [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ])) {
        assertTaskNotCancelled(taskUid);
        content += chunk;
        hub.broadcast(code, 'message_delta', { id: dmMessage.id, delta: chunk, content });

        if (Date.now() - lastPersistedAt > 750) {
          database.updateMessage({ id: dmMessage.id, content, status: 'streaming' });
          lastPersistedAt = Date.now();
        }
      }

      setAiTaskStatus(code, taskUid, 'VALIDATING');
      const openingContent = ensureOpeningSceneContent(content.trim(), introGuide);
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: openingContent,
        status: 'complete'
      });
      addAiLog(code, { stage: 'opening-completed', taskUid });
      setAiTaskStatus(code, taskUid, 'COMPLETED');
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      const cancelled = error instanceof AiTaskCancelled;
      addAiLog(code, { stage: 'opening-failed', taskUid, cancelled, error: publicError(error) });
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: `${content}\n\n[AI 开场${cancelled ? '已取消' : '生成失败：' + publicError(error)}]`.trim(),
        status: 'error'
      });
      setAiTaskStatus(code, taskUid, cancelled ? 'CANCELLED' : 'FAILED', cancelled ? '' : publicError(error));
      hub.broadcast(code, 'message_error', { message: failed });
    }
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

  function isCheckResultMessage(message) {
    return message?.authorType === 'system' &&
      ['对抗检定', '必要检定'].includes(message.displayName || '');
  }

  function hasNarrativeContinuationAfter(messages, checkMessageId) {
    const checkIndex = messages.findIndex((message) => message.id === checkMessageId);
    if (checkIndex < 0) return true;
    return messages.slice(checkIndex + 1).some((message) =>
      message.authorType === 'dm' ||
      (message.authorType === 'player' && message.messageType === 'ACTION')
    );
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
      segments = segmentModuleText(parsedText, metadata.extension);
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
      const skillTarget = (body.rollType === 'skill' || body.rollType === 'skill_check')
        ? getSkillTarget(participant?.characterSheet, body.skillName || body.label)
        : null;

      const { result, label: autoLabel } = dispatchDiceRoll({
        rollType: body.rollType || body.type || (body.target === undefined ? 'expression' : 'check'),
        expression: body.expression,
        target: Number(body.target) || 0,
        skillName: body.skillName || body.label,
        skillTarget,
        difficulty: body.difficulty,
        bonusDice: Number(body.bonusDice || 0),
        penaltyDice: Number(body.penaltyDice || 0),
        passed: body.passed,
        currentLuck: body.currentLuck,
        spendLuckAmount: body.spendLuckAmount,
        passiveTarget: Number(body.passiveTarget || 0)
      });
      return { ...result, label: autoLabel || body.label || result.skillName || '' };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error.message || 'Invalid roll');
    }
  }

  function rollSummaryText({ participant, label, result }) {
    return formatRollSummary({
      participantName: participant.characterName || participant.displayName,
      label,
      result
    });
  }

  function assistedDecision(value) {
    const text = String(value || 'NO_CHECK').trim().toUpperCase();
    if (['NO_CHECK', 'PASS', 'SKIP'].includes(text)) return 'NO_CHECK';
    if (['REQUIRED_CHECK', 'REQUIRED', 'CHECK'].includes(text)) return 'REQUIRED_CHECK';
    if (['OPPOSED_CHECK', 'OPPOSED', 'CONTEST'].includes(text)) return 'OPPOSED_CHECK';
    throw new HttpError(400, 'Invalid adjudication decision');
  }

  function findAdjudicatableAction(state, actionMessageId) {
    const action = state.messages.find((message) => Number(message.id) === Number(actionMessageId));
    if (!action || action.authorType !== 'player' || action.messageType !== 'ACTION') {
      throw new HttpError(400, 'No player action found for adjudication');
    }
    if (action.aiProcessedTaskUid) {
      throw new HttpError(409, 'This action has already been adjudicated');
    }
    return action;
  }

  function queueAssistedAiTask({ code, ownerPlayerId, actionMessage, triggerMessage, idempotencyKey }) {
    const result = database.createAiTask({
      code,
      playerId: ownerPlayerId,
      triggerMessageId: triggerMessage?.id || actionMessage.id,
      idempotencyKey
    });
    database.markActionProcessedByTask({
      code,
      actionMessageId: actionMessage.id,
      taskUid: result.task.uid
    });
    broadcastAiTask(code, result.task);
    if (result.created) enqueueDm(code, result.task.uid);
    return result;
  }

  function adjudicateNoCheck({ code, ownerPlayerId, actionMessage, reason }) {
    const message = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '房主裁定',
      content: [
        '房主裁定：此行动无需检定。',
        `行动：${shortActionText(actionMessage)}`,
        reason ? `说明：${reason}` : '',
        '',
        '（已交给 AI DM 继续生成剧情。）'
      ].filter((line) => line !== '').join('\n'),
      status: 'complete'
    });
    hub.broadcast(code, 'message_created', { message });
    const taskResult = queueAssistedAiTask({
      code,
      ownerPlayerId,
      actionMessage,
      triggerMessage: actionMessage,
      idempotencyKey: `assisted:no-check:${actionMessage.id}`
    });
    return { message, roll: null, taskResult };
  }

  function adjudicateRequiredCheck({ code, ownerPlayerId, actionMessage, body }) {
    const targetPlayerId = optionalString(body.targetPlayerId, 80) || actionMessage.playerId;
    const { participant } = database.getParticipant(code, targetPlayerId);
    const skillName = assertString(body.skillName || body.checkName, 'skillName', 80);
    const checkTarget = getCheckTarget(participant.characterSheet, skillName);
    if (!checkTarget || !Number.isInteger(checkTarget.target)) {
      throw new HttpError(400, 'Unknown skill or characteristic for target player');
    }

    const difficulty = String(body.difficulty || 'REGULAR').trim().toUpperCase();
    const { result } = dispatchDiceRoll({
      rollType: 'skill',
      skillName: checkTarget.label,
      skillTarget: checkTarget.target,
      difficulty,
      bonusDice: clampBonusPenalty(body.bonusDice),
      penaltyDice: clampBonusPenalty(body.penaltyDice)
    });
    const enrichedResult = {
      ...result,
      checkType: checkTarget.type,
      skillName: checkTarget.label
    };

    const roll = database.createDiceRoll({
      code,
      playerId: targetPlayerId,
      rollType: enrichedResult.type,
      expression: enrichedResult.expression,
      label: checkTarget.label,
      result: enrichedResult
    });

    const reason = optionalString(body.reason, 400);
    const message = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '必要检定',
      content: buildRequiredCheckMessage({
        actionMessage,
        participant,
        checkTarget,
        result: enrichedResult,
        difficulty,
        reason
      }),
      status: 'complete'
    });
    hub.broadcast(code, 'message_created', { message });
    hub.broadcast(code, 'dice_rolled', { roll });

    const taskResult = queueAssistedAiTask({
      code,
      ownerPlayerId,
      actionMessage,
      triggerMessage: message,
      idempotencyKey: `assisted:required:${actionMessage.id}:${message.id}`
    });
    return { message, roll, taskResult };
  }

  function adjudicateOpposedCheck({ code, ownerPlayerId, actionMessage, body }) {
    const targetPlayerId = optionalString(body.targetPlayerId, 80) || actionMessage.playerId;
    const { participant } = database.getParticipant(code, targetPlayerId);
    const activeSkillName = assertString(body.skillName || body.activeSkill, 'skillName', 80);
    const activeCheck = getCheckTarget(participant.characterSheet, activeSkillName);
    if (!activeCheck || !Number.isInteger(activeCheck.target)) {
      throw new HttpError(400, 'Unknown active skill or characteristic for target player');
    }

    const passiveName = assertString(body.passiveName || body.passiveNpcName || 'NPC', 'passiveName', 80);
    const passiveSkill = optionalString(body.passiveSkill, 80) || '心理学';
    const passiveTarget = Number(body.passiveTarget);
    if (!Number.isInteger(passiveTarget) || passiveTarget < 1 || passiveTarget > 100) {
      throw new HttpError(400, 'passiveTarget must be an integer from 1 to 100');
    }
    const contestType = String(body.contestType || 'social').trim().toLowerCase();
    const result = rollContestedCheck({
      playerSkill: activeCheck.target,
      npcSkill: passiveTarget,
      playerName: participant.characterName || participant.displayName,
      npcName: passiveName,
      playerBonusDice: clampBonusPenalty(body.bonusDice),
      playerPenaltyDice: clampBonusPenalty(body.penaltyDice),
      defenderIsNpc: contestType !== 'combat'
    });

    const roll = database.createDiceRoll({
      code,
      playerId: targetPlayerId,
      rollType: 'contested_check',
      expression: '1d100',
      label: `${activeCheck.label} vs ${passiveName}(${passiveSkill})`,
      result
    });

    const reason = optionalString(body.reason, 400);
    const message = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '对抗检定',
      content: buildOpposedCheckMessage({
        actionMessage,
        participant,
        activeCheck,
        passiveName,
        passiveSkill,
        passiveTarget,
        result,
        contestType,
        reason
      }),
      status: 'complete'
    });
    hub.broadcast(code, 'message_created', { message });
    hub.broadcast(code, 'dice_rolled', { roll });

    const taskResult = queueAssistedAiTask({
      code,
      ownerPlayerId,
      actionMessage,
      triggerMessage: message,
      idempotencyKey: `assisted:opposed:${actionMessage.id}:${message.id}`
    });
    return { message, roll, taskResult };
  }

  function performAssistedAdjudication({ code, body }) {
    const ownerPlayerId = assertString(body.playerId, 'playerId', 80);
    const actionMessageId = Number(body.actionMessageId);
    if (!Number.isInteger(actionMessageId)) throw new HttpError(400, 'actionMessageId is required');
    const decision = assistedDecision(body.decision);
    const { room } = database.getParticipant(code, ownerPlayerId);
    if (room.ownerPlayerId !== ownerPlayerId) throw new HttpError(403, 'Only the room owner can adjudicate actions');
    if (room.status !== 'ACTIVE') throw new HttpError(409, 'Game is not active');
    if (!isAssistedMode(room)) throw new HttpError(409, 'AI assisted mode is not enabled');

    const state = database.getRoomState(code, { playerId: ownerPlayerId, messageLimit: 200 });
    const actionMessage = findAdjudicatableAction(state, actionMessageId);
    const reason = optionalString(body.reason, 400);

    let result;
    if (decision === 'NO_CHECK') {
      result = adjudicateNoCheck({ code, ownerPlayerId, actionMessage, reason });
    } else if (decision === 'REQUIRED_CHECK') {
      result = adjudicateRequiredCheck({ code, ownerPlayerId, actionMessage, body });
    } else {
      result = adjudicateOpposedCheck({ code, ownerPlayerId, actionMessage, body });
    }

    const nextState = database.getRoomState(code, { playerId: ownerPlayerId, messageLimit: 100 });
    hub.broadcast(code, 'room_state', database.getRoomState(code, { messageLimit: 100 }));
    return {
      ...nextState,
      decision,
      adjudicationMessage: result.message,
      roll: result.roll,
      aiQueued: true,
      aiTask: result.taskResult.task,
      created: result.taskResult.created
    };
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

    if (request.method === 'POST' && parts.length === 3 && parts[1] === 'imports' && parts[2] === 'playtest') {
      const body = await readJson(request);
      const playerId = assertString(body.playerId, 'playerId', 80);
      const displayName = assertString(body.displayName, 'displayName', 40);
      const imported = database.importPlaytestExport({
        exportData: body.export || body.exportData || body.playtest || body,
        ownerPlayerId: playerId,
        displayName,
        roomName: optionalString(body.roomName, 80)
      });
      sendJson(response, 201, imported);
      return;
    }

    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      const body = await readJson(request);
      const name = assertString(body.roomName || '新的冒险', 'roomName', 80);
      const playerId = assertString(body.playerId, 'playerId', 80);
      const displayName = assertString(body.displayName, 'displayName', 40);
      const moduleId = Number(body.moduleId);
      if (!Number.isInteger(moduleId)) throw new HttpError(400, 'moduleId is required');
      const maxPlayers = Number(body.maxPlayers) || 5;
      const result = database.createRoom({ name, playerId, displayName, moduleId, maxPlayers });
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
        sendJson(response, 200, database.getRoomState(code, { playerId: playerId || '' }));
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

      if (request.method === 'POST' && parts[3] === 'leave') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const { room, participant } = database.getParticipant(code, playerId);

        // 房主离开 → 房间结束
        if (room.ownerPlayerId === playerId) {
          const ended = database.setRoomStatus({ code, playerId, status: 'ENDED' });
          const msg = createSystemMessage(code, '房主离开了，房间已结束。');
          const state = database.getRoomState(code);
          hub.broadcast(code, 'room_state', state);
          hub.broadcast(code, 'message_created', { message: msg });
          sendJson(response, 200, { disbanded: true, room: ended });
          return;
        }

        // 普通玩家离开：移除参与者记录（通过删除participant）
        database.removeParticipant(room.id, playerId);
        const msg = createSystemMessage(code, `${participant.characterName || participant.displayName} 离开了房间。`);
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        hub.broadcast(code, 'message_created', { message: msg });
        sendJson(response, 200, { left: true });
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'status') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const nextStatus = assertString(body.status, 'status', 20);
        const beforeState = database.getRoomState(code, 1);
        const room = database.setRoomStatus({
          code,
          playerId,
          status: nextStatus
        });
        const message = createSystemMessage(code, `房间状态变更为：${STATUS_LABELS[room.status] || room.status}`);
        let openingTask = null;
        let openingCreated = false;
        if (beforeState.room.status === 'PREPARING' && room.status === 'ACTIVE') {
          const result = database.createAiTask({
            code,
            playerId,
            idempotencyKey: `opening:${code}`
          });
          openingTask = result.task;
          openingCreated = result.created;
          broadcastAiTask(code, openingTask);
        }
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        hub.broadcast(code, 'message_created', { message });
        if (openingTask && openingCreated) enqueueOpeningScene(code, openingTask.uid);
        sendJson(response, 200, { ...state, message, openingTask, openingCreated });
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

      if (request.method === 'POST' && parts[3] === 'adjudications') {
        const body = await readJson(request);
        const payload = performAssistedAdjudication({ code, body });
        sendJson(response, 201, payload);
        return;
      }

      if (request.method === 'POST' && parts[3] === 'continue') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const checkMessageId = Number(body.checkMessageId);
        if (!Number.isInteger(checkMessageId)) throw new HttpError(400, 'checkMessageId is required');

        const { room } = database.getParticipant(code, playerId);
        if (room.status !== 'ACTIVE') throw new HttpError(409, 'Game is not active');

        const state = database.getRoomState(code, { playerId, messageLimit: 100 });
        if (state.activeAiTask) throw new HttpError(409, 'AI is already generating');

        const checkMessage = state.messages.find((message) => message.id === checkMessageId);
        if (!checkMessage || checkMessage.roomId !== room.id || !isCheckResultMessage(checkMessage)) {
          throw new HttpError(400, 'No continuable check message found');
        }
        if (hasNarrativeContinuationAfter(state.messages, checkMessageId)) {
          throw new HttpError(409, 'This check has already been continued');
        }

        const result = database.createAiTask({
          code,
          playerId,
          triggerMessageId: checkMessage.id,
          idempotencyKey: `continue:${checkMessage.id}`
        });
        broadcastAiTask(code, result.task);
        if (result.created) enqueueDm(code, result.task.uid);
        sendJson(response, 201, { aiQueued: true, aiTask: result.task, created: result.created });
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
        const privateTarget = optionalString(body.privateTarget, 80);
        const sender = database.getParticipant(code, playerId);
        const { room } = sender;
        const triggersAi = messageType === 'ACTION' || submitToDm;
        if (triggersAi && room.status !== 'ACTIVE') {
          throw new HttpError(409, 'Game is not active');
        }

        // Private messages: only deliver to intended recipient (and sender sees their own)
        if (messageType === 'PRIVATE') {
          if (!privateTarget) {
            throw new HttpError(400, 'privateTarget is required for private messages');
          }
          try {
            database.getParticipant(code, privateTarget);
          } catch {
            throw new HttpError(400, 'privateTarget must be a room participant');
          }
          const { participant } = sender;
          const message = database.createMessage({
            code,
            authorType: 'player',
            messageType: 'PRIVATE',
            playerId,
            participantId: participant.id,
            displayName: participant.characterName || participant.displayName,
            content,
            status: 'complete',
            privateTarget
          });
          hub.sendTo(code, privateTarget, 'message_created', { message });
          hub.sendTo(code, playerId, 'message_created', { message });
          sendJson(response, 201, { message, aiQueued: false });
          return;
        }

        const message = database.createPlayerMessage({ code, playerId, content, messageType });
        hub.broadcast(code, 'message_created', { message });
        let aiTask = null;
        if (triggersAi) {
          if (isAssistedMode(room)) {
            sendJson(response, 201, {
              message,
              aiQueued: false,
              aiTask: null,
              assistedPending: true,
              preflightCheck: null
            });
            return;
          }

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
        sendJson(response, 201, { message, aiQueued: Boolean(aiTask), aiTask, preflightCheck: null });
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
        if (isPrivate) {
          message = createSystemMessage(code, rollSummaryText({ participant, label, result }));
          hub.sendTo(code, playerId, 'message_created', { message });
          hub.sendTo(code, playerId, 'dice_rolled', { roll });
        } else {
          message = createSystemMessage(code, rollSummaryText({ participant, label, result }));
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
        hub.subscribePlayer(code, playerId, response);
        hub.send(response, 'connected', { ok: true });

        const heartbeat = setInterval(() => {
          if (!response.destroyed) hub.send(response, 'heartbeat', { time: Date.now() });
        }, 25_000);
        response.on('close', () => clearInterval(heartbeat));
        return;
      }

      if (request.method === 'POST' && parts[3] === 'messages' && parts[4] === 'review') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const messageId = Number(body.messageId);
        if (!Number.isInteger(messageId)) throw new HttpError(400, 'messageId is required');
        const approved = Boolean(body.approved);

        const { room } = database.getParticipant(code, playerId);
        if (room.ownerPlayerId !== playerId) throw new HttpError(403, 'Only the room owner can review AI replies');

        const message = database.updateMessage({
          id: messageId,
          content: approved
            ? (body.content || database.getMessageById(messageId)?.content || '')
            : `[审核未通过] ${database.getMessageById(messageId)?.content || ''}`,
          status: approved ? 'complete' : 'error'
        });

        hub.broadcast(code, approved ? 'message_completed' : 'message_error', { message });
        sendJson(response, 200, { message, approved });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'rollback' && parts[4]) {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const rollbackRef = String(parts[4] || '').trim();
        const numericRoundId = Number(rollbackRef);
        const useRoundId = Number.isInteger(numericRoundId);

        const result = computeRollback({
          database,
          roomCode: code,
          playerId,
          roundId: useRoundId ? numericRoundId : null,
          taskUid: useRoundId ? '' : rollbackRef
        });

        const publicState = database.getRoomState(code);
        const playerState = database.getRoomState(code, { playerId });
        hub.broadcast(code, 'room_state', publicState);
        hub.broadcast(code, 'round_rolled_back', { roundId: result.roundId, aiTaskUid: result.aiTaskUid });
        sendJson(response, 200, { ...result, ...playerState });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'rounds') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const { room } = database.getParticipant(code, playerId);
        const rounds = database.listRoundStates(room.id, Number(url.searchParams.get('limit') || 20));
        sendJson(response, 200, { rounds: rounds.map((r) => ({ ...r, snapshotJson: undefined })) });
        return;
      }

      if (request.method === 'POST' && parts[3] === 'start-intro') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const { room } = database.getParticipant(code, playerId);
        if (room.ownerPlayerId !== playerId) throw new HttpError(403, 'Only the room owner can start intro');

        const introTask = database.createAiTask({
          code,
          playerId,
          idempotencyKey: `intro:${code}`
        });
        broadcastAiTask(code, introTask.task);
        if (introTask.created) enqueueModuleIntro(code, introTask.task.uid);
        sendJson(response, 201, { task: introTask.task, created: introTask.created });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'export') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const format = String(url.searchParams.get('format') || 'json').toLowerCase();
        if (!['json', 'markdown'].includes(format)) throw new HttpError(400, 'Format must be json or markdown');

        const state = database.getExportState(code, playerId);

        if (format === 'json') {
          const jsonOutput = exportGameJson(state);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="dm-online-${code}.json"` });
          response.end(jsonOutput);
        } else {
          const mdOutput = exportGameMarkdown(state);
          response.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="dm-online-${code}.md"` });
          response.end(mdOutput);
        }
        return;
      }

      if (request.method === 'GET' && parts[3] === 'replay-fixture') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const state = database.getExportState(code, playerId);
        if (!state.isOwnerExport) throw new HttpError(403, 'Only the room owner can export replay fixtures');
        if (!state.room.roomMeta?.replay?.isReplay) throw new HttpError(409, 'Room is not an imported replay');
        const jsonOutput = exportReplayFixtureJson(state);
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="dm-online-${code}-fixture.json"` });
        response.end(jsonOutput);
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'player-state') {
        const body = await readJson(request);
        const playerId = assertString(body.playerId, 'playerId', 80);
        const meta = body.meta || {};
        database.updatePlayerMeta({ code, playerId, meta });
        const state = database.getRoomState(code, { playerId });
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'ai-log') {
        const playerId = assertString(url.searchParams.get('playerId'), 'playerId', 80);
        const { room } = database.getParticipant(code, playerId);
        if (room.ownerPlayerId !== playerId) throw new HttpError(403, 'Only the room owner can view AI logs');
        const logs = database.listAiLogs({ code, limit: 80 });
        sendJson(response, 200, { logs: logs.slice(-50) });
        return;
      }

      if (request.method === 'PATCH' && parts[3] === 'scene-state') {
        const body = await readJson(request);
        const room = database.updateSceneState({
          code,
          playerId: assertString(body.playerId, 'playerId', 80),
          sceneState: body.sceneState || {}
        });
        const state = database.getRoomState(code);
        hub.broadcast(code, 'room_state', state);
        sendJson(response, 200, { room });
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
