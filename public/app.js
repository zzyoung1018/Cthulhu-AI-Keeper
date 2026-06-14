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
  // 房间面板
  roomPanel: document.querySelector('#roomPanel'),
  roomTitle: document.querySelector('#roomTitle'),
  roomStatus: document.querySelector('#roomStatus'),
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
  editorPanel: document.querySelector('#editorPanel'),
  profileForm: document.querySelector('#profileForm'),
  characteristicsGrid: document.querySelector('#characteristicsGrid'),
  derivedGrid: document.querySelector('#derivedGrid'),
  resourceGrid: document.querySelector('#resourceGrid'),
  skillsTable: document.querySelector('#skillsTable'),
  readyCharacter: document.querySelector('#readyCharacter'),
  readyState: document.querySelector('#readyState'),
  // 状态面板
  statusPanel: document.querySelector('#statusPanel'),
  statusName: document.querySelector('#statusName'),
  statusCards: document.querySelector('#statusCards'),
  // 角色状态弹窗
  btnCharSheet: document.querySelector('#btnCharSheet'),
  charSheetDialog: document.querySelector('#charSheetDialog'),
  charSheetTitle: document.querySelector('#charSheetTitle'),
  charSheetBody: document.querySelector('#charSheetBody'),
  // 摘要
  summaryForm: document.querySelector('#summaryForm'),
  summaryPanel: document.querySelector('#summaryPanel'),
  summaryInput: document.querySelector('#summaryInput'),
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
  cancelAiTask: document.querySelector('#cancelAiTask'),
  regenerateAiTask: document.querySelector('#regenerateAiTask'),
  rollbackRound: document.querySelector('#rollbackRound'),
  submitRound: document.querySelector('#submitRound'),
  exportGame: document.querySelector('#exportGame'),
  // 私聊
  privateTargetRow: document.querySelector('#privateTargetRow'),
  privateTargetSelect: document.querySelector('#privateTargetSelect'),
  // 消息类型
  typeOptions: [...document.querySelectorAll('[data-message-type]')],
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

const activeAiStatuses = ['QUEUED', 'RETRIEVING', 'GENERATING', 'STREAMING', 'VALIDATING'];

const characteristicKeys = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'Luck'];

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
  历史: 5,
  恐吓: 15,
  跳跃: 20,
  母语: 50,
  法律: 5,
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
  侦查: 25,
  潜行: 20,
  游泳: 20,
  投掷: 20,
  追踪: 10
};

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

function latestFinishedAiTask() {
  return [...state.aiTasks].reverse().find((task) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) || null;
}

function renderAiTaskControls() {
  const activeTask = state.activeAiTask || findActiveAiTask(state.aiTasks);
  state.activeAiTask = activeTask;
  const busy = Boolean(activeTask);
  const label = activeTask ? aiTaskLabels[activeTask.status] || activeTask.status : 'AI 待命';
  els.aiPill.classList.toggle('busy', busy);
  els.aiPill.textContent = activeTask ? `${label} · ${activeTask.uid.slice(0, 8)}` : label;

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

  // Export always visible when in room
  els.exportGame.hidden = !state.room;
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

function findActiveAiTask(tasks = []) {
  return tasks.find((task) => activeAiStatuses.includes(task.status)) || null;
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
  els.moduleSelect.innerHTML = '<option value="">先上传或选择模组</option>';
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
  els.players.innerHTML = '';
  for (const participant of state.participants) {
    const node = document.createElement('div');
    node.className = participant.playerId === state.playerId ? 'player self' : 'player';
    node.innerHTML = `
      <div class="player-name"></div>
      <div class="player-meta"></div>
    `;
    node.querySelector('.player-name').textContent = participant.characterName || participant.displayName;
    node.querySelector('.player-meta').textContent = [
      participant.characterName ? `${participant.displayName} · 已填写角色` : '未填写角色名',
      participant.isReady ? '已准备' : '未准备'
    ].join(' · ');
    els.players.append(node);
  }
}

function messageClass(message) {
  const classes = ['message', message.authorType];
  if (message.messageType) classes.push(message.messageType.toLowerCase());
  if (message.status === 'error') classes.push('error');
  return classes.join(' ');
}

function renderMessages() {
  els.chatLog.innerHTML = '';
  if (!state.room) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <div class="empty-mark">D20</div>
      <h3>等待开桌</h3>
      <p>创建或加入房间后，聊天记录和 AI DM 的回应会出现在这里。</p>
    `;
    els.chatLog.append(empty);
    return;
  }

  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <div class="empty-mark">D20</div>
      <h3>桌面已准备好</h3>
      <p>发出第一段行动，AI DM 会接住这一幕。</p>
    `;
    els.chatLog.append(empty);
    return;
  }

  for (const message of state.messages) {
    const node = document.createElement('article');
    node.className = messageClass(message);
    node.dataset.id = message.id;
    node.innerHTML = `
      <div class="message-head">
        <strong></strong>
        <span class="message-type"></span>
        <time></time>
      </div>
      <div class="message-body"></div>
    `;
    node.querySelector('strong').textContent = message.displayName;
    node.querySelector('.message-type').textContent = messageTypeLabels[message.messageType] || message.messageType || 'IC';
    node.querySelector('time').textContent = new Date(message.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    node.querySelector('.message-body').textContent = message.content;
    els.chatLog.append(node);
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
  els.derivedGrid.innerHTML = cards.map(([label, value]) => `
    <div class="derived-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderResourceInputs(sheet, derived) {
  const resources = [
    ['hp', 'HP', derived.hp],
    ['mp', 'MP', derived.mp],
    ['san', 'SAN', 99],
    ['luck', 'Luck', 100]
  ];
  els.resourceGrid.innerHTML = '';
  for (const [key, labelText, max] of resources) {
    const label = document.createElement('label');
    label.className = 'resource-input';
    label.innerHTML = `
      <span>${labelText}</span>
      <input type="number" min="0" max="${max}" step="1" name="status.${key}">
    `;
    label.querySelector('input').value = sheet.status?.[key] ?? derived[labelText === 'Luck' ? 'luck' : key];
    els.resourceGrid.append(label);
  }
}

function renderCharacteristicInputs(sheet) {
  els.characteristicsGrid.innerHTML = '';
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  for (const key of characteristicKeys) {
    const label = document.createElement('label');
    label.className = 'stat-input';
    label.innerHTML = `
      <span>${key}</span>
      <input type="number" min="0" max="100" step="1" name="characteristics.${key}">
    `;
    label.querySelector('input').value = sheet.characteristics?.[key] ?? defaultCharacteristics[key];
    label.querySelector('input').addEventListener('input', () => {
      const nextDerived = calculateDerived(readCharacteristics(), readStatus());
      renderDerived(nextDerived);
      renderResourceInputs({ status: readStatus() }, nextDerived);
    });
    els.characteristicsGrid.append(label);
  }
  renderDerived(derived);
  renderResourceInputs(sheet, derived);
}

function renderSkills(sheet) {
  els.skillsTable.innerHTML = '';
  const skills = Object.entries({ ...defaultSkills, ...(sheet.skills || {}) })
    .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'));
  for (const [name, score] of skills) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.innerHTML = `
      <span class="skill-name"></span>
      <input type="number" min="0" max="100" step="1" data-skill-name="">
      <button class="ghost skill-roll" type="button" title="技能检定">检定</button>
    `;
    row.querySelector('.skill-name').textContent = name;
    const input = row.querySelector('input');
    input.dataset.skillName = name;
    input.value = score;
    row.querySelector('button').addEventListener('click', () => rollSkill(name));
    els.skillsTable.append(row);
  }
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
    ['Build', derived.build],
    ['准备', state.participant.isReady ? '是' : '否']
  ];
  els.statusCards.innerHTML = cards.map(([label, value]) => `
    <div class="status-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');

  // 角色状态大弹窗
  els.btnCharSheet.hidden = !state.participant;
  renderCharSheetOverlay();
}

function renderCharSheetOverlay() {
  if (!state.participant) return;
  const sheet = currentSheet();
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  const inv = sheet.investigator || {};
  const chars = sheet.characteristics || {};
  const st = sheet.status || {};
  const skills = Object.entries(sheet.skills || {}).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));

  els.charSheetTitle.textContent = inv.name || state.participant.characterName || '调查员';

  const html = [
    '<div class="char-overview">',
    inv.occupation ? `<p><strong>职业：</strong>${inv.occupation}</p>` : '',
    inv.age ? `<p><strong>年龄：</strong>${inv.age}</p>` : '',
    inv.residence ? `<p><strong>居住地：</strong>${inv.residence}</p>` : '',
    '</div>',
    '<div class="char-stats-grid">',
    ...['STR','CON','SIZ','DEX','APP','INT','POW','EDU','Luck'].map(k =>
      `<div class="char-stat"><span>${k}</span><strong>${chars[k] ?? '-'}</strong></div>`
    ),
    '</div>',
    '<div class="char-resources">',
    `<div>HP <strong>${st.hp ?? derived.currentHp}/${derived.hp}</strong></div>`,
    `<div>MP <strong>${st.mp ?? derived.currentMp}/${derived.mp}</strong></div>`,
    `<div>SAN <strong>${st.san ?? derived.currentSan}/${derived.san}</strong></div>`,
    `<div>Luck <strong>${st.luck ?? derived.currentLuck}</strong></div>`,
    `<div>MOV <strong>${derived.mov}</strong></div>`,
    `<div>DB <strong>${derived.damageBonus}</strong></div>`,
    `<div>Build <strong>${derived.build}</strong></div>`,
    '</div>',
    '<h3>技能</h3>',
    '<div class="char-skills-grid">',
    ...skills.map(([name, val]) => {
      const half = Math.floor((chars[name] || derived[name] || 50) / 2);
      const fifth = Math.floor((chars[name] || derived[name] || 50) / 5);
      return `<div class="char-skill-row"><span>${name}</span><strong>${val}</strong><span class="skill-levels">/ ${half} / ${fifth}</span></div>`;
    }),
    '</div>',
    sheet.weapons?.length ? `<h3>武器</h3><div class="char-weapons">${sheet.weapons.map(w => `<div>${w.name} · ${w.damage}${w.range ? ' · '+w.range : ''}</div>`).join('')}</div>` : '',
    sheet.equipment ? `<h3>装备</h3><p>${sheet.equipment}</p>` : '',
    sheet.relationships ? `<h3>人际关系</h3><p>${sheet.relationships}</p>` : '',
    sheet.beliefs ? `<h3>思想与信念</h3><p>${sheet.beliefs}</p>` : '',
  ].join('\n');

  els.charSheetBody.innerHTML = html;
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
  const existing = currentSheet();
  const characteristics = readCharacteristics();
  const status = readStatus();
  const derived = calculateDerived(characteristics, status);
  const skills = {};
  els.skillsTable.querySelectorAll('[data-skill-name]').forEach((input) => {
    skills[input.dataset.skillName] = numberInRange(input.value, 0, 0, 100);
  });

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
  setTextField('investigator.name', sheet.investigator?.name || state.participant.characterName || '');
  setTextField('investigator.occupation', sheet.investigator?.occupation || '');
  setTextField('investigator.age', sheet.investigator?.age || '');
  setTextField('investigator.residence', sheet.investigator?.residence || '');
  setTextField('weaponsText', weaponLines(sheet.weapons));
  for (const field of textSectionFields) setTextField(field, sheet[field] || '');
  renderCharacteristicInputs(sheet);
  renderSkills(sheet);
  els.readyState.textContent = state.participant.isReady ? '已准备' : '未准备';
  els.readyCharacter.textContent = state.participant.isReady ? '取消准备' : '准备';
  renderStatusPanel();
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
  els.editorPanel.hidden = !inRoom;
  els.tableArea.hidden = !inRoom;
  els.summaryPanel.hidden = true;
  els.messageForm.hidden = !inRoom;
  els.btnSettings.hidden = !inRoom || !isOwner();

  if (inRoom) {
    els.summaryPanel.hidden = false;
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
    els.summaryInput.value = state.room.summary || '';
  } else {
    els.tableTitle.textContent = '等待开局';
    els.tableSubtitle.textContent = '创建或加入房间后开始记录冒险。';
    els.statusPanel.hidden = true;
    els.btnSettings.hidden = true;
    setConnection('', '未进入房间');
  }

  renderPlayers();
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

  source.addEventListener('connected', () => {
    setConnection('online', `房间 ${state.room.code}`);
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
    updateMessageNode(message);
    setAiBusy(false);
  });

  source.addEventListener('ai_task_updated', (event) => {
    const { task } = JSON.parse(event.data);
    const index = state.aiTasks.findIndex((item) => item.uid === task.uid);
    if (index >= 0) state.aiTasks[index] = task;
    else state.aiTasks.push(task);
    state.aiTasks = state.aiTasks.slice(-20);
    state.activeAiTask = findActiveAiTask(state.aiTasks);
    renderAiTaskControls();
  });

  source.addEventListener('message_error', (event) => {
    const { message } = JSON.parse(event.data);
    const index = state.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) state.messages[index] = message;
    updateMessageNode(message);
    setAiBusy(false);
    toast('AI 生成失败');
  });

  source.onerror = () => {
    setConnection('reconnecting', '正在重连');
  };
}

function setMessageType(messageType) {
  state.messageType = messageType;
  for (const option of els.typeOptions) {
    option.classList.toggle('active', option.dataset.messageType === messageType);
  }
  els.privateTargetRow.hidden = messageType !== 'PRIVATE';
  if (messageType === 'PRIVATE') {
    updatePrivateTargetOptions();
  }
  els.messageForm.content.placeholder = messageType === 'ACTION'
    ? '声明正式行动，提交给 AI DM...'
    : messageType === 'PRIVATE'
      ? '私密消息，仅你和目标玩家可见...'
      : messageType === 'OOC'
        ? '场外讨论，不触发 AI...'
        : '角色内发言，不自动触发 AI...';
}

function updatePrivateTargetOptions() {
  els.privateTargetSelect.innerHTML = '<option value="">选择私聊对象</option>';
  for (const p of state.participants) {
    if (p.playerId === state.playerId) continue;
    const option = document.createElement('option');
    option.value = p.playerId;
    option.textContent = p.characterName || p.displayName;
    els.privateTargetSelect.append(option);
  }
}

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
document.querySelector('#closeCreateDialog').addEventListener('click', closeCreateDialog);
document.querySelector('#closeJoinDialog').addEventListener('click', closeJoinDialog);
document.querySelector('#closeSettingsDialog').addEventListener('click', closeSettingsDialog);

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
    toast('请选择模组文件（TXT/PDF/DOCX/JSON）');
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
els.typeOptions.forEach((option) => {
  option.addEventListener('click', () => setMessageType(option.dataset.messageType));
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
    render();
    toast('角色已保存');
  } catch (error) {
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

els.summaryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;

  try {
    await api(`/api/rooms/${state.room.code}/summary`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        summary: els.summaryInput.value
      })
    });
    toast('摘要已保存');
  } catch (error) {
    toast(error.message);
  }
});

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
  const shouldTriggerAi = state.messageType === 'ACTION';
  if (shouldTriggerAi) setAiBusy(true);

  const body = {
    playerId: state.playerId,
    content,
    messageType: state.messageType,
    submitToDm: shouldTriggerAi
  };

  if (state.messageType === 'PRIVATE') {
    body.privateTarget = els.privateTargetSelect.value;
  }

  try {
    const payload = await api(`/api/rooms/${state.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (payload.aiTask) {
      const index = state.aiTasks.findIndex((task) => task.uid === payload.aiTask.uid);
      if (index >= 0) state.aiTasks[index] = payload.aiTask;
      else state.aiTasks.push(payload.aiTask);
      state.activeAiTask = findActiveAiTask(state.aiTasks);
      renderAiTaskControls();
    }
  } catch (error) {
    if (shouldTriggerAi) setAiBusy(false);
    toast(error.message);
  }
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
  const roundId = els.rollbackRound.dataset.taskUid;
  if (!roundId) return;
  try {
    await api(`/api/rooms/${state.room.code}/rollback/${encodeURIComponent(roundId)}`, {
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
setMessageType('IC');
loadModules();
restoreLastRoom();

// 点击弹窗背景关闭
els.createRoomDialog.addEventListener('click', (e) => { if (e.target === els.createRoomDialog) closeCreateDialog(); });
els.joinRoomDialog.addEventListener('click', (e) => { if (e.target === els.joinRoomDialog) closeJoinDialog(); });
els.settingsDialog.addEventListener('click', (e) => { if (e.target === els.settingsDialog) closeSettingsDialog(); });

// 角色状态弹窗
els.btnCharSheet.addEventListener('click', () => {
  renderCharSheetOverlay();
  els.charSheetDialog.showModal();
});
document.querySelector('#closeCharSheet').addEventListener('click', () => els.charSheetDialog.close());
els.charSheetDialog.addEventListener('click', (e) => { if (e.target === els.charSheetDialog) els.charSheetDialog.close(); });
