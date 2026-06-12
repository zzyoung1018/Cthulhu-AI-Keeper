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
  roomCodeField: document.querySelector('#roomCodeField'),
  entryPanel: document.querySelector('#entryPanel'),
  roomPanel: document.querySelector('#roomPanel'),
  editorPanel: document.querySelector('#editorPanel'),
  profileForm: document.querySelector('#profileForm'),
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

function setMode(mode) {
  state.mode = mode;
  els.createTab.classList.toggle('active', mode === 'create');
  els.joinTab.classList.toggle('active', mode === 'join');
  els.roomNameField.hidden = mode !== 'create';
  els.roomCodeField.hidden = mode !== 'join';
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
    node.querySelector('.player-meta').textContent = participant.characterName
      ? `${participant.displayName} · 已填写角色`
      : '未填写角色名';
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

function renderProfile() {
  if (!state.participant) return;
  els.profileForm.characterName.value = state.participant.characterName || '';
  els.profileForm.characterCard.value = state.participant.characterCard || '';
  els.profileForm.state.value = state.participant.state || '';
}

function renderLifecycleActions() {
  const owner = isOwner();
  const status = state.room?.status || 'PREPARING';
  const canStart = owner && status === 'PREPARING';
  const canPause = owner && status === 'ACTIVE';
  const canResume = owner && status === 'PAUSED';
  const canEnd = owner && ['PREPARING', 'ACTIVE', 'PAUSED'].includes(status);

  els.startGame.hidden = !canStart;
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
    els.tableSubtitle.textContent = `${state.participants.length}/5 名玩家 · 房间码 ${state.room.code}`;
    els.summaryInput.value = state.room.summary || '';
  } else {
    els.tableTitle.textContent = '等待开局';
    els.tableSubtitle.textContent = '创建或加入房间后开始记录冒险。';
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
      const payload = await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          playerId: state.playerId,
          displayName,
          roomName: String(form.get('roomName') || '').trim()
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
  const form = new FormData(els.profileForm);

  try {
    const payload = await api(`/api/rooms/${state.room.code}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: state.playerId,
        displayName: state.displayName,
        characterName: String(form.get('characterName') || ''),
        characterCard: String(form.get('characterCard') || ''),
        state: String(form.get('state') || '')
      })
    });
    state.participant = payload.participant;
    toast('角色已保存');
  } catch (error) {
    toast(error.message);
  }
});

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
restoreLastRoom();
