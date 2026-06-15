// Round records and rollback system.
// Each AI round creates a transaction record capturing the pre-state so the
// owner can roll back the last AI reply, restoring character and scene state.

import { HttpError } from './errors.js';

export function createRoundRecord({ database, roomId, aiTaskUid, dmMessageId, preState }) {
  const record = database.createRoundState({
    roomId,
    aiTaskUid,
    dmMessageId,
    snapshotJson: JSON.stringify(preState)
  });
  return record;
}

export function capturePreRoundState(roomState) {
  return {
    participants: roomState.participants.map((p) => ({
      playerId: p.playerId,
      characterSheet: structuredClone(p.characterSheet || {}),
      characterRevision: p.characterRevision || 0
    })),
    summary: roomState.room.summary || '',
    sceneState: roomState.room.sceneState || '{}'
  };
}

export function computeRollback({
  database,
  roomCode,
  playerId,
  roundId = null,
  taskUid = ''
}) {
  const room = database.getRoomByCode(roomCode);
  if (!room) throw new HttpError(404, 'Room not found');
  if (room.ownerPlayerId !== playerId) throw new HttpError(403, 'Only the room owner can roll back');

  const round = taskUid
    ? database.getRoundStateByTaskUid(room.id, taskUid)
    : database.getRoundState(roundId);
  if (!round || round.roomId !== room.id) throw new HttpError(404, 'Round not found');
  if (round.isRolledBack) throw new HttpError(409, 'Round already rolled back');

  const preState = JSON.parse(round.snapshotJson);

  // Restore each participant's character sheet and revision
  for (const snap of preState.participants) {
    const participant = database.getParticipantByPlayerId(room.id, snap.playerId);
    if (!participant) continue;
    database.restoreCharacterSnapshot({
      participantId: participant.id,
      characterSheet: snap.characterSheet,
      characterRevision: snap.characterRevision
    });
  }

  // Restore story summary
  if (preState.summary !== undefined) {
    database.forceUpdateSummary(room.id, preState.summary);
  }

  if (preState.sceneState !== undefined) {
    database.forceUpdateSceneState(room.id, preState.sceneState);
  }

  // Mark the DM message as rolled back
  if (round.dmMessageId) {
    database.markMessageRolledBack(round.dmMessageId);
  }

  // Mark round as rolled back
  database.markRoundRolledBack(round.id);

  return { rolledBack: true, roundId: round.id, aiTaskUid: round.aiTaskUid };
}
