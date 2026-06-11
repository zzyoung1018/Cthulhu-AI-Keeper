export class RoomEventHub {
  constructor() {
    this.rooms = new Map();
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

  send(response, event, payload) {
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
}
