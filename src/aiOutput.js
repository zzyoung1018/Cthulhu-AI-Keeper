// AI structured output parser and validator.
// AI replies split into narrative text (streamed to players) and structured events
// parsed after completion. Events are validated before being written to the database.

const EVENT_SCHEMAS = {
  required_checks: {
    type: 'array',
    maxItems: 12,
    itemSchema: {
      type: 'object',
      required: ['skill', 'difficulty'],
      properties: {
        skill: 'string',
        difficulty: 'string',
        reason: 'string',
        playerHint: 'string',
        targetPlayerId: 'string'
      }
    }
  },
  opposed_checks: {
    type: 'array',
    maxItems: 8,
    itemSchema: {
      type: 'object',
      required: ['activePlayerId', 'activeSkill', 'passiveNpcName', 'passiveSkill', 'reason'],
      properties: {
        activePlayerId: 'string',
        activeSkill: 'string',
        passiveNpcName: 'string',
        passiveSkill: 'string',
        contestType: 'string',
        reason: 'string',
        playerHint: 'string',
        successResult: 'string',
        failureResult: 'string'
      }
    }
  },
  proposed_state_changes: {
    type: 'array',
    maxItems: 30,
    itemSchema: {
      type: 'object',
      required: ['targetPlayerId', 'fieldPath', 'newValue'],
      properties: {
        targetPlayerId: 'string',
        fieldPath: 'string',
        newValue: 'any',
        reason: 'string'
      }
    }
  },
  clues_revealed: {
    type: 'array',
    maxItems: 20,
    itemSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: 'string',
        privateTo: 'string',
        source: 'string'
      }
    }
  },
  scene_change: {
    type: 'object',
    properties: {
      newScene: 'string',
      newLocation: 'string',
      timeElapsed: 'string',
      description: 'string'
    }
  },
  npc_state_changes: {
    type: 'array',
    maxItems: 20,
    itemSchema: {
      type: 'object',
      required: ['npcName'],
      properties: {
        npcName: 'string',
        disposition: 'string',
        location: 'string',
        notes: 'string',
        isPresent: 'boolean'
      }
    }
  },
  summary_update: 'string'
};

const REQUIRED_OPPOSED_FIELDS = ['activePlayerId', 'activeSkill', 'passiveNpcName', 'passiveSkill', 'reason'];
const REQUIRED_CHECK_FIELDS = ['skill', 'difficulty'];

const VALID_FIELD_PATHS = new Set([
  'status.hp',
  'status.mp',
  'status.san',
  'status.luck',
  'characteristics.STR',
  'characteristics.CON',
  'characteristics.SIZ',
  'characteristics.DEX',
  'characteristics.APP',
  'characteristics.INT',
  'characteristics.POW',
  'characteristics.EDU',
  'characteristics.Luck'
]);

const ACTION_DETECTION_RULES = [
  {
    type: 'social',
    activeSkill: '恐吓',
    passiveSkill: '心理学',
    reason: '玩家对 NPC 进行恐吓或威胁',
    pattern: /恐吓|威胁|吓唬|逼问|震慑|警告|拍桌|拔刀|亮(?:出)?武器|用.*吓|压迫/
  },
  {
    type: 'social',
    activeSkill: '说服',
    passiveSkill: '心理学',
    reason: '玩家试图说服 NPC 改变态度或提供协助',
    pattern: /说服|劝(?:说)?|请求|拜托|交涉|谈判|打动|安抚|让.*(?:同意|答应|配合)|求(?:他|她|对方)/
  },
  {
    type: 'social',
    activeSkill: '魅惑',
    passiveSkill: '心理学',
    reason: '玩家试图用亲和或讨好方式影响 NPC',
    pattern: /魅惑|讨好|套近乎|献殷勤|拉关系|客套|寒暄/
  },
  {
    type: 'social',
    activeSkill: '话术',
    passiveSkill: '心理学',
    reason: '玩家对 NPC 撒谎、伪装身份或套话',
    pattern: /撒谎|说谎|谎称|欺骗|骗|忽悠|糊弄|瞎编|编(?:个|造)?|假装|装作|伪装|冒充|掩饰|隐瞒|套话|套出|诈(?:他|她|对方)?|诈称|自称|找(?:个)?借口|让.*相信|祖上|老一辈|姓郑|陈友让/
  },
  {
    type: 'stealth',
    activeSkill: '妙手',
    passiveSkill: '侦查',
    reason: '玩家试图偷取或暗中操作物品',
    pattern: /偷(?:走|拿|取|窃)|扒|摸走|顺走|悄悄拿|不被发现.*拿|藏起/
  },
  {
    type: 'stealth',
    activeSkill: '乔装',
    passiveSkill: '心理学',
    reason: '玩家试图乔装或伪装身份避开识破',
    pattern: /乔装|易容|伪装成|扮成|假扮|装成/
  },
  {
    type: 'stealth',
    activeSkill: '潜行',
    passiveSkill: '侦查',
    reason: '玩家试图潜行、跟踪或避开 NPC 发现',
    pattern: /潜行|偷偷|悄悄|无声|屏住呼吸|跟踪|尾随|躲开|躲藏|躲起来|藏起来|藏身|避开|绕开|溜(?:进|过去|走)|潜入|不被.*发现|别.*发现/
  },
  {
    type: 'combat',
    activeSkill: '射击',
    passiveSkill: '闪避',
    reason: '玩家对 NPC 开枪或进行远程攻击',
    pattern: /射击|开枪|枪击|开火|用.*枪|手枪|步枪|霰弹枪|瞄准.*(?:射|打)/
  },
  {
    type: 'combat',
    activeSkill: '格斗',
    passiveSkill: '闪避',
    reason: '玩家对 NPC 发起攻击或试图制服对方',
    pattern: /攻击|偷袭|刺杀|刺向|挥拳|打(?:他|她|对方)?|砍|制服|夺(?:刀|枪|武器)|抢(?:刀|枪|武器)/
  }
];

const REQUIRED_CHECK_DETECTION_RULES = [
  {
    skill: '图书馆使用',
    difficulty: 'REGULAR',
    reason: '玩家查阅资料、档案或文献寻找信息',
    playerHint: '你开始翻阅资料，信息是否足够有用取决于检定结果。',
    pattern: /图书馆使用|查资料|查阅|翻阅|检索|资料|档案|卷宗|文献|书架|书籍|报纸|报刊|记录|名册|登记簿|县志|族谱/
  },
  {
    skill: '侦查',
    difficulty: 'REGULAR',
    reason: '玩家搜索或观察环境寻找线索',
    playerHint: '你放慢动作仔细观察，线索是否显露取决于检定结果。',
    pattern: /侦查|观察|查看|检查|搜索|搜查|翻找|寻找|找找|看看|打量|环顾|留意|盯着|调查(?:房间|现场|周围|地面|墙|门|窗|桌|柜)/
  },
  {
    skill: '聆听',
    difficulty: 'REGULAR',
    reason: '玩家专注倾听环境中的声音或动静',
    playerHint: '你屏住呼吸倾听，能否分辨细节取决于检定结果。',
    pattern: /聆听|倾听|听(?:一听|听看|声音|脚步|动静)|有没有.*声音/
  }
];

const NPC_ALIAS_PAIRS = [
  ['林处长', '林处长'],
  ['王哥', '王勇'],
  ['王勇', '王勇'],
  ['顾所长', '顾振兴'],
  ['顾振兴', '顾振兴'],
  ['马大胆', '马大胆'],
  ['陈师傅', '陈友'],
  ['陈友', '陈友'],
  ['陈伯', '陈伯'],
  ['白主任', '白崇礼'],
  ['白崇礼', '白崇礼'],
  ['宋大夫', '宋大夫'],
  ['吴秀梅', '吴秀梅'],
  ['陈婆婆', '陈婆婆'],
  ['韩梅', '韩梅'],
  ['韩老师', '韩老师'],
  ['板寸头', '板寸头'],
  ['老汉', '老汉'],
  ['拖拉机师傅', '拖拉机师傅'],
  ['司机', '司机'],
  ['保安', '保安']
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateBySchema(value, schema, path = '') {
  const issues = [];

  if (schema === 'string') {
    if (typeof value !== 'string') issues.push(`${path}: expected string`);
    return issues;
  }

  if (schema === 'any') return issues;

  if (schema === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${path}: expected boolean`);
    return issues;
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path}: expected object`);
      return issues;
    }
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        issues.push(`${path ? `${path}.` : ''}${key}: required`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) {
        issues.push(...validateBySchema(value[key], propSchema, path ? `${path}.${key}` : key));
      }
    }
    return issues;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path}: expected array`);
      return issues;
    }
    if (value.length > schema.maxItems) {
      issues.push(`${path}: too many items (max ${schema.maxItems})`);
    }
    const itemSchema = schema.itemSchema;
    if (itemSchema) {
      for (let index = 0; index < Math.min(value.length, schema.maxItems); index += 1) {
        issues.push(...validateBySchema(value[index], itemSchema, `${path}[${index}]`));
      }
    }
    return issues;
  }

  if (schema === 'string') {
    if (typeof value !== 'string') issues.push(`${path}: expected string`);
  }

  return issues;
}

function isCompleteOpposedCheck(check) {
  return check && typeof check === 'object' && !Array.isArray(check) &&
    REQUIRED_OPPOSED_FIELDS.every((field) => typeof check[field] === 'string' && check[field].trim());
}

function isCompleteRequiredCheck(check) {
  return check && typeof check === 'object' && !Array.isArray(check) &&
    REQUIRED_CHECK_FIELDS.every((field) => typeof check[field] === 'string' && check[field].trim());
}

function compactEventArray(value, key) {
  if (!Array.isArray(value)) return value;
  if (key === 'required_checks') return value.filter(isCompleteRequiredCheck);
  if (key !== 'opposed_checks') return value;
  return value.filter(isCompleteOpposedCheck);
}

function validateStateChangeField(fieldPath) {
  if (!VALID_FIELD_PATHS.has(fieldPath)) {
    return [`Invalid state change field: ${fieldPath}`];
  }

  if (fieldPath.startsWith('status.')) {
    const [, resource] = fieldPath.split('.');
    const limits = {
      hp: { min: 0 },
      mp: { min: 0 },
      san: { min: 0, max: 99 },
      luck: { min: 0, max: 100 }
    };
    if (limits[resource]) {
      return []; // bounds checked when applying
    }
  }

  if (fieldPath.startsWith('characteristics.')) {
    return []; // All characteristics are 0-100, checked when applying
  }

  return [];
}

export function extractStructuredEvents(text) {
  const narrative = [];
  const events = {};
  const source = String(text || '');
  const fencePattern = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let lastIndex = 0;
  let matchedFence = false;

  for (const match of source.matchAll(fencePattern)) {
    matchedFence = true;
    narrative.push(source.slice(lastIndex, match.index).trimEnd());
    const jsonText = match[1].trim();
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(events, parsed);
      }
    } catch {
      narrative.push(match[0].trimEnd());
    }
    lastIndex = match.index + match[0].length;
  }

  narrative.push(source.slice(lastIndex).trimEnd());

  if (!matchedFence && Object.keys(events).length === 0) {
    const trailing = extractTrailingJsonObject(source);
    if (trailing) {
      return trailing;
    }
  }

  return {
    narrative: narrative.filter(Boolean).join('\n\n').trim(),
    events
  };
}

function extractTrailingJsonObject(text) {
  const source = String(text || '').trimEnd();
  if (!source.endsWith('}')) return null;

  const starts = [];
  for (let index = source.lastIndexOf('{'); index >= 0; index = source.lastIndexOf('{', index - 1)) {
    if (index === 0 || /\n\s*$/.test(source.slice(0, index))) {
      starts.push(index);
    }
    if (starts.length >= 12) break;
  }

  for (const index of starts) {
    try {
      const parsed = JSON.parse(source.slice(index).trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          narrative: source.slice(0, index).trim(),
          events: parsed
        };
      }
    } catch {
      // Try an earlier opening brace.
    }
  }

  return null;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function classifyOpposedAction(actionText) {
  const text = normalizeText(actionText);
  if (!text) return null;

  for (const rule of ACTION_DETECTION_RULES) {
    if (rule.pattern.test(text)) {
      const passiveSkill = rule.type === 'stealth' && /听|声音|脚步|响|聆听/.test(text)
        ? '聆听'
        : rule.passiveSkill;
      return { ...rule, passiveSkill };
    }
  }

  return null;
}

function classifyRequiredAction(actionText) {
  const text = normalizeText(actionText);
  if (!text) return null;

  for (const rule of REQUIRED_CHECK_DETECTION_RULES) {
    if (rule.pattern.test(text)) {
      return { ...rule };
    }
  }

  return null;
}

function npcCandidates(roomState = {}) {
  const pairs = [...NPC_ALIAS_PAIRS];
  for (const npc of roomState.moduleJson?.npcs || []) {
    if (npc?.name) pairs.push([String(npc.name), String(npc.name)]);
    if (npc?.npc_id && npc?.name) pairs.push([String(npc.npc_id), String(npc.name)]);
  }

  const seen = new Set();
  return pairs
    .filter(([alias, name]) => alias && name)
    .map(([alias, name]) => ({ alias, name }))
    .filter((item) => {
      const key = `${item.alias}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.alias.length - a.alias.length);
}

function findExplicitNpc(text, candidates) {
  const source = String(text || '');
  return candidates.find(({ alias }) => new RegExp(escapeRegExp(alias)).test(source))?.name || '';
}

function inferNpcName({ actionText, narrative, roomState }) {
  const candidates = npcCandidates(roomState);
  const explicit = findExplicitNpc(actionText, candidates);
  if (explicit) return explicit;

  const recentText = (roomState.messages || [])
    .slice(-8)
    .map((message) => message.content || '')
    .join('\n');

  const pronounTarget = /(?:他|她|对方|那人|那个人|老人|老汉|司机|板寸头|主任|所长|大夫|师傅)/.test(actionText);
  if (pronounTarget) {
    const fromNarrative = findExplicitNpc(narrative, candidates);
    if (fromNarrative) return fromNarrative;
    const fromRecent = findExplicitNpc(recentText, candidates);
    if (fromRecent) return fromRecent;
  }

  const fromNarrative = findExplicitNpc(narrative, candidates);
  if (fromNarrative) return fromNarrative;

  return '';
}

function latestPlayerAction(roomState = {}) {
  return [...(roomState.messages || [])]
    .reverse()
    .find((message) => message.authorType === 'player' && message.messageType === 'ACTION' && message.playerId);
}

function buildInferredOpposedCheck({ action, rule, npcName }) {
  return {
    activePlayerId: action.playerId,
    activeSkill: rule.activeSkill,
    passiveNpcName: npcName || '附近NPC',
    passiveSkill: rule.passiveSkill,
    contestType: rule.type,
    reason: rule.reason,
    playerHint: rule.type === 'social'
      ? `${npcName || '对方'}停顿了一下，似乎正在判断你的话是否可信。`
      : `${npcName || '对方'}的注意力转向四周，局势停在被发现前的一瞬。`,
    successResult: rule.type === 'social'
      ? `${npcName || '对方'}暂时接受了你的说法。`
      : '你没有被发现，行动继续保持隐蔽。',
    failureResult: rule.type === 'social'
      ? `${npcName || '对方'}察觉到不对，态度转为警惕。`
      : `${npcName || '对方'}发现了你的行动。`
  };
}

function buildInferredRequiredCheck({ action, rule }) {
  return {
    targetPlayerId: action.playerId,
    skill: rule.skill,
    difficulty: rule.difficulty,
    reason: rule.reason,
    playerHint: rule.playerHint
  };
}

function inferOpposedChecks({ events, narrative, roomState }) {
  const action = latestPlayerAction(roomState);
  const rule = action ? classifyOpposedAction(action.content) : null;
  if (!action || !rule) {
    return { checks: [], reason: '', action: null };
  }

  const existing = Array.isArray(events.opposed_checks) ? events.opposed_checks.filter(isCompleteOpposedCheck) : [];
  if (existing.length > 0) {
    return { checks: [], reason: 'model-provided', action };
  }

  const npcName = inferNpcName({ actionText: action.content, narrative, roomState });
  return {
    checks: [buildInferredOpposedCheck({ action, rule, npcName })],
    reason: `backend-${rule.type}`,
    action
  };
}

function inferRequiredChecks({ events, roomState }) {
  const action = latestPlayerAction(roomState);
  if (!action) {
    return { checks: [], reason: '', action: null };
  }

  if (classifyOpposedAction(action.content)) {
    return { checks: [], reason: 'opposed-action', action };
  }

  const existing = Array.isArray(events.required_checks) ? events.required_checks.filter(isCompleteRequiredCheck) : [];
  if (existing.length > 0) {
    return { checks: [], reason: 'model-provided', action };
  }

  const rule = classifyRequiredAction(action.content);
  if (!rule) {
    return { checks: [], reason: '', action };
  }

  return {
    checks: [buildInferredRequiredCheck({ action, rule })],
    reason: `backend-${rule.skill}`,
    action
  };
}

function isSuggestionLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  return /^(?:[-*]\s*)?(?:你们?|调查员).{0,20}(?:可以|可选择|也可以|接下来|下一步|若想|如果想|是否|要不要)/.test(text) ||
    /^(?:[-*]\s*)?(?:接下来|下一步|可选行动|行动建议|建议|选择|选项)[:：]/.test(text) ||
    /^(?:[-*]\s*)?(?:接下来|下一步).{0,20}(?:可以|可选择|选择|要做)/.test(text) ||
    /(?:也是一个选择|都是可行的|任选其一|供你们选择)/.test(text);
}

function stripTrailingActionSuggestions(text) {
  const lines = String(text || '').trimEnd().split(/\r?\n/);
  let cut = lines.length;
  let sawSuggestionHeading = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    const blockLine = /^(?:[-*]|\d+[.、])\s+/.test(line) || line === '---';
    const suggestionLine = isSuggestionLine(line);

    if (!line && cut < lines.length) {
      cut = index;
      continue;
    }
    if (suggestionLine || blockLine) {
      if (suggestionLine) sawSuggestionHeading = true;
      cut = index;
      continue;
    }
    break;
  }

  if (!sawSuggestionHeading) return { text: String(text || '').trim(), stripped: false };
  return { text: lines.slice(0, cut).join('\n').trim(), stripped: true };
}

function trimDecisiveOutcomeForCheck(text) {
  const source = String(text || '').trim();
  if (!source) return { text: source, stripped: false };

  const decisive = /(?:相信了|信了|没有怀疑|没怀疑|放松了警惕|答应了|同意了|被说服|被吓住|被唬住|识破了|看穿了|不信|发现了你|发现了.*身影|没有发现你|没发现你|注意到你|没注意到你|察觉到你|没察觉到你|抓住你|拦住你)/;
  const sentences = source.match(/[^。！？!?]+[。！？!?]?|\n+/g) || [source];
  const kept = [];

  for (const sentence of sentences) {
    if (decisive.test(sentence)) {
      const textBeforeOutcome = kept.join('').trim();
      return {
        text: textBeforeOutcome || '局势停在结果揭晓前的一瞬。',
        stripped: true
      };
    }
    kept.push(sentence);
  }

  return { text: source, stripped: false };
}

function trimDecisiveOutcomeForRequiredCheck(text) {
  const source = String(text || '').trim();
  if (!source) return { text: source, stripped: false };

  const decisive = /(?:发现(?:了|到)|找到(?:了)?|查到(?:了)?|翻出(?:了)?|看出(?:了)?|确认(?:了)?|确定(?:了)?|线索是|答案是)/;
  const sentences = source.match(/[^。！？!?]+[。！？!?]?|\n+/g) || [source];
  const kept = [];

  for (const sentence of sentences) {
    if (decisive.test(sentence)) {
      const textBeforeOutcome = kept.join('').trim();
      return {
        text: textBeforeOutcome || '局势停在检定结果揭晓前的一瞬。',
        stripped: true
      };
    }
    kept.push(sentence);
  }

  return { text: source, stripped: false };
}

function sanitizeNarrative(narrative, inferredOpposedChecks, inferredRequiredChecks) {
  const suggestionResult = stripTrailingActionSuggestions(narrative);
  let text = suggestionResult.text;
  let decisiveStripped = false;

  if (inferredOpposedChecks.length > 0) {
    const result = trimDecisiveOutcomeForCheck(text);
    text = result.text;
    decisiveStripped = result.stripped;
    text = [
      text,
      `（此处触发${inferredOpposedChecks[0].contestType === 'social' ? '社交' : inferredOpposedChecks[0].contestType === 'stealth' ? '潜行' : '对抗'}检定，等待服务器骰点结果后继续。）`
    ].filter(Boolean).join('\n\n');
  } else if (inferredRequiredChecks.length > 0) {
    const result = trimDecisiveOutcomeForRequiredCheck(text);
    text = result.text;
    decisiveStripped = result.stripped;
    text = [
      text,
      `（此处触发${inferredRequiredChecks[0].skill}检定，等待服务器骰点结果后继续。）`
    ].filter(Boolean).join('\n\n');
  }

  return {
    narrative: text,
    strippedActionSuggestions: suggestionResult.stripped,
    strippedDecisiveOutcome: decisiveStripped
  };
}

export function enhanceStructuredEvents({ events, narrative, roomState } = {}) {
  const enhancedEvents = { ...(events || {}) };
  const diagnostics = {
    inferredRequiredChecks: [],
    inferredRequiredReason: '',
    inferredOpposedChecks: [],
    inferredReason: '',
    droppedIncompleteRequiredChecks: 0,
    droppedIncompleteOpposedChecks: 0,
    droppedRequiredChecksForOpposedAction: 0,
    strippedActionSuggestions: false,
    strippedDecisiveOutcome: false,
    latestActionId: null
  };

  if (Array.isArray(enhancedEvents.opposed_checks)) {
    const before = enhancedEvents.opposed_checks.length;
    enhancedEvents.opposed_checks = compactEventArray(enhancedEvents.opposed_checks, 'opposed_checks');
    diagnostics.droppedIncompleteOpposedChecks = before - enhancedEvents.opposed_checks.length;
  }

  if (Array.isArray(enhancedEvents.required_checks)) {
    const before = enhancedEvents.required_checks.length;
    enhancedEvents.required_checks = compactEventArray(enhancedEvents.required_checks, 'required_checks');
    diagnostics.droppedIncompleteRequiredChecks = before - enhancedEvents.required_checks.length;
  }

  const inferred = inferOpposedChecks({ events: enhancedEvents, narrative, roomState });
  diagnostics.latestActionId = inferred.action?.id || null;
  diagnostics.inferredReason = inferred.reason;

  if (inferred.checks.length > 0) {
    enhancedEvents.opposed_checks = [
      ...(Array.isArray(enhancedEvents.opposed_checks) ? enhancedEvents.opposed_checks : []),
      ...inferred.checks
    ];
    diagnostics.inferredOpposedChecks = inferred.checks;
  }

  if ((inferred.checks.length > 0 || inferred.reason === 'model-provided') && Array.isArray(enhancedEvents.required_checks)) {
    diagnostics.droppedRequiredChecksForOpposedAction = enhancedEvents.required_checks.length;
    delete enhancedEvents.required_checks;
  }

  const inferredRequired = inferRequiredChecks({ events: enhancedEvents, roomState });
  diagnostics.latestActionId = diagnostics.latestActionId || inferredRequired.action?.id || null;
  diagnostics.inferredRequiredReason = inferredRequired.reason;

  if (inferredRequired.checks.length > 0) {
    enhancedEvents.required_checks = [
      ...(Array.isArray(enhancedEvents.required_checks) ? enhancedEvents.required_checks : []),
      ...inferredRequired.checks
    ];
    diagnostics.inferredRequiredChecks = inferredRequired.checks;
  }

  const sanitized = sanitizeNarrative(narrative, inferred.checks, inferredRequired.checks);
  diagnostics.strippedActionSuggestions = sanitized.strippedActionSuggestions;
  diagnostics.strippedDecisiveOutcome = sanitized.strippedDecisiveOutcome;

  return {
    narrative: sanitized.narrative,
    events: enhancedEvents,
    diagnostics
  };
}

export function validateStructuredEvents(events) {
  const valid = {};
  const rejected = [];
  const issues = [];

  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    const value = events[key];
    if (value === undefined || value === null) continue;

    if (key === 'summary_update') {
      if (typeof value === 'string' && value.trim().length <= 6000) {
        valid[key] = value.trim();
      } else {
        rejected.push(key);
        issues.push(`${key}: must be a string (max 6000 chars)`);
      }
      continue;
    }

    const schemaIssues = validateBySchema(value, schema, key);
    if (schemaIssues.length > 0) {
      rejected.push(key);
      issues.push(...schemaIssues);
      continue;
    }

    if (key === 'proposed_state_changes') {
      const fieldIssues = value.flatMap((change) => validateStateChangeField(change.fieldPath));
      if (fieldIssues.length > 0) {
        rejected.push(key);
        issues.push(...fieldIssues);
        continue;
      }
    }

    if (key === 'required_checks') {
      const difficultyIssues = value.flatMap((check, index) => {
        const difficulty = String(check.difficulty || '').toUpperCase();
        return ['REGULAR', 'NORMAL', 'HARD', 'EXTREME'].includes(difficulty)
          ? []
          : [`${key}[${index}].difficulty: invalid difficulty`];
      });
      if (difficultyIssues.length > 0) {
        rejected.push(key);
        issues.push(...difficultyIssues);
        continue;
      }
    }

    if (key === 'opposed_checks') {
      const contestIssues = value.flatMap((check, index) => {
        if (!check.contestType) return [];
        return ['social', 'stealth', 'combat', 'item'].includes(String(check.contestType))
          ? []
          : [`${key}[${index}].contestType: invalid contest type`];
      });
      if (contestIssues.length > 0) {
        rejected.push(key);
        issues.push(...contestIssues);
        continue;
      }
    }

    valid[key] = value;
  }

  return { valid, rejected, issues };
}
