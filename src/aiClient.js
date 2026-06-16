import { isAiConfigured } from './config.js';
import { formatCharacterState, summarizeCharacterSheet } from './character.js';
import { summarizePlayerState } from './playerState.js';
import { buildDmSystemPrompt, buildDmUserContext, FALLBACK_TEXT } from './prompts.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatCompletionsUrl(baseUrl) {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function parseOpenAiSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return data === '[DONE]' ? { done: true } : null;
  const parsed = JSON.parse(data);
  return {
    done: false,
    content: parsed.choices?.[0]?.delta?.content || ''
  };
}

async function* streamLocalFallback() {
  const pieces = FALLBACK_TEXT.match(/.{1,12}/gs) || [FALLBACK_TEXT];
  for (const piece of pieces) {
    await delay(35);
    yield piece;
  }
}

function summarizeRecentCheckRolls(diceRolls = []) {
  const checks = diceRolls
    .filter((roll) => {
      const type = roll.result?.type || roll.rollType;
      return ['skill_check', 'coc_check', 'contested_check', 'opposed_check', 'pushed_check', 'luck_spend'].includes(type);
    })
    .slice(-6)
    .map((roll) => {
      const result = roll.result || {};
      if (result.type === 'contested_check') {
        return {
          id: roll.id,
          createdAt: roll.createdAt,
          rollType: result.type,
          label: roll.label,
          playerId: roll.playerId,
          player: result.player,
          npc: result.npc,
          winner: result.winner,
          reason: result.reason
        };
      }
      if (result.type === 'opposed_check') {
        return {
          id: roll.id,
          createdAt: roll.createdAt,
          rollType: result.type,
          label: roll.label,
          playerId: roll.playerId,
          active: result.active,
          passive: result.passive,
          winner: result.winner
        };
      }
      return {
        id: roll.id,
        createdAt: roll.createdAt,
        rollType: result.type || roll.rollType,
        label: roll.label || result.skillName || '',
        playerId: roll.playerId,
        skillName: result.skillName || roll.label || '',
        target: result.target,
        difficulty: result.difficulty,
        total: result.total,
        successLevel: result.successLevel,
        passed: result.passed,
        consequence: result.consequence || ''
      };
    });

  return checks.length > 0 ? JSON.stringify(checks, null, 2) : '';
}

function parseSceneState(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function compactText(value, limit = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase();
}

function collectContextTerms({ room, messages = [], playerStates = [] }) {
  const sceneState = parseSceneState(room.sceneState);
  const terms = new Set();
  for (const value of [
    sceneState.currentScene,
    sceneState.currentSceneId,
    sceneState.sceneId,
    sceneState.currentLocation,
    sceneState.description
  ]) {
    if (value) terms.add(normalizeMatchText(value));
  }

  for (const npc of Object.values(sceneState.npcStates || {})) {
    for (const value of [npc.id, npc.npcId, npc.name, npc.location, npc.disposition]) {
      if (value) terms.add(normalizeMatchText(value));
    }
  }

  for (const state of playerStates || []) {
    for (const npc of state.knownNpcs || []) {
      for (const value of [npc.id, npc.npcId, npc.name, npc.location, npc.disposition]) {
        if (value) terms.add(normalizeMatchText(value));
      }
    }
    for (const clue of state.discoveredClues || []) {
      for (const value of [clue.id, clue.clueId, clue.source, clue.content]) {
        if (value) terms.add(normalizeMatchText(value));
      }
    }
  }

  for (const message of messages.slice(-10)) {
    for (const match of String(message.content || '').matchAll(/[\p{Script=Han}\w]{2,16}/gu)) {
      terms.add(normalizeMatchText(match[0]));
    }
  }

  return { sceneState, terms: [...terms].filter(Boolean) };
}

function relevanceScore(parts, terms) {
  const text = normalizeMatchText(parts.filter(Boolean).join(' '));
  if (!text) return 0;
  let score = 0;
  for (const term of terms) {
    if (term && text.includes(term)) score += Math.min(20, Math.max(2, term.length));
  }
  return score;
}

function pickRelevant(items, scoreItem, limit) {
  return [...(items || [])]
    .map((item, index) => ({ item, index, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function buildModuleJsonContext({ room, messages, playerStates, moduleJson }) {
  if (!moduleJson) return '';

  const mi = moduleJson.module_info || {};
  const ko = moduleJson.keeper_overview || {};
  const rules = moduleJson.ai_dm_global_rules || {};
  const { sceneState, terms } = collectContextTerms({ room, messages, playerStates });
  const currentSceneText = [
    sceneState.currentScene,
    sceneState.currentSceneId,
    sceneState.sceneId,
    sceneState.currentLocation
  ].filter(Boolean).map(normalizeMatchText);

  const scenes = pickRelevant(moduleJson.scenes || [], (scene) => {
    let score = relevanceScore([
      scene.scene_id,
      scene.name,
      scene.player_visible_description,
      scene.default_ai_dm_instruction,
      scene.when_players_enter,
      scene.when_players_search
    ], terms);
    if (currentSceneText.some((value) =>
      value && [scene.scene_id, scene.name].some((field) => {
        const normalized = normalizeMatchText(field);
        return normalized && (normalized.includes(value) || value.includes(normalized));
      })
    )) {
      score += 120;
    }
    return score;
  }, 4);

  const npcs = pickRelevant(moduleJson.npcs || [], (npc) => {
    let score = relevanceScore([
      npc.npc_id,
      npc.name,
      npc.role,
      npc.player_visible_info,
      npc.first_impression,
      npc.personality,
      npc.dialogue_style
    ], terms);
    const known = Object.values(sceneState.npcStates || {}).some((stateNpc) =>
      (normalizeMatchText(npc.name) && normalizeMatchText(stateNpc.name || stateNpc.id).includes(normalizeMatchText(npc.name))) ||
      (normalizeMatchText(npc.npc_id) && normalizeMatchText(stateNpc.id || stateNpc.npcId).includes(normalizeMatchText(npc.npc_id)))
    );
    if (known) score += 100;
    return score;
  }, 6);

  const clues = pickRelevant(moduleJson.clues || [], (clue) => {
    let score = relevanceScore([
      clue.clue_id,
      clue.name,
      clue.scene_id,
      clue.reveal_condition,
      clue.player_visible_text
    ], terms);
    if (currentSceneText.some((value) => {
      const sceneId = normalizeMatchText(clue.scene_id);
      return value && sceneId && sceneId.includes(value);
    })) score += 80;
    return score;
  }, 6);

  const checks = pickRelevant(moduleJson.checks || [], (check) => {
    let score = relevanceScore([
      check.check_id,
      check.scene_id,
      check.skill,
      check.trigger,
      check.ai_dm_instruction,
      check.success,
      check.failure
    ], terms);
    if (currentSceneText.some((value) => {
      const sceneId = normalizeMatchText(check.scene_id);
      return value && sceneId && sceneId.includes(value);
    })) score += 80;
    return score;
  }, 6);

  const sceneStateJson = Object.keys(sceneState).length > 0 ? JSON.stringify(sceneState, null, 2) : '';

  return [
    '=== 模组结构化数据（已按当前场景排序） ===',
    `标题：${mi.title || room.moduleTitle}`,
    `时代：${mi.time_period || ''}`,
    `地点：${mi.location || ''}`,
    `主题：${(mi.themes || []).join('、')}`,
    `氛围：${mi.tone || ''}`,
    '',
    `调查目标：${ko.investigation_goal || ''}`,
    `主要冲突：${ko.main_conflict || ''}`,
    sceneStateJson ? `当前房间场景状态（JSON）：\n${sceneStateJson}` : '',
    '',
    '相关场景：',
    ...scenes.map((scene) =>
      `[${scene.scene_id}] ${scene.name}: ${compactText(scene.player_visible_description || scene.default_ai_dm_instruction)}`
    ),
    '',
    '相关 NPC：',
    ...npcs.map((npc) =>
      `[${npc.npc_id}] ${npc.name} (${npc.role || ''}): ${compactText(npc.player_visible_info || npc.first_impression)}`
    ),
    '',
    '相关线索：',
    ...clues.map((clue) =>
      `[${clue.clue_id}] ${clue.name || ''}: ${compactText(clue.player_visible_text || clue.reveal_condition)}`
    ),
    '',
    '相关检定：',
    ...checks.map((check) =>
      `[${check.check_id || check.skill}] ${check.skill || ''} ${check.difficulty || ''}: ${compactText(check.trigger || check.ai_dm_instruction)}`
    ),
    '',
    'AI DM 规则：',
    ...(rules.must_follow || []).map((rule, index) => `${index + 1}. ${rule}`),
    rules.style ? `叙述：${rules.style.narration_length || ''}, 语气：${rules.style.tone || ''}` : ''
  ].filter(Boolean).join('\n');
}

export async function* streamChatCompletion(aiConfig, messages) {
  if (!isAiConfigured(aiConfig)) {
    if (aiConfig.localFallback) {
      yield* streamLocalFallback();
      return;
    }
    throw new Error('AI provider is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiConfig.timeoutMs);

  try {
    const response = await fetch(chatCompletionsUrl(aiConfig.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages,
        temperature: aiConfig.temperature,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI request failed with ${response.status}: ${text.slice(0, 400)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseOpenAiSseLine(line.trim());
        if (!parsed) continue;
        if (parsed.done) return;
        if (parsed.content) yield parsed.content;
      }
    }

    if (buffer.trim()) {
      const parsed = parseOpenAiSseLine(buffer.trim());
      if (parsed?.content) yield parsed.content;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function buildDmMessages({ room, participants, messages, diceRolls = [], moduleSegments = [], playerStates = [], moduleJson = null }) {
  const aiConfig = room.aiConfig || {};

  // 玩家状态摘要（文本）
  const roster = (playerStates.length > 0 ? playerStates : participants)
    .map((item, index) => {
      if (item.playerId) {
        // is a PlayerState object
        return `${index + 1}. ${summarizePlayerState(item)}`;
      }
      // fallback to old format
      const participant = item;
      const character = participant.characterName || '未命名角色';
      const card = participant.characterSheet
        ? summarizeCharacterSheet(participant.characterSheet)
        : participant.characterCard || '暂无角色卡';
      const state = participant.characterSheet
        ? formatCharacterState(participant.characterSheet)
        : participant.state || '暂无状态';
      return `${index + 1}. 玩家 ${participant.displayName} / 角色 ${character}\n角色卡：${card}\n人物状态：${state}`;
    })
    .join('\n\n');

  // 玩家状态 JSON（结构化数据给 AI）
  let playerStateJson = '';
  if (playerStates.length > 0) {
    playerStateJson = JSON.stringify(playerStates.map((s) => ({
      playerId: s.playerId,
      characterName: s.characterName,
      occupation: s.occupation,
      status: s.status,
      characteristics: s.characteristics,
      derived: s.derived,
      location: s.location,
      party: s.party,
      skills: s.skills,
      weapons: s.weapons,
      equipment: s.equipment,
      conditions: s.conditions,
      discoveredClues: s.discoveredClues,
      knownNpcs: s.knownNpcs
    })), null, 2);
  }

  const moduleJsonContext = buildModuleJsonContext({ room, messages, playerStates, moduleJson });

  const recent = messages
    .filter((message) => !['OOC', 'PRIVATE'].includes(message.messageType))
    .slice(-24)
    .map((message) => {
      const name = message.authorType === 'dm' ? 'DM' : message.displayName;
      const type = message.messageType === 'ACTION' ? '正式行动' : message.messageType;
      return `[${type}] ${name}: ${message.content}`;
    });

  const recentRolls = diceRolls.slice(-8).map((roll) => {
    const label = roll.label || roll.rollType;
    return `${label}: ${roll.expression} => ${JSON.stringify(roll.result)}`;
  });
  const recentChecks = summarizeRecentCheckRolls(diceRolls);

  const moduleContext = moduleSegments.slice(0, 6).map((segment, index) => [
    `片段 ${index + 1}：${segment.scene || segment.title}`,
    segment.content
  ].join('\n')).join('\n\n---\n\n');

  const userContext = buildDmUserContext({
    room, roster,
    recent: recent.length > 0 ? recent.join('\n') : '暂无聊天',
    recentRolls: recentRolls.length > 0 ? recentRolls.join('\n') : '暂无骰子',
    recentChecks,
    moduleContext,
    moduleJsonContext,
    playerStateJson: playerStateJson || ''
  });

  return [
    { role: 'system', content: buildDmSystemPrompt(aiConfig) },
    { role: 'user', content: userContext }
  ];
}
