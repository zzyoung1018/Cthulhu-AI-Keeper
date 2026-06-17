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
