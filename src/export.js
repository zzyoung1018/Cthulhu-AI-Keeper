// Game export: Markdown and JSON formats.
// Exports complete chat log, final character sheets, dice records, story summary,
// scene state, and AI configuration for archival.

function sanitizeMarkdown(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\|/g, '/')
    .trim();
}

function formatMessage(m) {
  const time = new Date(m.createdAt).toLocaleString('zh-CN');
  const type = m.messageType || 'IC';
  const name = m.displayName || '未知';
  const content = String(m.content || '').trim();

  if (type === 'SYSTEM') return `> **系统** · ${time}\n> ${content}\n`;
  if (type === 'AI_DM') return `### 🎭 AI DM · ${time}\n\n${content}\n`;
  if (type === 'OOC') return `> 💬 ${name}（OOC）· ${time}\n> ${content}\n`;
  if (type === 'ACTION') return `### ⚔️ ${name}（行动）· ${time}\n\n${content}\n`;
  if (type === 'PRIVATE') return `> 🔒 ${name}（私密）· ${time}\n> *(内容已隐藏)*`;
  return `**${name}** · ${time}\n${content}\n`;
}

function formatDiceRoll(r) {
  const time = new Date(r.createdAt).toLocaleString('zh-CN');
  const label = r.label || r.rollType || '骰子';
  const result = typeof r.result === 'object' ? r.result : JSON.parse(r.result || '{}');

  if (result.type === 'coc_check' || result.type === 'skill_check') {
    const skill = result.skillName ? ` ${result.skillName}` : '';
    return `| ${time} | ${label} | ${result.expression || '1d100'} = ${result.total} / ${result.target} | ${result.successLevel} | ${result.passed ? '✓' : '✗'} |`;
  }

  if (result.type === 'sanity_loss') {
    return `| ${time} | ${label} | ${result.expression} | ${result.total} | ${result.passed ? '通过' : '失败'} |`;
  }

  return `| ${time} | ${label} | ${result.expression || '-'} | ${result.total ?? '-'} | - |`;
}

function formatCharacterSheetForExport(sheet, displayName) {
  const s = sheet || {};
  const inv = s.investigator || {};
  const chars = s.characteristics || {};
  const derived = {};
  if (chars.CON && chars.SIZ) derived.hp = Math.max(1, Math.floor((chars.CON + chars.SIZ) / 10));
  if (chars.POW) derived.mp = Math.max(0, Math.floor(chars.POW / 5));
  if (chars.POW) derived.san = chars.POW;

  return [
    `### ${inv.name || displayName || '未命名'}`,
    '',
    inv.occupation ? `- 职业：${inv.occupation}` : '',
    inv.age ? `- 年龄：${inv.age}` : '',
    inv.residence ? `- 居住地：${inv.residence}` : '',
    '',
    '| 属性 | 数值 |',
    '| --- | --- |',
    ...['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'Luck'].map((k) => `| ${k} | ${chars[k] ?? '-'} |`),
    ...['HP', 'MP', 'SAN', 'Luck'].map((k) => {
      const current = (s.status || {})[k.toLowerCase()];
      const max = derived[k.toLowerCase()] ?? '-';
      return `| ${k} | ${current ?? '-'} / ${max} |`;
    }),
    '',
    s.skills && Object.keys(s.skills).length > 0
      ? '| 技能 | 数值 |\n| --- | --- |\n' + Object.entries(s.skills).map(([n, v]) => `| ${n} | ${v} |`).join('\n')
      : '',
    '',
    s.weapons && s.weapons.length > 0
      ? `**武器**：${s.weapons.map((w) => `${w.name} ${w.damage}`).join('、')}`
      : '',
    s.equipment ? `\n**装备**：${s.equipment}` : '',
    s.relationships ? `\n**人际关系**：${s.relationships}` : '',
    s.beliefs ? `\n**思想与信念**：${s.beliefs}` : ''
  ].filter(Boolean).join('\n');
}

function clipText(value, limit = 1200) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildPlayerRefs(participants = []) {
  const refs = new Map();
  participants.forEach((participant, index) => {
    refs.set(participant.playerId || '', `P${index + 1}`);
  });
  return refs;
}

function playerRef(refs, playerId) {
  return refs.get(playerId || '') || '';
}

function slimDetection(detection, refs) {
  if (!detection || typeof detection !== 'object') return null;
  return {
    source: detection.source || '',
    kind: detection.kind || '',
    ruleId: detection.ruleId || '',
    confidence: detection.confidence ?? null,
    skill: detection.skill || detection.activeSkill || '',
    passiveSkill: detection.passiveSkill || '',
    target: detection.target || '',
    difficulty: detection.difficulty || '',
    playerRef: playerRef(refs, detection.playerId || detection.targetPlayerId || detection.activePlayerId || ''),
    notes: Array.isArray(detection.notes) ? detection.notes.slice(0, 8) : []
  };
}

function slimLog(log, refs) {
  const detection = log.detection || {};
  return {
    stage: log.stage || '',
    taskUid: log.taskUid || '',
    time: log.time || log.createdAt || '',
    actionMessageId: log.actionMessageId || null,
    type: log.type || '',
    reason: log.reason || '',
    eventKeys: Array.isArray(log.eventKeys) ? log.eventKeys : [],
    validKeys: Array.isArray(log.validKeys) ? log.validKeys : [],
    rejectedKeys: Array.isArray(log.rejectedKeys) ? log.rejectedKeys : [],
    issues: Array.isArray(log.issues) ? log.issues.slice(0, 12) : [],
    warnings: Array.isArray(log.warnings) ? log.warnings.slice(0, 12) : [],
    detection: slimDetection(detection, refs),
    detectionNotes: Array.isArray(detection.detectionNotes)
      ? detection.detectionNotes.slice(0, 8).map((note) => slimDetection(note, refs)).filter(Boolean)
      : [],
    rawResponseSnippet: clipText(log.rawResponseSnippet, 1000)
  };
}

function messageById(messages = []) {
  return new Map(messages.filter((message) => message.id).map((message) => [message.id, message]));
}

function checksFromDice(diceRolls = [], refs) {
  return diceRolls.map((roll) => ({
    id: roll.id || null,
    playerRef: playerRef(refs, roll.playerId),
    rollType: roll.rollType || '',
    label: roll.label || '',
    expression: roll.expression || '',
    isPrivate: Boolean(roll.isPrivate),
    result: {
      type: roll.result?.type || '',
      skillName: roll.result?.skillName || roll.label || '',
      total: roll.result?.total ?? null,
      target: roll.result?.target ?? null,
      difficulty: roll.result?.difficulty || '',
      successLevel: roll.result?.successLevel || '',
      passed: roll.result?.passed ?? null,
      winner: roll.result?.winner || '',
      activeSkill: roll.result?.activeSkill || '',
      passiveSkill: roll.result?.passiveSkill || '',
      passiveName: roll.result?.passiveName || ''
    },
    createdAt: roll.createdAt || ''
  }));
}

function expectedFromLogs(aiLogs = [], refs) {
  return aiLogs
    .filter((log) => ['preflight-check', 'structured-events'].includes(log.stage))
    .map((log) => ({
      stage: log.stage,
      taskUid: log.taskUid || '',
      actionMessageId: log.actionMessageId || log.detection?.latestActionId || null,
      type: log.type || '',
      reason: log.reason || log.detection?.inferredRequiredReason || log.detection?.inferredReason || '',
      eventKeys: Array.isArray(log.eventKeys) ? log.eventKeys : [],
      validKeys: Array.isArray(log.validKeys) ? log.validKeys : [],
      detection: slimDetection(log.detection, refs),
      detectionNotes: Array.isArray(log.detection?.detectionNotes)
        ? log.detection.detectionNotes.slice(0, 8).map((note) => slimDetection(note, refs)).filter(Boolean)
        : []
    }));
}

export function exportGameMarkdown(state) {
  const { room, participants, messages, diceRolls } = state;

  const lines = [
    `# ${room.name}`,
    '',
    `- 房间码：${room.code}`,
    `- 模组：${room.moduleTitle || '未命名'}`,
    `- 状态：${room.status}`,
    `- 创建时间：${room.createdAt}`,
    '',
    '## 剧情摘要',
    '',
    room.summary || '暂无摘要',
    '',
    '## 角色卡',
    '',
    ...participants.flatMap((p) => [formatCharacterSheetForExport(p.characterSheet, p.displayName), '']),
    '## 骰子记录',
    '',
    '| 时间 | 标签 | 表达式 | 结果 | 通过 |',
    '| --- | --- | --- | --- | --- |',
    ...diceRolls.map(formatDiceRoll),
    '',
    '## 聊天记录',
    '',
    ...messages.map(formatMessage)
  ];

  return lines.join('\n');
}

export function exportGameJson(state) {
  const {
    room,
    participants,
    messages,
    diceRolls,
    aiTasks = [],
    rounds = [],
    module = null,
    moduleSegments = [],
    aiLogs = [],
    isOwnerExport = false
  } = state;

  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    isOwnerExport,
    room: {
      code: room.code,
      name: room.name,
      moduleId: room.moduleId,
      moduleTitle: room.moduleTitle,
      moduleParseStatus: room.moduleParseStatus,
      status: room.status,
      maxPlayers: room.maxPlayers,
      summary: room.summary,
      sceneState: room.sceneState,
      createdAt: room.createdAt
    },
    module: module ? {
      id: module.id,
      title: module.title,
      originalName: module.originalName,
      fileType: module.fileType,
      contentType: module.contentType,
      sizeBytes: module.sizeBytes,
      parseStatus: module.parseStatus,
      segmentCount: module.segmentCount,
      parsedText: module.parsedText || '',
      createdAt: module.createdAt,
      updatedAt: module.updatedAt
    } : null,
    moduleSegments: moduleSegments.map((segment) => ({
      sortOrder: segment.sortOrder,
      title: segment.title,
      scene: segment.scene,
      content: segment.content
    })),
    participants: participants.map((p) => ({
      displayName: p.displayName,
      playerId: p.playerId,
      isOwner: Boolean(p.isOwner),
      characterSheet: p.characterSheet,
      characterRevision: p.characterRevision,
      isReady: p.isReady,
      state: p.state,
      discoveredClues: p.discoveredClues,
      knownNpcs: p.knownNpcs,
      joinedAt: p.joinedAt
    })),
    messages: messages.map((m) => ({
      authorType: m.authorType,
      messageType: m.messageType,
      playerId: m.playerId || '',
      privateTarget: m.privateTarget || '',
      displayName: m.displayName,
      content: m.content,
      status: m.status,
      createdAt: m.createdAt
    })),
    diceRolls: diceRolls.map((r) => ({
      rollType: r.rollType,
      playerId: r.playerId || '',
      expression: r.expression,
      label: r.label,
      isPrivate: Boolean(r.isPrivate),
      result: r.result,
      createdAt: r.createdAt
    })),
    aiTasks: aiTasks.map((t) => ({
      uid: t.task_uid || t.uid,
      status: t.status,
      error: t.error || '',
      createdAt: t.createdAt,
      completedAt: t.completedAt || ''
    })),
    rounds,
    aiLogs
  }, null, 2);
}

export function buildReplayFixture(state) {
  const {
    room,
    participants = [],
    messages = [],
    diceRolls = [],
    aiLogs = [],
    module = null,
    moduleSegments = []
  } = state;
  const refs = buildPlayerRefs(participants);
  const byId = messageById(messages);
  const replay = room?.roomMeta?.replay || {};
  const actions = messages
    .filter((message) => message.messageType === 'ACTION')
    .map((message) => ({
      id: message.id || null,
      playerRef: playerRef(refs, message.playerId),
      displayName: message.displayName || '',
      content: clipText(message.content, 2000),
      createdAt: message.createdAt || ''
    }));

  return {
    schemaVersion: 'dm-online-replay-fixture/1.0',
    generatedAt: new Date().toISOString(),
    room: {
      code: room.code,
      name: room.name,
      status: room.status,
      moduleTitle: room.moduleTitle || module?.title || '',
      summary: clipText(room.summary, 4000),
      sceneState: parseObject(room.sceneState),
      replay: {
        isReplay: Boolean(replay.isReplay),
        sourceRoomCode: replay.sourceRoomCode || '',
        sourceRoomName: replay.sourceRoomName || '',
        sourceModuleTitle: replay.sourceModuleTitle || '',
        importedAt: replay.importedAt || ''
      }
    },
    participants: participants.map((participant) => ({
      ref: playerRef(refs, participant.playerId),
      displayName: participant.displayName,
      isOwner: Boolean(participant.isOwner),
      characterName: participant.characterName || participant.characterSheet?.investigator?.name || '',
      characteristics: participant.characterSheet?.characteristics || {},
      skills: participant.characterSheet?.skills || {},
      state: clipText(participant.state, 1000),
      discoveredClues: participant.discoveredClues || [],
      knownNpcs: participant.knownNpcs || []
    })),
    moduleContext: {
      title: module?.title || room.moduleTitle || '',
      segmentCount: moduleSegments.length,
      segments: moduleSegments.slice(0, 80).map((segment) => ({
        sortOrder: segment.sortOrder,
        title: segment.title,
        scene: segment.scene,
        content: clipText(segment.content, 1200)
      }))
    },
    timeline: messages.map((message) => ({
      id: message.id || null,
      authorType: message.authorType,
      messageType: message.messageType,
      playerRef: playerRef(refs, message.playerId),
      privateTargetRef: playerRef(refs, message.privateTarget),
      displayName: message.displayName,
      content: clipText(message.content, 3000),
      status: message.status,
      createdAt: message.createdAt
    })),
    actions,
    checks: checksFromDice(diceRolls, refs),
    expectedAiBehavior: expectedFromLogs(aiLogs, refs).map((entry) => ({
      ...entry,
      action: entry.actionMessageId ? {
        id: entry.actionMessageId,
        content: clipText(byId.get(entry.actionMessageId)?.content || '', 2000),
        playerRef: playerRef(refs, byId.get(entry.actionMessageId)?.playerId || '')
      } : null
    })),
    aiLogs: aiLogs.slice(-120).map((log) => slimLog(log, refs)),
    testHints: {
      actionCount: actions.length,
      checkCount: diceRolls.length,
      aiLogCount: aiLogs.length,
      hasPreflightChecks: aiLogs.some((log) => log.stage === 'preflight-check'),
      hasValidationWarnings: aiLogs.some((log) =>
        (Array.isArray(log.issues) && log.issues.length > 0) ||
        (Array.isArray(log.warnings) && log.warnings.length > 0)
      )
    }
  };
}

export function exportReplayFixtureJson(state) {
  return JSON.stringify(buildReplayFixture(state), null, 2);
}
