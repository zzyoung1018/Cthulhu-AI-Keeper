const state = {
  mode: 'create',
  playerId: localStorage.getItem('dm-online-player-id') || crypto.randomUUID(),
  displayName: localStorage.getItem('dm-online-display-name') || '',
  room: null,
  participant: null,
  participants: [],
  messages: [],
  events: null
};

localStorage.setItem('dm-online-player-id', state.playerId);

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
  tableTitle: document.querySelector('#tableTitle'),
  roomCode: document.querySelector('#roomCode'),
  playerCount: document.querySelector('#playerCount'),
  players: document.querySelector('#players'),
  chatLog: document.querySelector('#chatLog'),
  messageForm: document.querySelector('#messageForm'),
  connectionStatus: document.querySelector('#connectionStatus'),
  aiPill: document.querySelector('#aiPill'),
  copyRoomCode: document.querySelector('#copyRoomCode'),
  toast: document.querySelector('#toast')
};

els.roomForm.displayName.value = state.displayName;

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
    throw new Error(payload.error || `HTTP ${response.status}`);
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
  els.aiPill.textContent = isBusy ? 'AI 生成中' : 'AI 待命';
}

function applyRoomPayload(payload) {
  state.room = payload.room;
  state.participant = payload.participant || state.participant;
  state.participants = payload.participants || [];
  state.messages = payload.messages || [];
  render();
  connectEvents();
}

function renderPlayers() {
  els.players.innerHTML = '';
  for (const participant of state.participants) {
    const node = document.createElement('div');
    node.className = 'player';
    node.innerHTML = `
      <div class="player-name"></div>
      <div class="player-meta"></div>
    `;
    node.querySelector('.player-name').textContent = participant.characterName || participant.displayName;
    node.querySelector('.player-meta').textContent = participant.characterName
      ? participant.displayName
      : '未填写角色名';
    els.players.append(node);
  }
}

function messageClass(message) {
  const classes = ['message', message.authorType];
  if (message.status === 'error') classes.push('error');
  return classes.join(' ');
}

function renderMessages() {
  els.chatLog.innerHTML = '';
  if (!state.room) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '创建或加入房间后，聊天记录会出现在这里。';
    els.chatLog.append(empty);
    return;
  }

  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '桌面已准备好。';
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
        <time></time>
      </div>
      <div class="message-body"></div>
    `;
    node.querySelector('strong').textContent = message.displayName;
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

function render() {
  const inRoom = Boolean(state.room);
  els.entryPanel.hidden = inRoom;
  els.roomPanel.hidden = !inRoom;
  els.editorPanel.hidden = !inRoom;
  els.summaryPanel.hidden = !inRoom;
  els.messageForm.hidden = !inRoom;

  if (inRoom) {
    els.roomTitle.textContent = state.room.name;
    els.tableTitle.textContent = state.room.name;
    els.roomCode.textContent = state.room.code;
    els.playerCount.textContent = `${state.participants.length}/5`;
    els.connectionStatus.textContent = `房间 ${state.room.code}`;
    els.summaryInput.value = state.room.summary || '';
  } else {
    els.tableTitle.textContent = '等待开局';
    els.connectionStatus.textContent = '未进入房间';
  }

  renderPlayers();
  renderMessages();
  renderProfile();
}

function connectEvents() {
  if (!state.room) return;
  if (state.events) state.events.close();

  const source = new EventSource(`/api/rooms/${state.room.code}/events?playerId=${encodeURIComponent(state.playerId)}`);
  state.events = source;

  source.addEventListener('connected', () => {
    els.connectionStatus.textContent = `房间 ${state.room.code}`;
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
    els.connectionStatus.textContent = '正在重连';
  };
}

els.createTab.addEventListener('click', () => setMode('create'));
els.joinTab.addEventListener('click', () => setMode('join'));

els.roomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(els.roomForm);
  const displayName = String(form.get('displayName') || '').trim();
  state.displayName = displayName;
  localStorage.setItem('dm-online-display-name', displayName);

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
  setAiBusy(true);

  try {
    await api(`/api/rooms/${state.room.code}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        playerId: state.playerId,
        content
      })
    });
  } catch (error) {
    setAiBusy(false);
    toast(error.message);
  }
});

els.copyRoomCode.addEventListener('click', async () => {
  if (!state.room) return;
  await navigator.clipboard.writeText(state.room.code).catch(() => undefined);
  toast('房间码已复制');
});

render();
