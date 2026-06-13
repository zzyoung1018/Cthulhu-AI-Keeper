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
  events: null
};

localStorage.setItem(storageKeys.playerId, state.playerId);

const els = {
  createTab: document.querySelector('#createTab'),
  joinTab: document.querySelector('#joinTab'),
  roomForm: document.querySelector('#roomForm'),
  roomNameField: document.querySelector('#roomNameField'),
  moduleField: document.querySelector('#moduleField'),
  moduleSelect: document.querySelector('#moduleSelect'),
  moduleFile: document.querySelector('#moduleFile'),
  uploadModule: document.querySelector('#uploadModule'),
  modulePreview: document.querySelector('#modulePreview'),
  roomCodeField: document.querySelector('#roomCodeField'),
  entryPanel: document.querySelector('#entryPanel'),
  roomPanel: document.querySelector('#roomPanel'),
  editorPanel: document.querySelector('#editorPanel'),
  profileForm: document.querySelector('#profileForm'),
  characteristicsGrid: document.querySelector('#characteristicsGrid'),
  derivedGrid: document.querySelector('#derivedGrid'),
  resourceGrid: document.querySelector('#resourceGrid'),
  skillsTable: document.querySelector('#skillsTable'),
  readyCharacter: document.querySelector('#readyCharacter'),
  readyState: document.querySelector('#readyState'),
  statusPanel: document.querySelector('#statusPanel'),
  statusName: document.querySelector('#statusName'),
  statusCards: document.querySelector('#statusCards'),
  summaryForm: document.querySelector('#summaryForm'),
  summaryPanel: document.querySelector('#summaryPanel'),
  summaryInput: document.querySelector('#summaryInput'),
  roomTitle: document.querySelector('#roomTitle'),
  roomStatus: document.querySelector('#roomStatus'),
  tableTitle: document.querySelector('#tableTitle'),
  roomCode: document.querySelector('#roomCode'),
  playerCount: document.querySelector('#playerCount'),
  players: document.querySelector('#players'),
  chatLog: document.querySelector('#chatLog'),
  messageForm: document.querySelector('#messageForm'),
  connectionStatus: document.querySelector('#connectionStatus'),
  connectionDot: document.querySelector('#connectionDot'),
  tableSubtitle: document.querySelector('#tableSubtitle'),
  aiPill: document.querySelector('#aiPill'),
  copyRoomCode: document.querySelector('#copyRoomCode'),
  leaveRoom: document.querySelector('#leaveRoom'),
  startGame: document.querySelector('#startGame'),
  pauseGame: document.querySelector('#pauseGame'),
  resumeGame: document.querySelector('#resumeGame'),
  endGame: document.querySelector('#endGame'),
  typeOptions: [...document.querySelectorAll('[data-message-type]')],
  toast: document.querySelector('#toast')
};

els.roomForm.displayName.value = state.displayName;

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

function setMode(mode) {
  state.mode = mode;
  els.createTab.classList.toggle('active', mode === 'create');
  els.joinTab.classList.toggle('active', mode === 'join');
  els.roomNameField.hidden = mode !== 'create';
  els.moduleField.hidden = mode !== 'create';
  els.roomCodeField.hidden = mode !== 'join';
  els.moduleSelect.required = mode === 'create';
  els.roomForm.roomCode.required = mode === 'join';
}

function setAiBusy(isBusy) {
  els.aiPill.classList.toggle('busy', isBusy);
  els.aiPill.textContent = isBusy ? 'AI 正在写下一幕' : 'AI 待命';
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

function syncDisplayNameFromParticipant(participant) {
  if (!participant?.displayName) return;
  state.displayName = participant.displayName;
  localStorage.setItem(storageKeys.displayName, participant.displayName);
  els.roomForm.displayName.value = participant.displayName;
}

function applyRoomPayload(payload) {
  state.room = payload.room;
  state.participants = payload.participants || [];
  state.participant = payload.participant || selfFromParticipants(state.participants) || state.participant;
  syncDisplayNameFromParticipant(state.participant);
  rememberRoom(state.room);
  state.messages = payload.messages || [];
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

function render() {
  const inRoom = Boolean(state.room);
  els.entryPanel.hidden = inRoom;
  els.roomPanel.hidden = !inRoom;
  els.editorPanel.hidden = !inRoom;
  els.summaryPanel.hidden = !inRoom;
  els.messageForm.hidden = !inRoom;

  if (inRoom) {
    els.roomTitle.textContent = state.room.name;
    els.roomStatus.textContent = roomStatusLabels[state.room.status] || state.room.status || '准备阶段';
    els.tableTitle.textContent = state.room.name;
    els.roomCode.textContent = state.room.code;
    els.playerCount.textContent = `${state.participants.length}/5`;
    setConnection('online', `房间 ${state.room.code}`);
    els.tableSubtitle.textContent = [
      `${state.participants.length}/5 名玩家`,
      `房间码 ${state.room.code}`,
      state.room.moduleTitle ? `模组 ${state.room.moduleTitle}` : ''
    ].filter(Boolean).join(' · ');
    els.summaryInput.value = state.room.summary || '';
  } else {
    els.tableTitle.textContent = '等待开局';
    els.tableSubtitle.textContent = '创建或加入房间后开始记录冒险。';
    els.statusPanel.hidden = true;
    setConnection('', '未进入房间');
  }

  renderPlayers();
  renderLifecycleActions();
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
  els.messageForm.content.placeholder = messageType === 'ACTION'
    ? '声明正式行动，提交给 AI DM...'
    : messageType === 'OOC'
      ? '场外讨论，不触发 AI...'
      : '角色内发言，不自动触发 AI...';
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

els.createTab.addEventListener('click', () => setMode('create'));
els.joinTab.addEventListener('click', () => setMode('join'));
els.moduleSelect.addEventListener('change', async () => {
  state.selectedModuleId = els.moduleSelect.value;
  await previewModule(state.selectedModuleId);
});
els.uploadModule.addEventListener('click', async () => {
  const file = els.moduleFile.files?.[0];
  if (!file) {
    toast('请选择 TXT、PDF 或 DOCX 模组');
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

els.roomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(els.roomForm);
  const displayName = String(form.get('displayName') || '').trim();
  state.displayName = displayName;
  localStorage.setItem(storageKeys.displayName, displayName);

  try {
    if (state.mode === 'create') {
      const moduleId = Number(form.get('moduleId') || state.selectedModuleId);
      if (!Number.isInteger(moduleId) || moduleId <= 0) {
        toast('请先选择已解析的模组');
        return;
      }
      const payload = await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          playerId: state.playerId,
          displayName,
          roomName: String(form.get('roomName') || '').trim(),
          moduleId
        })
      });
      applyRoomPayload(payload);
      toast('房间已创建');
    } else {
      const roomCode = String(form.get('roomCode') || '').trim().toUpperCase();
      const payload = await api(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
        method: 'POST',
        body: JSON.stringify({ playerId: state.playerId, displayName })
      });
      applyRoomPayload(payload);
      toast('已加入房间');
    }
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

els.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;
  const content = els.messageForm.content.value.trim();
  if (!content) return;

  els.messageForm.content.value = '';
  const shouldTriggerAi = state.messageType === 'ACTION';
  if (shouldTriggerAi) setAiBusy(true);

  try {
    await api(`/api/rooms/${state.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: state.playerId,
        content,
        messageType: state.messageType,
        submitToDm: shouldTriggerAi
      })
    });
  } catch (error) {
    if (shouldTriggerAi) setAiBusy(false);
    toast(error.message);
  }
});

els.copyRoomCode.addEventListener('click', async () => {
  if (!state.room) return;
  await navigator.clipboard.writeText(state.room.code).catch(() => undefined);
  toast('房间码已复制');
});

els.leaveRoom.addEventListener('click', () => {
  disconnectEvents();
  state.room = null;
  state.participant = null;
  state.participants = [];
  state.messages = [];
  forgetRoom();
  setAiBusy(false);
  render();
  toast('已离开房间');
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
