const DICE_EXPRESSION = /^(\d*)d(\d+)([+-]\d+)?$/i;
const FIXED_NUMBER = /^\d+$/;

function randomInt(max, rng = Math.random) {
  return Math.floor(rng() * max) + 1;
}

function assertInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
}

export function parseDiceExpression(expression) {
  const text = String(expression || '').trim().replace(/\s+/g, '');
  const match = DICE_EXPRESSION.exec(text);
  if (!match) throw new Error('Invalid dice expression');

  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;

  assertInteger(count, 'Dice count', 1, 100);
  assertInteger(sides, 'Dice sides', 2, 1000);
  assertInteger(modifier, 'Dice modifier', -10000, 10000);

  return { expression: `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : String(modifier)) : ''}`, count, sides, modifier };
}

export function rollDiceExpression(expression, rng = Math.random) {
  const parsed = parseDiceExpression(expression);
  const rolls = Array.from({ length: parsed.count }, () => randomInt(parsed.sides, rng));
  const subtotal = rolls.reduce((total, roll) => total + roll, 0);
  return {
    type: 'expression',
    expression: parsed.expression,
    count: parsed.count,
    sides: parsed.sides,
    modifier: parsed.modifier,
    rolls,
    subtotal,
    total: subtotal + parsed.modifier
  };
}

function percentileFromTens(tens, ones) {
  const value = tens * 10 + ones;
  return value === 0 ? 100 : value;
}

export function rollD100({ bonusDice = 0, penaltyDice = 0, rng = Math.random } = {}) {
  assertInteger(bonusDice, 'Bonus dice', 0, 2);
  assertInteger(penaltyDice, 'Penalty dice', 0, 2);

  const netDice = bonusDice - penaltyDice;
  const extraTens = Math.abs(netDice);
  const ones = randomInt(10, rng) - 1;
  const tensDice = Array.from({ length: extraTens + 1 }, () => randomInt(10, rng) - 1);
  const candidates = tensDice.map((tens) => percentileFromTens(tens, ones));
  const total = netDice >= 0 ? Math.min(...candidates) : Math.max(...candidates);

  return {
    type: 'd100',
    expression: '1d100',
    bonusDice,
    penaltyDice,
    ones,
    tensDice,
    candidates,
    total
  };
}

export function cocSuccessLevel(roll, target) {
  assertInteger(roll, 'Roll', 1, 100);
  assertInteger(target, 'Target', 0, 100);

  if (roll === 1) return 'CRITICAL';
  if ((target < 50 && roll >= 96) || roll === 100) return 'FUMBLE';
  if (roll > target) return 'FAIL';
  if (roll <= Math.floor(target / 5)) return 'EXTREME';
  if (roll <= Math.floor(target / 2)) return 'HARD';
  return 'REGULAR';
}

export function cocCheckPasses(level, difficulty = 'REGULAR') {
  const required = String(difficulty || 'REGULAR').trim().toUpperCase();
  const ranks = {
    FUMBLE: -1,
    FAIL: 0,
    REGULAR: 1,
    HARD: 2,
    EXTREME: 3,
    CRITICAL: 4
  };
  const requiredRank = {
    REGULAR: 1,
    NORMAL: 1,
    HARD: 2,
    EXTREME: 3
  }[required];

  if (!requiredRank) throw new Error('Invalid check difficulty');
  return ranks[level] >= requiredRank;
}

export function rollCocCheck({ target, difficulty = 'REGULAR', bonusDice = 0, penaltyDice = 0, rng = Math.random }) {
  assertInteger(target, 'Target', 0, 100);
  const roll = rollD100({ bonusDice, penaltyDice, rng });
  const successLevel = cocSuccessLevel(roll.total, target);
  return {
    ...roll,
    type: 'coc_check',
    target,
    difficulty: String(difficulty || 'REGULAR').trim().toUpperCase(),
    successLevel,
    passed: cocCheckPasses(successLevel, difficulty)
  };
}

function resolveLossSide(side, rng) {
  const text = String(side || '').trim();
  if (FIXED_NUMBER.test(text)) {
    return { expression: text, total: Number(text), fixed: true };
  }
  return rollDiceExpression(text, rng);
}

export function rollSanityLoss(expression, passed, rng = Math.random) {
  const [successSide, failureSide] = String(expression || '').split('/').map((part) => part.trim());
  if (!successSide || !failureSide) throw new Error('Invalid sanity loss expression');

  const selectedExpression = passed ? successSide : failureSide;
  const selected = resolveLossSide(selectedExpression, rng);
  return {
    type: 'sanity_loss',
    expression: `${successSide}/${failureSide}`,
    passed: Boolean(passed),
    selectedExpression,
    selected,
    total: selected.total
  };
}
