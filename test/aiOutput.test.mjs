import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceStructuredEvents, extractStructuredEvents, validateStructuredEvents } from '../src/aiOutput.js';
import { buildStructuredOutputPrompt } from '../src/prompts.js';

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

test('rejects invalid state change field paths', () => {
  const events = {
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'skills.侦查', newValue: 90, reason: 'hack' },
      { targetPlayerId: 'p1', fieldPath: 'inventory.gold', newValue: 999, reason: 'hack' },
      { targetPlayerId: 'p1', fieldPath: 'status.hp', newValue: 10, reason: 'valid' }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);

  assert.ok(rejected.includes('proposed_state_changes'));
  assert.equal(valid.proposed_state_changes, undefined);
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
  assert.match(instructions, /proposed_state_changes/);
  assert.match(instructions, /clues_revealed/);
  assert.match(instructions, /scene_change/);
  assert.match(instructions, /npc_state_changes/);
  assert.match(instructions, /summary_update/);
  assert.match(instructions, /json/);
});
