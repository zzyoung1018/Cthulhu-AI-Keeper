window.onerror = function(msg, url, line) {
  const banner = document.createElement('div');
  banner.className = 'js-error-banner';
  banner.textContent = `JS错误: ${msg} (行${line})`;
  document.body.append(banner);
};

function createPlayerId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-');
}

const storageKeys = {
  playerId: 'dm-online-player-id',
  displayName: 'dm-online-display-name',
  lastRoomCode: 'dm-online-last-room-code',
  lastRoomName: 'dm-online-last-room-name'
};

const state = {
  mode: 'create',
  messageType: 'IC',
  playerId: localStorage.getItem(storageKeys.playerId) || createPlayerId(),
  displayName: localStorage.getItem(storageKeys.displayName) || '',
  room: null,
  modules: [],
  selectedModuleId: '',
  participant: null,
  participants: [],
  messages: [],
  aiTasks: [],
  activeAiTask: null,
  aiLogEntries: [],
  events: null
};

localStorage.setItem(storageKeys.playerId, state.playerId);

const els = {
  // 大厅
  entryPanel: document.querySelector('#entryPanel'),
  btnCreateRoom: document.querySelector('#btnCreateRoom'),
  btnJoinRoom: document.querySelector('#btnJoinRoom'),
  // 弹窗
  createRoomDialog: document.querySelector('#createRoomDialog'),
  createRoomForm: document.querySelector('#createRoomForm'),
  joinRoomDialog: document.querySelector('#joinRoomDialog'),
  joinRoomForm: document.querySelector('#joinRoomForm'),
  settingsDialog: document.querySelector('#settingsDialog'),
  // 模组
  moduleSelect: document.querySelector('#moduleSelect'),
  moduleFile: document.querySelector('#moduleFile'),
  uploadModule: document.querySelector('#uploadModule'),
  modulePreview: document.querySelector('#modulePreview'),
  playtestImportFile: document.querySelector('#playtestImportFile'),
  importPlaytest: document.querySelector('#importPlaytest'),
  importPreview: document.querySelector('#importPreview'),
  // 房间面板
  roomPanel: document.querySelector('#roomPanel'),
  roomTitle: document.querySelector('#roomTitle'),
  roomStatus: document.querySelector('#roomStatus'),
  replayBanner: document.querySelector('#replayBanner'),
  replaySource: document.querySelector('#replaySource'),
  replayMeta: document.querySelector('#replayMeta'),
  exportReplayFixture: document.querySelector('#exportReplayFixture'),
  roomCode: document.querySelector('#roomCode'),
  codeRow: document.querySelector('#codeRow'),
  playerCount: document.querySelector('#playerCount'),
  players: document.querySelector('#players'),
  leaveRoom: document.querySelector('#leaveRoom'),
  startGame: document.querySelector('#startGame'),
  pauseGame: document.querySelector('#pauseGame'),
  resumeGame: document.querySelector('#resumeGame'),
  endGame: document.querySelector('#endGame'),
  // AI 设置
  btnSettings: document.querySelector('#btnSettings'),
  aiConfigForm: document.querySelector('#aiConfigForm'),
  // 角色卡
  characterCard: document.querySelector('#characterCard'),
  charCardName: document.querySelector('#charCardName'),
  charCardStatus: document.querySelector('#charCardStatus'),
  btnEditCharacter: document.querySelector('#btnEditCharacter'),
  characterDialog: document.querySelector('#characterDialog'),
  dialogReadyState: document.querySelector('#dialogReadyState'),
  profileForm: document.querySelector('#profileForm'),
  rollCharacteristics: document.querySelector('#rollCharacteristics'),
  resetCharacteristics: document.querySelector('#resetCharacteristics'),
  characteristicRollSummary: document.querySelector('#characteristicRollSummary'),
  characteristicsGrid: document.querySelector('#characteristicsGrid'),
  derivedGrid: document.querySelector('#derivedGrid'),
  resourceGrid: document.querySelector('#resourceGrid'),
  skillsTable: document.querySelector('#skillsTable'),
  occupationSelect: document.querySelector('#occupationSelect'),
  occPtsRemaining: document.querySelector('#occPtsRemaining'),
  intPtsRemaining: document.querySelector('#intPtsRemaining'),
  skillPointsDisplay: document.querySelector('#skillPointsDisplay'),
  readyCharacter: document.querySelector('#readyCharacter'),
  // 状态面板
  statusPanel: document.querySelector('#statusPanel'),
  statusName: document.querySelector('#statusName'),
  statusCards: document.querySelector('#statusCards'),
  // 角色状态弹窗
  btnCharSheet: document.querySelector('#btnCharSheet'),
  charSheetDialog: document.querySelector('#charSheetDialog'),
  charSheetTitle: document.querySelector('#charSheetTitle'),
  charSheetBody: document.querySelector('#charSheetBody'),
  // 桌面
  tableArea: document.querySelector('#tableArea'),
  tableTitle: document.querySelector('#tableTitle'),
  tableSubtitle: document.querySelector('#tableSubtitle'),
  chatLog: document.querySelector('#chatLog'),
  messageForm: document.querySelector('#messageForm'),
  connectionStatus: document.querySelector('#connectionStatus'),
  connectionDot: document.querySelector('#connectionDot'),
  // AI 控制
  aiPill: document.querySelector('#aiPill'),
  aiQueueSummary: document.querySelector('#aiQueueSummary'),
  cancelAiTask: document.querySelector('#cancelAiTask'),
  regenerateAiTask: document.querySelector('#regenerateAiTask'),
  rollbackRound: document.querySelector('#rollbackRound'),
  submitRound: document.querySelector('#submitRound'),
  btnAiLog: document.querySelector('#btnAiLog'),
  aiLogDialog: document.querySelector('#aiLogDialog'),
  aiLogBody: document.querySelector('#aiLogBody'),
  aiLogStats: document.querySelector('#aiLogStats'),
  aiLogStageFilter: document.querySelector('#aiLogStageFilter'),
  aiLogWarningOnly: document.querySelector('#aiLogWarningOnly'),
  aiLogGroupByTask: document.querySelector('#aiLogGroupByTask'),
  exportAiLog: document.querySelector('#exportAiLog'),
  exportGame: document.querySelector('#exportGame'),
  toast: document.querySelector('#toast')
};

// 设置初始显示名
els.createRoomForm.displayName.value = state.displayName;
els.joinRoomForm.displayName.value = state.displayName;

const roomStatusLabels = {
  PREPARING: '准备阶段',
  ACTIVE: '游玩阶段',
  PAUSED: '暂停阶段',
  ENDED: '已结束',
  ARCHIVED: '已归档'
};

const messageTypeLabels = {
  IC: 'IC',
  OOC: 'OOC',
  ACTION: 'ACTION',
  SYSTEM: 'SYSTEM',
  AI_DM: 'AI DM',
  PRIVATE: 'PRIVATE'
};

const aiTaskLabels = {
  QUEUED: 'AI 排队中',
  RETRIEVING: '检索模组',
  GENERATING: '生成中',
  STREAMING: '流式输出',
  VALIDATING: '验证事件',
  COMPLETED: 'AI 完成',
  FAILED: 'AI 失败',
  CANCELLED: 'AI 已取消'
};

const aiLogStageLabels = {
  'preflight-check': '服务器预检定',
  'preflight-skipped': '预检定跳过',
  'structured-events': '结构化事件检测',
  'apply-events': '执行结构化事件',
  'rejected-events': '事件被拒绝',
  'dm-completed': 'AI 回复完成',
  'dm-failed': 'AI 回复失败',
  'intro-completed': '剧情简介完成',
  'intro-failed': '剧情简介失败',
  'npc-skill-fallback': 'NPC 技能回退',
  'clue-state-updated': '线索写入状态',
  'clue-state-skipped': '线索未写入',
  'clue-state-failed': '线索写入失败',
  'npc-state-updated': 'NPC 状态写入',
  'npc-state-scene-skipped': 'NPC 场景状态未写入',
  'npc-state-failed': 'NPC 状态写入失败'
};

const aiLogEventLabels = {
  required_checks: '必要检定',
  opposed_checks: '对抗检定',
  proposed_state_changes: '人物状态',
  clues_revealed: '线索',
  scene_change: '场景',
  npc_state_changes: 'NPC',
  summary_update: '摘要'
};

const activeAiStatuses = ['QUEUED', 'RETRIEVING', 'GENERATING', 'STREAMING', 'VALIDATING'];

const characteristicKeys = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'Luck'];
const skillCreationMax = 100;

const characteristicInfo = {
  STR: { label: '力量', formula: '3D6×5', dice: '3d6' },
  CON: { label: '体质', formula: '3D6×5', dice: '3d6' },
  SIZ: { label: '体型', formula: '(2D6+6)×5', dice: '2d6+6' },
  DEX: { label: '敏捷', formula: '3D6×5', dice: '3d6' },
  APP: { label: '外貌', formula: '3D6×5', dice: '3d6' },
  INT: { label: '智力', formula: '(2D6+6)×5', dice: '2d6+6' },
  POW: { label: '意志', formula: '3D6×5', dice: '3d6' },
  EDU: { label: '教育', formula: '(2D6+6)×5', dice: '2d6+6' },
  Luck: { label: '幸运', formula: '3D6×5', dice: '3d6' }
};

const derivedInfo = {
  MOV: '移动力',
  DB: '伤害加值',
  Build: '体格'
};

const defaultCharacteristics = {
  STR: 50,
  CON: 50,
  SIZ: 50,
  DEX: 50,
  APP: 50,
  INT: 50,
  POW: 50,
  EDU: 50,
  Luck: 50
};

const defaultSkills = {
  会计: 5,
  人类学: 1,
  估价: 5,
  考古学: 1,
  魅惑: 15,
  攀爬: 20,
  信用评级: 0,
  克苏鲁神话: 0,
  乔装: 5,
  闪避: 25,
  驾驶汽车: 20,
  电气维修: 10,
  话术: 5,
  急救: 30,
  驾驶: 1,
  历史: 5,
  化学: 1,
  恐吓: 15,
  跳跃: 20,
  母语: 50,
  法律: 5,
  格斗: 25,
  工艺: 5,
  图书馆使用: 20,
  聆听: 20,
  锁匠: 1,
  机械维修: 10,
  医学: 1,
  博物学: 10,
  导航: 10,
  神秘学: 5,
  说服: 10,
  精神分析: 1,
  心理学: 10,
  骑术: 5,
  妙手: 10,
  摄影: 5,
  射击: 20,
  侦查: 25,
  潜行: 20,
  游泳: 20,
  投掷: 20,
  外语: 1,
  物理学: 1,
  药学: 1,
  追踪: 10
};

// CoC 7e 职业模板（名称 → 职业技能列表）
const occupationTemplates = {
  '': [],
  '会计师': ['会计', '法律', '图书馆使用', '聆听', '说服', '侦查'],
  '演员': ['乔装', '话术', '魅惑', '心理学', '妙手'],
  '考古学家': ['估价', '考古学', '历史', '图书馆使用', '侦查', '外语'],
  '医生': ['急救', '医学', '心理学', '侦查', '药学', '外语'],
  '记者': ['话术', '图书馆使用', '聆听', '说服', '心理学', '侦查'],
  '律师': ['话术', '法律', '图书馆使用', '说服', '心理学'],
  '警察': ['格斗', '射击', '法律', '聆听', '心理学', '侦查'],
  '教授': ['图书馆使用', '母语', '心理学', '说服', '神秘学'],
  '私家侦探': ['图书馆使用', '摄影', '潜行', '心理学', '侦查', '追踪'],
  '图书管理员': ['会计', '图书馆使用', '母语', '说服', '侦查'],
  '摄影师': ['摄影', '侦查', '心理学', '潜行'],
  '艺术家': ['工艺', '侦查', '历史', '神秘学', '心理学'],
  '音乐家': ['魅惑', '聆听', '心理学', '妙手'],
  '作家': ['话术', '历史', '图书馆使用', '母语', '心理学', '侦查'],
  '科学家': ['电气维修', '图书馆使用', '机械维修', '博物学', '药学'],
  '工程师': ['电气维修', '图书馆使用', '机械维修', '物理学', '化学'],
  '神职人员': ['魅惑', '聆听', '心理学', '说服', '神秘学'],
  '罪犯': ['格斗', '射击', '锁匠', '潜行', '妙手', '侦查'],
  '刺客': ['格斗', '射击', '闪避', '潜行', '锁匠', '妙手'],
  '司机': ['驾驶汽车', '聆听', '机械维修', '心理学', '侦查'],
  '农民': ['攀爬', '格斗', '追踪', '博物学', '机械维修'],
  '海员': ['攀爬', '跳跃', '格斗', '导航', '聆听', '游泳'],
  '飞行员': ['驾驶', '电气维修', '导航', '侦查', '机械维修'],
  '士兵': ['格斗', '射击', '闪避', '潜行', '急救', '投掷'],
};

function matchOccupationTemplate(occupation = '') {
  return Object.keys(occupationTemplates)
    .find((name) => name && (name === occupation || occupation.includes(name))) || '';
}

function occupationSkillsForName(occupation = '') {
  return occupationTemplates[occupation] || [];
}

const textSectionFields = [
  'equipment',
  'relationships',
  'beliefs',
  'locations',
  'scarsTraumas',
  'encounteredMonsters',
  'clues',
  'privateNotes'
];

function numberInRange(value, fallback, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function rollDie(sides = 6) {
  return Math.floor(Math.random() * sides) + 1;
}

function rollCharacteristic(key) {
  const info = characteristicInfo[key] || { dice: '3d6', formula: '3D6×5' };
  if (info.dice === '2d6+6') {
    const rolls = [rollDie(), rollDie()];
    const total = rolls[0] + rolls[1] + 6;
    return { key, rolls, bonus: 6, total, value: total * 5, formula: info.formula };
  }
  const rolls = [rollDie(), rollDie(), rollDie()];
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  return { key, rolls, bonus: 0, total, value: total * 5, formula: info.formula };
}

function characteristicDisplayName(key) {
  const info = characteristicInfo[key];
  return info ? `${key} ${info.label}` : key;
}

function characteristicRollText(result) {
  const dice = result.rolls.join('+') + (result.bonus ? `+${result.bonus}` : '');
  return `${characteristicDisplayName(result.key)} ${dice}=${result.total} → ${result.value}`;
}

function currentSheet() {
  return state.participant?.characterSheet || {
    investigator: {
      name: state.participant?.characterName || '',
      playerName: state.displayName,
      occupation: '',
      age: '',
      residence: '',
      birthplace: ''
    },
    characteristics: { ...defaultCharacteristics },
    status: {},
    skills: { ...defaultSkills },
    skillAllocations: {},
    weapons: [],
    equipment: '',
    relationships: '',
    beliefs: '',
    locations: '',
    scarsTraumas: '',
    encounteredMonsters: '',
    clues: '',
    privateNotes: ''
  };
}

function calculateDerived(characteristics, status = {}) {
  const values = Object.fromEntries(characteristicKeys.map((key) => [
    key,
    numberInRange(characteristics?.[key], defaultCharacteristics[key], 0, 100)
  ]));
  const hp = Math.max(1, Math.floor((values.CON + values.SIZ) / 10));
  const mp = Math.max(0, Math.floor(values.POW / 5));
  const san = Math.max(0, values.POW);
  const mov = values.STR < values.SIZ && values.DEX < values.SIZ
    ? 7
    : values.STR > values.SIZ && values.DEX > values.SIZ
      ? 9
      : 8;
  const sum = values.STR + values.SIZ;
  let damageBonus = '0';
  let build = 0;
  if (sum <= 64) {
    damageBonus = '-2';
    build = -2;
  } else if (sum <= 84) {
    damageBonus = '-1';
    build = -1;
  } else if (sum <= 124) {
    damageBonus = '0';
    build = 0;
  } else if (sum <= 164) {
    damageBonus = '+1d4';
    build = 1;
  } else if (sum <= 204) {
    damageBonus = '+1d6';
    build = 2;
  } else {
    build = Math.floor((sum - 205) / 80) + 3;
    damageBonus = `+${build - 1}d6`;
  }

  return {
    hp,
    mp,
    san,
    luck: values.Luck,
    mov,
    damageBonus,
    build,
    currentHp: numberInRange(status.hp, hp, 0, hp),
    currentMp: numberInRange(status.mp, mp, 0, mp),
    currentSan: numberInRange(status.san, san, 0, 99),
    currentLuck: numberInRange(status.luck, values.Luck, 0, 100)
  };
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function uploadModuleFile(file) {
  const form = new FormData();
  form.set('playerId', state.playerId);
  form.set('title', file.name.replace(/\.[^.]+$/, ''));
  form.set('file', file);

  const response = await fetch('/api/modules', {
    method: 'POST',
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function importPlaytestFile(file, { displayName, roomName }) {
  const text = await file.text();
  let exported;
  try {
    exported = JSON.parse(text);
  } catch {
    throw new Error('导入文件不是有效 JSON');
  }

  return api('/api/imports/playtest', {
    method: 'POST',
    body: JSON.stringify({
      playerId: state.playerId,
      displayName,
      roomName,
      export: exported
    })
  });
}

// 弹窗控制
function openCreateDialog() {
  els.createRoomForm.displayName.value = state.displayName;
  els.createRoomDialog.showModal();
}
function closeCreateDialog() { els.createRoomDialog.close(); }
function openJoinDialog() {
  els.joinRoomForm.displayName.value = state.displayName;
  els.joinRoomDialog.showModal();
}
function closeJoinDialog() { els.joinRoomDialog.close(); }
function openSettingsDialog() {
  if (!state.room || !isOwner()) { toast('只有房主可以修改 AI 设置'); return; }
  renderAiConfigForm();
  els.settingsDialog.showModal();
}
function closeSettingsDialog() { els.settingsDialog.close(); }

function setAiBusy(isBusy) {
  els.aiPill.classList.toggle('busy', isBusy);
  els.aiPill.textContent = isBusy ? 'AI 正在写下一幕' : 'AI 待命';
}

function shortTaskUid(task) {
  return task?.uid ? String(task.uid).slice(0, 8) : '';
}

function taskStatusLabel(task) {
  if (!task) return '';
  return aiTaskLabels[task.status] || task.status || '未知状态';
}

function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stateChip(label, value = '', className = '') {
  const node = document.createElement('span');
  node.className = ['ai-state-chip', className].filter(Boolean).join(' ');
  node.append(document.createTextNode(`${label} `));
  if (value) {
    const strong = document.createElement('strong');
    strong.textContent = value;
    node.append(strong);
  }
  return node;
}

function completedAiTasks() {
  return state.aiTasks.filter((task) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status));
}

function latestFinishedAiTask() {
  return [...completedAiTasks()].reverse()[0] || null;
}

function renderAiQueueSummary(activeTask) {
  if (!els.aiQueueSummary) return;
  els.aiQueueSummary.replaceChildren();
  if (!state.room) {
    els.aiQueueSummary.hidden = true;
    return;
  }
  els.aiQueueSummary.hidden = false;

  const waitingTasks = state.aiTasks.filter((task) =>
    activeAiStatuses.includes(task.status) && task.uid !== activeTask?.uid
  );
  const failedTasks = state.aiTasks.filter((task) => task.status === 'FAILED');
  const finished = latestFinishedAiTask();

  if (activeTask) {
    const status = taskStatusLabel(activeTask);
    els.aiQueueSummary.append(stateChip('当前', `${status} #${shortTaskUid(activeTask)}`, 'busy'));
    if (activeTask.startedAt || activeTask.updatedAt) {
      els.aiQueueSummary.append(stateChip('更新', formatClock(activeTask.updatedAt || activeTask.startedAt)));
    }
  } else {
    els.aiQueueSummary.append(stateChip('队列', '空闲', 'ok'));
  }

  els.aiQueueSummary.append(stateChip('等待', String(waitingTasks.length)));

  if (failedTasks.length > 0) {
    els.aiQueueSummary.append(stateChip('失败', String(failedTasks.length), 'error'));
  } else if (finished) {
    const finishedAt = formatClock(finished.completedAt || finished.updatedAt);
    els.aiQueueSummary.append(stateChip('最近', `${taskStatusLabel(finished)}${finishedAt ? ` ${finishedAt}` : ''}`));
  }
}

function renderAiTaskControls() {
  const activeTask = state.activeAiTask || findActiveAiTask(state.aiTasks);
  state.activeAiTask = activeTask;
  const busy = Boolean(activeTask);
  const label = activeTask ? aiTaskLabels[activeTask.status] || activeTask.status : 'AI 待命';
  els.aiPill.classList.toggle('busy', busy);
  els.aiPill.textContent = activeTask ? `${label} · ${activeTask.uid.slice(0, 8)}` : label;
  renderAiQueueSummary(activeTask);

  const owner = isOwner();
  els.cancelAiTask.hidden = !owner || !activeTask || !['QUEUED', 'RETRIEVING', 'GENERATING', 'STREAMING'].includes(activeTask.status);
  const finished = latestFinishedAiTask();
  els.regenerateAiTask.hidden = !owner || Boolean(activeTask) || !finished;
  els.cancelAiTask.dataset.taskUid = activeTask?.uid || '';
  els.regenerateAiTask.dataset.taskUid = finished?.uid || '';

  // Rollback: show when there's a finished AI task and no active task
  els.rollbackRound.hidden = !owner || Boolean(activeTask) || !finished;
  els.rollbackRound.dataset.taskUid = finished?.uid || '';

  // Round submit: show in ROUND trigger mode when no active task
  const triggerMode = state.room?.aiConfig?.triggerMode || 'ACTION';
  els.submitRound.hidden = triggerMode !== 'ROUND';
  els.btnAiLog.hidden = !owner || !state.room;

  // Export always visible when in room
  els.exportGame.hidden = !state.room;
}

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return `${Math.round(number * 100)}%`;
}

function eventNames(keys = []) {
  return keys.map((key) => aiLogEventLabels[key] || key);
}

function preflightTypeLabel(type) {
  return {
    required: '必要检定',
    opposed: '对抗检定'
  }[type] || '检定';
}

function formatPreflightReason(reason = '') {
  const text = String(reason || '').trim();
  const known = {
    'action-already-processed': '行动已被处理',
    'no-check': '未识别到需要检定的行动',
    'not-action': '不是正式行动消息',
    'opposed-npc-unresolved': '未能确定对抗目标 NPC',
    'opposed-validation-failed': '对抗检定未通过房间校验',
    'required-validation-failed': '必要检定未通过房间校验',
    'no-check-message-created': '未能创建检定消息'
  };
  if (known[text]) return known[text];
  if (text.startsWith('preflight-generic-')) return `通用规则：${text.replace('preflight-generic-', '')}`;
  if (text.startsWith('preflight-module-')) return `模组规则：${text.replace('preflight-module-', '')}`;
  if (text.startsWith('preflight-social')) return '社交对抗规则';
  if (text.startsWith('preflight-stealth')) return '潜行对抗规则';
  if (text.startsWith('preflight-combat')) return '战斗对抗规则';
  return text || '未记录原因';
}

function chip(text, className = '') {
  const node = document.createElement('span');
  node.className = ['ai-log-chip', className].filter(Boolean).join(' ');
  node.textContent = text;
  return node;
}

function detectionLine(note) {
  const source = {
    model: '模型返回',
    generic: '通用规则',
    module: '模组规则',
    backend: '后端规则'
  }[note.source] || note.source || '检测';
  const kind = note.kind === 'opposed' ? '对抗' : note.kind === 'required' ? '必要' : (note.kind || '事件');
  return [
    `${source} · ${kind}`,
    note.skill ? `技能 ${note.skill}` : '',
    note.passiveSkill ? `对手 ${note.passiveSkill}` : '',
    note.target ? `目标 ${note.target}` : '',
    note.difficulty ? `难度 ${note.difficulty}` : '',
    note.ruleId ? `规则 ${note.ruleId}` : '',
    `置信度 ${formatConfidence(note.confidence)}`,
    Array.isArray(note.notes) && note.notes.length ? `依据 ${note.notes.join('/')}` : ''
  ].filter(Boolean).join(' · ');
}

function aiLogSummaryLines(entry) {
  const detection = entry.detection || {};
  const lines = [];

  if (entry.stage === 'structured-events') {
    lines.push(`模型 JSON：${entry.hasJsonBlock ? '有' : '无'}；有效事件：${eventNames(entry.validKeys || []).join('、') || '无'}`);
    if (entry.enhancedEventKeys?.length) lines.push(`后端增强后事件：${eventNames(entry.enhancedEventKeys).join('、')}`);
    if (detection.inferredReason) lines.push(`后端补充对抗检定：${detection.inferredReason}`);
    if (detection.inferredRequiredReason) lines.push(`后端补充必要检定：${detection.inferredRequiredReason}`);
    if (detection.droppedRequiredChecksForOpposedAction) {
      lines.push(`因对抗优先，丢弃 required_checks ${detection.droppedRequiredChecksForOpposedAction} 个`);
    }
    if (detection.strippedActionSuggestions) lines.push('已删除 AI 回复末尾的行动建议');
    if (detection.strippedDecisiveOutcome) lines.push('已截断检定前不应提前宣布的结果');
  } else if (entry.stage === 'apply-events') {
    lines.push(`执行事件：${eventNames(entry.keys || []).join('、') || '无'}`);
  } else if (entry.stage === 'rejected-events') {
    lines.push(`拒绝事件：${eventNames(entry.rejected || []).join('、') || '无'}`);
  } else if (entry.stage === 'clue-state-updated') {
    lines.push(`线索 ${entry.clueId || '未命名'} 已写入：${(entry.targets || []).join('、') || '无目标'}`);
  } else if (entry.stage === 'npc-state-updated') {
    lines.push(`NPC ${entry.npcName || entry.npcId || '未命名'} 已更新：${[entry.disposition, entry.location, entry.isPresent === false ? '离场' : '在场'].filter(Boolean).join(' · ')}`);
  } else if (entry.stage === 'npc-skill-fallback') {
    lines.push(`${entry.npcName || 'NPC'} 的 ${entry.passiveSkill || '技能'} 无有效数值，使用 ${entry.fallback}`);
  } else if (entry.stage === 'preflight-check') {
    lines.push(`服务器已在 AI 回复前完成${preflightTypeLabel(entry.type)}，避免模型先叙事后补骰。`);
    if (entry.reason) lines.push(`触发来源：${formatPreflightReason(entry.reason)}`);
    if (entry.eventKeys?.length) lines.push(`执行事件：${eventNames(entry.eventKeys).join('、')}`);
    if (entry.actionMessageId) lines.push(`关联行动消息 #${entry.actionMessageId}`);
  } else if (entry.stage === 'preflight-skipped') {
    lines.push(`服务器未执行预检定：${formatPreflightReason(entry.reason)}`);
    if (entry.actionMessageId) lines.push(`关联行动消息 #${entry.actionMessageId}`);
  } else if (entry.error) {
    lines.push(`错误：${entry.error}`);
  }

  if (entry.issues?.length) lines.push(`问题：${entry.issues.join('；')}`);
  if (entry.warnings?.length) lines.push(`提示：${entry.warnings.join('；')}`);
  return lines.length > 0 ? lines : ['无额外摘要'];
}

function isAiLogWarning(entry) {
  return Boolean(entry.rejectedKeys?.length ||
    entry.rejected?.length ||
    entry.error ||
    /failed|skipped|rejected|fallback/.test(entry.stage || ''));
}

function aiLogTaskLabel(taskUid) {
  return taskUid ? `任务 ${String(taskUid).slice(0, 8)}` : '未关联任务';
}

function renderAiLogStageOptions(logs = []) {
  if (!els.aiLogStageFilter) return;
  const selected = els.aiLogStageFilter.value;
  els.aiLogStageFilter.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部';
  els.aiLogStageFilter.append(all);

  const stages = [...new Set(logs.map((entry) => entry.stage).filter(Boolean))]
    .sort((left, right) => (aiLogStageLabels[left] || left).localeCompare(aiLogStageLabels[right] || right, 'zh-Hans-CN'));
  for (const stage of stages) {
    const option = document.createElement('option');
    option.value = stage;
    option.textContent = aiLogStageLabels[stage] || stage;
    els.aiLogStageFilter.append(option);
  }
  els.aiLogStageFilter.value = stages.includes(selected) ? selected : '';
}

function filteredAiLogs() {
  const stage = els.aiLogStageFilter?.value || '';
  const warningsOnly = Boolean(els.aiLogWarningOnly?.checked);
  return state.aiLogEntries.filter((entry) =>
    (!stage || entry.stage === stage) &&
    (!warningsOnly || isAiLogWarning(entry))
  );
}

function uniqueTaskCount(logs = []) {
  return new Set(logs.map((entry) => entry.taskUid || '').filter(Boolean)).size;
}

function renderAiLogStats(logs = filteredAiLogs()) {
  if (!els.aiLogStats) return;
  els.aiLogStats.replaceChildren();
  if (!state.aiLogEntries.length) {
    els.aiLogStats.append(stateChip('日志', '0'));
    return;
  }

  const warnings = state.aiLogEntries.filter(isAiLogWarning).length;
  const taskCount = uniqueTaskCount(state.aiLogEntries);
  const preflightCount = state.aiLogEntries.filter((entry) => entry.stage === 'preflight-check').length;
  const latest = [...state.aiLogEntries]
    .sort((left, right) => new Date(right.time || 0) - new Date(left.time || 0))[0];
  const latestLabel = latest
    ? `${aiLogStageLabels[latest.stage] || latest.stage || '日志'}${formatClock(latest.time) ? ` ${formatClock(latest.time)}` : ''}`
    : '';

  els.aiLogStats.append(
    stateChip('总数', String(state.aiLogEntries.length)),
    stateChip('命中', String(logs.length), logs.length ? 'ok' : ''),
    stateChip('警告', String(warnings), warnings ? 'error' : ''),
    stateChip('任务', String(taskCount))
  );
  if (preflightCount) els.aiLogStats.append(stateChip('预检', String(preflightCount), 'ok'));
  if (latestLabel) els.aiLogStats.append(stateChip('最近', latestLabel));
}

function renderAiLogEntry(entry) {
  const item = document.createElement('article');
  item.className = `ai-log-entry${isAiLogWarning(entry) ? ' warning' : ''}`;

  const head = document.createElement('div');
  head.className = 'ai-log-head';
  const title = document.createElement('strong');
  title.textContent = aiLogStageLabels[entry.stage] || entry.stage || '日志';
  const time = document.createElement('time');
  time.textContent = entry.time ? new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  head.append(title, time);
  item.append(head);

  const chips = document.createElement('div');
  chips.className = 'ai-log-chips';
  if (entry.stage) chips.append(chip(aiLogStageLabels[entry.stage] || entry.stage, 'muted'));
  if (entry.taskUid) chips.append(chip(aiLogTaskLabel(entry.taskUid)));
  for (const key of eventNames(entry.validKeys || entry.keys || [])) chips.append(chip(key, 'ok'));
  for (const key of eventNames(entry.rejectedKeys || entry.rejected || [])) chips.append(chip(`拒绝 ${key}`, 'warn'));
  item.append(chips);

  const summary = document.createElement('div');
  summary.className = 'ai-log-summary';
  for (const line of aiLogSummaryLines(entry)) {
    const row = document.createElement('p');
    row.textContent = line;
    summary.append(row);
  }
  item.append(summary);

  const detection = entry.detection || {};
  const notes = Array.isArray(detection.detectionNotes) ? detection.detectionNotes : [];

  if (notes.length > 0) {
    const list = document.createElement('div');
    list.className = 'ai-log-detections';
    for (const note of notes) {
      const row = document.createElement('div');
      row.className = 'ai-log-detection';
      row.textContent = detectionLine(note);
      list.append(row);
    }
    item.append(list);
  }

  if (entry.rawResponseSnippet) {
    const details = document.createElement('details');
    details.className = 'ai-log-raw';
    const summaryNode = document.createElement('summary');
    summaryNode.textContent = '查看原始回复片段';
    const snippet = document.createElement('pre');
    snippet.className = 'ai-log-snippet';
    snippet.textContent = entry.rawResponseSnippet;
    details.append(summaryNode, snippet);
    item.append(details);
  }

  return item;
}

function renderAiLogEntries() {
  els.aiLogBody.replaceChildren();
  const logs = filteredAiLogs();
  renderAiLogStats(logs);
  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty compact-empty';
    empty.textContent = state.aiLogEntries.length ? '没有匹配的 AI 检测日志' : '暂无 AI 检测日志';
    els.aiLogBody.append(empty);
    return;
  }

  const ordered = [...logs].reverse();
  if (!els.aiLogGroupByTask?.checked) {
    for (const entry of ordered) els.aiLogBody.append(renderAiLogEntry(entry));
    return;
  }

  const groups = new Map();
  for (const entry of ordered) {
    const key = entry.taskUid || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const [taskUid, entries] of groups) {
    const group = document.createElement('section');
    group.className = 'ai-log-task-group';
    const heading = document.createElement('h3');
    heading.className = 'ai-log-task-heading';
    heading.textContent = `${aiLogTaskLabel(taskUid)} · ${entries.length} 条`;
    group.append(heading);
    for (const entry of entries) group.append(renderAiLogEntry(entry));
    els.aiLogBody.append(group);
  }
}

async function openAiLogDialog() {
  if (!state.room || !isOwner()) return;
  els.aiLogBody.textContent = '读取中...';
  els.aiLogStats?.replaceChildren(stateChip('状态', '读取中'));
  els.aiLogDialog.showModal();
  try {
    const payload = await api(`/api/rooms/${state.room.code}/ai-log?playerId=${encodeURIComponent(state.playerId)}`);
    state.aiLogEntries = payload.logs || [];
    renderAiLogStageOptions(state.aiLogEntries);
    renderAiLogEntries();
  } catch (error) {
    state.aiLogEntries = [];
    els.aiLogStats?.replaceChildren(stateChip('状态', '读取失败', 'error'));
    els.aiLogBody.textContent = error.message;
  }
}

function exportFilteredAiLogs() {
  if (!state.room) return;
  const logs = filteredAiLogs();
  const blob = new Blob([JSON.stringify({
    roomCode: state.room.code,
    exportedAt: new Date().toISOString(),
    filters: {
      stage: els.aiLogStageFilter?.value || '',
      warningsOnly: Boolean(els.aiLogWarningOnly?.checked),
      groupByTask: Boolean(els.aiLogGroupByTask?.checked)
    },
    logs
  }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = `dm-online-${state.room.code}-ai-log.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  toast(`已导出 ${logs.length} 条 AI 检测日志`);
}

function exportReplayFixture() {
  if (!state.room || !currentReplayMeta()) return;
  const link = document.createElement('a');
  link.href = `/api/rooms/${state.room.code}/replay-fixture?playerId=${encodeURIComponent(state.playerId)}`;
  link.download = `dm-online-${state.room.code}-fixture.json`;
  link.click();
  toast('正在导出回归用例...');
}

function setConnection(status, text) {
  els.connectionStatus.textContent = text;
  els.connectionDot.className = `status-dot ${status}`;
}

function rememberRoom(room) {
  if (!room) return;
  localStorage.setItem(storageKeys.lastRoomCode, room.code);
  localStorage.setItem(storageKeys.lastRoomName, room.name);
}

function forgetRoom() {
  localStorage.removeItem(storageKeys.lastRoomCode);
  localStorage.removeItem(storageKeys.lastRoomName);
}

function selfFromParticipants(participants) {
  return participants.find((participant) => participant.playerId === state.playerId) || null;
}

function isOwner() {
  return Boolean(state.participant?.isOwner || state.room?.ownerPlayerId === state.playerId);
}

function currentReplayMeta() {
  const meta = state.room?.roomMeta || {};
  const replay = meta.replay || null;
  return replay?.isReplay ? replay : null;
}

function findActiveAiTask(tasks = []) {
  return tasks.find((task) => activeAiStatuses.includes(task.status)) || null;
}

function canSubmitToDm() {
  return Boolean(state.room && state.participant && state.room.status === 'ACTIVE' && !findActiveAiTask(state.aiTasks));
}

function isCheckResultMessage(message) {
  return message?.authorType === 'system' &&
    ['对抗检定', '必要检定'].includes(message.displayName || '');
}

function latestContinuableCheckMessage() {
  const index = [...state.messages].reverse().findIndex(isCheckResultMessage);
  if (index < 0) return null;

  const messageIndex = state.messages.length - 1 - index;
  const laterMessages = state.messages.slice(messageIndex + 1);
  const alreadyContinued = laterMessages.some((message) =>
    message.authorType === 'dm' ||
    (message.authorType === 'player' && message.messageType === 'ACTION')
  );

  if (alreadyContinued) return null;
  return state.messages[messageIndex];
}

function shouldShowContinueAction() {
  return canSubmitToDm() && Boolean(latestContinuableCheckMessage());
}

function syncDisplayNameFromParticipant(participant) {
  if (!participant?.displayName) return;
  state.displayName = participant.displayName;
  localStorage.setItem(storageKeys.displayName, participant.displayName);
  els.createRoomForm.displayName.value = participant.displayName;
  els.joinRoomForm.displayName.value = participant.displayName;
}

function applyRoomPayload(payload) {
  state.room = payload.room;
  state.participants = payload.participants || [];
  state.participant = payload.participant || selfFromParticipants(state.participants) || state.participant;
  syncDisplayNameFromParticipant(state.participant);
  rememberRoom(state.room);
  state.messages = payload.messages || [];
  state.aiTasks = payload.aiTasks || [];
  state.activeAiTask = payload.activeAiTask || findActiveAiTask(state.aiTasks);
  render();
  connectEvents();
}

function renderModules() {
  const current = state.selectedModuleId || els.moduleSelect.value;
  els.moduleSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '先上传或选择模组';
  els.moduleSelect.append(placeholder);
  for (const module of state.modules) {
    const option = document.createElement('option');
    option.value = String(module.id);
    option.textContent = `${module.title} · ${module.parseStatus} · ${module.segmentCount} 段`;
    option.disabled = module.parseStatus !== 'PARSED';
    els.moduleSelect.append(option);
  }
  if (current && state.modules.some((module) => String(module.id) === String(current))) {
    els.moduleSelect.value = String(current);
    state.selectedModuleId = String(current);
  }
}

async function previewModule(moduleId) {
  if (!moduleId) {
    els.modulePreview.textContent = '模组内容仅房主和 AI DM 可见。';
    return;
  }

  try {
    const payload = await api(`/api/modules/${encodeURIComponent(moduleId)}/preview?playerId=${encodeURIComponent(state.playerId)}`);
    const first = payload.segments[0];
    els.modulePreview.textContent = first
      ? `${payload.module.title}：${payload.segments.length} 个片段。预览：${first.scene} - ${first.content.slice(0, 90)}`
      : `${payload.module.title}：暂无可预览片段。`;
  } catch (error) {
    els.modulePreview.textContent = error.message;
  }
}

async function loadModules() {
  try {
    const payload = await api(`/api/modules?playerId=${encodeURIComponent(state.playerId)}`);
    state.modules = payload.modules || [];
    renderModules();
    if (state.selectedModuleId) await previewModule(state.selectedModuleId);
  } catch (error) {
    els.modulePreview.textContent = error.message;
  }
}

function disconnectEvents() {
  if (!state.events) return;
  state.events.close();
  state.events = null;
}

function renderPlayers() {
  els.players.replaceChildren();
  for (const participant of state.participants) {
    const node = document.createElement('div');
    node.className = participant.playerId === state.playerId ? 'player self' : 'player';
    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = participant.characterName || participant.displayName;
    const meta = document.createElement('div');
    meta.className = 'player-meta';
    meta.textContent = [
      participant.characterName ? `${participant.displayName} · 已填写角色` : '未填写角色名',
      participant.isReady ? '已准备' : '未准备'
    ].join(' · ');
    node.append(name, meta);
    els.players.append(node);
  }
}

function renderReplayBanner() {
  if (!els.replayBanner) return;
  const replay = currentReplayMeta();
  const visible = Boolean(state.room && isOwner() && replay);
  els.replayBanner.hidden = !visible;
  if (els.exportReplayFixture) els.exportReplayFixture.hidden = !visible;
  if (!visible) {
    els.replaySource.textContent = '';
    els.replayMeta.replaceChildren();
    return;
  }

  const source = [
    replay.sourceRoomName || '',
    replay.sourceRoomCode ? `#${replay.sourceRoomCode}` : ''
  ].filter(Boolean).join(' ');
  els.replaySource.textContent = source ? `来源 ${source}` : '来源 owner JSON';

  const counts = [
    ['玩家', replay.importedParticipants],
    ['消息', replay.importedMessages],
    ['骰点', replay.importedDiceRolls],
    ['日志', replay.importedAiLogs],
    ['片段', replay.importedModuleSegments]
  ].filter(([, value]) => Number.isFinite(Number(value)));

  els.replayMeta.replaceChildren();
  for (const [label, value] of counts) {
    els.replayMeta.append(stateChip(label, String(value), 'replay-chip'));
  }
  els.replayMeta.append(stateChip('用途', '调试', 'replay-chip'));
}

function messageClass(message) {
  const classes = ['message', message.authorType];
  if (message.messageType) classes.push(message.messageType.toLowerCase());
  if (message.status === 'error') classes.push('error');
  return classes.join(' ');
}

function renderMessages() {
  els.chatLog.replaceChildren();
  if (!state.room) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.textContent = 'D20';
    const title = document.createElement('h3');
    title.textContent = '等待开桌';
    const copy = document.createElement('p');
    copy.textContent = '创建或加入房间后，聊天记录和 AI DM 的回应会出现在这里。';
    empty.append(mark, title, copy);
    els.chatLog.append(empty);
    return;
  }

  if (els.btnCharSheet) {
    els.btnCharSheet.hidden = !state.participant;
    els.chatLog.append(els.btnCharSheet);
  }

  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.textContent = 'D20';
    const title = document.createElement('h3');
    title.textContent = '桌面已准备好';
    const copy = document.createElement('p');
    copy.textContent = '发出第一段行动，AI DM 会接住这一幕。';
    empty.append(mark, title, copy);
    els.chatLog.append(empty);
    return;
  }

  for (const message of state.messages) {
    const node = document.createElement('article');
    node.className = messageClass(message);
    node.dataset.id = message.id;
    const head = document.createElement('div');
    head.className = 'message-head';
    const name = document.createElement('strong');
    name.textContent = message.displayName;
    const type = document.createElement('span');
    type.className = 'message-type';
    type.textContent = messageTypeLabels[message.messageType] || message.messageType || 'IC';
    const time = document.createElement('time');
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    head.append(name, type, time);
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.content;
    node.append(head, body);
    els.chatLog.append(node);
  }

  const checkMessage = shouldShowContinueAction() ? latestContinuableCheckMessage() : null;
  if (checkMessage) {
    const action = document.createElement('div');
    action.className = 'continue-action';
    const button = document.createElement('button');
    button.className = 'primary continue-button';
    button.type = 'button';
    button.dataset.continueFromCheck = String(checkMessage.id);
    button.textContent = '继续叙事';
    action.append(button);
    els.chatLog.append(action);
  }

  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function updateMessageNode(message) {
  const node = els.chatLog.querySelector(`[data-id="${message.id}"]`);
  if (!node) {
    state.messages.push(message);
    renderMessages();
    return;
  }
  node.className = messageClass(message);
  node.querySelector('.message-body').textContent = message.content;
  if (shouldShowContinueAction() && !els.chatLog.querySelector('[data-continue-from-check]')) {
    renderMessages();
    return;
  }
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function weaponLines(weapons = []) {
  return weapons
    .map((weapon) => [weapon.name, weapon.damage, weapon.range].filter(Boolean).join(' | '))
    .join('\n');
}

function parseWeaponLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => {
      const [name = '', damage = '', range = ''] = line.split('|').map((part) => part.trim());
      return { name, damage, range, attacks: '', ammo: '', malfunction: '' };
    });
}

function renderDerived(derived) {
  const cards = [
    ['MOV', derived.mov],
    ['DB', derived.damageBonus],
    ['Build', derived.build]
  ];
  els.derivedGrid.replaceChildren();
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'derived-card';
    const labelNode = document.createElement('span');
    labelNode.textContent = `${label} · ${derivedInfo[label] || ''}`;
    const valueNode = document.createElement('strong');
    valueNode.textContent = String(value);
    card.append(labelNode, valueNode);
    els.derivedGrid.append(card);
  }
}

function renderResourceInputs(sheet, derived) {
  const resources = [
    ['hp', 'HP', derived.hp],
    ['mp', 'MP', derived.mp],
    ['san', 'SAN', 99],
    ['luck', 'Luck', 100]
  ];
  els.resourceGrid.replaceChildren();
  for (const [key, labelText, max] of resources) {
    const label = document.createElement('label');
    label.className = 'resource-input';
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.step = '1';
    input.name = `status.${key}`;
    input.value = sheet.status?.[key] ?? derived[labelText === 'Luck' ? 'luck' : key];
    label.append(span, input);
    els.resourceGrid.append(label);
  }
}

function fullResourceStatus(derived) {
  return {
    hp: derived.hp,
    mp: derived.mp,
    san: derived.san,
    luck: derived.luck
  };
}

function refreshCharacterDerived({ resetResources = false } = {}) {
  const characteristics = readCharacteristics();
  const currentStatus = readStatus();
  const nextDerived = calculateDerived(characteristics, resetResources ? {} : currentStatus);
  const status = resetResources ? fullResourceStatus(nextDerived) : currentStatus;
  renderDerived(nextDerived);
  renderResourceInputs({ status }, nextDerived);
  updateSkillPointsDisplay();
}

function applyCharacteristicValues(values, summary = '', options = {}) {
  for (const [key, value] of Object.entries(values)) {
    const input = els.profileForm.elements[`characteristics.${key}`];
    if (input) input.value = numberInRange(value, defaultCharacteristics[key] || 50, 0, 100);
  }
  if (els.characteristicRollSummary) {
    els.characteristicRollSummary.textContent = summary;
  }
  refreshCharacterDerived(options);
}

function rollAllCharacteristics() {
  const results = characteristicKeys.map((key) => rollCharacteristic(key));
  const values = Object.fromEntries(results.map((result) => [result.key, result.value]));
  applyCharacteristicValues(values, results.map(characteristicRollText).join('；'), { resetResources: true });
  toast('属性已按 CoC 7版规则随机投掷');
}

function resetCharacteristics() {
  applyCharacteristicValues(defaultCharacteristics, '已恢复默认属性 50。', { resetResources: true });
  toast('属性已重置');
}

function renderCharacteristicInputs(sheet) {
  els.characteristicsGrid.replaceChildren();
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  for (const key of characteristicKeys) {
    const info = characteristicInfo[key] || {};
    const label = document.createElement('label');
    label.className = 'stat-input';
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = key;
    const small = document.createElement('small');
    small.textContent = `${info.label || ''} · ${info.formula || ''}`;
    text.append(strong, small);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.name = `characteristics.${key}`;
    input.value = sheet.characteristics?.[key] ?? defaultCharacteristics[key];
    input.addEventListener('input', refreshCharacterDerived);
    label.append(text, input);
    els.characteristicsGrid.append(label);
  }
  if (els.characteristicRollSummary) {
    els.characteristicRollSummary.textContent = 'CoC 7版：STR/CON/DEX/APP/POW/Luck 为 3D6×5；SIZ/INT/EDU 为 (2D6+6)×5。';
  }
  renderDerived(derived);
  renderResourceInputs(sheet, derived);
}

function getOccupationSkills() {
  return occupationSkillsForName(els.occupationSelect.value);
}

function calculateSkillPoints(chars) {
  const edu = numberInRange(chars?.EDU, 50, 0, 100);
  const int = numberInRange(chars?.INT, 50, 0, 100);
  return {
    occupationPoints: edu * 4,
    interestPoints: int * 2
  };
}

function skillInputNumber(input) {
  return numberInRange(input?.value, 0, 0, skillCreationMax);
}

function skillRowValues(row) {
  const base = Number(row.dataset.base || 0);
  const occupation = skillInputNumber(row.querySelector('[data-skill-kind="occupation"]'));
  const interest = skillInputNumber(row.querySelector('[data-skill-kind="interest"]'));
  return { base, occupation, interest, total: Math.min(skillCreationMax, base + occupation + interest) };
}

function updateSkillRowTotal(row) {
  if (!row?.dataset.skillName) return;
  const values = skillRowValues(row);
  row.dataset.total = String(values.total);
  const total = row.querySelector('[data-skill-total]');
  if (total) total.textContent = values.total;
  const overSkill = values.base + values.occupation + values.interest > skillCreationMax;
  row.classList.toggle('skill-over', overSkill);
}

function calculateSkillPointUsage(excludeInput = null) {
  const usage = { usedOcc: 0, usedInt: 0, overSkill: false };
  if (!els.skillsTable) return usage;
  els.skillsTable.querySelectorAll('.skill-row[data-skill-name]').forEach((row) => {
    const base = Number(row.dataset.base || 0);
    const occInput = row.querySelector('[data-skill-kind="occupation"]');
    const intInput = row.querySelector('[data-skill-kind="interest"]');
    const occ = occInput === excludeInput ? 0 : skillInputNumber(occInput);
    const interest = intInput === excludeInput ? 0 : skillInputNumber(intInput);
    usage.usedOcc += occ;
    usage.usedInt += interest;
    if (base + occ + interest > skillCreationMax) usage.overSkill = true;
  });
  return usage;
}

function validateSkillPointBudget() {
  const pools = calculateSkillPoints(readCharacteristics());
  const usage = calculateSkillPointUsage();
  return {
    ...pools,
    ...usage,
    overOcc: usage.usedOcc > pools.occupationPoints,
    overInt: usage.usedInt > pools.interestPoints,
    valid: usage.usedOcc <= pools.occupationPoints &&
      usage.usedInt <= pools.interestPoints &&
      !usage.overSkill
  };
}

function clampSkillAllocation(input) {
  const row = input.closest('.skill-row');
  if (!row) return;

  const kind = input.dataset.skillKind;
  let value = skillInputNumber(input);
  const base = Number(row.dataset.base || 0);
  const values = skillRowValues(row);
  const otherSkillPoints = kind === 'occupation' ? values.interest : values.occupation;
  const usage = calculateSkillPointUsage(input);
  const pools = calculateSkillPoints(readCharacteristics());
  const remainingPool = kind === 'occupation'
    ? pools.occupationPoints - usage.usedOcc
    : pools.interestPoints - usage.usedInt;
  const maxBySkill = Math.max(0, skillCreationMax - base - otherSkillPoints);
  const maxAllowed = Math.max(0, Math.min(maxBySkill, remainingPool));

  if (value > maxAllowed) {
    value = maxAllowed;
    toast(kind === 'occupation' ? '职业技能点不足或技能已达上限' : '兴趣技能点不足或技能已达上限');
  }
  input.value = value;
  updateSkillRowTotal(row);
}

function inferSkillAllocations(sheet, sortedSkills, occSkills) {
  const pools = calculateSkillPoints(sheet.characteristics || {});
  let remainingOcc = pools.occupationPoints;
  const allocations = new Map();

  for (const [name, score] of sortedSkills) {
    const base = defaultSkills[name] || 0;
    const spent = Math.max(0, numberInRange(score, base, 0, skillCreationMax) - base);
    let occupation = 0;
    let interest = spent;
    if (occSkills.includes(name) && remainingOcc > 0) {
      occupation = Math.min(spent, remainingOcc);
      interest = spent - occupation;
      remainingOcc -= occupation;
    }
    allocations.set(name, { occupation, interest });
  }

  return allocations;
}

function normalizeSkillAllocation(allocation, base, score, isOccupationSkill) {
  const maxSpent = Math.max(0, numberInRange(score, base, 0, skillCreationMax) - base);
  let occupation = numberInRange(allocation?.occupation, 0, 0, maxSpent);
  let interest = numberInRange(allocation?.interest, 0, 0, maxSpent);

  if (occupation + interest > maxSpent) {
    interest = Math.max(0, maxSpent - occupation);
    occupation = Math.min(occupation, maxSpent);
  }

  if (!isOccupationSkill && occupation > 0) {
    interest = Math.min(maxSpent, interest + occupation);
    occupation = 0;
  }

  return { occupation, interest };
}

function buildSkillAllocationMap(sheet, sortedSkills, occSkills) {
  const hasSavedAllocations = Boolean(sheet.skillAllocations && typeof sheet.skillAllocations === 'object');
  const inferred = hasSavedAllocations ? new Map() : inferSkillAllocations(sheet, sortedSkills, occSkills);
  const saved = hasSavedAllocations ? sheet.skillAllocations : {};
  const allocations = new Map();

  for (const [name, score] of sortedSkills) {
    const base = defaultSkills[name] || 0;
    const isOccupationSkill = occSkills.includes(name);
    const source = hasSavedAllocations ? (saved[name] || {}) : (inferred.get(name) || {});
    allocations.set(name, normalizeSkillAllocation(source, base, score, isOccupationSkill));
  }

  return allocations;
}

function renderSkills(sheet) {
  if (!els.skillsTable) return;
  els.skillsTable.replaceChildren();
  const occSkills = getOccupationSkills();
  const skills = Object.entries({ ...defaultSkills, ...(sheet.skills || {}) })
    .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'));
  const allocations = buildSkillAllocationMap(sheet, skills, occSkills);

  const header = document.createElement('div');
  header.className = 'skill-row skill-row-header';
  for (const text of ['技能', '初始', '职业+', '兴趣+', '合计']) {
    const cell = document.createElement('span');
    cell.textContent = text;
    header.append(cell);
  }
  els.skillsTable.append(header);

  for (const [name, score] of skills) {
    const isOccSkill = occSkills.includes(name);
    const row = document.createElement('div');
    row.className = 'skill-row' + (isOccSkill ? ' occ-skill' : '');
    const base = defaultSkills[name] || 0;
    const allocation = allocations.get(name) || { occupation: 0, interest: Math.max(0, score - base) };
    row.dataset.skillName = name;
    row.dataset.base = String(base);
    const nameCell = document.createElement('span');
    nameCell.className = 'skill-name';
    nameCell.textContent = (isOccSkill ? '★ ' : '') + name;
    const baseCell = document.createElement('span');
    baseCell.className = 'skill-base';
    baseCell.textContent = String(base);
    const occupationInput = document.createElement('input');
    occupationInput.className = 'skill-add';
    occupationInput.type = 'number';
    occupationInput.min = '0';
    occupationInput.max = String(skillCreationMax);
    occupationInput.step = '1';
    occupationInput.dataset.skillKind = 'occupation';
    occupationInput.disabled = !isOccSkill;
    occupationInput.value = isOccSkill ? allocation.occupation : 0;
    const interestInput = document.createElement('input');
    interestInput.className = 'skill-add';
    interestInput.type = 'number';
    interestInput.min = '0';
    interestInput.max = String(skillCreationMax);
    interestInput.step = '1';
    interestInput.dataset.skillKind = 'interest';
    interestInput.value = allocation.interest;
    const total = document.createElement('strong');
    total.className = 'skill-total';
    total.dataset.skillTotal = '';
    row.append(nameCell, baseCell, occupationInput, interestInput, total);
    row.querySelectorAll('[data-skill-kind]').forEach((input) => {
      input.addEventListener('input', () => {
        clampSkillAllocation(input);
        updateSkillPointsDisplay();
      });
      input.addEventListener('change', () => {
        clampSkillAllocation(input);
        updateSkillPointsDisplay();
      });
    });
    updateSkillRowTotal(row);
    els.skillsTable.append(row);
  }
  updateSkillPointsDisplay();
}

function updateSkillPointsDisplay() {
  if (!els.occPtsRemaining || !els.intPtsRemaining) return;
  const occSkills = getOccupationSkills();
  els.skillsTable?.querySelectorAll('.skill-row[data-skill-name]').forEach(updateSkillRowTotal);
  const status = validateSkillPointBudget();
  els.occPtsRemaining.textContent = occSkills.length > 0
    ? `${status.occupationPoints - status.usedOcc}/${status.occupationPoints}`
    : '--';
  els.intPtsRemaining.textContent = `${status.interestPoints - status.usedInt}/${status.interestPoints}`;
  els.skillPointsDisplay?.classList.toggle('over-limit', !status.valid);
  const saveButton = els.profileForm?.querySelector('button[type="submit"]');
  if (saveButton) saveButton.disabled = !status.valid;
}

function collectSkillsFromTable() {
  const skills = {};
  if (!els.skillsTable) return skills;
  els.skillsTable.querySelectorAll('.skill-row[data-skill-name]').forEach((row) => {
    const values = skillRowValues(row);
    skills[row.dataset.skillName] = numberInRange(values.total, values.base, 0, skillCreationMax);
  });
  return skills;
}

function collectSkillAllocationsFromTable() {
  const allocations = {};
  if (!els.skillsTable) return allocations;
  els.skillsTable.querySelectorAll('.skill-row[data-skill-name]').forEach((row) => {
    const values = skillRowValues(row);
    if (values.occupation > 0 || values.interest > 0) {
      allocations[row.dataset.skillName] = {
        occupation: values.occupation,
        interest: values.interest
      };
    }
  });
  return allocations;
}

function skillRowsForSheet(sheet) {
  const occupationName = matchOccupationTemplate(sheet.investigator?.occupation || '');
  const occSkills = occupationSkillsForName(occupationName);
  const skills = Object.entries({ ...defaultSkills, ...(sheet.skills || {}) })
    .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'));
  const allocations = buildSkillAllocationMap(sheet, skills, occSkills);

  return skills.map(([name, score]) => {
    const base = defaultSkills[name] || 0;
    const allocation = allocations.get(name) || { occupation: 0, interest: 0 };
    const total = numberInRange(score, base, 0, skillCreationMax);
    return {
      name,
      base,
      occupation: allocation.occupation,
      interest: allocation.interest,
      total,
      half: Math.floor(total / 2),
      fifth: Math.floor(total / 5),
      isOccupationSkill: occSkills.includes(name)
    };
  });
}

function skillPointUsageForSheet(sheet, rows = skillRowsForSheet(sheet)) {
  const pools = calculateSkillPoints(sheet.characteristics || {});
  const usedOcc = rows.reduce((sum, row) => sum + row.occupation, 0);
  const usedInt = rows.reduce((sum, row) => sum + row.interest, 0);
  const occupationName = matchOccupationTemplate(sheet.investigator?.occupation || '');
  return {
    ...pools,
    usedOcc,
    usedInt,
    occupationName,
    remainingOcc: pools.occupationPoints - usedOcc,
    remainingInt: pools.interestPoints - usedInt
  };
}

function renderStatusPanel() {
  if (!state.participant) {
    els.statusPanel.hidden = true;
    return;
  }

  const sheet = currentSheet();
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  els.statusPanel.hidden = false;
  els.statusName.textContent = sheet.investigator?.name || state.participant.characterName || '未命名调查员';
  const cards = [
    ['HP', `${derived.currentHp}/${derived.hp}`],
    ['MP', `${derived.currentMp}/${derived.mp}`],
    ['SAN', `${derived.currentSan}/${derived.san}`],
    ['Luck', derived.currentLuck],
    ['MOV', derived.mov],
    ['DB', derived.damageBonus],
    ['Build', derived.build]
  ];
  els.statusCards.replaceChildren();
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'status-card';
    const labelNode = document.createElement('span');
    labelNode.textContent = `${label}${derivedInfo[label] ? ` · ${derivedInfo[label]}` : ''}`;
    const valueNode = document.createElement('strong');
    valueNode.textContent = String(value);
    card.append(labelNode, valueNode);
    els.statusCards.append(card);
  }
  const action = document.createElement('button');
  action.className = 'status-card status-action-card';
  action.type = 'button';
  action.dataset.openSkillAllocations = '';
  const actionLabel = document.createElement('span');
  actionLabel.textContent = '技能加点';
  const actionValue = document.createElement('strong');
  actionValue.textContent = '查看';
  action.append(actionLabel, actionValue);
  els.statusCards.append(action);

  // 角色状态大弹窗
  els.btnCharSheet.hidden = !state.participant;
  renderCharSheetOverlay();
}

function labeledParagraph(label, value) {
  const paragraph = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${label}：`;
  paragraph.append(strong, document.createTextNode(value));
  return paragraph;
}

function appendHeading(container, text) {
  const heading = document.createElement('h3');
  heading.textContent = text;
  container.append(heading);
}

function renderSkillAllocationSummary(usage) {
  const summary = document.createElement('div');
  summary.className = 'skill-allocation-summary';
  const entries = [
    ['职业', usage.occupationName || '自定义'],
    ['职业点', `${usage.remainingOcc}/${usage.occupationPoints}`],
    ['兴趣点', `${usage.remainingInt}/${usage.interestPoints}`]
  ];
  for (const [label, value] of entries) {
    const item = document.createElement('span');
    item.append(document.createTextNode(`${label}：`));
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(strong);
    summary.append(item);
  }
  return summary;
}

function renderSkillAllocationGrid(rows) {
  const grid = document.createElement('div');
  grid.className = 'char-skill-allocation-grid';
  const header = document.createElement('div');
  header.className = 'char-skill-allocation-row allocation-header';
  for (const text of ['技能', '初始', '职业+', '兴趣+', '合计']) {
    const cell = document.createElement('span');
    cell.textContent = text;
    header.append(cell);
  }
  grid.append(header);

  for (const row of rows) {
    const node = document.createElement('div');
    node.className = `char-skill-allocation-row${row.isOccupationSkill ? ' occupation-skill' : ''}`;
    const name = document.createElement('span');
    name.textContent = `${row.isOccupationSkill ? '★ ' : ''}${row.name}`;
    for (const value of [name, row.base, row.occupation, row.interest]) {
      if (value instanceof Node) {
        node.append(value);
      } else {
        const cell = document.createElement('span');
        cell.textContent = String(value);
        node.append(cell);
      }
    }
    const total = document.createElement('strong');
    total.textContent = String(row.total);
    node.append(total);
    grid.append(node);
  }
  return grid;
}

function renderCharSheetOverlay(options = {}) {
  if (!state.participant) return;
  const sheet = currentSheet();
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  const inv = sheet.investigator || {};
  const chars = sheet.characteristics || {};
  const st = sheet.status || {};
  const skillRows = skillRowsForSheet(sheet);
  const skillUsage = skillPointUsageForSheet(sheet, skillRows);

  els.charSheetTitle.textContent = options.focusSkills
    ? `${inv.name || state.participant.characterName || '调查员'} · 技能加点`
    : inv.name || state.participant.characterName || '调查员';

  els.charSheetBody.replaceChildren();
  if (options.focusSkills) {
    const overview = document.createElement('div');
    overview.className = 'char-overview';
    if (inv.occupation) overview.append(labeledParagraph('职业', inv.occupation));
    els.charSheetBody.append(
      overview,
      renderSkillAllocationSummary(skillUsage),
      renderSkillAllocationGrid(skillRows)
    );
    return;
  }

  const overview = document.createElement('div');
  overview.className = 'char-overview';
  if (inv.occupation) overview.append(labeledParagraph('职业', inv.occupation));
  if (inv.age) overview.append(labeledParagraph('年龄', inv.age));
  if (inv.residence) overview.append(labeledParagraph('居住地', inv.residence));

  const stats = document.createElement('div');
  stats.className = 'char-stats-grid';
  for (const key of ['STR','CON','SIZ','DEX','APP','INT','POW','EDU','Luck']) {
    const stat = document.createElement('div');
    stat.className = 'char-stat';
    const label = document.createElement('span');
    label.textContent = characteristicDisplayName(key);
    const value = document.createElement('strong');
    value.textContent = String(chars[key] ?? '-');
    stat.append(label, value);
    stats.append(stat);
  }

  const resources = document.createElement('div');
  resources.className = 'char-resources';
  const resourceRows = [
    ['HP', `${st.hp ?? derived.currentHp}/${derived.hp}`],
    ['MP', `${st.mp ?? derived.currentMp}/${derived.mp}`],
    ['SAN', `${st.san ?? derived.currentSan}/${derived.san}`],
    ['Luck', st.luck ?? derived.currentLuck],
    [`MOV · ${derivedInfo.MOV}`, derived.mov],
    [`DB · ${derivedInfo.DB}`, derived.damageBonus],
    [`Build · ${derivedInfo.Build}`, derived.build]
  ];
  for (const [label, value] of resourceRows) {
    const row = document.createElement('div');
    row.append(document.createTextNode(`${label} `));
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    row.append(strong);
    resources.append(row);
  }

  const skillGrid = document.createElement('div');
  skillGrid.className = 'char-skills-grid';
  for (const row of skillRows) {
    const node = document.createElement('div');
    node.className = 'char-skill-row';
    const name = document.createElement('span');
    name.textContent = row.name;
    const total = document.createElement('strong');
    total.textContent = String(row.total);
    const levels = document.createElement('span');
    levels.className = 'skill-levels';
    levels.textContent = `/ ${row.half} / ${row.fifth}`;
    node.append(name, total, levels);
    skillGrid.append(node);
  }

  els.charSheetBody.append(overview, stats, resources);
  appendHeading(els.charSheetBody, '技能');
  els.charSheetBody.append(renderSkillAllocationSummary(skillUsage), skillGrid);

  if (sheet.weapons?.length) {
    appendHeading(els.charSheetBody, '武器');
    const weapons = document.createElement('div');
    weapons.className = 'char-weapons';
    for (const weapon of sheet.weapons) {
      const row = document.createElement('div');
      row.textContent = [weapon.name, weapon.damage, weapon.range].filter(Boolean).join(' · ');
      weapons.append(row);
    }
    els.charSheetBody.append(weapons);
  }

  for (const [label, value] of [
    ['装备', sheet.equipment],
    ['人际关系', sheet.relationships],
    ['思想与信念', sheet.beliefs]
  ]) {
    if (!value) continue;
    appendHeading(els.charSheetBody, label);
    const paragraph = document.createElement('p');
    paragraph.textContent = value;
    els.charSheetBody.append(paragraph);
  }
}

function setTextField(name, value) {
  const field = els.profileForm.elements[name];
  if (field) field.value = value || '';
}

function readCharacteristics() {
  return Object.fromEntries(characteristicKeys.map((key) => [
    key,
    numberInRange(els.profileForm.elements[`characteristics.${key}`]?.value, defaultCharacteristics[key], 0, 100)
  ]));
}

function readStatus() {
  const derived = calculateDerived(readCharacteristics(), {});
  return {
    hp: numberInRange(els.profileForm.elements['status.hp']?.value, derived.hp, 0, derived.hp),
    mp: numberInRange(els.profileForm.elements['status.mp']?.value, derived.mp, 0, derived.mp),
    san: numberInRange(els.profileForm.elements['status.san']?.value, derived.san, 0, 99),
    luck: numberInRange(els.profileForm.elements['status.luck']?.value, derived.luck, 0, 100)
  };
}

function collectCharacterSheet() {
  const skillBudget = validateSkillPointBudget();
  if (!skillBudget.valid) {
    if (skillBudget.overOcc) throw new Error('职业技能点超过上限，请减少职业加点');
    if (skillBudget.overInt) throw new Error('兴趣技能点超过上限，请减少兴趣加点');
    throw new Error('技能加点超过单项技能上限');
  }

  const existing = currentSheet();
  const characteristics = readCharacteristics();
  const status = readStatus();
  const derived = calculateDerived(characteristics, status);
  const skills = collectSkillsFromTable();
  const skillAllocations = collectSkillAllocationsFromTable();

  const sheet = {
    version: 1,
    ruleset: 'coc7e',
    investigator: {
      name: String(els.profileForm.elements['investigator.name']?.value || '').trim(),
      playerName: state.displayName,
      occupation: String(els.profileForm.elements['investigator.occupation']?.value || '').trim(),
      age: String(els.profileForm.elements['investigator.age']?.value || '').trim(),
      residence: String(els.profileForm.elements['investigator.residence']?.value || '').trim(),
      birthplace: ''
    },
    characteristics,
    status: {
      hp: derived.currentHp,
      mp: derived.currentMp,
      san: derived.currentSan,
      luck: derived.currentLuck
    },
    skills,
    skillAllocations,
    weapons: parseWeaponLines(els.profileForm.elements.weaponsText?.value),
    assets: existing.assets || ''
  };

  for (const field of textSectionFields) {
    sheet[field] = String(els.profileForm.elements[field]?.value || '');
  }

  return sheet;
}

function renderProfile() {
  if (!state.participant) return;
  const sheet = currentSheet();
  const name = sheet.investigator?.name || state.participant.characterName || '';
  els.charCardName.textContent = name || '未创建角色';
  els.charCardStatus.textContent = state.participant.isReady ? '✅ 已准备' : (name ? '⚠ 未准备' : '');
  els.readyCharacter.textContent = state.participant.isReady ? '取消准备' : '准备';
  els.dialogReadyState.textContent = state.participant.isReady ? '已准备' : '未准备';
  renderStatusPanel();
}

function renderProfileForm() {
  if (!state.participant) return toast('无角色数据');
  const sheet = currentSheet();

  try {
    if (!els.occupationSelect) return toast('缺少 #occupationSelect');
    els.occupationSelect.replaceChildren();
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = '自定义';
    els.occupationSelect.append(custom);
    for (const [name] of Object.entries(occupationTemplates)) {
      if (!name) continue;
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      els.occupationSelect.append(opt);
    }
    const currentOcc = sheet.investigator?.occupation || '';
    els.occupationSelect.value = matchOccupationTemplate(currentOcc);
  } catch (e) { return toast('职业下拉失败: ' + e.message); }

  try { setTextField('investigator.name', sheet.investigator?.name || state.participant.characterName || ''); } catch (e) { return toast('name失败: ' + e.message); }
  try { setTextField('investigator.occupation', sheet.investigator?.occupation || ''); } catch (e) { return toast('occupation失败: ' + e.message); }
  try { setTextField('investigator.age', sheet.investigator?.age || ''); } catch (e) { return toast('age失败: ' + e.message); }
  try { setTextField('investigator.residence', sheet.investigator?.residence || ''); } catch (e) { return toast('residence失败: ' + e.message); }
  try { setTextField('weaponsText', weaponLines(sheet.weapons)); } catch (e) { return toast('weapons失败: ' + e.message); }
  for (const field of textSectionFields) {
    try { setTextField(field, sheet[field] || ''); } catch (e) { return toast(field + '失败: ' + e.message); }
  }

  try { renderCharacteristicInputs(sheet); } catch (e) { return toast('属性渲染失败: ' + e.message); }
  try { renderSkills(sheet); } catch (e) { return toast('技能渲染失败: ' + e.message); }
}

// 职业选择变化时重渲染技能
if (els.occupationSelect) {
  els.occupationSelect.addEventListener('change', () => {
    try {
      const occ = els.occupationSelect.value;
      if (occ) {
        const field = els.profileForm?.elements?.['investigator.occupation'];
        if (field) field.value = occ;
      }
      renderSkills({
        ...currentSheet(),
        characteristics: readCharacteristics(),
        skills: collectSkillsFromTable(),
        skillAllocations: collectSkillAllocationsFromTable()
      });
    } catch (e) {
      console.error('occupation change error:', e);
    }
  });
}

function renderLifecycleActions() {
  const owner = isOwner();
  const status = state.room?.status || 'PREPARING';
  const canStart = owner && status === 'PREPARING';
  const canPause = owner && status === 'ACTIVE';
  const canResume = owner && status === 'PAUSED';
  const canEnd = owner && ['PREPARING', 'ACTIVE', 'PAUSED'].includes(status);
  const allReady = state.participants.length > 0 && state.participants.every((participant) => participant.isReady);

  els.startGame.hidden = !canStart;
  els.startGame.disabled = canStart && !allReady;
  els.startGame.title = canStart && !allReady ? '所有玩家保存角色并准备后才能开始' : '';
  els.pauseGame.hidden = !canPause;
  els.resumeGame.hidden = !canResume;
  els.endGame.hidden = !canEnd;
}

function setFormValue(form, name, value) {
  const field = form.elements[name];
  if (!field) return;
  if (field.type === 'checkbox') {
    field.checked = Boolean(value);
  } else {
    field.value = value ?? '';
  }
}

function renderAiConfigForm() {
  const config = state.room?.aiConfig || {};
  setFormValue(els.aiConfigForm, 'dmStyle', config.dmStyle || '');
  setFormValue(els.aiConfigForm, 'narrativeDetail', config.narrativeDetail || 'BALANCED');
  setFormValue(els.aiConfigForm, 'rulesStrictness', config.rulesStrictness || 'STANDARD');
  setFormValue(els.aiConfigForm, 'triggerMode', config.triggerMode || 'ACTION');
  setFormValue(els.aiConfigForm, 'allowModuleExpansion', config.allowModuleExpansion);
  setFormValue(els.aiConfigForm, 'keeperReviewRequired', config.keeperReviewRequired);
  setFormValue(els.aiConfigForm, 'contentBoundaries', config.contentBoundaries || '');
}

function render() {
  const inRoom = Boolean(state.room);
  // 大厅模式居中
  document.querySelector('.shell').classList.toggle('lobby', !inRoom);

  els.entryPanel.hidden = inRoom;
  els.roomPanel.hidden = !inRoom;
  const isPreparing = state.room?.status === 'PREPARING';
  els.characterCard.hidden = !isPreparing;
  els.readyCharacter.hidden = !isPreparing;
  els.tableArea.hidden = !inRoom;
  els.messageForm.hidden = !inRoom;
  els.btnSettings.hidden = !inRoom || !isOwner();

  if (inRoom) {
    els.roomTitle.textContent = state.room.name;
    els.roomStatus.textContent = roomStatusLabels[state.room.status] || state.room.status || '准备阶段';
    els.tableTitle.textContent = state.room.name;
    els.roomCode.textContent = state.room.code;
    els.playerCount.textContent = `${state.participants.length}/${state.room.maxPlayers || 5}`;
    setConnection('online', `房间 ${state.room.code}`);
    els.tableSubtitle.textContent = [
      `${state.participants.length}/${state.room.maxPlayers || 5} 名玩家`,
      `房间码 ${state.room.code}`,
      state.room.moduleTitle ? `模组 ${state.room.moduleTitle}` : ''
    ].filter(Boolean).join(' · ');
  } else {
    els.tableTitle.textContent = '等待开局';
    els.tableSubtitle.textContent = '创建或加入房间后开始记录冒险。';
    els.statusPanel.hidden = true;
    els.btnSettings.hidden = true;
    setConnection('', '未进入房间');
  }

  renderPlayers();
  renderReplayBanner();
  renderLifecycleActions();
  renderAiTaskControls();
  renderMessages();
  renderProfile();
}

function connectEvents() {
  if (!state.room) return;
  disconnectEvents();

  const source = new EventSource(`/api/rooms/${state.room.code}/events?playerId=${encodeURIComponent(state.playerId)}`);
  state.events = source;

  source.addEventListener('connected', async () => {
    setConnection('online', `房间 ${state.room.code}`);
    // 房主在准备阶段且没有 AI 消息时，请求生成剧情简介
    if (isOwner() && state.room.status === 'PREPARING' && !state.messages.some(m => m.authorType === 'dm')) {
      try {
        const payload = await api(`/api/rooms/${state.room.code}/start-intro`, {
          method: 'POST',
          body: JSON.stringify({ playerId: state.playerId })
        });
        if (payload.task) {
          state.aiTasks.push(payload.task);
          state.activeAiTask = findActiveAiTask(state.aiTasks);
          renderAiTaskControls();
        }
      } catch { /* already triggered */ }
    }
  });

  source.addEventListener('room_state', (event) => {
    const payload = JSON.parse(event.data);
    state.room = payload.room;
    state.participants = payload.participants || [];
    state.aiTasks = payload.aiTasks || state.aiTasks;
    state.activeAiTask = payload.activeAiTask || findActiveAiTask(state.aiTasks);
    const self = state.participants.find((participant) => participant.playerId === state.playerId);
    if (self) state.participant = self;
    render();
  });

  source.addEventListener('message_created', (event) => {
    const { message } = JSON.parse(event.data);
    if (!state.messages.some((existing) => existing.id === message.id)) {
      // 流式生成中的消息显示"正在输入"占位
      if (message.authorType === 'dm' && message.status === 'streaming') {
        message.content = '⏳ AI 正在输入中…';
      }
      state.messages.push(message);
      renderMessages();
    }
    if (message.authorType === 'dm' && message.status === 'streaming') setAiBusy(true);
  });

  source.addEventListener('message_delta', (event) => {
    const { id, delta, content } = JSON.parse(event.data);
    const message = state.messages.find((item) => item.id === id);
    if (message) {
      message.content = content ?? `${message.content}${delta || ''}`;
      updateMessageNode(message);
    }
    setAiBusy(true);
  });

  source.addEventListener('message_completed', (event) => {
    const { message } = JSON.parse(event.data);
    const index = state.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) state.messages[index] = message;
    else state.messages.push(message);
    updateMessageNode(message);
    setAiBusy(false);
  });

  source.addEventListener('message_error', (event) => {
    const { message } = JSON.parse(event.data);
    const index = state.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) state.messages[index] = message;
    updateMessageNode(message);
    setAiBusy(false);
    toast('AI 生成失败');
  });

  source.addEventListener('ai_task_updated', (event) => {
    const { task } = JSON.parse(event.data);
    const index = state.aiTasks.findIndex((item) => item.uid === task.uid);
    if (index >= 0) state.aiTasks[index] = task;
    else state.aiTasks.push(task);
    state.aiTasks = state.aiTasks.slice(-20);
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
    renderMessages();
  });

  source.onerror = () => {
    setConnection('reconnecting', '正在重连');
  };
}

// 消息类型固定为 ACTION，所有发言都提交给 AI DM

async function restoreLastRoom() {
  const roomCode = localStorage.getItem(storageKeys.lastRoomCode);
  if (!roomCode) return;

  setConnection('reconnecting', `恢复房间 ${roomCode}`);
  try {
    const payload = await api(`/api/rooms/${encodeURIComponent(roomCode)}?playerId=${encodeURIComponent(state.playerId)}`);
    applyRoomPayload(payload);
    toast(`已恢复房间 ${roomCode}`);
  } catch (error) {
    if (error.status === 403 || error.status === 404) forgetRoom();
    setConnection('', '未进入房间');
  }
}

// 大厅按钮 → 弹窗
els.btnCreateRoom.addEventListener('click', openCreateDialog);
els.btnJoinRoom.addEventListener('click', openJoinDialog);
els.btnSettings.addEventListener('click', openSettingsDialog);
els.btnAiLog.addEventListener('click', openAiLogDialog);
document.querySelector('#closeCreateDialog').addEventListener('click', closeCreateDialog);
document.querySelector('#closeJoinDialog').addEventListener('click', closeJoinDialog);
document.querySelector('#closeSettingsDialog').addEventListener('click', closeSettingsDialog);
document.querySelector('#closeAiLogDialog').addEventListener('click', () => els.aiLogDialog.close());
els.aiLogStageFilter?.addEventListener('change', renderAiLogEntries);
els.aiLogWarningOnly?.addEventListener('change', renderAiLogEntries);
els.aiLogGroupByTask?.addEventListener('change', renderAiLogEntries);
els.exportAiLog?.addEventListener('click', exportFilteredAiLogs);
els.exportReplayFixture?.addEventListener('click', exportReplayFixture);

// 房间码点击复制
els.codeRow.addEventListener('click', async () => {
  if (!state.room?.code) return;
  await navigator.clipboard.writeText(state.room.code).catch(() => undefined);
  toast(`房间码 ${state.room.code} 已复制`);
});

els.moduleSelect.addEventListener('change', async () => {
  state.selectedModuleId = els.moduleSelect.value;
  await previewModule(state.selectedModuleId);
});
els.uploadModule.addEventListener('click', async () => {
  const file = els.moduleFile.files?.[0];
  if (!file) {
    toast('请选择 JSON 模组文件');
    return;
  }
  els.uploadModule.disabled = true;
  els.modulePreview.textContent = '正在上传并解析...';
  try {
    const payload = await uploadModuleFile(file);
    state.selectedModuleId = String(payload.module.id);
    await loadModules();
    await previewModule(state.selectedModuleId);
    toast(payload.module.parseStatus === 'PARSED' ? '模组已解析' : '模组已保存，但解析失败');
  } catch (error) {
    els.modulePreview.textContent = error.message;
    toast(error.message);
  } finally {
    els.uploadModule.disabled = false;
  }
});

els.importPlaytest?.addEventListener('click', async () => {
  const file = els.playtestImportFile?.files?.[0];
  if (!file) {
    toast('请选择 owner 导出的 JSON');
    return;
  }

  const form = new FormData(els.createRoomForm);
  const displayName = String(form.get('displayName') || '').trim();
  if (!displayName) {
    els.importPreview.textContent = '请先填写玩家名。';
    toast('请先填写玩家名');
    return;
  }

  state.displayName = displayName;
  localStorage.setItem(storageKeys.displayName, displayName);
  els.importPlaytest.disabled = true;
  els.importPreview.textContent = '正在导入回放房间...';
  try {
    const payload = await importPlaytestFile(file, {
      displayName,
      roomName: String(form.get('roomName') || '').trim()
    });
    closeCreateDialog();
    applyRoomPayload(payload);
    const summary = payload.importSummary || {};
    els.importPreview.textContent = '从 owner 导出的 dm-online JSON 创建可调试回放房间。';
    toast(`已导入回放：${summary.importedMessages || 0} 条消息`);
  } catch (error) {
    els.importPreview.textContent = error.message;
    toast(error.message);
  } finally {
    els.importPlaytest.disabled = false;
  }
});
// 创建房间表单
els.createRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(els.createRoomForm);
  const displayName = String(form.get('displayName') || '').trim();
  state.displayName = displayName;
  localStorage.setItem(storageKeys.displayName, displayName);

  const moduleId = Number(form.get('moduleId') || state.selectedModuleId);
  if (!Number.isInteger(moduleId) || moduleId <= 0) {
    toast('请先选择已解析的模组');
    return;
  }
  try {
    const payload = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        playerId: state.playerId,
        displayName,
        roomName: String(form.get('roomName') || '').trim(),
        moduleId,
        maxPlayers: Number(form.get('maxPlayers') || 5)
      })
    });
    closeCreateDialog();
    applyRoomPayload(payload);
    toast('房间已创建');
  } catch (error) {
    toast(error.message);
  }
});

// 加入房间表单
els.joinRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(els.joinRoomForm);
  const displayName = String(form.get('displayName') || '').trim();
  state.displayName = displayName;
  localStorage.setItem(storageKeys.displayName, displayName);

  const roomCode = String(form.get('roomCode') || '').trim().toUpperCase();
  try {
    const payload = await api(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerId: state.playerId, displayName })
    });
    closeJoinDialog();
    applyRoomPayload(payload);
    toast('已加入房间');
  } catch (error) {
    toast(error.message);
  }
});

els.profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;

  try {
    const payload = await api(`/api/rooms/${state.room.code}/character`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        displayName: state.displayName,
        characterSheet: collectCharacterSheet()
      })
    });
    state.participant = payload.participant;
    const index = state.participants.findIndex((participant) => participant.playerId === state.playerId);
    if (index >= 0) state.participants[index] = payload.participant;
    els.characterDialog.close();
    renderProfile();
    renderStatusPanel();
    toast('角色已保存');
  } catch (error) {
    toast(error.message);
  }
});

// 角色卡弹窗
els.btnEditCharacter.addEventListener('click', () => {
  try {
    renderProfileForm();
    if (!els.characterDialog) { toast('缺少characterDialog'); return; }
    els.characterDialog.showModal();
  } catch (e) {
    console.error(e);
    toast('打开角色卡失败：' + e.message);
  }
});
document.querySelector('#closeCharacterDialog').addEventListener('click', () => els.characterDialog.close());
els.characterDialog.addEventListener('click', (e) => { if (e.target === els.characterDialog) els.characterDialog.close(); });
els.rollCharacteristics?.addEventListener('click', rollAllCharacteristics);
els.resetCharacteristics?.addEventListener('click', resetCharacteristics);

els.statusCards?.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-open-skill-allocations]');
  if (!trigger) return;
  renderCharSheetOverlay({ focusSkills: true });
  els.charSheetDialog.showModal();
});

async function submitActionToDm(content, { actionId = '' } = {}) {
  if (!state.room) return null;
  setAiBusy(true);
  const payload = await api(`/api/rooms/${state.room.code}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      playerId: state.playerId,
      content,
      messageType: 'ACTION',
      submitToDm: true,
      ...(actionId ? { actionId } : {})
    })
  });

  if (payload.aiTask) {
    const index = state.aiTasks.findIndex((task) => task.uid === payload.aiTask.uid);
    if (index >= 0) state.aiTasks[index] = payload.aiTask;
    else state.aiTasks.push(payload.aiTask);
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
    renderMessages();
  }

  return payload;
}

async function continueAfterCheck(checkMessageId) {
  if (!state.room) return null;
  setAiBusy(true);
  const payload = await api(`/api/rooms/${state.room.code}/continue`, {
    method: 'POST',
    body: JSON.stringify({
      playerId: state.playerId,
      checkMessageId: Number(checkMessageId)
    })
  });

  if (payload.aiTask) {
    const index = state.aiTasks.findIndex((task) => task.uid === payload.aiTask.uid);
    if (index >= 0) state.aiTasks[index] = payload.aiTask;
    else state.aiTasks.push(payload.aiTask);
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
    renderMessages();
  }

  return payload;
}

els.chatLog.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-continue-from-check]');
  if (!button || !canSubmitToDm()) return;

  button.disabled = true;
  try {
    await continueAfterCheck(button.dataset.continueFromCheck);
  } catch (error) {
    setAiBusy(false);
    button.disabled = false;
    toast(error.message);
  }
});

els.readyCharacter.addEventListener('click', async () => {
  if (!state.room || !state.participant) return;
  try {
    const payload = await api(`/api/rooms/${state.room.code}/ready`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        isReady: !state.participant.isReady
      })
    });
    state.participant = payload.participant;
    const index = state.participants.findIndex((participant) => participant.playerId === state.playerId);
    if (index >= 0) state.participants[index] = payload.participant;
    render();
    toast(state.participant.isReady ? '已准备' : '已取消准备');
  } catch (error) {
    toast(error.message);
  }
});

async function rollSkill(skillName) {
  if (!state.room) return;
  try {
    await api(`/api/rooms/${state.room.code}/rolls`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: state.playerId,
        rollType: 'skill',
        skillName,
        label: skillName
      })
    });
  } catch (error) {
    toast(error.message);
  }
}

els.aiConfigForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;
  const form = new FormData(els.aiConfigForm);

  try {
    const payload = await api(`/api/rooms/${state.room.code}/ai-config`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        aiConfig: {
          dmStyle: String(form.get('dmStyle') || ''),
          narrativeDetail: String(form.get('narrativeDetail') || 'BALANCED'),
          rulesStrictness: String(form.get('rulesStrictness') || 'STANDARD'),
          triggerMode: String(form.get('triggerMode') || 'ACTION'),
          allowModuleExpansion: form.get('allowModuleExpansion') === 'on',
          keeperReviewRequired: form.get('keeperReviewRequired') === 'on',
          contentBoundaries: String(form.get('contentBoundaries') || '')
        }
      })
    });
    state.room = payload.room;
    closeSettingsDialog();
    toast('AI 设置已保存');
  } catch (error) {
    toast(error.message);
  }
});

els.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;
  const content = els.messageForm.content.value.trim();
  if (!content) return;

  els.messageForm.content.value = '';

  try {
    await submitActionToDm(content);
  } catch (error) {
    setAiBusy(false);
    toast(error.message);
  }
});

els.messageForm.content.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
  event.preventDefault();
  els.messageForm.requestSubmit();
});

els.cancelAiTask.addEventListener('click', async () => {
  if (!state.room || !els.cancelAiTask.dataset.taskUid) return;
  try {
    const payload = await api(`/api/rooms/${state.room.code}/ai-tasks/${els.cancelAiTask.dataset.taskUid}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ playerId: state.playerId })
    });
    const index = state.aiTasks.findIndex((task) => task.uid === payload.task.uid);
    if (index >= 0) state.aiTasks[index] = payload.task;
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
    toast('AI 任务已取消');
  } catch (error) {
    toast(error.message);
  }
});

els.regenerateAiTask.addEventListener('click', async () => {
  if (!state.room || !els.regenerateAiTask.dataset.taskUid) return;
  try {
    const payload = await api(`/api/rooms/${state.room.code}/ai-tasks/${els.regenerateAiTask.dataset.taskUid}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ playerId: state.playerId })
    });
    state.aiTasks.push(payload.task);
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
    toast('AI 已重新排队');
  } catch (error) {
    toast(error.message);
  }
});

els.rollbackRound.addEventListener('click', async () => {
  if (!state.room) return;
  const rollbackRef = els.rollbackRound.dataset.taskUid;
  if (!rollbackRef) return;
  try {
    await api(`/api/rooms/${state.room.code}/rollback/${encodeURIComponent(rollbackRef)}`, {
      method: 'POST',
      body: JSON.stringify({ playerId: state.playerId })
    });
    toast('已撤回');
  } catch (error) {
    toast(error.message);
  }
});

els.submitRound.addEventListener('click', async () => {
  if (!state.room) return;
  try {
    await api(`/api/rooms/${state.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: state.playerId,
        content: '提交回合行动',
        messageType: 'ACTION',
        submitToDm: true,
        actionId: `round:${Date.now()}`
      })
    });
    toast('回合已提交');
  } catch (error) {
    toast(error.message);
  }
});

els.exportGame.addEventListener('click', async () => {
  if (!state.room) return;
  const format = confirm('导出 JSON？确定=JSON，取消=Markdown') ? 'json' : 'markdown';
  try {
    const link = document.createElement('a');
    link.href = `/api/rooms/${state.room.code}/export?playerId=${encodeURIComponent(state.playerId)}&format=${format}`;
    link.download = `dm-online-${state.room.code}.${format === 'json' ? 'json' : 'md'}`;
    link.click();
    toast(`正在导出 ${format.toUpperCase()}...`);
  } catch (error) {
    toast(error.message);
  }
});

els.leaveRoom.addEventListener('click', async () => {
  if (!state.room) return;
  const isOwnerLeaving = isOwner();
  const confirmed = isOwnerLeaving
    ? confirm('你是房主，离开后房间将自动结束并解散。确定离开？')
    : true;
  if (!confirmed) return;

  try {
    await api(`/api/rooms/${state.room.code}/leave`, {
      method: 'POST',
      body: JSON.stringify({ playerId: state.playerId })
    });
  } catch { /* 即使请求失败也清理本地状态 */ }

  disconnectEvents();
  state.room = null;
  state.participant = null;
  state.participants = [];
  state.messages = [];
  state.aiTasks = [];
  state.activeAiTask = null;
  forgetRoom();
  setAiBusy(false);
  render();
  toast(isOwnerLeaving ? '房间已解散' : '已离开房间');
});

async function changeRoomStatus(status) {
  if (!state.room) return;
  try {
    const payload = await api(`/api/rooms/${state.room.code}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        status
      })
    });
    state.room = payload.room;
    state.participants = payload.participants || state.participants;
    state.aiTasks = payload.aiTasks || state.aiTasks;
    state.activeAiTask = payload.activeAiTask || findActiveAiTask(state.aiTasks);
    if (payload.openingTask && !state.aiTasks.some((task) => task.uid === payload.openingTask.uid)) {
      state.aiTasks.push(payload.openingTask);
      state.activeAiTask = findActiveAiTask(state.aiTasks);
    }
    const self = selfFromParticipants(state.participants);
    if (self) state.participant = self;
    render();
  } catch (error) {
    toast(error.message);
  }
}

els.startGame.addEventListener('click', () => changeRoomStatus('ACTIVE'));
els.pauseGame.addEventListener('click', () => changeRoomStatus('PAUSED'));
els.resumeGame.addEventListener('click', () => changeRoomStatus('ACTIVE'));
els.endGame.addEventListener('click', () => changeRoomStatus('ENDED'));

render();
loadModules();
restoreLastRoom();

// 点击弹窗背景关闭
els.createRoomDialog.addEventListener('click', (e) => { if (e.target === els.createRoomDialog) closeCreateDialog(); });
els.joinRoomDialog.addEventListener('click', (e) => { if (e.target === els.joinRoomDialog) closeJoinDialog(); });
els.settingsDialog.addEventListener('click', (e) => { if (e.target === els.settingsDialog) closeSettingsDialog(); });
els.aiLogDialog.addEventListener('click', (e) => { if (e.target === els.aiLogDialog) els.aiLogDialog.close(); });

// 角色状态弹窗
els.btnCharSheet.addEventListener('click', () => {
  renderCharSheetOverlay();
  els.charSheetDialog.showModal();
});
document.querySelector('#closeCharSheet').addEventListener('click', () => els.charSheetDialog.close());
els.charSheetDialog.addEventListener('click', (e) => { if (e.target === els.charSheetDialog) els.charSheetDialog.close(); });
