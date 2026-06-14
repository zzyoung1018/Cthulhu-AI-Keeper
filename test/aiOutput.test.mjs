import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuredEvents, validateStructuredEvents } from '../src/aiOutput.js';
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
