// Round records and rollback system.
// Each AI round creates a transaction record capturing the pre-state so the
// owner can roll back the last AI reply, restoring character and scene state.

let _randomUUID;
async function randomUUID() {
  if (!_randomUUID) {
    const crypto = await import('node:crypto');
    _randomUUID = crypto.randomUUID;
  }
  return _randomUUID();
}

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
  roundId
}) {
  const room = database.getRoomByCode(roomCode);
  if (!room) throw new Error('Room not found');
  if (room.ownerPlayerId !== playerId) throw new Error('Only the room owner can roll back');

  const round = database.getRoundState(roundId);
  if (!round || round.roomId !== room.id) throw new Error('Round not found');

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

  // Mark the DM message as rolled back
  if (round.dmMessageId) {
    database.markMessageRolledBack(round.dmMessageId);
  }

  // Mark round as rolled back
  database.markRoundRolledBack(roundId);

  return { rolledBack: true, roundId };
}
