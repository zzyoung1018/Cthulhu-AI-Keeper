// Per-player SSE channels for private messages, hidden dice, and private clues.
// Public messages are broadcast to all players; private events go only to the
// intended recipient.

export class PrivateEventHub {
  constructor() {
    // Map<roomCode, Map<playerId, Set<response>>>
    this.rooms = new Map();
  }

  subscribe(code, playerId, response) {
    const roomCode = code.toUpperCase();
    let roomMap = this.rooms.get(roomCode);
    if (!roomMap) {
      roomMap = new Map();
      this.rooms.set(roomCode, roomMap);
    }

    let subscribers = roomMap.get(playerId);
    if (!subscribers) {
      subscribers = new Set();
      roomMap.set(playerId, subscribers);
    }

    subscribers.add(response);

    response.on('close', () => {
      subscribers.delete(response);
      if (subscribers.size === 0) {
        roomMap.delete(playerId);
        if (roomMap.size === 0) {
          this.rooms.delete(roomCode);
        }
      }
    });
  }

  send(response, event, payload) {
    if (response.destroyed) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  sendTo(code, playerId, event, payload) {
    const roomMap = this.rooms.get(code.toUpperCase());
    if (!roomMap) return;
    const subscribers = roomMap.get(playerId);
    if (!subscribers) return;
    for (const response of subscribers) {
      this.send(response, event, payload);
    }
  }

  broadcastToRoom(code, event, payload) {
    const roomMap = this.rooms.get(code.toUpperCase());
    if (!roomMap) return;
    for (const subscribers of roomMap.values()) {
      for (const response of subscribers) {
        this.send(response, event, payload);
      }
    }
  }
}
