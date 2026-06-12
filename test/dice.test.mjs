import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cocCheckPasses,
  cocSuccessLevel,
  parseDiceExpression,
  rollCocCheck,
  rollD100,
  rollDiceExpression,
  rollSanityLoss
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
