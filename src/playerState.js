// Per-player state JSON generator.
// Each player gets a detailed state snapshot sent to AI as context.

import { calculateDerived, normalizeCharacterSheet } from './character.js';

export function buildPlayerState(participant, room, allParticipants = []) {
  const sheet = normalizeCharacterSheet(participant.characterSheet || {}, {
    displayName: participant.displayName,
    characterName: participant.characterName
  });
  const derived = calculateDerived(sheet.characteristics, sheet.status);
  const inv = sheet.investigator || {};

  // Party detection
  const otherPlayers = allParticipants.filter((p) => p.playerId !== participant.playerId);
  const sameLocationPlayers = otherPlayers.filter((p) =>
    p.stateSceneId && p.stateSceneId === participant.stateSceneId
  );

  return {
    playerId: participant.playerId,
    displayName: participant.displayName,
    characterName: inv.name || participant.characterName || '未命名',
    occupation: inv.occupation || '',
    age: inv.age || '',
    residence: inv.residence || '',

    // 生命状态
    status: {
      hp: { current: derived.currentHp, max: derived.hp },
      mp: { current: derived.currentMp, max: derived.mp },
      san: { current: derived.currentSan, max: derived.san },
      luck: { current: derived.currentLuck, max: sheet.characteristics.Luck || 50 }
    },

    // 属性
    characteristics: sheet.characteristics,

    // 派生
    derived: {
      mov: derived.mov,
      damageBonus: derived.damageBonus,
      build: derived.build
    },

    // 当前位置
    location: {
      sceneId: participant.stateSceneId || '',
      sceneName: participant.stateSceneName || '',
      updatedAt: participant.stateLocationUpdatedAt || ''
    },

    // 组队状态
    party: {
      isGrouped: sameLocationPlayers.length > 0,
      groupedWith: sameLocationPlayers.map((p) => ({
        playerId: p.playerId,
        characterName: p.characterName || p.displayName
      })),
      allPlayersAtLocation: [participant, ...sameLocationPlayers].map((p) => ({
        playerId: p.playerId,
        characterName: p.characterName || p.displayName,
        displayName: p.displayName
      }))
    },

    // 技能（仅含值>0的，完整发送给 AI 以便普通检定可覆盖所有技能）
    skills: Object.fromEntries(
      Object.entries(sheet.skills || {})
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
    ),

    // 武器
    weapons: (sheet.weapons || []).map((w) => ({
      name: w.name,
      damage: w.damage,
      range: w.range || ''
    })).filter((w) => w.name),

    // 装备
    equipment: sheet.equipment || '',

    // 状态标记
    conditions: {
      isUnconscious: derived.currentHp <= 0,
      isInsane: derived.currentSan <= 0,
      isWounded: derived.currentHp < Math.floor(derived.hp / 2),
      isReady: participant.isReady
    },

    // 已发现线索
    discoveredClues: participant.discoveredClues || [],

    // 已知 NPC
    knownNpcs: participant.knownNpcs || [],

    // 私人笔记
    privateNotes: sheet.privateNotes || ''
  };
}

// 汇总所有玩家状态
export function buildAllPlayerStates(participants, room) {
  return participants.map((p) => buildPlayerState(p, room, participants));
}

// 生成简短文本摘要（用于 prompt 的非 JSON 部分）
export function summarizePlayerState(state) {
  const s = state.status;
  return [
    `${state.characterName}（${state.occupation || '无职业'}）`,
    `HP ${s.hp.current}/${s.hp.max} · MP ${s.mp.current}/${s.mp.max} · SAN ${s.san.current}/${s.san.max} · Luck ${s.luck.current}/${s.luck.max}`,
    `MOV ${state.derived.mov} · DB ${state.derived.damageBonus} · Build ${state.derived.build}`,
    state.location.sceneName ? `位置：${state.location.sceneName}` : '',
    state.party.isGrouped
      ? `同行：${state.party.groupedWith.map((p) => p.characterName).join('、')}`
      : '独自行动',
    state.conditions.isWounded ? '⚠ 重伤' : '',
    state.conditions.isUnconscious ? '💀 昏迷' : '',
    state.conditions.isInsane ? '🌀 疯狂' : ''
  ].filter(Boolean).join(' | ');
}
