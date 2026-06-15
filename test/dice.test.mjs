import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cocCheckPasses,
  cocSuccessLevel,
  dispatchDiceRoll,
  formatRollSummary,
  parseDiceExpression,
  rollCocCheck,
  rollD100,
  rollDiceExpression,
  rollOpposedCheck,
  rollPushedCheck,
  rollSanityLoss,
  spendLuck
} from '../src/dice.js';

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

test('parses and rolls dice expressions on the server', () => {
  assert.deepEqual(parseDiceExpression('2d6+3'), {
    expression: '2d6+3',
    count: 2,
    sides: 6,
    modifier: 3
  });

  const roll = rollDiceExpression('2d6+1', sequence([0, 0.999]));
  assert.deepEqual(roll.rolls, [1, 6]);
  assert.equal(roll.total, 8);
});

test('rolls CoC d100 bonus and penalty dice', () => {
  const bonus = rollD100({ bonusDice: 1, rng: sequence([0.4, 0.8, 0.2]) });
  assert.deepEqual(bonus.candidates, [84, 24]);
  assert.equal(bonus.total, 24);

  const penalty = rollD100({ penaltyDice: 1, rng: sequence([0.4, 0.8, 0.2]) });
  assert.deepEqual(penalty.candidates, [84, 24]);
  assert.equal(penalty.total, 84);
});

test('classifies CoC 7th Edition success levels and difficulty', () => {
  assert.equal(cocSuccessLevel(1, 50), 'CRITICAL');
  assert.equal(cocSuccessLevel(10, 50), 'EXTREME');
  assert.equal(cocSuccessLevel(25, 50), 'HARD');
  assert.equal(cocSuccessLevel(50, 50), 'REGULAR');
  assert.equal(cocSuccessLevel(60, 50), 'FAIL');
  assert.equal(cocSuccessLevel(96, 40), 'FUMBLE');
  assert.equal(cocCheckPasses('HARD', 'HARD'), true);
  assert.equal(cocCheckPasses('REGULAR', 'HARD'), false);
});

test('rolls complete CoC checks and sanity loss expressions', () => {
  const check = rollCocCheck({ target: 60, difficulty: 'HARD', rng: sequence([0.2, 0.2]) });
  assert.equal(check.total, 22);
  assert.equal(check.successLevel, 'HARD');
  assert.equal(check.passed, true);

  const successLoss = rollSanityLoss('0/1d6', true, sequence([0.5]));
  assert.equal(successLoss.total, 0);
  const failureLoss = rollSanityLoss('0/1d6', false, sequence([0.5]));
  assert.equal(failureLoss.total, 4);
});

test('opposed checks determine winner by success level', () => {
  // Active rolls HARD (22), passive rolls REGULAR (50) - same target but active wins by higher level
  const result = rollOpposedCheck({
    activeTarget: 60,
    passiveTarget: 60,
    rng: sequence([0.2, 0.2, 0.5, 0.5])
  });

  assert.equal(result.type, 'opposed_check');
  assert.equal(result.active.roll, 22);
  assert.equal(result.passive.roll, 55);
  assert.equal(result.active.successLevel, 'HARD');
  assert.equal(result.passive.successLevel, 'REGULAR');
  assert.equal(result.winner, 'active');
});

test('opposed checks use skill value before roll total when success levels tie', () => {
  const result = rollOpposedCheck({
    activeTarget: 70,
    passiveTarget: 50,
    rng: sequence([0.4, 0.4, 0.3, 0.3])
  });

  assert.equal(result.active.roll, 44);
  assert.equal(result.passive.roll, 33);
  assert.equal(result.active.successLevel, 'REGULAR');
  assert.equal(result.passive.successLevel, 'REGULAR');
  assert.equal(result.winner, 'active');
});

test('pushed rolls mark fumbles and consequences', () => {
  const pushed = rollPushedCheck({
    target: 60,
    difficulty: 'REGULAR',
    rng: sequence([0.7, 0.7])
  });

  assert.equal(pushed.type, 'pushed_check');
  assert.equal(pushed.pushed, true);
  assert.ok(['success', 'fail', 'fumble'].includes(pushed.consequence));
});

test('pushed roll with roll=100 is always a fumble', () => {
  // total=100 requires ones=0, tens=0 (value 0 → 100)
  const pushed = rollPushedCheck({
    target: 90,
    difficulty: 'REGULAR',
    rng: sequence([0, 0])
  });

  assert.equal(pushed.total, 100);
  assert.equal(pushed.fumbled, true);
  assert.equal(pushed.consequence, 'fumble');
});

test('luck spending reduces roll value and deducts from luck pool', () => {
  // Roll 75, target 60, need 15 points, spend 20 (only 15 needed)
  const result = spendLuck({
    currentLuck: 50,
    rollTotal: 75,
    target: 60,
    amount: 20
  });

  assert.equal(result.type, 'luck_spend');
  assert.equal(result.spent, 15); // Only spends what's needed
  assert.equal(result.rollAfter, 60);
  assert.equal(result.passed, true);
  assert.equal(result.newLuck, 35);
});

test('luck spending fails when insufficient luck points', () => {
  assert.throws(() => {
    spendLuck({ currentLuck: 5, rollTotal: 75, target: 60, amount: 20 });
  }, /Not enough luck/);
});

test('dispatch routes skill checks with target from character sheet', () => {
  const { result, label } = dispatchDiceRoll({
    rollType: 'skill',
    skillName: '侦查',
    skillTarget: 68,
    difficulty: 'HARD'
  });

  assert.equal(result.type, 'skill_check');
  assert.equal(result.skillName, '侦查');
  assert.equal(result.target, 68);
  assert.equal(result.difficulty, 'HARD');
  assert.equal(label, '侦查');
});

test('dispatch routes opposed checks with both targets', () => {
  const { result } = dispatchDiceRoll({
    rollType: 'opposed',
    target: 60,
    passiveTarget: 45
  });

  assert.equal(result.type, 'opposed_check');
  assert.equal(result.active.target, 60);
  assert.equal(result.passive.target, 45);
});

test('dispatch routes pushed checks', () => {
  const { result } = dispatchDiceRoll({
    rollType: 'pushed',
    target: 50,
    difficulty: 'HARD'
  });

  assert.equal(result.type, 'pushed_check');
  assert.equal(result.pushed, true);
});

test('format roll summary for opposed checks', () => {
  const text = formatRollSummary({
    participantName: '林娜',
    label: '对抗',
    result: {
      type: 'opposed_check',
      active: { roll: 22, target: 60, successLevel: 'HARD' },
      passive: { roll: 55, target: 60, successLevel: 'REGULAR' },
      winner: 'active'
    }
  });

  assert.match(text, /林娜/);
  assert.match(text, /对抗检定/);
  assert.match(text, /主动方胜/);
});

test('format roll summary for pushed checks', () => {
  const text = formatRollSummary({
    participantName: '林娜',
    label: '推骰',
    result: {
      type: 'pushed_check',
      total: 45,
      target: 60,
      successLevel: 'REGULAR',
      passed: true,
      pushed: true,
      fumbled: false,
      consequence: 'success'
    }
  });

  assert.match(text, /推骰/);
  assert.match(text, /推骰成功/);
});

test('format roll summary for luck spend', () => {
  const text = formatRollSummary({
    participantName: '林娜',
    label: '幸运',
    result: {
      type: 'luck_spend',
      spent: 15,
      rollBefore: 75,
      rollAfter: 60,
      target: 60,
      passed: true,
      newLuck: 35
    }
  });

  assert.match(text, /消耗 15 点幸运值/);
  assert.match(text, /通过/);
});

test('dispatch routes sanity loss expressions', () => {
  const { result } = dispatchDiceRoll({
    rollType: 'sanity',
    expression: '0/1d6',
    passed: false
  });

  assert.equal(result.type, 'sanity_loss');
  assert.equal(result.passed, false);
});

test('format roll summary for sanity loss', () => {
  const text = formatRollSummary({
    participantName: '林娜',
    label: '理智',
    result: {
      type: 'sanity_loss',
      expression: '1/1d6',
      passed: false,
      total: 4
    }
  });

  assert.match(text, /理智损失/);
  assert.match(text, /4/);
});
