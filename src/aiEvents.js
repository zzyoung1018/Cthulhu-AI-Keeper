// Apply validated AI structured events to room state (dice rolls, messages, character changes).

import { getCheckTarget, getSkillTarget } from './character.js';
import { dispatchDiceRoll, rollContestedCheck } from './dice.js';

export function createEventApplier({ database, hub, addAiLog }) {

  function resolveDefaultCheckPlayerId(state, taskUid) {
    try {
      const task = database.getAiTask(taskUid);
      if (task?.requestedByPlayerId) return task.requestedByPlayerId;
    } catch {
      // Fall through to latest action.
    }

    const latestAction = [...(state.messages || [])]
      .reverse()
      .find((message) => message.authorType === 'player' && message.messageType === 'ACTION' && message.playerId);
    return latestAction?.playerId || state.participants?.[0]?.playerId || '';
  }

  function normalizeCheckDifficulty(value) {
    const difficulty = String(value || 'REGULAR').trim().toUpperCase();
    return difficulty === 'NORMAL' ? 'REGULAR' : difficulty;
  }

  function difficultyText(value) {
    return {
      REGULAR: '常规',
      HARD: '困难',
      EXTREME: '极难'
    }[normalizeCheckDifficulty(value)] || normalizeCheckDifficulty(value);
  }

  function successText(result) {
    return result.passed ? '成功' : '失败';
  }

  function applyRequiredCheck(code, check, defaultPlayerId) {
    const targetPlayerId = check.targetPlayerId || defaultPlayerId;
    if (!targetPlayerId) return;

    const { participant } = database.getParticipant(code, targetPlayerId);
    if (!participant) return;

    const target = getCheckTarget(participant.characterSheet, check.skill);
    if (!target || !Number.isInteger(target.target)) return;

    const difficulty = normalizeCheckDifficulty(check.difficulty);
    const { result } = dispatchDiceRoll({
      rollType: 'skill',
      skillName: target.label,
      skillTarget: target.target,
      difficulty
    });
    const enrichedResult = {
      ...result,
      checkType: target.type,
      skillName: target.label
    };
    const playerName = participant.characterName || participant.displayName;

    const roll = database.createDiceRoll({
      code,
      playerId: targetPlayerId,
      rollType: enrichedResult.type,
      expression: enrichedResult.expression,
      label: target.label,
      result: enrichedResult
    });

    const msg = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '必要检定',
      content: [
        `🎲 必要检定：${playerName} 的 ${target.label}(${target.target})`,
        `难度：${difficultyText(difficulty)}`,
        check.reason ? `原因：${check.reason}` : '',
        `1d100 = ${enrichedResult.total} → ${enrichedResult.successLevel}（${successText(enrichedResult)}）`,
        check.playerHint || ''
      ].filter(Boolean).join('\n'),
      status: 'complete'
    });

    hub.broadcast(code, 'message_created', { message: msg });
    hub.broadcast(code, 'dice_rolled', { roll });
  }

  function applyStateChange(code, change) {
    if (!change.targetPlayerId || !change.fieldPath) return;

    const { participant } = database.getParticipant(code, change.targetPlayerId);
    if (!participant) return;

    const sheet = structuredClone(participant.characterSheet || {});
    const parts = change.fieldPath.split('.');

    if (parts[0] === 'status' && parts[1]) {
      sheet.status = sheet.status || {};
      const resource = parts[1];
      const newValue = Number(change.newValue);
      if (!Number.isFinite(newValue)) return;

      const limits = { hp: 100, mp: 100, san: 99, luck: 100 };
      const max = limits[resource] || 100;
      sheet.status[resource] = Math.max(0, Math.min(max, Math.round(newValue)));
    } else if (parts[0] === 'characteristics' && parts[1]) {
      sheet.characteristics = sheet.characteristics || {};
      const newValue = Number(change.newValue);
      if (!Number.isFinite(newValue)) return;
      sheet.characteristics[parts[1]] = Math.max(0, Math.min(100, Math.round(newValue)));
    } else {
      return;
    }

    database.updateCharacterSheet({
      code,
      playerId: change.targetPlayerId,
      displayName: participant.displayName,
      characterSheet: sheet
    });

    // Notify the affected player
    const msg = database.createMessage({
      code,
      authorType: 'system',
      messageType: 'SYSTEM',
      displayName: '状态变更',
      content: `${change.reason || 'AI DM 提议的状态变更'}：${change.fieldPath} → ${change.newValue}`,
      status: 'complete',
      privateTarget: change.targetPlayerId
    });
    hub.sendTo(code, change.targetPlayerId, 'message_created', { message: msg });
  }

  function applyStructuredEvents(code, taskUid, events, dmMessageId, moduleJson = null) {
    const state = database.getRoomState(code, 80);
    const defaultPlayerId = resolveDefaultCheckPlayerId(state, taskUid);

    // Process required checks against static obstacles or the environment.
    if (Array.isArray(events.required_checks)) {
      for (const check of events.required_checks) {
        try {
          applyRequiredCheck(code, check, defaultPlayerId);
        } catch (checkError) {
          console.error('[ai-output] required check failed:', check.skill, checkError.message);
        }
      }
    }

    // Process opposed/contested checks (all types: social, stealth, combat, item)
    if (Array.isArray(events.opposed_checks)) {
      for (const opp of events.opposed_checks) {
        try {
          const { participant } = database.getParticipant(code, opp.activePlayerId);
          if (!participant) continue;

          const playerSkill = getSkillTarget(participant.characterSheet, opp.activeSkill);
          if (!Number.isInteger(playerSkill)) continue;

          // NPC passive skill: try module data first, fallback based on NPC role
          let npcSkill = 50; // default
          if (moduleJson?.npcs) {
            const npc = moduleJson.npcs.find((n) =>
              n.name === opp.passiveNpcName || n.npc_id === opp.passiveNpcName
            );
            if (npc) {
              if (npc.skills?.[opp.passiveSkill]) {
                npcSkill = Number(npc.skills[opp.passiveSkill]);
              } else if (npc.attributes?.[opp.passiveSkill]) {
                npcSkill = Number(npc.attributes[opp.passiveSkill]);
              } else if (npc.role) {
                // Estimate based on role
                const role = String(npc.role).toLowerCase();
                if (/警察|侦探|保安/.test(role)) npcSkill = 65;
                else if (/干部|医生|教师/.test(role)) npcSkill = 55;
                else if (/农民|工人|司机/.test(role)) npcSkill = 40;
                else if (/老人|小孩/.test(role)) npcSkill = 35;
              }
            }
          }

          const playerName = participant.characterName || participant.displayName;
          const check = rollContestedCheck({
            playerSkill,
            npcSkill,
            playerName,
            npcName: opp.passiveNpcName || 'NPC',
            defenderIsNpc: opp.contestType !== 'combat' // 社交/潜行中 NPC 是防守方
          });

          const contestTypeLabel = {
            social: '🎭 社交对抗', stealth: '🥷 潜行对抗',
            combat: '⚔️ 战斗对抗', item: '🔧 技术对抗'
          }[opp.contestType] || '⚡ 对抗检定';

          const playerWon = check.winner === 'player';
          const detailLines = [
            `${contestTypeLabel}：${playerName} 的 ${opp.activeSkill}(${playerSkill}) vs ${opp.passiveNpcName} 的 ${opp.passiveSkill}(${npcSkill})`,
            `调查员 1d100 = ${check.player.roll} → ${check.player.successLevel}${check.player.isCritical ? ' 🎯大成功！' : ''}${check.player.isFumble ? ' 💀大失败！' : ''}`,
            `${opp.passiveNpcName} 1d100 = ${check.npc.roll} → ${check.npc.successLevel}${check.npc.isCritical ? ' 🎯大成功！' : ''}${check.npc.isFumble ? ' 💀大失败！' : ''}`,
            `判定：${check.reason}`,
            `结果：${playerWon ? '调查员胜' : (check.winner === 'npc' ? 'NPC胜' : '平局')}`
          ];

          if (playerWon && opp.successResult) {
            detailLines.push('', opp.successResult);
          } else if (!playerWon && opp.failureResult) {
            detailLines.push('', opp.failureResult);
          }

          const roll = database.createDiceRoll({
            code,
            playerId: opp.activePlayerId,
            rollType: 'contested_check',
            expression: '1d100',
            label: `${opp.activeSkill} vs ${opp.passiveNpcName}(${opp.passiveSkill})`,
            result: check
          });

          const msg = database.createMessage({
            code,
            authorType: 'system',
            messageType: 'SYSTEM',
            displayName: '对抗检定',
            content: detailLines.join('\n'),
            status: 'complete'
          });

          hub.broadcast(code, 'message_created', { message: msg });
          hub.broadcast(code, 'dice_rolled', { roll });
        } catch (oppError) {
          console.error('[ai-output] opposed check failed:', oppError.message);
        }
      }
    }

    // Apply state changes
    if (Array.isArray(events.proposed_state_changes)) {
      for (const change of events.proposed_state_changes) {
        try {
          applyStateChange(code, change);
        } catch (stateError) {
          console.error('[ai-output] state change failed:', change.fieldPath, stateError.message);
        }
      }
    }

    // Reveal clues as system messages
    if (Array.isArray(events.clues_revealed)) {
      for (const clue of events.clues_revealed) {
        const clueMsg = database.createMessage({
          code,
          authorType: 'system',
          messageType: 'SYSTEM',
          displayName: '线索',
          content: `🔍 ${clue.source ? `[${clue.source}] ` : ''}${clue.content}`,
          status: 'complete',
          privateTarget: clue.privateTo || ''
        });
        if (clue.privateTo) {
          hub.sendTo(code, clue.privateTo, 'message_created', { message: clueMsg });
        } else {
          hub.broadcast(code, 'message_created', { message: clueMsg });
        }
      }
    }

    // Update summary
    if (events.summary_update && typeof events.summary_update === 'string') {
      try {
        database.forceUpdateSummary(state.room.id, events.summary_update);
      } catch (summaryError) {
        console.error('[ai-output] summary update failed:', summaryError.message);
      }
    }

    // Handle scene change
    if (events.scene_change && events.scene_change.newScene) {
      const sceneMsg = database.createMessage({
        code,
        authorType: 'system',
        messageType: 'SYSTEM',
        displayName: '场景',
        content: [
          `📍 场景：${events.scene_change.newScene}`,
          events.scene_change.newLocation ? `地点：${events.scene_change.newLocation}` : '',
          events.scene_change.timeElapsed ? `时间：${events.scene_change.timeElapsed}` : '',
          events.scene_change.description || ''
        ].filter(Boolean).join('\n'),
        status: 'complete'
      });
      hub.broadcast(code, 'message_created', { message: sceneMsg });

      // Update scene state in room
      try {
        database.forceUpdateSummary(state.room.id,
          (state.room.summary || '') + '\n' + (events.summary_update || events.scene_change.description || ''));
      } catch { /* non-critical */ }
    }

    // NPC state changes
    if (Array.isArray(events.npc_state_changes) && events.npc_state_changes.length > 0) {
      for (const npc of events.npc_state_changes) {
        const npcMsg = database.createMessage({
          code,
          authorType: 'system',
          messageType: 'SYSTEM',
          displayName: 'NPC',
          content: [
            `👤 ${npc.npcName}`,
            npc.disposition ? `态度：${npc.disposition}` : '',
            npc.location ? `位置：${npc.location}` : '',
            npc.isPresent === false ? '（已离场）' : '',
            npc.notes || ''
          ].filter(Boolean).join(' · '),
          status: 'complete'
        });
        hub.broadcast(code, 'message_created', { message: npcMsg });
      }
    }

    // Broadcast updated room state
    const updatedState = database.getRoomState(code, 80);
    hub.broadcast(code, 'room_state', updatedState);
  }

  return { applyStructuredEvents };
}
