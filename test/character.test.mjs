import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDerived,
  diffCharacterSheets,
  getSkillTarget,
  normalizeCharacterSheet
} from '../src/character.js';

test('normalizes CoC 7e character sheets and calculates derived values', () => {
  const sheet = normalizeCharacterSheet({
    investigator: { name: '林娜', occupation: '记者' },
    characteristics: {
      STR: 65,
      CON: 55,
      SIZ: 60,
      DEX: 70,
      POW: 45,
      Luck: 30
    },
    skills: {
      侦查: 72
    },
    skillAllocations: {
      侦查: { occupation: 40, interest: 7 }
    }
  });

  const derived = calculateDerived(sheet.characteristics, sheet.status);
  assert.equal(sheet.investigator.name, '林娜');
  assert.equal(derived.hp, 11);
  assert.equal(derived.mp, 9);
  assert.equal(derived.san, 45);
  assert.equal(derived.mov, 9);
  assert.equal(derived.damageBonus, '+1d4');
  assert.equal(derived.build, 1);
  assert.equal(getSkillTarget(sheet, '侦查'), 72);
  assert.deepEqual(sheet.skillAllocations.侦查, { occupation: 40, interest: 7 });
});

test('distinguishes legacy sheets without saved skill allocations', () => {
  const legacy = normalizeCharacterSheet({
    skills: { 侦查: 72 }
  });
  const saved = normalizeCharacterSheet({
    skills: { 侦查: 72 },
    skillAllocations: {}
  });

  assert.equal(legacy.skillAllocations, null);
  assert.deepEqual(saved.skillAllocations, {});
});

test('diffs individual character fields for history records', () => {
  const before = normalizeCharacterSheet({
    investigator: { name: '旧名' },
    characteristics: { STR: 50 },
    skills: { 侦查: 25 }
  });
  const after = normalizeCharacterSheet({
    investigator: { name: '新名' },
    characteristics: { STR: 65 },
    skills: { 侦查: 60 }
  });

  const paths = diffCharacterSheets(before, after).map((change) => change.fieldPath);
  assert.ok(paths.includes('investigator.name'));
  assert.ok(paths.includes('characteristics.STR'));
  assert.ok(paths.includes('skills.侦查'));
});
