import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceStructuredEvents, extractStructuredEvents, planPreflightCheck, validateStructuredEvents } from '../src/aiOutput.js';
import { buildStructuredOutputPrompt } from '../src/prompts.js';

function testSheet() {
  return {
    investigator: { name: '测试调查员', occupation: '记者' },
    characteristics: {
      STR: 50, CON: 50, SIZ: 50, DEX: 55,
      APP: 50, INT: 60, POW: 50, EDU: 65, Luck: 50
    },
    skills: {
      侦查: 68,
      聆听: 55,
      会计: 45,
      话术: 60,
      说服: 55,
      恐吓: 30,
      潜行: 45,
      妙手: 35,
      乔装: 25,
      格斗: 40,
      射击: 35
    }
  };
}

function roomStateForAction(content, { recent = [], moduleJson = null } = {}) {
  const action = {
    id: 100 + recent.length,
    authorType: 'player',
    messageType: 'ACTION',
    playerId: 'p1',
    displayName: '测试调查员',
    content
  };
  return {
    room: { sceneState: '{}' },
    participants: [{
      playerId: 'p1',
      displayName: '玩家',
      characterName: '测试调查员',
      characterSheet: testSheet(),
      playerMeta: {}
    }],
    messages: [
      ...recent.map((content, index) => ({
        id: index + 1,
        authorType: 'dm',
        messageType: 'AI_DM',
        displayName: 'AI DM',
        content
      })),
      action
    ],
    moduleJson: moduleJson || {
      npcs: [
        { name: '陈友', npc_id: 'chen_you', skills: { 心理学: 35 } },
        { name: '老汉', npc_id: 'old_man', skills: { 心理学: 40 } },
        { name: '顾振兴', npc_id: 'gu_zhenxing', skills: { 心理学: 60 } },
        { name: '白崇礼', npc_id: 'bai_chongli', skills: { 心理学: 65 } },
        { name: '王勇', npc_id: 'wang_yong', skills: { 侦查: 55 } }
      ],
      checks: []
    },
    action
  };
}

test('extracts structured events from AI response with JSON block', () => {
  const text = [
    '你推开门，看到一间昏暗的房间。空气中弥漫着霉味。',
    '',
    '```json',
    JSON.stringify({
      required_checks: [
        { skill: '侦查', difficulty: 'REGULAR', reason: '发现隐藏线索', playerHint: '你注意到地板有些不对劲' }
      ],
      proposed_state_changes: [
        { targetPlayerId: 'player1', fieldPath: 'status.san', newValue: 55, reason: '目睹恐怖场景' }
      ],
      clues_revealed: [
        { content: '壁炉后方有一个暗格', source: '侦查成功' }
      ],
      summary_update: '调查员进入旧宅的昏暗房间，在壁炉后方发现暗格。'
    }, null, 2),
    '```'
  ].join('\n');

  const { narrative, events } = extractStructuredEvents(text);

  assert.match(narrative, /你推开门/);
  assert.ok(events.required_checks);
  assert.equal(events.required_checks[0].skill, '侦查');
  assert.ok(events.proposed_state_changes);
  assert.equal(events.proposed_state_changes[0].fieldPath, 'status.san');
  assert.ok(events.clues_revealed);
  assert.equal(events.summary_update, '调查员进入旧宅的昏暗房间，在壁炉后方发现暗格。');
});

test('handles response with no structured events gracefully', () => {
  const text = '你探索了房间，但什么都没发现。';

  const { narrative, events } = extractStructuredEvents(text);

  assert.equal(narrative, text);
  assert.deepEqual(events, {});
});

test('handles response with invalid JSON in code block', () => {
  const text = [
    '一些叙事先。',
    '```json',
    '{ this is not valid json }',
    '```',
    '更多叙事。'
  ].join('\n');

  const { narrative, events } = extractStructuredEvents(text);

  assert.match(narrative, /一些叙事先/);
  assert.match(narrative, /更多叙事/);
  assert.deepEqual(events, {});
});

test('extracts unfenced trailing JSON object from AI response', () => {
  const text = [
    '陈友停下手里的动作，抬眼看向你。',
    '',
    JSON.stringify({ scene_change: { newScene: '招待所灶房' }, summary_update: '调查员开始试探陈友。' }, null, 2)
  ].join('\n');

  const { narrative, events } = extractStructuredEvents(text);

  assert.match(narrative, /陈友停下/);
  assert.equal(events.scene_change.newScene, '招待所灶房');
  assert.equal(events.summary_update, '调查员开始试探陈友。');
});

test('validates structured events and rejects invalid fields', () => {
  const validEvents = {
    required_checks: [
      { skill: '侦查', difficulty: 'REGULAR' }
    ],
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'status.san', newValue: 50, reason: 'test' }
    ],
    clues_revealed: [
      { content: 'a clue' }
    ],
    summary_update: 'new summary'
  };

  const { valid, rejected, issues } = validateStructuredEvents(validEvents);

  assert.equal(rejected.length, 0);
  assert.equal(valid.required_checks.length, 1);
  assert.equal(valid.proposed_state_changes.length, 1);
  assert.equal(valid.summary_update, 'new summary');
});

test('rejects structured objects missing required fields or invalid booleans', () => {
  const events = {
    opposed_checks: [
      { activeSkill: '话术', passiveNpcName: '陈友', passiveSkill: '心理学', reason: '缺少玩家ID' }
    ],
    npc_state_changes: [
      { npcName: '陈友', isPresent: 'yes' }
    ]
  };

  const { valid, rejected, issues } = validateStructuredEvents(events);

  assert.deepEqual(valid, {});
  assert.ok(rejected.includes('opposed_checks'));
  assert.ok(rejected.includes('npc_state_changes'));
  assert.ok(issues.some((issue) => issue.includes('activePlayerId: required')));
  assert.ok(issues.some((issue) => issue.includes('isPresent: expected boolean')));
});

test('drops invalid state change items while keeping valid room-independent items', () => {
  const events = {
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'skills.侦查', newValue: 90, reason: 'hack' },
      { targetPlayerId: 'p1', fieldPath: 'inventory.gold', newValue: 999, reason: 'hack' },
      { targetPlayerId: 'p1', fieldPath: 'status.hp', newValue: 10, reason: 'valid' }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);

  assert.equal(rejected.length, 0);
  assert.equal(valid.proposed_state_changes.length, 1);
  assert.equal(valid.proposed_state_changes[0].fieldPath, 'status.hp');
});

test('allows valid field paths in state changes', () => {
  const events = {
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'status.hp', newValue: 8, reason: '受伤' },
      { targetPlayerId: 'p1', fieldPath: 'status.san', newValue: 45, reason: '理智损失' },
      { targetPlayerId: 'p1', fieldPath: 'status.luck', newValue: 30, reason: '消耗幸运' },
      { targetPlayerId: 'p1', fieldPath: 'characteristics.STR', newValue: 40, reason: '属性损失' }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);

  assert.equal(rejected.length, 0);
  assert.equal(valid.proposed_state_changes.length, 4);
});

test('rejects array items exceeding max limits', () => {
  const events = {
    required_checks: Array.from({ length: 15 }, (_, i) => ({
      skill: '侦查',
      difficulty: 'REGULAR',
      reason: `check ${i}`
    }))
  };

  const { valid, rejected } = validateStructuredEvents(events);

  assert.ok(rejected.includes('required_checks'));
});

test('preflight regression from playtest log: conversational deception triggers opposed checks', () => {
  const cases = [
    {
      name: '祖上借口',
      recent: ['陈友把茶缸放在柜台边，抬头等你继续解释。'],
      action: '其实我祖上也是我们村的人',
      expectedNpc: '陈友'
    },
    {
      name: '老一辈借口',
      recent: ['陈友皱着眉，没有立刻回答你。'],
      action: '老一辈就让我找您呀',
      expectedNpc: '陈友'
    },
    {
      name: '姓郑伪装',
      recent: ['陈友盯着你的介绍信，问你到底是哪家人。'],
      action: '姓郑啊',
      expectedNpc: '陈友'
    },
    {
      name: '借陈友名义骗老汉',
      recent: ['老汉拄着锄头挡在田埂边，狐疑地看着你们。'],
      action: '陈友让我们往北边去的',
      expectedNpc: '老汉'
    }
  ];

  for (const item of cases) {
    const state = roomStateForAction(item.action, { recent: item.recent });
    const plan = planPreflightCheck({ actionMessage: state.action, roomState: state });

    assert.equal(plan.type, 'opposed', item.name);
    assert.equal(plan.events.opposed_checks.length, 1, item.name);
    assert.equal(plan.events.opposed_checks[0].activeSkill, '话术', item.name);
    assert.equal(plan.events.opposed_checks[0].passiveSkill, '心理学', item.name);
    assert.equal(plan.events.opposed_checks[0].passiveNpcName, item.expectedNpc, item.name);
  }
});

test('preflight regression from playtest log: explicit skill actions trigger required checks', () => {
  const cases = [
    ['会计', '回到房间 自己审查所有账册，看看是否有问题'],
    ['侦查', '仔细观察一下这个房间（过侦查检定）'],
    ['聆听', '我们出门 然后在门外先不走远 (过聆听）']
  ];

  for (const [expectedSkill, action] of cases) {
    const state = roomStateForAction(action);
    const plan = planPreflightCheck({ actionMessage: state.action, roomState: state });

    assert.equal(plan.type, 'required', expectedSkill);
    assert.equal(plan.events.required_checks.length, 1, expectedSkill);
    assert.equal(plan.events.required_checks[0].skill, expectedSkill, expectedSkill);
    assert.equal(plan.events.required_checks[0].targetPlayerId, 'p1', expectedSkill);
  }
});

test('room-aware validation rejects impossible player, skill, private target, and hallucinated NPC', () => {
  const state = roomStateForAction('我检查柜台。');

  const unknownSkill = validateStructuredEvents({
    required_checks: [{ targetPlayerId: 'p1', skill: '不存在技能', difficulty: 'REGULAR' }]
  }, { roomState: state, defaultPlayerId: 'p1' });
  assert.ok(unknownSkill.rejected.includes('required_checks'));
  assert.ok(unknownSkill.issues.some((issue) => issue.includes('unknown skill')));

  const missingPlayer = validateStructuredEvents({
    opposed_checks: [{
      activePlayerId: 'missing',
      activeSkill: '话术',
      passiveNpcName: '陈友',
      passiveSkill: '心理学',
      reason: '不存在的玩家'
    }]
  }, { roomState: state });
  assert.ok(missingPlayer.rejected.includes('opposed_checks'));
  assert.ok(missingPlayer.issues.some((issue) => issue.includes('participant not found')));

  const hallucinatedNpc = validateStructuredEvents({
    opposed_checks: [{
      activePlayerId: 'p1',
      activeSkill: '话术',
      passiveNpcName: '幻觉NPC',
      passiveSkill: '心理学',
      reason: '模型编造 NPC'
    }]
  }, { roomState: state });
  assert.ok(hallucinatedNpc.rejected.includes('opposed_checks'));
  assert.ok(hallucinatedNpc.issues.some((issue) => issue.includes('NPC not found')));

  const privateClue = validateStructuredEvents({
    clues_revealed: [{ content: '只有不存在的人能看见', privateTo: 'missing' }]
  }, { roomState: state });
  assert.ok(privateClue.rejected.includes('clues_revealed'));
  assert.ok(privateClue.issues.some((issue) => issue.includes('privateTo')));
});

test('room-aware validation drops bad array items while keeping valid checks', () => {
  const state = roomStateForAction('我检查柜台。');

  const result = validateStructuredEvents({
    required_checks: [
      { targetPlayerId: 'p1', skill: '侦查', difficulty: 'REGULAR', reason: '有效检定' },
      { targetPlayerId: 'p1', skill: '不存在技能', difficulty: 'REGULAR', reason: '无效检定' }
    ],
    clues_revealed: [
      { content: '公开线索' },
      { content: '错误私密线索', privateTo: 'missing' }
    ]
  }, { roomState: state, defaultPlayerId: 'p1' });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.valid.required_checks.length, 1);
  assert.equal(result.valid.required_checks[0].skill, '侦查');
  assert.equal(result.valid.clues_revealed.length, 1);
  assert.equal(result.valid.clues_revealed[0].content, '公开线索');
  assert.ok(result.issues.some((issue) => issue.includes('unknown skill')));
  assert.ok(result.issues.some((issue) => issue.includes('privateTo')));
  assert.ok(result.warnings.some((warning) => warning.includes('dropped 1 invalid item')));
});

test('infers social opposed check when AI omits structured events for deception', () => {
  const roomState = {
    messages: [
      {
        id: 12,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '其实我祖上也是我们村的人，老一辈让我找陈友问问。'
      }
    ],
    moduleJson: {
      npcs: [{ name: '陈友', npc_id: 'npc_chen_you' }]
    }
  };
  const narrative = '陈友相信了你的说法，脸上的戒备稍微松下来。';

  const enhanced = enhanceStructuredEvents({ events: {}, narrative, roomState });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activePlayerId, 'player1');
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '话术');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '陈友');
  assert.equal(enhanced.events.opposed_checks[0].passiveSkill, '心理学');
  assert.equal(enhanced.diagnostics.inferredReason, 'backend-social');
  assert.equal(enhanced.diagnostics.strippedDecisiveOutcome, true);
  assert.doesNotMatch(enhanced.narrative, /相信了/);
  assert.match(enhanced.narrative, /触发社交检定/);
});

test('uses AI task triggerMessageId instead of the latest queued action', () => {
  const roomState = {
    messages: [
      {
        id: 30,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '我骗陈友说自己是远房亲戚。'
      },
      {
        id: 31,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player2',
        content: '我搜索柜台下面有没有暗格。'
      }
    ],
    moduleJson: {
      npcs: [{ name: '陈友', npc_id: 'npc_chen_you' }]
    }
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '陈友眯起眼睛看着你。',
    roomState,
    triggerMessageId: 30
  });

  assert.equal(enhanced.diagnostics.latestActionId, 30);
  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activePlayerId, 'player1');
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '话术');
  assert.equal(enhanced.events.required_checks, undefined);
});

test('strips decisive outcome when model provides opposed checks', () => {
  const roomState = {
    messages: [
      {
        id: 13,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '我骗陈友说顾所长让我来取账本。'
      }
    ],
    moduleJson: {
      npcs: [{ name: '陈友', npc_id: 'npc_chen_you' }]
    }
  };
  const narrative = '陈友相信了你的说法，转身把账本取了出来。';

  const enhanced = enhanceStructuredEvents({
    events: {
      opposed_checks: [{
        activePlayerId: 'player1',
        activeSkill: '话术',
        passiveNpcName: '陈友',
        passiveSkill: '心理学',
        contestType: 'social',
        reason: '玩家对 NPC 撒谎'
      }]
    },
    narrative,
    roomState
  });

  assert.equal(enhanced.diagnostics.inferredReason, 'model-provided');
  assert.equal(enhanced.diagnostics.strippedDecisiveOutcome, true);
  assert.doesNotMatch(enhanced.narrative, /相信了/);
  assert.match(enhanced.narrative, /触发社交检定/);
});

test('infers opposed check when model-provided check is not room-applicable', () => {
  const roomState = roomStateForAction('我骗陈友说自己是顾所长派来的。');

  const enhanced = enhanceStructuredEvents({
    events: {
      opposed_checks: [{
        activePlayerId: 'p1',
        activeSkill: '话术',
        passiveNpcName: '幻觉NPC',
        passiveSkill: '心理学',
        contestType: 'social',
        reason: '模型编造了不存在的 NPC'
      }]
    },
    narrative: '陈友眯起眼睛看着你。',
    roomState
  });
  const checked = validateStructuredEvents(enhanced.events, { roomState, defaultPlayerId: 'p1' });

  assert.equal(enhanced.diagnostics.inferredReason, 'backend-social');
  assert.equal(checked.rejected.length, 0);
  assert.equal(checked.valid.opposed_checks.length, 1);
  assert.equal(checked.valid.opposed_checks[0].passiveNpcName, '陈友');
  assert.ok(checked.issues.some((issue) => issue.includes('NPC not found')));
});

test('infers stealth opposed check when model returns an empty opposed_checks array', () => {
  const roomState = {
    messages: [
      {
        id: 21,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player2',
        content: '偷偷跟着他，距离他一段距离看看情况'
      }
    ],
    moduleJson: {}
  };
  const narrative = '板寸头把火柴盒搁下，侧脸像是在听。';

  const enhanced = enhanceStructuredEvents({
    events: { opposed_checks: [] },
    narrative,
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activePlayerId, 'player2');
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '潜行');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '板寸头');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'stealth');
});

test('regression: detects opposed checks for common player actions', () => {
  const cases = [
    {
      name: '撒谎',
      action: '我谎称自己是陈友的远房亲戚，想让他相信我。',
      expectedSkill: '话术',
      expectedNpc: '陈友',
      expectedType: 'social'
    },
    {
      name: '说服',
      action: '我试着说服陈友把昨晚看到的事告诉我。',
      expectedSkill: '说服',
      expectedNpc: '陈友',
      expectedType: 'social'
    },
    {
      name: '恐吓',
      action: '我拍桌恐吓陈友，让他别再隐瞒。',
      expectedSkill: '恐吓',
      expectedNpc: '陈友',
      expectedType: 'social'
    },
    {
      name: '潜行',
      action: '我潜行绕过保安，贴着墙溜进档案室。',
      expectedSkill: '潜行',
      expectedNpc: '保安',
      expectedType: 'stealth'
    },
    {
      name: '偷窃',
      action: '我趁保安不注意，悄悄偷走他腰间的钥匙。',
      expectedSkill: '妙手',
      expectedNpc: '保安',
      expectedType: 'stealth'
    },
    {
      name: '攻击',
      action: '我挥拳攻击保安，试图制服他。',
      expectedSkill: '格斗',
      expectedNpc: '保安',
      expectedType: 'combat'
    }
  ];

  for (const item of cases) {
    const enhanced = enhanceStructuredEvents({
      events: {},
      narrative: `${item.expectedNpc}的动作停了一下。`,
      roomState: {
        messages: [{
          id: item.name,
          authorType: 'player',
          messageType: 'ACTION',
          playerId: 'player1',
          content: item.action
        }],
        moduleJson: { npcs: [{ name: '陈友' }, { name: '保安' }] }
      }
    });

    assert.equal(enhanced.events.opposed_checks.length, 1, item.name);
    const check = enhanced.events.opposed_checks[0];
    assert.equal(check.activePlayerId, 'player1', item.name);
    assert.equal(check.activeSkill, item.expectedSkill, item.name);
    assert.equal(check.passiveNpcName, item.expectedNpc, item.name);
    assert.equal(check.contestType, item.expectedType, item.name);
    assert.equal(enhanced.events.required_checks, undefined, item.name);
  }
});

test('infers required check when model-provided check has invalid skill', () => {
  const roomState = roomStateForAction('我仔细检查柜台下面有没有隐藏痕迹。');

  const enhanced = enhanceStructuredEvents({
    events: {
      required_checks: [{
        targetPlayerId: 'p1',
        skill: '不存在技能',
        difficulty: 'REGULAR',
        reason: '模型写错技能名'
      }]
    },
    narrative: '你蹲下身，手电光扫过柜台底部。',
    roomState
  });
  const checked = validateStructuredEvents(enhanced.events, { roomState, defaultPlayerId: 'p1' });

  assert.equal(enhanced.diagnostics.inferredRequiredReason, 'generic-侦查');
  assert.equal(checked.rejected.length, 0);
  assert.equal(checked.valid.required_checks.length, 1);
  assert.equal(checked.valid.required_checks[0].skill, '侦查');
  assert.ok(checked.issues.some((issue) => issue.includes('unknown skill')));
});

test('drops model required checks when latest action must be opposed', () => {
  const enhanced = enhanceStructuredEvents({
    events: {
      required_checks: [
        { targetPlayerId: 'player1', skill: '话术', difficulty: 'REGULAR', reason: '模型误把撒谎写成普通检定' }
      ]
    },
    narrative: '陈友眯起眼睛。',
    roomState: {
      messages: [{
        id: 31,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '我谎称自己是陈友的亲戚。'
      }],
      moduleJson: { npcs: [{ name: '陈友' }] }
    }
  });

  assert.equal(enhanced.events.required_checks, undefined);
  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '话术');
  assert.equal(enhanced.diagnostics.droppedRequiredChecksForOpposedAction, 1);
});

test('regression: detects required checks for ordinary spot hidden and library use actions', () => {
  const cases = [
    {
      name: '普通侦查',
      action: '我仔细侦查房间，检查书桌下面有没有隐藏痕迹。',
      expectedSkill: '侦查'
    },
    {
      name: '图书馆使用',
      action: '我在档案和旧报纸里查资料，翻阅有没有东乡村旧案记录。',
      expectedSkill: '图书馆使用'
    }
  ];

  for (const item of cases) {
    const enhanced = enhanceStructuredEvents({
      events: {},
      narrative: '你开始处理眼前的信息。',
      roomState: {
        messages: [{
          id: item.name,
          authorType: 'player',
          messageType: 'ACTION',
          playerId: 'player2',
          content: item.action
        }],
        moduleJson: {}
      }
    });

    assert.equal(enhanced.events.required_checks.length, 1, item.name);
    const check = enhanced.events.required_checks[0];
    assert.equal(check.targetPlayerId, 'player2', item.name);
    assert.equal(check.skill, item.expectedSkill, item.name);
    assert.equal(check.difficulty, 'REGULAR', item.name);
    assert.equal(enhanced.events.opposed_checks, undefined, item.name);
    assert.match(enhanced.narrative, new RegExp(`触发${item.expectedSkill}检定`));
  }
});

test('regression: detects expanded ordinary skill checks', () => {
  const cases = [
    ['会计', '我核对账本流水，看看收支有没有异常。'],
    ['锁匠', '我用发卡试着撬开抽屉的锁。'],
    ['医学', '我检查尸体伤口，判断真正死因。'],
    ['驾驶汽车', '我猛踩油门开车甩开后面的车。'],
    ['神秘学', '我辨认墙上那些怪异符号和仪式痕迹。']
  ];

  for (const [expectedSkill, action] of cases) {
    const enhanced = enhanceStructuredEvents({
      events: {},
      narrative: '你开始处理眼前的问题。',
      roomState: {
        messages: [{
          id: expectedSkill,
          authorType: 'player',
          messageType: 'ACTION',
          playerId: 'player3',
          content: action
        }],
        moduleJson: {}
      }
    });

    assert.equal(enhanced.events.required_checks.length, 1, expectedSkill);
    assert.equal(enhanced.events.required_checks[0].skill, expectedSkill, expectedSkill);
    assert.equal(enhanced.diagnostics.inferredRequiredDetection.source, 'generic', expectedSkill);
  }
});

test('does not infer spot hidden for observing only an NPC reaction', () => {
  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '陈友低头喝了一口水，手指仍搭在搪瓷杯边缘。',
    roomState: {
      messages: [{
        id: 41,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '我看看陈友的脸色和反应。'
      }],
      moduleJson: { npcs: [{ name: '陈友', npc_id: 'chenyou' }] }
    }
  });

  assert.equal(enhanced.events.required_checks, undefined);
  assert.equal(enhanced.events.opposed_checks, undefined);
  assert.equal(enhanced.diagnostics.inferredRequiredDetection, null);
});

test('matches module JSON checks before generic required checks', () => {
  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '登记簿摊在柜台上，墨迹在灯光下泛着暗色。',
    roomState: {
      room: {
        sceneState: { currentScene: 'lobby' }
      },
      messages: [{
        id: 42,
        authorType: 'player',
        messageType: 'ACTION',
        playerId: 'player1',
        content: '我检查前台登记簿，尤其看王建国的房号有没有被改过。'
      }],
      moduleJson: {
        checks: [{
          check_id: 'spot_register',
          scene_id: 'lobby',
          skill: '侦查',
          difficulty: 'HARD',
          trigger: '调查员检查前台登记簿',
          success: '发现王建国的房间号被涂改过',
          failure: '登记簿看起来很普通',
          ai_dm_instruction: '内部说明：不要直接告诉玩家秘密。'
        }]
      }
    }
  });

  assert.equal(enhanced.events.required_checks.length, 1);
  assert.equal(enhanced.events.required_checks[0].skill, '侦查');
  assert.equal(enhanced.events.required_checks[0].difficulty, 'HARD');
  assert.equal(enhanced.events.required_checks[0].playerHint, '这一行动命中了模组预设检定，结果由服务器骰点决定。');
  assert.equal(enhanced.diagnostics.inferredRequiredDetection.source, 'module');
  assert.equal(enhanced.diagnostics.inferredRequiredDetection.moduleCheckId, 'spot_register');
  assert.ok(enhanced.diagnostics.inferredRequiredDetection.confidence >= 0.7);
});

test('strips trailing action suggestions from AI narrative', () => {
  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: [
      '雨水顺着卫生院的玻璃往下滑，走廊里只剩日光灯的嗡鸣。',
      '',
      '---',
      '接下来你们可以：',
      '- 去村委会',
      '- 去卫生站'
    ].join('\n'),
    roomState: { messages: [] }
  });

  assert.match(enhanced.narrative, /日光灯/);
  assert.doesNotMatch(enhanced.narrative, /接下来/);
  assert.equal(enhanced.diagnostics.strippedActionSuggestions, true);
});

test('formats structured output instructions for AI prompt', () => {
  const instructions = buildStructuredOutputPrompt();

  assert.match(instructions, /required_checks/);
  assert.match(instructions, /JSON\.parse/);
  assert.match(instructions, /targetPlayerId/);
  assert.match(instructions, /图书馆使用/);
  assert.match(instructions, /继续/);
  assert.match(instructions, /不要自己生成 d100/);
  assert.match(instructions, /顶层只允许/);
  assert.match(instructions, /不确定 playerId/);
  assert.match(instructions, /proposed_state_changes/);
  assert.match(instructions, /clues_revealed/);
  assert.match(instructions, /scene_change/);
  assert.match(instructions, /npc_state_changes/);
  assert.match(instructions, /summary_update/);
  assert.match(instructions, /json/);
});

test('strips AI-generated check markers so backend can inject its own', () => {

  const enhanced = enhanceStructuredEvents({
    events: {
      opposed_checks: [{
        activePlayerId: 'p1', activeSkill: '恐吓',
        passiveNpcName: '王勇', passiveSkill: '心理学',
        contestType: 'social', reason: '威胁NPC'
      }]
    },
    narrative: [
      '王勇转过身，手按住了腰间的枪套搭扣。',
      '（此处触发对抗检定，立即暂停叙事，等待服务器骰点结果。）',
      '（此处触发战斗检定，由服务器骰点判定胜负。）',
      '日光灯管嗡嗡作响。'
    ].join('\n'),
    roomState: {
      messages: [{
        id: 1, authorType: 'player', messageType: 'ACTION',
        playerId: 'p1', content: '威胁王勇交出所有资料。'
      }]
    }
  });

  // AI 自己写的两个标记都应被清理
  assert.ok(!enhanced.narrative.includes('对抗检定，立即暂停叙事'),
    'AI写的"对抗检定"标记应被删除');
  assert.ok(!enhanced.narrative.includes('战斗检定，由服务器骰点判定胜负'),
    'AI写的"战斗检定"标记应被删除');
  // 后端注入的标记应该存在
  assert.ok(enhanced.narrative.includes('社交检定'),
    '后端注入的标记应该存在');
  // 只出现一次"此处触发"
  const count = (enhanced.narrative.match(/此处触发/g) || []).length;
  assert.equal(count, 1, '应该只有一个"此处触发"标记');
});
