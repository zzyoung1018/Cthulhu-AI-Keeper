const CHARACTERISTIC_KEYS = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'Luck'];

const DEFAULT_CHARACTERISTICS = {
  STR: 50,
  CON: 50,
  SIZ: 50,
  DEX: 50,
  APP: 50,
  INT: 50,
  POW: 50,
  EDU: 50,
  Luck: 50
};

const DEFAULT_SKILLS = {
  会计: 5,
  人类学: 1,
  估价: 5,
  考古学: 1,
  魅惑: 15,
  攀爬: 20,
  信用评级: 0,
  克苏鲁神话: 0,
  乔装: 5,
  闪避: 25,
  驾驶汽车: 20,
  电气维修: 10,
  话术: 5,
  急救: 30,
  驾驶: 1,
  历史: 5,
  化学: 1,
  恐吓: 15,
  跳跃: 20,
  母语: 50,
  法律: 5,
  格斗: 25,
  工艺: 5,
  图书馆使用: 20,
  聆听: 20,
  锁匠: 1,
  机械维修: 10,
  医学: 1,
  博物学: 10,
  导航: 10,
  神秘学: 5,
  说服: 10,
  精神分析: 1,
  心理学: 10,
  骑术: 5,
  妙手: 10,
  摄影: 5,
  射击: 20,
  侦查: 25,
  潜行: 20,
  游泳: 20,
  投掷: 20,
  外语: 1,
  物理学: 1,
  药学: 1,
  追踪: 10
};

const TEXT_FIELDS = [
  'equipment',
  'assets',
  'relationships',
  'beliefs',
  'locations',
  'scarsTraumas',
  'encounteredMonsters',
  'clues',
  'privateNotes'
];

function parseSource(source) {
  if (!source) return {};
  if (typeof source === 'string') {
    try {
      return JSON.parse(source);
    } catch {
      return {};
    }
  }
  return typeof source === 'object' ? source : {};
}

function trimText(value, maxLength = 4000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function numberInRange(value, fallback, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeInvestigator(value = {}, fallback = {}) {
  return {
    name: trimText(value.name || fallback.characterName || '', 80),
    playerName: trimText(value.playerName || fallback.displayName || '', 80),
    occupation: trimText(value.occupation, 80),
    age: trimText(value.age, 20),
    residence: trimText(value.residence, 120),
    birthplace: trimText(value.birthplace, 120)
  };
}

function normalizeCharacteristics(value = {}) {
  return Object.fromEntries(CHARACTERISTIC_KEYS.map((key) => [
    key,
    numberInRange(value[key], DEFAULT_CHARACTERISTICS[key], 0, 100)
  ]));
}

function normalizeSkills(value = {}) {
  const skills = { ...DEFAULT_SKILLS };
  for (const [name, score] of Object.entries(value || {})) {
    const skillName = trimText(name, 80);
    if (!skillName) continue;
    skills[skillName] = numberInRange(score, skills[skillName] ?? 0, 0, 100);
  }
  return Object.fromEntries(Object.entries(skills).sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN')));
}

function normalizeSkillAllocations(value = {}, skills = {}) {
  const allocations = {};
  if (!value || typeof value !== 'object') return allocations;

  for (const [name, allocation] of Object.entries(value)) {
    const skillName = trimText(name, 80);
    if (!skillName || !allocation || typeof allocation !== 'object') continue;

    const base = DEFAULT_SKILLS[skillName] ?? 0;
    const total = numberInRange(skills[skillName], base, 0, 100);
    const maxSpent = Math.max(0, total - base);
    let occupation = numberInRange(allocation.occupation, 0, 0, maxSpent);
    let interest = numberInRange(allocation.interest, 0, 0, maxSpent);

    if (occupation + interest > maxSpent) {
      interest = Math.max(0, maxSpent - occupation);
      occupation = Math.min(occupation, maxSpent);
    }

    if (occupation > 0 || interest > 0) {
      allocations[skillName] = { occupation, interest };
    }
  }

  return Object.fromEntries(Object.entries(allocations).sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN')));
}

function normalizeWeapons(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((weapon) => ({
    name: trimText(weapon?.name, 80),
    damage: trimText(weapon?.damage, 80),
    attacks: trimText(weapon?.attacks, 40),
    range: trimText(weapon?.range, 40),
    ammo: trimText(weapon?.ammo, 40),
    malfunction: trimText(weapon?.malfunction, 40)
  })).filter((weapon) => weapon.name || weapon.damage);
}

function damageBonusAndBuild(str, siz) {
  const sum = str + siz;
  if (sum <= 64) return { damageBonus: '-2', build: -2 };
  if (sum <= 84) return { damageBonus: '-1', build: -1 };
  if (sum <= 124) return { damageBonus: '0', build: 0 };
  if (sum <= 164) return { damageBonus: '+1d4', build: 1 };
  if (sum <= 204) return { damageBonus: '+1d6', build: 2 };
  const build = Math.floor((sum - 205) / 80) + 3;
  return { damageBonus: `+${build - 1}d6`, build };
}

export function calculateDerived(characteristics = {}, status = {}) {
  const values = normalizeCharacteristics(characteristics);
  const hp = Math.max(1, Math.floor((values.CON + values.SIZ) / 10));
  const mp = Math.max(0, Math.floor(values.POW / 5));
  const san = Math.max(0, values.POW);
  const mov = values.STR < values.SIZ && values.DEX < values.SIZ
    ? 7
    : values.STR > values.SIZ && values.DEX > values.SIZ
      ? 9
      : 8;
  return {
    hp,
    mp,
    san,
    luck: values.Luck,
    mov,
    ...damageBonusAndBuild(values.STR, values.SIZ),
    currentHp: numberInRange(status.hp, hp, 0, hp),
    currentMp: numberInRange(status.mp, mp, 0, mp),
    currentSan: numberInRange(status.san, san, 0, 99),
    currentLuck: numberInRange(status.luck, values.Luck, 0, 100)
  };
}

function normalizeStatus(value = {}, characteristics = DEFAULT_CHARACTERISTICS) {
  const derived = calculateDerived(characteristics, {});
  return {
    hp: numberInRange(value.hp, derived.hp, 0, derived.hp),
    mp: numberInRange(value.mp, derived.mp, 0, derived.mp),
    san: numberInRange(value.san, derived.san, 0, 99),
    luck: numberInRange(value.luck, derived.luck, 0, 100)
  };
}

export function normalizeCharacterSheet(source, fallback = {}) {
  const input = parseSource(source);
  const characteristics = normalizeCharacteristics(input.characteristics);
  const status = normalizeStatus(input.status, characteristics);
  const skills = normalizeSkills(input.skills);
  const hasSkillAllocations = input &&
    typeof input === 'object' &&
    Object.hasOwn(input, 'skillAllocations') &&
    input.skillAllocations &&
    typeof input.skillAllocations === 'object';
  const sheet = {
    version: 1,
    ruleset: 'coc7e',
    investigator: normalizeInvestigator(input.investigator, fallback),
    characteristics,
    status,
    skills,
    skillAllocations: hasSkillAllocations ? normalizeSkillAllocations(input.skillAllocations, skills) : null,
    weapons: normalizeWeapons(input.weapons)
  };

  for (const field of TEXT_FIELDS) {
    sheet[field] = trimText(input[field], field === 'privateNotes' ? 8000 : 4000);
  }

  return sheet;
}

export function hasReadyCharacter(sheet) {
  const normalized = normalizeCharacterSheet(sheet);
  return Boolean(normalized.investigator.name);
}

export function getSkillTarget(sheet, skillName) {
  const normalized = normalizeCharacterSheet(sheet);
  const targetName = trimText(skillName, 80);
  if (!targetName) return null;
  if (Object.hasOwn(normalized.skills, targetName)) {
    return normalized.skills[targetName];
  }

  const found = Object.entries(normalized.skills).find(([name]) => name.toLowerCase() === targetName.toLowerCase());
  return found ? found[1] : null;
}

export function formatCharacterState(sheet) {
  const normalized = normalizeCharacterSheet(sheet);
  const derived = calculateDerived(normalized.characteristics, normalized.status);
  return [
    `HP ${derived.currentHp}/${derived.hp}`,
    `MP ${derived.currentMp}/${derived.mp}`,
    `SAN ${derived.currentSan}/${derived.san}`,
    `Luck ${derived.currentLuck}`,
    `MOV ${derived.mov}`,
    `DB ${derived.damageBonus}`,
    `Build ${derived.build}`
  ].join(' · ');
}

export function summarizeCharacterSheet(sheet) {
  const normalized = normalizeCharacterSheet(sheet);
  const derived = calculateDerived(normalized.characteristics, normalized.status);
  const coreSkills = ['侦查', '聆听', '图书馆使用', '心理学', '急救', '闪避']
    .filter((name) => Object.hasOwn(normalized.skills, name))
    .map((name) => `${name}${normalized.skills[name]}`)
    .join('、');
  const characteristics = CHARACTERISTIC_KEYS.map((key) => `${key} ${normalized.characteristics[key]}`).join('、');
  return [
    `调查员：${normalized.investigator.name || '未命名'}`,
    normalized.investigator.occupation ? `职业：${normalized.investigator.occupation}` : '',
    `属性：${characteristics}`,
    `状态：${formatCharacterState(normalized)}`,
    coreSkills ? `核心技能：${coreSkills}` : '',
    normalized.weapons.length ? `武器：${normalized.weapons.map((weapon) => `${weapon.name} ${weapon.damage}`).join('、')}` : '',
    `派生：MOV ${derived.mov}，DB ${derived.damageBonus}，Build ${derived.build}`
  ].filter(Boolean).join('\n');
}

function flatten(value, prefix = '', output = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, output));
    if (value.length === 0 && prefix) output[prefix] = [];
    return output;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }

  if (prefix) output[prefix] = value;
  return output;
}

export function diffCharacterSheets(before, after) {
  const oldFlat = flatten(normalizeCharacterSheet(before));
  const newFlat = flatten(normalizeCharacterSheet(after));
  const keys = [...new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)])].sort();
  return keys
    .filter((key) => JSON.stringify(oldFlat[key]) !== JSON.stringify(newFlat[key]))
    .map((key) => ({
      fieldPath: key,
      oldValue: oldFlat[key] ?? null,
      newValue: newFlat[key] ?? null
    }));
}

export { CHARACTERISTIC_KEYS, DEFAULT_SKILLS, TEXT_FIELDS };
