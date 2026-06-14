import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { buildDmMessages, streamChatCompletion } from './aiClient.js';
import { extractStructuredEvents, validateStructuredEvents } from './aiOutput.js';
import { buildIntroSystemPrompt, buildIntroUserContext, buildStructuredOutputPrompt } from './prompts.js';
import { RoomAiQueue } from './aiQueue.js';
import { assertAiSettingsInput, roomRuntimeAiConfig } from './aiSettings.js';
import { getSkillTarget } from './character.js';
import { isAiConfigured } from './config.js';
import { createDatabase } from './db.js';
import { dispatchDiceRoll, formatRollSummary, rollContestedCheck } from './dice.js';
import { assertString, optionalString, HttpError } from './errors.js';
import { exportGameJson, exportGameMarkdown } from './export.js';
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

    // Try to get module JSON for AI context
    state.moduleJson = null;
    try {
      if (state.room.moduleId) {
        const preview = database.getModuleForOwner(
          state.room.moduleId,
          state.room.ownerPlayerId,
          { includeText: true, includeSegments: false }
        );
        const pt = preview?.module?.parsedText || '';
        if (pt.trim().startsWith('{')) {
          state.moduleJson = JSON.parse(pt);
        }
      }
    } catch { /* use text segments instead */ }

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
      const { valid, rejected, issues } = validateStructuredEvents(events);

      const narrationContent = narrative || content.trim() || '（DM 沉默片刻，等待玩家继续行动。）';
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: narrationContent,
        status: 'complete'
      });

      // Apply valid structured events
      if (Object.keys(valid).length > 0) {
        applyStructuredEvents(code, taskUid, valid, dmMessage.id);
      }

      if (rejected.length > 0) {
        console.error('[ai-output] rejected events:', rejected, issues);
      }

      // Save round record for rollback
      try {
        createRoundRecord({
          database,
          roomId: state.room.id,
          aiTaskUid: taskUid,
          dmMessageId: dmMessage.id,
          preState
        });
      } catch (roundError) {
        console.error('[ai-output] round record failed:', roundError.message);
      }

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

  function applyStructuredEvents(code, taskUid, events, dmMessageId) {
    const state = database.getRoomState(code, 80);

    // Process opposed/contested checks (all types: social, stealth, combat, item)
    if (Array.isArray(events.opposed_checks)) {
      for (const opp of events.opposed_checks) {
        try {
          const { participant } = database.getParticipant(code, opp.activePlayerId);
          if (!participant) continue;

          const playerSkill = getSkillTarget(participant.characterSheet, opp.activeSkill);
          if (!Number.isInteger(playerSkill)) continue;

          // NPC passive skill: try module data first, fallback based on NPC role
          let npcSkill = 50; // default
          if (state.moduleJson?.npcs) {
            const npc = state.moduleJson.npcs.find((n) =>
              n.name === opp.passiveNpcName || n.npc_id === opp.passiveNpcName
            );
            if (npc) {
              if (npc.skills?.[opp.passiveSkill]) {
                npcSkill = Number(npc.skills[opp.passiveSkill]);
              } else if (npc.attributes?.[opp.passiveSkill]) {
                npcSkill = Number(npc.attributes[opp.passiveSkill]);
              } else if (npc.role) {
                // Estimate based on role
                const role = String(npc.role).toLowerCase();
                if (/警察|侦探|保安/.test(role)) npcSkill = 65;
                else if (/干部|医生|教师/.test(role)) npcSkill = 55;
                else if (/农民|工人|司机/.test(role)) npcSkill = 40;
                else if (/老人|小孩/.test(role)) npcSkill = 35;
              }
            }
          }

          const playerName = participant.characterName || participant.displayName;
          const check = rollContestedCheck({
            playerSkill,
            npcSkill,
            playerName,
            npcName: opp.passiveNpcName || 'NPC',
            defenderIsNpc: opp.contestType !== 'combat' // 社交/潜行中 NPC 是防守方
          });

          const contestTypeLabel = {
            social: '🎭 社交对抗', stealth: '🥷 潜行对抗',
            combat: '⚔️ 战斗对抗', item: '🔧 技术对抗'
          }[opp.contestType] || '⚡ 对抗检定';

          const playerWon = check.winner === 'player';
          const detailLines = [
            `${contestTypeLabel}：${playerName} 的 ${opp.activeSkill}(${playerSkill}) vs ${opp.passiveNpcName} 的 ${opp.passiveSkill}(${npcSkill})`,
            `调查员 1d100 = ${check.player.roll} → ${check.player.successLevel}${check.player.isCritical ? ' 🎯大成功！' : ''}${check.player.isFumble ? ' 💀大失败！' : ''}`,
            `${opp.passiveNpcName} 1d100 = ${check.npc.roll} → ${check.npc.successLevel}${check.npc.isCritical ? ' 🎯大成功！' : ''}${check.npc.isFumble ? ' 💀大失败！' : ''}`,
            `判定：${check.reason}`,
            `结果：${playerWon ? '调查员胜' : (check.winner === 'npc' ? 'NPC胜' : '平局')}`
          ];

          if (playerWon && opp.successResult) {
            detailLines.push('', opp.successResult);
          } else if (!playerWon && opp.failureResult) {
            detailLines.push('', opp.failureResult);
          }

          const roll = database.createDiceRoll({
            code,
            playerId: opp.activePlayerId,
            rollType: 'contested_check',
            expression: '1d100',
            label: `${opp.activeSkill} vs ${opp.passiveNpcName}(${opp.passiveSkill})`,
            result: check
          });

          const msg = database.createMessage({
            code,
            authorType: 'system',
            messageType: 'SYSTEM',
            displayName: '对抗检定',
            content: detailLines.join('\n'),
            status: 'complete'
          });

          hub.broadcast(code, 'message_created', { message: msg });
          hub.broadcast(code, 'dice_rolled', { roll });
        } catch (oppError) {
          console.error('[ai-output] opposed check failed:', oppError.message);
        }
      }
    }

    // Apply state changes
    if (Array.isArray(events.proposed_state_changes)) {
      for (const change of events.proposed_state_changes) {
        try {
          applyStateChange(code, change);
        } catch (stateError) {
          console.error('[ai-output] state change failed:', change.fieldPath, stateError.message);
        }
      }
    }

    // Reveal clues as system messages
    if (Array.isArray(events.clues_revealed)) {
      for (const clue of events.clues_revealed) {
        const clueMsg = database.createMessage({
          code,
          authorType: 'system',
          messageType: 'SYSTEM',
          displayName: '线索',
          content: `🔍 ${clue.source ? `[${clue.source}] ` : ''}${clue.content}`,
          status: 'complete',
          privateTarget: clue.privateTo || ''
        });
        if (clue.privateTo) {
          hub.sendTo(code, clue.privateTo, 'message_created', { message: clueMsg });
        } else {
          hub.broadcast(code, 'message_created', { message: clueMsg });
        }
      }
    }

    // Update summary
    if (events.summary_update && typeof events.summary_update === 'string') {
      try {
        database.forceUpdateSummary(state.room.id, events.summary_update);
      } catch (summaryError) {
        console.error('[ai-output] summary update failed:', summaryError.message);
      }
    }

    // Handle scene change
    if (events.scene_change && events.scene_change.newScene) {
      const sceneMsg = database.createMessage({
        code,
        authorType: 'system',
        messageType: 'SYSTEM',
        displayName: '场景',
        content: [
          `📍 场景：${events.scene_change.newScene}`,
          events.scene_change.newLocation ? `地点：${events.scene_change.newLocation}` : '',
          events.scene_change.timeElapsed ? `时间：${events.scene_change.timeElapsed}` : '',
          events.scene_change.description || ''
        ].filter(Boolean).join('\n'),
        status: 'complete'
      });
      hub.broadcast(code, 'message_created', { message: sceneMsg });

      // Update scene state in room
      try {
        database.forceUpdateSummary(state.room.id,
          (state.room.summary || '') + '\n' + (events.summary_update || events.scene_change.description || ''));
      } catch { /* non-critical */ }
    }

    // NPC state changes
    if (Array.isArray(events.npc_state_changes) && events.npc_state_changes.length > 0) {
      for (const npc of events.npc_state_changes) {
        const npcMsg = database.createMessage({
          code,
          authorType: 'system',
          messageType: 'SYSTEM',
          displayName: 'NPC',
          content: [
            `👤 ${npc.npcName}`,
            npc.disposition ? `态度：${npc.disposition}` : '',
            npc.location ? `位置：${npc.location}` : '',
            npc.isPresent === false ? '（已离场）' : '',
            npc.notes || ''
          ].filter(Boolean).join(' · '),
          status: 'complete'
        });
        hub.broadcast(code, 'message_created', { message: npcMsg });
      }
    }

    // Broadcast updated room state
    const updatedState = database.getRoomState(code, 80);
    hub.broadcast(code, 'room_state', updatedState);
  }

  function applyStateChange(code, change) {
    if (!change.targetPlayerId || !change.fieldPath) return;

    const { participant } = database.getParticipant(code, change.targetPlayerId);
    if (!participant) return;

    const sheet = structuredClone(participant.characterSheet || {});
    const parts = change.fieldPath.split('.');

    if (parts[0] === 'status' && parts[1]) {
      sheet.status = sheet.status || {};
      const resource = parts[1];
      const newValue = Number(change.newValue);
      if (!Number.isFinite(newValue)) return;

      const limits = { hp: 100, mp: 100, san: 99, luck: 100 };
      const max = limits[resource] || 100;
      sheet.status[resource] = Math.max(0, Math.min(max, Math.round(newValue)));
    } else if (parts[0] === 'characteristics' && parts[1]) {
      sheet.characteristics = sheet.characteristics || {};
      const newValue = Number(change.newValue);
      if (!Number.isFinite(newValue)) return;
      sheet.characteristics[parts[1]] = Math.max(0, Math.min(100, Math.round(newValue)));
    } else {
      return;
    }

    database.updateCharacterSheet({
      code,
      playerId: change.targetPlayerId,
      displayName: participant.displayName,
      characterSheet: sheet
    });

    // Notify the affected player
    const msg = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '状态变更',
      content: `${change.reason || 'AI DM 提议的状态变更'}：${change.fieldPath} → ${change.newValue}`,
      status: 'complete',
      privateTarget: change.targetPlayerId
    });
    hub.sendTo(code, change.targetPlayerId, 'message_created', { message: msg });
  }

  function enqueueDm(code, taskUid) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateDmReply(code, taskUid));
  }

  function enqueueModuleIntro(code, taskUid) {
    const { room } = database.getRoomState(code, 1);
    queue.enqueue(room.id, () => generateModuleIntro(code, taskUid));
  }

  async function generateModuleIntro(code, taskUid) {
    setAiTaskStatus(code, taskUid, 'RETRIEVING');

    const state = database.getRoomState(code, 80);
    const roomCfg = state.room.aiConfig || {};
    const moduleSegments = database.getRoomModuleSegments(code, 40);

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
      const ko = jsonData.keeper_overview || {};
      const rules = jsonData.ai_dm_global_rules || {};
      const sp = jsonData.story_progression || {};

      moduleContext = [
        '=== 模组结构化信息 ===',
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
        po.suggested_intro_text ? `建议开场文本：${po.suggested_intro_text}` : '',
        po.known_npcs?.length ? `已知NPC：${po.known_npcs.join('、')}` : '',
        po.known_locations?.length ? `已知地点：${po.known_locations.join('、')}` : '',
        '',
        ko.investigation_goal ? `调查目标：${ko.investigation_goal}` : '',
        ko.default_opening ? `默认开场方式：${ko.default_opening}` : '',
        '',
        rules.style ? `AI风格要求：叙述长度=${rules.style.narration_length || ''}, 语气=${rules.style.tone || ''}` : '',
        rules.must_follow?.length ? `AI必须遵守：\n${rules.must_follow.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
    } else {
      moduleContext = moduleSegments.slice(0, 8)
        .map((s) => `[${s.scene || s.title}]\n${s.content}`).join('\n\n');
    }

    const systemMsg = buildIntroSystemPrompt(roomCfg);
    const userMsg = buildIntroUserContext({
      moduleTitle: state.room.moduleTitle,
      maxPlayers: state.room.maxPlayers,
      moduleContext
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
      const completed = database.updateMessage({
        id: dmMessage.id,
        content: content.trim() || '（AI 未能生成模组介绍，请房主手动说明。）',
        status: 'complete'
      });
      setAiTaskStatus(code, taskUid, 'COMPLETED');
      hub.broadcast(code, 'message_completed', { message: completed });
    } catch (error) {
      const failed = database.updateMessage({
        id: dmMessage.id,
        content: `${content}\n\n[生成失败：${publicError(error)}]`.trim(),
        status: 'error'
      });
      setAiTaskStatus(code, taskUid, 'FAILED', publicError(error));
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
        const privateTarget = optionalString(body.privateTarget, 80);
        const { room } = database.getParticipant(code, playerId);
        const triggersAi = messageType === 'ACTION' || submitToDm;
        if (triggersAi && room.status !== 'ACTIVE') {
          throw new HttpError(409, 'Game is not active');
        }

        // Private messages: only deliver to intended recipient (and sender sees their own)
        if (messageType === 'PRIVATE') {
          const { participant } = database.getParticipant(code, playerId);
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
          if (privateTarget) {
            hub.sendTo(code, privateTarget, 'message_created', { message });
            hub.sendTo(code, playerId, 'message_created', { message });
          }
          sendJson(response, 201, { message, aiQueued: false });
          return;
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
        const roundId = Number(parts[4]);
        if (!Number.isInteger(roundId)) throw new HttpError(400, 'Invalid round id');

        const result = computeRollback({
          database,
          roomCode: code,
          playerId: assertString(body.playerId, 'playerId', 80),
          roundId
        });

        const state = database.getRoomState(code, { playerId: body.playerId || '' });
        hub.broadcast(code, 'room_state', state);
        hub.broadcast(code, 'round_rolled_back', { roundId });
        sendJson(response, 200, { ...result, ...state });
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
