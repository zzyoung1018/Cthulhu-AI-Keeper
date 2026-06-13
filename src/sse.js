// Room event hub with per-player private channels.
// Public events broadcast to all subscribers in a room.
// Private events go only to the intended player's SSE connection.

export class RoomEventHub {
  constructor() {
    // Map<roomCode, Set<response>> — public subscribers
    this.rooms = new Map();
    // Map<roomCode, Map<playerId, Set<response>>> — per-player subscribers
    this.players = new Map();
  }

  subscribe(code, response) {
    const roomCode = code.toUpperCase();
    let subscribers = this.rooms.get(roomCode);
    if (!subscribers) {
      subscribers = new Set();
      this.rooms.set(roomCode, subscribers);
    }

    subscribers.add(response);
    response.on('close', () => {
      subscribers.delete(response);
      if (subscribers.size === 0) {
        this.rooms.delete(roomCode);
      }
    });
  }

  subscribePlayer(code, playerId, response) {
    const roomCode = code.toUpperCase();
    let roomMap = this.players.get(roomCode);
    if (!roomMap) {
      roomMap = new Map();
      this.players.set(roomCode, roomMap);
    }

    let playerSet = roomMap.get(playerId);
    if (!playerSet) {
      playerSet = new Set();
      roomMap.set(playerId, playerSet);
    }

    playerSet.add(response);
    response.on('close', () => {
      playerSet.delete(response);
      if (playerSet.size === 0) {
        roomMap.delete(playerId);
        if (roomMap.size === 0) {
          this.players.delete(roomCode);
        }
      }
    });
  }

  send(response, event, payload) {
    if (response.destroyed) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(code, event, payload) {
    const subscribers = this.rooms.get(code.toUpperCase());
    if (!subscribers) return;

    for (const response of subscribers) {
      this.send(response, event, payload);
    }
  }

  sendTo(code, playerId, event, payload) {
    const roomMap = this.players.get(code.toUpperCase());
    if (!roomMap) return;
    const subscribers = roomMap.get(playerId);
    if (!subscribers) return;
    for (const response of subscribers) {
      this.send(response, event, payload);
    }
  }
}
