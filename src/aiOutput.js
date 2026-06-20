// AI structured output parser and validator.
// AI replies split into narrative text (streamed to players) and structured events
// parsed after completion. Events are validated before being written to the database.

import { canonicalSkillName, getCheckTarget, getSkillTarget } from './character.js';

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
        clueId: 'string',
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
        npcId: 'string',
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
    skill: '会计',
    difficulty: 'REGULAR',
    reason: '玩家检查账本、流水或财务异常',
    playerHint: '你开始核对账目，数字背后的异常需要靠检定确认。',
    pattern: /会计|账本|账目|账册|流水|收支|发票|凭据|账单|财务|对账|查账/
  },
  {
    skill: '图书馆使用',
    difficulty: 'REGULAR',
    reason: '玩家查阅资料、档案或文献寻找信息',
    playerHint: '你开始翻阅资料，信息是否足够有用取决于检定结果。',
    pattern: /图书馆使用|查资料|查阅|翻阅|检索|资料|档案|卷宗|文献|书架|书籍|报纸|报刊|记录|名册|登记簿|县志|族谱/
  },
  {
    skill: '外语',
    difficulty: 'REGULAR',
    reason: '玩家试图解读陌生语言、文字、刻字或录音片段',
    playerHint: '这些语言或文字不像普通信息，能否解读取决于检定结果。',
    pattern: /语言学|外语|翻译|辨认.*(?:文字|语言|语音|录音|刻字|铭文|字迹)|解读.*(?:文字|语言|语音|录音|刻字|铭文|字迹)|拼凑.*(?:录音|语音|句子|片段)|未知语言|陌生语言|陌生文字|古代语言|枪托刻字|刻字|铭文/
  },
  {
    skill: '锁匠',
    difficulty: 'REGULAR',
    reason: '玩家试图开锁、撬锁或处理锁具机关',
    playerHint: '锁芯细微地卡住，能否打开取决于检定结果。',
    pattern: /锁匠|开锁|撬锁|撬开.*锁|解锁|撬门|撬开|万能钥匙|铁丝.*锁|发卡.*锁/
  },
  {
    skill: '急救',
    difficulty: 'REGULAR',
    reason: '玩家进行紧急处理、止血或包扎',
    playerHint: '你迅速处理伤势，效果取决于检定结果。',
    pattern: /急救|包扎|止血|处理伤口|救治|简单治疗|应急处理|按压伤口|固定夹板/
  },
  {
    skill: '医学',
    difficulty: 'REGULAR',
    reason: '玩家进行医学诊断、尸检或判断病理伤势',
    playerHint: '你从医学角度检查，能否判断关键细节取决于检定结果。',
    pattern: /医学|诊断|验尸|尸检|检查尸体|病因|死因|伤势|药物治疗|病理|中毒|处方|药量/
  },
  {
    skill: '驾驶汽车',
    difficulty: 'REGULAR',
    reason: '玩家进行危险驾驶、追车或复杂车辆操作',
    playerHint: '车辆在路面上颠簸，能否稳住局面取决于检定结果。',
    pattern: /驾驶汽车|开车|驾车|发动车|倒车|追车|甩开|急转|急刹|冲过|开.*车|驾.*车/
  },
  {
    skill: '攀爬',
    difficulty: 'REGULAR',
    reason: '玩家攀爬、翻越或从高处移动',
    playerHint: '你寻找落脚点，能否顺利通过取决于检定结果。',
    pattern: /攀爬|爬上|爬下|爬墙|爬窗|爬到|翻墙|翻越|攀上|攀过|顺着.*爬/
  },
  {
    skill: '跳跃',
    difficulty: 'REGULAR',
    reason: '玩家跳过障碍或从高低差处跃过',
    playerHint: '你估算距离和落点，能否跳过取决于检定结果。',
    pattern: /跳跃|跳过|跃过|跳下|跳上|纵身|跨过|飞身|助跑.*跳/
  },
  {
    skill: '投掷',
    difficulty: 'REGULAR',
    reason: '玩家投掷物品命中特定目标',
    playerHint: '你掂量手里的东西，命中与否取决于检定结果。',
    pattern: /投掷|扔向|丢向|掷向|抛向|砸向|扔过去|丢过去|投过去/
  },
  {
    skill: '追踪',
    difficulty: 'REGULAR',
    reason: '玩家根据脚印、痕迹或路线追踪目标',
    playerHint: '你沿着细碎痕迹判断方向，能否追上取决于检定结果。',
    pattern: /追踪|脚印|足迹|踪迹|痕迹.*追|沿着.*痕迹|跟着.*痕迹|车辙|拖痕/
  },
  {
    skill: '神秘学',
    difficulty: 'REGULAR',
    reason: '玩家辨认神秘符号、仪式或民俗禁忌',
    playerHint: '这些符号似曾相识，能否理解含义取决于检定结果。',
    pattern: /神秘学|仪式|符号|咒文|邪教|护符|祭祀|禁忌|民俗|神秘图案|怪异图案/
  },
  {
    skill: '法律',
    difficulty: 'REGULAR',
    reason: '玩家判断法律、流程或官方文书问题',
    playerHint: '你回想相关条文和流程，判断是否准确取决于检定结果。',
    pattern: /法律|法规|法条|条例|搜查令|调查令|许可|拘留|逮捕|立案|警局流程|司法/
  },
  {
    skill: '估价',
    difficulty: 'REGULAR',
    reason: '玩家评估物品价值、真伪或成色',
    playerHint: '你检查材质和做工，判断是否准确取决于检定结果。',
    pattern: /估价|鉴定价值|值多少钱|价格|价钱|古董|成色|真伪|赝品|年代|材质/
  },
  {
    skill: '导航',
    difficulty: 'REGULAR',
    reason: '玩家辨认路线、地图或方位',
    playerHint: '你对照方向和地形，能否找到正确路线取决于检定结果。',
    pattern: /导航|辨认方向|找路|路线|地图|迷路|方位|坐标|抄近路|绕路/
  },
  {
    skill: '博物学',
    difficulty: 'REGULAR',
    reason: '玩家判断自然、植物、动物或环境痕迹',
    playerHint: '你观察自然细节，能否辨认来源取决于检定结果。',
    pattern: /博物学|植物|动物|昆虫|草药|菌类|土壤|自然|树叶|花粉|羽毛|粪便/
  },
  {
    skill: '机械维修',
    difficulty: 'REGULAR',
    reason: '玩家修理或判断机械装置',
    playerHint: '机械结构传来细小摩擦声，能否修好取决于检定结果。',
    pattern: /机械维修|修理机器|修机器|发动机|齿轮|发电机|机械|机器|马达|传动|零件/
  },
  {
    skill: '电气维修',
    difficulty: 'REGULAR',
    reason: '玩家修理电路、电灯或电气设备',
    playerHint: '线路和接点需要仔细判断，能否恢复取决于检定结果。',
    pattern: /电气维修|电路|电线|电灯|保险丝|电闸|开关|发电|短路|接线|配电/
  },
  {
    skill: '化学',
    difficulty: 'REGULAR',
    reason: '玩家分析化学物质、气味或反应',
    playerHint: '你谨慎分辨气味和残留，结论取决于检定结果。',
    pattern: /化学|试剂|化学品|酸|碱|粉末|残留物|反应|腐蚀|气味.*刺鼻/
  },
  {
    skill: '物理学',
    difficulty: 'REGULAR',
    reason: '玩家判断力学、结构或物理现象',
    playerHint: '你估算受力和结构，判断是否准确取决于检定结果。',
    pattern: /物理学|受力|结构|承重|杠杆|滑轮|轨迹|弹道|速度|压力/
  },
  {
    skill: '药学',
    difficulty: 'REGULAR',
    reason: '玩家辨认药物、毒物或剂量',
    playerHint: '你辨认药性和剂量，能否判断准确取决于检定结果。',
    pattern: /药学|药物|毒物|毒药|剂量|药瓶|药片|药粉|麻醉|镇静剂/
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

  return issues;
}

function validateArrayItemsBySchema(value, schema, key) {
  if (!Array.isArray(value)) {
    return { value, issues: [`${key}: expected array`], fatal: true };
  }

  if (value.length > schema.maxItems) {
    return { value, issues: [`${key}: too many items (max ${schema.maxItems})`], fatal: true };
  }

  const kept = [];
  const issues = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemIssues = schema.itemSchema
      ? validateBySchema(value[index], schema.itemSchema, `${key}[${index}]`)
      : [];
    if (itemIssues.length > 0) {
      issues.push(...itemIssues);
    } else {
      kept.push(value[index]);
    }
  }

  return { value: kept, issues, fatal: false };
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

function normalizeSkillName(skillName) {
  return canonicalSkillName(skillName) || normalizeText(skillName);
}

function sameSkillName(left, right) {
  return normalizeSkillName(left) === normalizeSkillName(right);
}

function normalizeDifficulty(value) {
  const difficulty = String(value || 'REGULAR').trim().toUpperCase();
  if (difficulty === 'NORMAL') return 'REGULAR';
  if (difficulty === '困难') return 'HARD';
  if (difficulty === '极难') return 'EXTREME';
  if (difficulty === '常规' || difficulty === '普通') return 'REGULAR';
  return ['REGULAR', 'HARD', 'EXTREME'].includes(difficulty) ? difficulty : 'REGULAR';
}

function isAllowedDifficulty(value) {
  const raw = String(value || '').trim();
  const difficulty = raw.toUpperCase();
  return ['REGULAR', 'NORMAL', 'HARD', 'EXTREME'].includes(difficulty) ||
    ['困难', '极难', '常规', '普通'].includes(raw);
}

function normalizeContestType(value) {
  const contestType = String(value || '').trim().toLowerCase();
  return ['social', 'stealth', 'combat', 'item'].includes(contestType) ? contestType : '';
}

function cjkBigrams(text) {
  const grams = [];
  for (const match of String(text || '').matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const value = match[0];
    for (let index = 0; index < value.length - 1; index += 1) {
      grams.push(value.slice(index, index + 2));
    }
  }
  return [...new Set(grams)];
}

function detectionMeta({ source, kind, ruleId, confidence, matchedText = '', notes = [] }) {
  return {
    source,
    kind,
    ruleId,
    confidence: Math.max(0, Math.min(1, Math.round(Number(confidence || 0) * 100) / 100)),
    matchedText,
    notes
  };
}

function currentSceneIds(roomState = {}) {
  const ids = new Set();
  const raw = roomState.room?.sceneState;
  let sceneState = {};
  if (raw && typeof raw === 'object') sceneState = raw;
  else if (raw) {
    try { sceneState = JSON.parse(raw); } catch { sceneState = {}; }
  }

  for (const key of ['currentScene', 'currentSceneId', 'sceneId', 'currentLocation']) {
    if (sceneState[key]) ids.add(String(sceneState[key]));
  }
  for (const participant of roomState.participants || []) {
    if (participant.stateSceneId) ids.add(String(participant.stateSceneId));
    if (participant.stateSceneName) ids.add(String(participant.stateSceneName));
  }
  return ids;
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

function participantByPlayerId(roomState = {}, playerId = '') {
  return (roomState.participants || []).find((participant) => participant.playerId === playerId) || null;
}

function isNpcOnlyObservation(text, roomState) {
  const source = normalizeText(text);
  if (!/(看|看看|查看|观察|打量|盯着|端详)/.test(source)) return false;
  if (/(房间|现场|周围|地面|墙|门|窗|桌|柜|抽屉|床|包|箱|登记簿|账本|线索|痕迹|脚印|血迹|物品|尸体)/.test(source)) {
    return false;
  }
  const candidates = npcCandidates(roomState);
  return Boolean(findExplicitNpc(source, candidates) || /(?:他|她|对方|那人|那个人).{0,8}(?:表情|脸色|反应|眼神|神情|动作)?/.test(source));
}

function withRequiredMeta(rule, meta) {
  return {
    ...rule,
    difficulty: normalizeDifficulty(rule.difficulty),
    detection: meta
  };
}

function classifyOpposedAction(actionText) {
  const text = normalizeText(actionText);
  if (!text) return null;

  for (const rule of ACTION_DETECTION_RULES) {
    if (rule.pattern.test(text)) {
      const passiveSkill = rule.type === 'stealth' && /听|声音|脚步|响|聆听/.test(text)
        ? '聆听'
        : rule.passiveSkill;
      return {
        ...rule,
        passiveSkill,
        detection: detectionMeta({
          source: 'generic',
          kind: 'opposed',
          ruleId: `${rule.type}:${rule.activeSkill}`,
          confidence: 0.82,
          matchedText: String(rule.pattern)
        })
      };
    }
  }

  return null;
}

function classifyRequiredAction(actionText, roomState = {}) {
  const text = normalizeText(actionText);
  if (!text) return null;
  if (isNpcOnlyObservation(text, roomState)) return null;

  for (const rule of REQUIRED_CHECK_DETECTION_RULES) {
    if (rule.pattern.test(text)) {
      return withRequiredMeta(rule, detectionMeta({
        source: 'generic',
        kind: 'required',
        ruleId: `generic:${rule.skill}`,
        confidence: 0.74,
        matchedText: String(rule.pattern)
      }));
    }
  }

  return null;
}

function moduleCheckText(check) {
  return [
    check.check_id,
    check.skill,
    check.trigger,
    check.ai_dm_instruction,
    check.success,
    check.failure
  ].filter(Boolean).join(' ');
}

function scoreModuleCheck(actionText, check, roomState) {
  const action = normalizeText(actionText);
  const trigger = normalizeText(check.trigger);
  const checkText = normalizeText(moduleCheckText(check));
  const checkSkill = normalizeText(check.skill);
  const normalizedCheckSkill = normalizeSkillName(checkSkill);
  if (!action || !checkText || !checkSkill) return { score: 0, notes: [] };

  let score = 0;
  const notes = [];
  let anchored = false;
  if (trigger && (action.includes(trigger) || trigger.includes(action))) {
    score += 8;
    notes.push('trigger-exact');
    anchored = true;
  }

  if (action.includes(checkSkill) || (normalizedCheckSkill !== checkSkill && action.includes(normalizedCheckSkill))) {
    score += 4;
    notes.push('skill-mentioned');
    anchored = true;
  }

  const genericRule = classifyRequiredAction(action, roomState);
  if (genericRule && sameSkillName(genericRule.skill, checkSkill)) {
    score += 4;
    notes.push('generic-same-skill');
    anchored = true;
  }

  const sceneIds = currentSceneIds(roomState);
  if (check.scene_id && sceneIds.has(String(check.scene_id))) {
    score += 2;
    notes.push('scene-match');
  }

  let triggerOverlap = 0;
  for (const gram of cjkBigrams(action)) {
    if (trigger.includes(gram)) triggerOverlap += 1;
  }
  if (triggerOverlap >= 2) {
    score += Math.min(6, triggerOverlap);
    notes.push(`trigger-overlap:${triggerOverlap}`);
    anchored = true;
  }

  let overlap = 0;
  for (const gram of cjkBigrams(action)) {
    if (checkText.includes(gram)) overlap += 1;
  }
  if (overlap > 0) {
    score += Math.min(3, overlap);
    notes.push(`overlap:${overlap}`);
  }

  return { score: anchored ? score : 0, notes };
}

function classifyModuleRequiredAction(actionText, roomState = {}) {
  const checks = Array.isArray(roomState.moduleJson?.checks) ? roomState.moduleJson.checks : [];
  if (checks.length === 0) return null;
  if (isNpcOnlyObservation(actionText, roomState)) return null;

  let best = null;
  for (const check of checks) {
    if (check?.requires_roll === false) continue;
    const { score, notes } = scoreModuleCheck(actionText, check, roomState);
    if (score < 5) continue;
    if (!best || score > best.score) best = { check, score, notes };
  }

  if (!best) return null;
  const { check, score, notes } = best;
  const rawSkill = String(check.skill || '').trim();
  const skill = normalizeSkillName(rawSkill);
  const detectionNotes = skill && rawSkill && skill !== rawSkill
    ? [...notes, `skill-alias:${rawSkill}->${skill}`]
    : notes;
  return withRequiredMeta({
    skill,
    difficulty: normalizeDifficulty(check.difficulty),
    reason: check.trigger ? `模组检定：${check.trigger}` : `模组检定：${check.check_id || check.skill}`,
    playerHint: '这一行动命中了模组预设检定，结果由服务器骰点决定。',
    moduleCheckId: check.check_id || '',
    moduleSceneId: check.scene_id || ''
  }, detectionMeta({
    source: 'module',
    kind: 'required',
    ruleId: `module:${check.check_id || check.skill}`,
    confidence: Math.min(0.95, 0.58 + score * 0.04),
    matchedText: normalizeText(check.trigger || check.ai_dm_instruction || check.check_id || ''),
    notes: detectionNotes
  }));
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
  return explicitNpcMatches(source, candidates)[0]?.name || '';
}

function explicitNpcMatches(text, candidates) {
  const source = String(text || '');
  return candidates.filter(({ alias }) => new RegExp(escapeRegExp(alias)).test(source));
}

function uniqueNpcName(matches) {
  const names = [...new Set(matches.map((match) => match.name).filter(Boolean))];
  return names.length === 1 ? names[0] : '';
}

function recentNpcMention(roomState, candidates, excludedNames = []) {
  const excluded = new Set(excludedNames.filter(Boolean));
  const recentText = (roomState.messages || [])
    .slice(-8)
    .map((message) => `${message.displayName || ''} ${message.content || ''}`)
    .join('\n');
  return uniqueNpcName(explicitNpcMatches(recentText, candidates)
    .filter((match) => !excluded.has(match.name)));
}

function sourceNpcNamesInDeception(text, candidates) {
  const source = String(text || '');
  return [...new Set(explicitNpcMatches(source, candidates)
    .filter((match) => new RegExp(`${escapeRegExp(match.alias)}.{0,6}(?:让|叫|派|托|要|让我|让我们)`).test(source))
    .map((match) => match.name)
    .filter(Boolean))];
}

function resolveNpcReference(value, roomState = {}) {
  const name = normalizeText(value);
  if (!name) return null;

  for (const npc of roomState.moduleJson?.npcs || []) {
    const aliases = [npc.name, npc.npc_id].filter(Boolean).map(normalizeText);
    if (aliases.some((alias) => alias && (alias === name || alias.includes(name) || name.includes(alias)))) {
      return {
        name: npc.name || name,
        npcId: npc.npc_id || '',
        source: 'module'
      };
    }
  }

  const sceneState = parseSceneState(roomState.room?.sceneState);
  for (const npc of Object.values(sceneState.npcStates || {})) {
    const aliases = [npc.name, npc.npcName, npc.id, npc.npcId].filter(Boolean).map(normalizeText);
    if (aliases.some((alias) => alias && (alias === name || alias.includes(name) || name.includes(alias)))) {
      return {
        name: npc.name || npc.npcName || name,
        npcId: npc.npcId || npc.id || '',
        source: 'scene-state'
      };
    }
  }

  for (const participant of roomState.participants || []) {
    for (const npc of participant.playerMeta?.knownNpcs || []) {
      const aliases = [npc.name, npc.npcName, npc.id, npc.npcId].filter(Boolean).map(normalizeText);
      if (aliases.some((alias) => alias && (alias === name || alias.includes(name) || name.includes(alias)))) {
        return {
          name: npc.name || npc.npcName || name,
          npcId: npc.npcId || npc.id || '',
          source: 'known-npc'
        };
      }
    }
  }

  const alias = npcCandidates(roomState).find((candidate) =>
    normalizeText(candidate.alias) === name || normalizeText(candidate.name) === name
  );
  return alias ? { name: alias.name, npcId: '', source: 'alias' } : null;
}

function recentTextIncludes(value, roomState = {}) {
  const text = normalizeText((roomState.messages || []).slice(-12).map((message) =>
    `${message.displayName || ''} ${message.content || ''}`
  ).join('\n'));
  const needle = normalizeText(value);
  return Boolean(needle && text.includes(needle));
}

function inferNpcName({ actionText, narrative, roomState }) {
  const candidates = npcCandidates(roomState);
  const sourceNames = sourceNpcNamesInDeception(actionText, candidates);
  if (sourceNames.length > 0) {
    const recentTarget = recentNpcMention(roomState, candidates, sourceNames);
    if (recentTarget) return recentTarget;
  }

  const explicit = findExplicitNpc(actionText, candidates);
  if (explicit) return explicit;

  const recentText = (roomState.messages || [])
    .slice(-8)
    .map((message) => message.content || '')
    .join('\n');

  const contextualTarget = recentNpcMention(roomState, candidates);
  if (contextualTarget) return contextualTarget;

  const pronounTarget = /(?:他|她|你|您|对方|那人|那个人|老人|老汉|司机|板寸头|主任|所长|大夫|师傅)/.test(actionText);
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

function latestPlayerAction(roomState = {}, { triggerMessageId = null } = {}) {
  const messages = roomState.messages || [];
  if (triggerMessageId) {
    const triggered = messages.find((message) => Number(message.id) === Number(triggerMessageId));
    if (!triggered || triggered.authorType !== 'player' || triggered.messageType !== 'ACTION' || !triggered.playerId) {
      return null;
    }
    if (triggered.aiProcessedTaskUid) return null;
    return triggered;
  }

  const action = [...messages]
    .reverse()
    .find((message) =>
      message.authorType === 'player' &&
      message.messageType === 'ACTION' &&
      message.playerId &&
      !message.aiProcessedTaskUid
    );
  if (!action) return null;

  // 如果这条 ACTION 之后已经有 DM 回复或检定系统消息，
  // 说明已经被 AI 处理过，不应再用来推断检定
  const actionIndex = messages.findIndex((m) => m.id === action.id);
  const alreadyProcessed = messages.slice(actionIndex + 1).some((m) =>
    m.authorType === 'dm' ||
    (m.authorType === 'system' && ['对抗检定', '必要检定'].includes(m.displayName || ''))
  );
  if (alreadyProcessed) return null;

  return action;
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

function hasUsableModelRequiredCheck(checks, roomState = {}, defaultPlayerId = '') {
  if (!Array.isArray(roomState.participants)) return checks.length > 0;
  return checks.some((check) => {
    if (!isAllowedDifficulty(check.difficulty)) return false;
    const targetPlayerId = check.targetPlayerId || defaultPlayerId || roomState.participants[0]?.playerId || '';
    const participant = participantByPlayerId(roomState, targetPlayerId);
    if (!participant) return false;
    const target = getCheckTarget(participant.characterSheet, check.skill);
    return Boolean(target && Number.isInteger(target.target));
  });
}

function hasUsableModelOpposedCheck(checks, roomState = {}) {
  if (!Array.isArray(roomState.participants)) return checks.length > 0;
  const hasModuleNpcs = Array.isArray(roomState.moduleJson?.npcs) && roomState.moduleJson.npcs.length > 0;
  return checks.some((check) => {
    if (check.contestType && !normalizeContestType(check.contestType)) return false;
    const participant = participantByPlayerId(roomState, check.activePlayerId);
    if (!participant) return false;
    if (!Number.isInteger(getSkillTarget(participant.characterSheet, check.activeSkill))) return false;
    const npc = resolveNpcReference(check.passiveNpcName, roomState);
    return Boolean(npc || !hasModuleNpcs || recentTextIncludes(check.passiveNpcName, roomState));
  });
}

export function planPreflightCheck({ actionMessage, roomState = {} } = {}) {
  const action = actionMessage;
  if (!action || action.authorType !== 'player' || action.messageType !== 'ACTION' || !action.playerId) {
    return { type: 'none', reason: 'not-action', events: {}, detection: null, issues: [] };
  }

  const opposedRule = classifyOpposedAction(action.content);
  if (opposedRule) {
    const npcName = inferNpcName({ actionText: action.content, narrative: '', roomState });
    if (!npcName) {
      return {
        type: 'none',
        reason: 'opposed-npc-unresolved',
        events: {},
        detection: {
          ...opposedRule.detection,
          skill: opposedRule.activeSkill,
          passiveSkill: opposedRule.passiveSkill
        },
        issues: ['opposed check target NPC could not be resolved before narration']
      };
    }

    const events = {
      opposed_checks: [buildInferredOpposedCheck({ action, rule: opposedRule, npcName })]
    };
    const checked = validateStructuredEvents(events, { roomState, defaultPlayerId: action.playerId });
    if (!checked.valid.opposed_checks?.length) {
      return {
        type: 'none',
        reason: 'opposed-validation-failed',
        events: {},
        detection: opposedRule.detection,
        issues: checked.issues
      };
    }

    return {
      type: 'opposed',
      reason: `preflight-${opposedRule.type}`,
      events: { opposed_checks: checked.valid.opposed_checks },
      detection: {
        ...opposedRule.detection,
        target: checked.valid.opposed_checks[0].passiveNpcName,
        skill: opposedRule.activeSkill,
        passiveSkill: opposedRule.passiveSkill
      },
      issues: checked.issues,
      warnings: checked.warnings || []
    };
  }

  const requiredRule = classifyModuleRequiredAction(action.content, roomState) ||
    classifyRequiredAction(action.content, roomState);
  if (!requiredRule) {
    return { type: 'none', reason: 'no-check', events: {}, detection: null, issues: [] };
  }

  const events = {
    required_checks: [buildInferredRequiredCheck({ action, rule: requiredRule })]
  };
  const checked = validateStructuredEvents(events, { roomState, defaultPlayerId: action.playerId });
  if (!checked.valid.required_checks?.length) {
    return {
      type: 'none',
      reason: 'required-validation-failed',
      events: {},
      detection: requiredRule.detection,
      issues: checked.issues
    };
  }

  return {
    type: 'required',
    reason: `preflight-${requiredRule.detection?.source || 'backend'}-${requiredRule.skill}`,
    events: { required_checks: checked.valid.required_checks },
    detection: {
      ...requiredRule.detection,
      skill: checked.valid.required_checks[0].skill,
      difficulty: checked.valid.required_checks[0].difficulty,
      moduleCheckId: requiredRule.moduleCheckId || '',
      moduleSceneId: requiredRule.moduleSceneId || ''
    },
    issues: checked.issues,
    warnings: checked.warnings || []
  };
}

function inferOpposedChecks({ events, narrative, roomState, triggerMessageId = null }) {
  const action = latestPlayerAction(roomState, { triggerMessageId });
  const rule = action ? classifyOpposedAction(action.content) : null;
  if (!action || !rule) {
    return { checks: [], reason: '', action: null, detection: null };
  }

  const existing = Array.isArray(events.opposed_checks) ? events.opposed_checks.filter(isCompleteOpposedCheck) : [];
  if (hasUsableModelOpposedCheck(existing, roomState)) {
    return {
      checks: [],
      reason: 'model-provided',
      action,
      detection: detectionMeta({
        source: 'model',
        kind: 'opposed',
        ruleId: 'model-provided',
        confidence: 0.9,
        notes: ['model-provided']
      })
    };
  }

  const npcName = inferNpcName({ actionText: action.content, narrative, roomState });
  return {
    checks: [buildInferredOpposedCheck({ action, rule, npcName })],
    reason: `backend-${rule.type}`,
    action,
    detection: {
      ...rule.detection,
      target: npcName || '附近NPC',
      skill: rule.activeSkill,
      passiveSkill: rule.passiveSkill
    }
  };
}

function inferRequiredChecks({ events, roomState, triggerMessageId = null }) {
  const action = latestPlayerAction(roomState, { triggerMessageId });
  if (!action) {
    return { checks: [], reason: '', action: null, detection: null };
  }

  if (classifyOpposedAction(action.content)) {
    return {
      checks: [],
      reason: 'opposed-action',
      action,
      detection: detectionMeta({
        source: 'backend',
        kind: 'required',
        ruleId: 'skipped:opposed-action',
        confidence: 1,
        notes: ['opposed-action-priority']
      })
    };
  }

  const existing = Array.isArray(events.required_checks) ? events.required_checks.filter(isCompleteRequiredCheck) : [];
  if (hasUsableModelRequiredCheck(existing, roomState, action.playerId)) {
    return {
      checks: [],
      reason: 'model-provided',
      action,
      detection: detectionMeta({
        source: 'model',
        kind: 'required',
        ruleId: 'model-provided',
        confidence: 0.9,
        notes: ['model-provided']
      })
    };
  }

  const rule = classifyModuleRequiredAction(action.content, roomState) ||
    classifyRequiredAction(action.content, roomState);
  if (!rule) {
    return { checks: [], reason: '', action, detection: null };
  }

  return {
    checks: [buildInferredRequiredCheck({ action, rule })],
    reason: `${rule.detection?.source || 'backend'}-${rule.skill}`,
    action,
    detection: {
      ...rule.detection,
      skill: rule.skill,
      difficulty: rule.difficulty,
      moduleCheckId: rule.moduleCheckId || '',
      moduleSceneId: rule.moduleSceneId || ''
    }
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

// AI 有时会在叙事里自己写"此处触发XX检定"标记，但这是后端的职责。
// 先清理掉 AI 生成的标记，再由后端统一追加。
const AI_CHECK_MARKER = /（此处触发[^）]*?检定[^）]*?。）\s*/g;

function sanitizeNarrative(narrative, inferredOpposedChecks, inferredRequiredChecks) {
  let text = String(narrative || '').replace(AI_CHECK_MARKER, '').trim();
  const suggestionResult = stripTrailingActionSuggestions(text);
  text = suggestionResult.text;
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

export function enhanceStructuredEvents({ events, narrative, roomState, triggerMessageId = null, disableCheckInference = false } = {}) {
  const enhancedEvents = { ...(events || {}) };
  const diagnostics = {
    inferredRequiredChecks: [],
    inferredRequiredReason: '',
    inferredRequiredDetection: null,
    inferredOpposedChecks: [],
    inferredReason: '',
    inferredOpposedDetection: null,
    detectionNotes: [],
    droppedIncompleteRequiredChecks: 0,
    droppedIncompleteOpposedChecks: 0,
    droppedRequiredChecksForOpposedAction: 0,
    strippedActionSuggestions: false,
    strippedDecisiveOutcome: false,
    latestActionId: null,
    checkEventsSuppressed: false,
    suppressedCheckEventCount: 0
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

  if (disableCheckInference) {
    const opposedCount = Array.isArray(enhancedEvents.opposed_checks) ? enhancedEvents.opposed_checks.length : 0;
    const requiredCount = Array.isArray(enhancedEvents.required_checks) ? enhancedEvents.required_checks.length : 0;
    if (opposedCount > 0) delete enhancedEvents.opposed_checks;
    if (requiredCount > 0) delete enhancedEvents.required_checks;
    diagnostics.checkEventsSuppressed = opposedCount + requiredCount > 0;
    diagnostics.suppressedCheckEventCount = opposedCount + requiredCount;

    const sanitized = sanitizeNarrative(narrative, [], []);
    diagnostics.strippedActionSuggestions = sanitized.strippedActionSuggestions;
    diagnostics.strippedDecisiveOutcome = sanitized.strippedDecisiveOutcome;

    return {
      narrative: sanitized.narrative,
      events: enhancedEvents,
      diagnostics
    };
  }

  const inferred = inferOpposedChecks({ events: enhancedEvents, narrative, roomState, triggerMessageId });
  diagnostics.latestActionId = inferred.action?.id || null;
  diagnostics.inferredReason = inferred.reason;
  diagnostics.inferredOpposedDetection = inferred.detection;
  if (inferred.detection) diagnostics.detectionNotes.push(inferred.detection);

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

  const inferredRequired = inferRequiredChecks({ events: enhancedEvents, roomState, triggerMessageId });
  diagnostics.latestActionId = diagnostics.latestActionId || inferredRequired.action?.id || null;
  diagnostics.inferredRequiredReason = inferredRequired.reason;
  diagnostics.inferredRequiredDetection = inferredRequired.detection;
  if (inferredRequired.detection) diagnostics.detectionNotes.push(inferredRequired.detection);

  if (inferredRequired.checks.length > 0) {
    enhancedEvents.required_checks = [
      ...(Array.isArray(enhancedEvents.required_checks) ? enhancedEvents.required_checks : []),
      ...inferredRequired.checks
    ];
    diagnostics.inferredRequiredChecks = inferredRequired.checks;
  }

  const opposedChecksForNarrative = Array.isArray(enhancedEvents.opposed_checks)
    ? enhancedEvents.opposed_checks.filter(isCompleteOpposedCheck)
    : [];
  const requiredChecksForNarrative = Array.isArray(enhancedEvents.required_checks)
    ? enhancedEvents.required_checks.filter(isCompleteRequiredCheck)
    : [];
  const sanitized = sanitizeNarrative(narrative, opposedChecksForNarrative, requiredChecksForNarrative);
  diagnostics.strippedActionSuggestions = sanitized.strippedActionSuggestions;
  diagnostics.strippedDecisiveOutcome = sanitized.strippedDecisiveOutcome;

  return {
    narrative: sanitized.narrative,
    events: enhancedEvents,
    diagnostics
  };
}

function normalizeRequiredChecksForRoom(value, roomState, defaultPlayerId) {
  const kept = [];
  const issues = [];

  value.forEach((check, index) => {
    const targetPlayerId = check.targetPlayerId || defaultPlayerId || roomState.participants?.[0]?.playerId || '';
    const participant = participantByPlayerId(roomState, targetPlayerId);
    if (!participant) {
      issues.push(`required_checks[${index}].targetPlayerId: room participant not found`);
      return;
    }

    const target = getCheckTarget(participant.characterSheet, check.skill);
    if (!target || !Number.isInteger(target.target)) {
      issues.push(`required_checks[${index}].skill: unknown skill or characteristic for target player (${check.skill})`);
      return;
    }

    kept.push({
      ...check,
      targetPlayerId,
      skill: target.label,
      difficulty: normalizeDifficulty(check.difficulty)
    });
  });

  return { value: kept, issues };
}

function normalizeOpposedChecksForRoom(value, roomState) {
  const kept = [];
  const issues = [];
  const warnings = [];
  const hasModuleNpcs = Array.isArray(roomState.moduleJson?.npcs) && roomState.moduleJson.npcs.length > 0;

  value.forEach((check, index) => {
    const participant = participantByPlayerId(roomState, check.activePlayerId);
    if (!participant) {
      issues.push(`opposed_checks[${index}].activePlayerId: room participant not found`);
      return;
    }

    const activeSkill = getSkillTarget(participant.characterSheet, check.activeSkill);
    if (!Number.isInteger(activeSkill)) {
      issues.push(`opposed_checks[${index}].activeSkill: unknown skill for active player (${check.activeSkill})`);
      return;
    }

    const npc = resolveNpcReference(check.passiveNpcName, roomState);
    if (!npc && hasModuleNpcs && !recentTextIncludes(check.passiveNpcName, roomState)) {
      issues.push(`opposed_checks[${index}].passiveNpcName: NPC not found in module, known NPCs, or recent scene (${check.passiveNpcName})`);
      return;
    }
    if (!npc) {
      warnings.push(`opposed_checks[${index}].passiveNpcName: NPC kept as ad-hoc target (${check.passiveNpcName})`);
    }

    kept.push({
      ...check,
      passiveNpcName: npc?.name || check.passiveNpcName,
      contestType: normalizeContestType(check.contestType) || inferContestTypeFromSkill(check.activeSkill)
    });
  });

  return { value: kept, issues, warnings };
}

function inferContestTypeFromSkill(skill) {
  if (['潜行', '妙手', '乔装'].includes(skill)) return 'stealth';
  if (['格斗', '射击'].includes(skill)) return 'combat';
  return 'social';
}

function normalizeStateChangesForRoom(value, roomState) {
  const kept = [];
  const issues = [];

  value.forEach((change, index) => {
    if (!participantByPlayerId(roomState, change.targetPlayerId)) {
      issues.push(`proposed_state_changes[${index}].targetPlayerId: room participant not found`);
      return;
    }
    kept.push(change);
  });

  return { value: kept, issues };
}

function normalizeCluesForRoom(value, roomState) {
  const kept = [];
  const issues = [];

  value.forEach((clue, index) => {
    if (clue.privateTo && !participantByPlayerId(roomState, clue.privateTo)) {
      issues.push(`clues_revealed[${index}].privateTo: room participant not found`);
      return;
    }
    kept.push(clue);
  });

  return { value: kept, issues };
}

function normalizeNpcChangesForRoom(value, roomState) {
  const warnings = [];
  const normalized = value.map((npc, index) => {
    const match = resolveNpcReference(npc.npcId || npc.npcName, roomState);
    if (!match && Array.isArray(roomState.moduleJson?.npcs) && roomState.moduleJson.npcs.length > 0) {
      warnings.push(`npc_state_changes[${index}].npcName: NPC kept as ad-hoc state (${npc.npcName})`);
      return npc;
    }
    if (!match) return npc;
    return {
      ...npc,
      npcId: npc.npcId || match.npcId,
      npcName: match.name
    };
  });

  return { value: normalized, issues: [], warnings };
}

function normalizeEventValueForRoom(key, value, roomState, defaultPlayerId) {
  if (!roomState?.participants) return { value, issues: [], warnings: [] };
  if (key === 'required_checks') return normalizeRequiredChecksForRoom(value, roomState, defaultPlayerId);
  if (key === 'opposed_checks') return normalizeOpposedChecksForRoom(value, roomState);
  if (key === 'proposed_state_changes') return normalizeStateChangesForRoom(value, roomState);
  if (key === 'clues_revealed') return normalizeCluesForRoom(value, roomState);
  if (key === 'npc_state_changes') return normalizeNpcChangesForRoom(value, roomState);
  return { value, issues: [], warnings: [] };
}

export function validateStructuredEvents(events, options = {}) {
  const valid = {};
  const rejected = [];
  const issues = [];
  const warnings = [];
  const { roomState = null, defaultPlayerId = '' } = options || {};

  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    let value = events[key];
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

    if (schema.type === 'array') {
      const arrayValidation = validateArrayItemsBySchema(value, schema, key);
      if (arrayValidation.fatal) {
        rejected.push(key);
        issues.push(...arrayValidation.issues);
        continue;
      }
      if (arrayValidation.issues.length > 0) {
        issues.push(...arrayValidation.issues);
        warnings.push(`${key}: dropped ${value.length - arrayValidation.value.length} invalid item(s)`);
      }
      if (value.length > 0 && arrayValidation.value.length === 0) {
        rejected.push(key);
        continue;
      }
      value = arrayValidation.value;
    } else {
      const schemaIssues = validateBySchema(value, schema, key);
      if (schemaIssues.length > 0) {
        rejected.push(key);
        issues.push(...schemaIssues);
        continue;
      }
    }

    if (key === 'proposed_state_changes') {
      const kept = [];
      const fieldIssues = [];
      value.forEach((change, index) => {
        const itemIssues = validateStateChangeField(change.fieldPath);
        if (itemIssues.length > 0) {
          fieldIssues.push(...itemIssues.map((issue) => `${key}[${index}]: ${issue}`));
        } else {
          kept.push(change);
        }
      });
      if (fieldIssues.length > 0) {
        issues.push(...fieldIssues);
        warnings.push(`${key}: dropped ${value.length - kept.length} invalid item(s)`);
      }
      if (value.length > 0 && kept.length === 0) {
        rejected.push(key);
        continue;
      }
      value = kept;
    }

    if (key === 'required_checks') {
      const kept = [];
      const difficultyIssues = [];
      value.forEach((check, index) => {
        if (!isAllowedDifficulty(check.difficulty)) {
          difficultyIssues.push(`${key}[${index}].difficulty: invalid difficulty`);
          return;
        }
        kept.push({
          ...check,
          difficulty: normalizeDifficulty(check.difficulty)
        });
      });
      if (difficultyIssues.length > 0) {
        issues.push(...difficultyIssues);
        warnings.push(`${key}: dropped ${value.length - kept.length} invalid item(s)`);
      }
      if (value.length > 0 && kept.length === 0) {
        rejected.push(key);
        continue;
      }
      value = kept;
    }

    if (key === 'opposed_checks') {
      const kept = [];
      const contestIssues = [];
      value.forEach((check, index) => {
        if (!check.contestType) {
          kept.push(check);
          return;
        }
        const contestType = normalizeContestType(check.contestType);
        if (!contestType) {
          contestIssues.push(`${key}[${index}].contestType: invalid contest type`);
          return;
        }
        kept.push({
          ...check,
          contestType
        });
      });
      if (contestIssues.length > 0) {
        issues.push(...contestIssues);
        warnings.push(`${key}: dropped ${value.length - kept.length} invalid item(s)`);
      }
      if (value.length > 0 && kept.length === 0) {
        rejected.push(key);
        continue;
      }
      value = kept;
    }

    const roomValidation = normalizeEventValueForRoom(key, value, roomState, defaultPlayerId);
    warnings.push(...(roomValidation.warnings || []));
    if (roomValidation.issues?.length > 0) {
      issues.push(...roomValidation.issues);
      if (Array.isArray(value) && Array.isArray(roomValidation.value) && roomValidation.value.length > 0) {
        warnings.push(`${key}: dropped ${value.length - roomValidation.value.length} invalid item(s)`);
        valid[key] = roomValidation.value;
        continue;
      }
      rejected.push(key);
      continue;
    }
    if (Array.isArray(roomValidation.value) && roomValidation.value.length === 0 && Array.isArray(value) && value.length > 0) {
      rejected.push(key);
      issues.push(`${key}: no valid room-applicable items`);
      continue;
    }

    valid[key] = roomValidation.value;
  }

  return { valid, rejected, issues, warnings };
}
