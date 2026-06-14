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

export function rollOpposedCheck({
  activeTarget,
  passiveTarget,
  activeBonusDice = 0,
  activePenaltyDice = 0,
  passiveBonusDice = 0,
  passivePenaltyDice = 0,
  rng = Math.random
}) {
  assertInteger(activeTarget, 'Active target', 0, 100);
  assertInteger(passiveTarget, 'Passive target', 0, 100);

  const activeRoll = rollD100({ bonusDice: activeBonusDice, penaltyDice: activePenaltyDice, rng });
  const passiveRoll = rollD100({ bonusDice: passiveBonusDice, penaltyDice: passivePenaltyDice, rng });

  const activeLevel = cocSuccessLevel(activeRoll.total, activeTarget);
  const passiveLevel = cocSuccessLevel(passiveRoll.total, passiveTarget);

  const rank = { FUMBLE: -1, FAIL: 0, REGULAR: 1, HARD: 2, EXTREME: 3, CRITICAL: 4 };

  let winner = 'tie';
  if (rank[activeLevel] > rank[passiveLevel]) winner = 'active';
  if (rank[passiveLevel] > rank[activeLevel]) winner = 'passive';
  if (winner === 'tie' && activeLevel !== 'FUMBLE' && activeLevel !== 'FAIL') {
    winner = activeRoll.total > passiveRoll.total ? 'active' : activeRoll.total === passiveRoll.total ? 'tie' : 'passive';
  }

  return {
    type: 'opposed_check',
    expression: '1d100',
    active: {
      target: activeTarget,
      roll: activeRoll.total,
      successLevel: activeLevel,
      bonusDice: activeBonusDice,
      penaltyDice: activePenaltyDice
    },
    passive: {
      target: passiveTarget,
      roll: passiveRoll.total,
      successLevel: passiveLevel,
      bonusDice: passiveBonusDice,
      penaltyDice: passivePenaltyDice
    },
    winner
  };
}

export function rollPushedCheck({
  target,
  difficulty = 'REGULAR',
  bonusDice = 0,
  penaltyDice = 0,
  rng = Math.random
}) {
  assertInteger(target, 'Target', 0, 100);
  const roll = rollD100({ bonusDice, penaltyDice, rng });
  const successLevel = cocSuccessLevel(roll.total, target);
  const passed = cocCheckPasses(successLevel, difficulty);
  const fumbled = roll.total === 100 || (target < 50 && roll.total >= 96);
  return {
    ...roll,
    type: 'pushed_check',
    target,
    difficulty: String(difficulty || 'REGULAR').trim().toUpperCase(),
    successLevel,
    passed,
    pushed: true,
    fumbled,
    consequence: fumbled ? 'fumble' : (!passed ? 'fail' : 'success')
  };
}

export function spendLuck({
  currentLuck,
  rollTotal,
  target,
  amount
}) {
  assertInteger(currentLuck, 'Current luck', 0, 100);
  assertInteger(rollTotal, 'Roll total', 1, 100);
  assertInteger(target, 'Target', 0, 100);
  const spend = Number(amount);
  if (!Number.isInteger(spend) || spend <= 0) throw new Error('Luck spend amount must be a positive integer');
  if (spend > currentLuck) throw new Error('Not enough luck points');
  const needed = Math.max(0, rollTotal - target);
  const effectiveSpend = Math.min(spend, needed);
  const newTotal = rollTotal - effectiveSpend;
  return {
    type: 'luck_spend',
    expression: `luck:${effectiveSpend}`,
    previousLuck: currentLuck,
    spent: effectiveSpend,
    requestedSpend: spend,
    rollBefore: rollTotal,
    rollAfter: newTotal,
    target,
    passed: newTotal <= target,
    newLuck: currentLuck - effectiveSpend
  };
}

export function dispatchDiceRoll({ rollType, expression, target, skillName, skillTarget, difficulty, bonusDice, penaltyDice, passed, participant, currentLuck, spendLuckAmount, passiveTarget }) {
  const type = String(rollType || 'expression').toLowerCase();

  if (type === 'skill' || type === 'skill_check') {
    if (!Number.isInteger(skillTarget)) throw new Error('Unknown skill or missing target');
    const check = rollCocCheck({
      target: skillTarget,
      difficulty: difficulty || 'REGULAR',
      bonusDice: Number(bonusDice || 0),
      penaltyDice: Number(penaltyDice || 0)
    });
    return { result: { ...check, type: 'skill_check', skillName }, label: skillName };
  }

  if (type === 'check' || type === 'coc_check') {
    if (!Number.isInteger(target)) throw new Error('target is required');
    const check = rollCocCheck({
      target,
      difficulty: difficulty || 'REGULAR',
      bonusDice: Number(bonusDice || 0),
      penaltyDice: Number(penaltyDice || 0)
    });
    return { result: check, label: '' };
  }

  if (type === 'sanity' || type === 'sanity_loss') {
    if (!expression) throw new Error('expression is required');
    return { result: rollSanityLoss(expression, Boolean(passed)), label: '' };
  }

  if (type === 'opposed' || type === 'opposed_check') {
    if (!Number.isInteger(target)) throw new Error('active target is required');
    if (!Number.isInteger(passiveTarget)) throw new Error('passive target is required');
    const opposed = rollOpposedCheck({
      activeTarget: target,
      passiveTarget,
      activeBonusDice: Number(bonusDice || 0),
      activePenaltyDice: Number(penaltyDice || 0)
    });
    return { result: opposed, label: '' };
  }

  if (type === 'pushed' || type === 'pushed_check') {
    if (!Number.isInteger(target)) throw new Error('target is required');
    return { result: rollPushedCheck({
      target,
      difficulty: difficulty || 'REGULAR',
      bonusDice: Number(bonusDice || 0),
      penaltyDice: Number(penaltyDice || 0)
    }), label: '' };
  }

  if (type === 'luck' || type === 'luck_spend') {
    if (!Number.isInteger(target)) throw new Error('target is required');
    if (!Number.isInteger(currentLuck)) throw new Error('currentLuck is required');
    const spend = spendLuckAmount || Number(String(expression || '0').replace(/^luck:/i, ''));
    const check = rollCocCheck({ target, difficulty: difficulty || 'REGULAR' });
    const luckResult = spendLuck({ currentLuck, rollTotal: check.total, target, amount: spend });
    return { result: { ...check, ...luckResult, type: 'luck_spend' }, label: '' };
  }

  if (!expression) throw new Error('expression is required');
  return { result: rollDiceExpression(expression), label: '' };
}

// 将 NPC 技能值转化为玩家检定的难度等级
// CoC 7e 对抗规则：NPC 越强，玩家需要越高的成功等级
export function npcSkillToDifficulty(npcSkill) {
  const s = Number(npcSkill);
  if (!Number.isFinite(s) || s < 1) return 'REGULAR';
  if (s < 30) return 'REGULAR';
  if (s < 60) return 'HARD';
  if (s < 90) return 'EXTREME';
  return 'EXTREME'; // 90+ NPC needs EXTREME success; CRITICAL always wins
}

// 对抗检定：玩家单方面掷骰，NPC 技能转化为难度
// 返回详细的成功/大成功/大失败信息
export function rollContestedCheck({
  playerSkill,
  npcSkill,
  npcName = 'NPC',
  playerName = '玩家',
  bonusDice = 0,
  penaltyDice = 0,
  rng = Math.random
}) {
  assertInteger(playerSkill, 'Player skill', 0, 100);
  const npcVal = Number(npcSkill);
  const difficulty = npcSkillToDifficulty(npcVal);
  const roll = rollCocCheck({ target: playerSkill, difficulty, bonusDice, penaltyDice, rng });

  const isCritical = roll.successLevel === 'CRITICAL';
  const isFumble = roll.successLevel === 'FUMBLE';

  // CRITICAL always wins, FUMBLE always loses, otherwise difficulty determines
  const playerWins = isCritical ? true : (isFumble ? false : roll.passed);

  return {
    type: 'contested_check',
    expression: '1d100',
    playerName,
    npcName,
    playerSkill,
    npcSkill: npcVal,
    difficulty,
    roll: roll.total,
    successLevel: roll.successLevel,
    isCritical,
    isFumble,
    passed: roll.passed,
    playerWins,
    bonusDice,
    penaltyDice,
    description: playerWins
      ? (isCritical ? '🎯 大成功！完美通过' : `${roll.successLevel} 成功，对抗通过`)
      : (isFumble ? '💀 大失败！严重失误' : `${roll.successLevel}，对抗失败`)
  };
}

export function formatRollSummary({ participantName, label, result }) {
  const prefix = `${participantName} · ${label || '骰子'}`;

  if (result.type === 'coc_check' || result.type === 'skill_check') {
    const skill = result.skillName ? `${result.skillName} ` : '';
    const lines = [`${prefix}：${skill}1d100 = ${result.total} / ${result.target}，${result.successLevel}，${result.passed ? '通过' : '未通过'}`];
    if (result.bonusDice) lines.push(`（${result.bonusDice} 奖励骰）`);
    if (result.penaltyDice) lines.push(`（${result.penaltyDice} 惩罚骰）`);
    if (result.luckSpend) lines.push(`消耗 ${result.luckSpend.spent} 点幸运值，${result.luckSpend.passed ? '通过' : '仍失败'}`);
    return lines.join(' ');
  }

  if (result.type === 'opposed_check') {
    return [
      `${prefix}：对抗检定`,
      `主动方 1d100 = ${result.active.roll} / ${result.active.target}，${result.active.successLevel}`,
      `被动方 1d100 = ${result.passive.roll} / ${result.passive.target}，${result.passive.successLevel}`,
      `结果：${result.winner === 'active' ? '主动方胜' : result.winner === 'passive' ? '被动方胜' : '平局'}`
    ].join(' · ');
  }

  if (result.type === 'pushed_check') {
    return [
      `${prefix}：推骰 1d100 = ${result.total} / ${result.target}，${result.successLevel}`,
      result.consequence === 'fumble' ? '大失败！' : result.passed ? '推骰成功' : '推骰失败'
    ].join(' · ');
  }

  if (result.type === 'luck_spend') {
    return `${prefix}：消耗 ${result.spent} 点幸运值，${result.rollBefore}→${result.rollAfter} / ${result.target}，${result.passed ? '通过' : '未通过'}，剩余 ${result.newLuck}`;
  }

  if (result.type === 'sanity_loss') {
    return `${prefix}：理智损失 ${result.expression}，结果 ${result.total}`;
  }

  const modifier = result.modifier ? ` ${result.modifier > 0 ? '+' : '-'} ${Math.abs(result.modifier)}` : '';
  return `${prefix}：${result.expression} = [${result.rolls.join(', ')}]${modifier}，合计 ${result.total}`;
}
