import { isAiConfigured } from './config.js';
import { formatCharacterState, summarizeCharacterSheet } from './character.js';
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

// Rough token estimator: ~4 chars per token for English, ~1.5 CJK chars per token
function estimateTokens(text) {
  const str = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

const DEFAULT_TOKEN_BUDGET = 6000;

function trimToBudget(text, maxTokens, label) {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  const lines = text.split('\n');
  let result = '';
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (estimateTokens(candidate) > maxTokens && result) break;
    result = candidate;
  }
  console.error(`[ai-budget] trimmed ${label}: ${estimated} → ~${estimateTokens(result)} tokens (budget: ${maxTokens})`);
  return result || text.slice(0, maxTokens * 4);
}

export function buildDmMessages({ room, participants, messages, diceRolls = [], moduleSegments = [] }) {
  const aiConfig = room.aiConfig || {};
  const tokenBudget = Number(aiConfig.tokenBudget) || DEFAULT_TOKEN_BUDGET;
  // Reserve ~800 tokens for system prompt + overhead
  const contextBudget = Math.max(800, tokenBudget - 800);

  const roster = participants
    .map((participant, index) => {
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

  // Build user message with budget-aware trimming
  const summaryText = `剧情摘要：${room.summary || '暂无摘要'}`;
  const moduleText = `相关模组片段：\n${moduleContext || '暂无可用片段'}`;
  const rosterText = `角色资料：\n${roster || '暂无角色'}`;
  const diceText = `最近骰子：\n${recentRolls.join('\n') || '暂无骰子'}`;
  const prelude = `房间：${room.name} (${room.code})\n模组：${room.moduleTitle || '未命名模组'}`;

  let chatText = `最近聊天：\n${recent.join('\n') || '暂无聊天'}`;
  const fixedTokens = estimateTokens([prelude, summaryText, rosterText, diceText].join('\n\n')) + 100;

  // Trim chat first if over budget
  const remainingForChat = contextBudget - fixedTokens - estimateTokens(moduleText);
  if (remainingForChat < 200) {
    chatText = `最近聊天：\n${recent.slice(-6).join('\n') || '暂无聊天'}`;
  }

  // Trim module if still over budget
  let finalModuleText = moduleText;
  const revisedRemaining = contextBudget - fixedTokens - estimateTokens(chatText);
  if (estimateTokens(finalModuleText) > Math.max(200, revisedRemaining - 200)) {
    const fewerModules = moduleSegments.slice(0, 3).map((segment, index) => [
      `片段 ${index + 1}：${segment.scene || segment.title}`,
      segment.content
    ].join('\n')).join('\n\n---\n\n');
    finalModuleText = `相关模组片段：\n${fewerModules || '暂无可用片段'}`;
  }

  const userContent = [
    prelude,
    finalModuleText,
    summaryText,
    rosterText,
    diceText,
    chatText,
    '请生成下一段 DM 回复。'
  ].join('\n\n');

  const estimatedTotal = estimateTokens(userContent) + 200;

  const userContext = buildDmUserContext({
    room, roster,
    recent: recent.length > 0 ? recent.join('\n') : '暂无聊天',
    recentRolls: recentRolls.length > 0 ? recentRolls.join('\n') : '暂无骰子',
    moduleContext
  });

  return [
    { role: 'system', content: buildDmSystemPrompt(aiConfig) },
    { role: 'user', content: userContext }
  ];
}
