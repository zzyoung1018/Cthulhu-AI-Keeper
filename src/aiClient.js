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

  // 模组 JSON 摘要（提取关键字段）
  let moduleJsonContext = '';
  if (moduleJson) {
    const mi = moduleJson.module_info || {};
    const ko = moduleJson.keeper_overview || {};
    const rules = moduleJson.ai_dm_global_rules || {};

    moduleJsonContext = [
      '=== 模组结构化数据 ===',
      `标题：${mi.title || room.moduleTitle}`,
      `时代：${mi.time_period || ''}`,
      `地点：${mi.location || ''}`,
      `主题：${(mi.themes || []).join('、')}`,
      `氛围：${mi.tone || ''}`,
      '',
      `调查目标：${ko.investigation_goal || ''}`,
      `主要冲突：${ko.main_conflict || ''}`,
      '',
      '当前场景数据：',
      // Include current active scenes
      ...(moduleJson.scenes || []).slice(0, 3).map((s) =>
        `[${s.scene_id}] ${s.name}: ${s.player_visible_description || ''}`
      ),
      '',
      '当前 NPC：',
      ...(moduleJson.npcs || []).slice(0, 5).map((n) =>
        `[${n.npc_id}] ${n.name} (${n.role || ''}): ${n.player_visible_info || ''}`
      ),
      '',
      'AI DM 规则：',
      ...(rules.must_follow || []).map((r, i) => `${i + 1}. ${r}`),
      rules.style ? `叙述：${rules.style.narration_length || ''}, 语气：${rules.style.tone || ''}` : ''
    ].filter(Boolean).join('\n');
  }

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

  const moduleContext = moduleSegments.slice(0, 6).map((segment, index) => [
    `片段 ${index + 1}：${segment.scene || segment.title}`,
    segment.content
  ].join('\n')).join('\n\n---\n\n');

  const userContext = buildDmUserContext({
    room, roster,
    recent: recent.length > 0 ? recent.join('\n') : '暂无聊天',
    recentRolls: recentRolls.length > 0 ? recentRolls.join('\n') : '暂无骰子',
    moduleContext,
    moduleJsonContext,
    playerStateJson: playerStateJson || ''
  });

  return [
    { role: 'system', content: buildDmSystemPrompt(aiConfig) },
    { role: 'user', content: userContext }
  ];
}
