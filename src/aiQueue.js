export class RoomAiQueue {
  constructor({ onError = console.error } = {}) {
    this.queues = new Map();
    this.onError = onError;
  }

  enqueue(roomId, task) {
    const previous = this.queues.get(roomId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.onError(error);
      })
      .finally(() => {
        if (this.queues.get(roomId) === next) {
          this.queues.delete(roomId);
        }
      });

    this.queues.set(roomId, next);
    return next;
  }

  isBusy(roomId) {
    return this.queues.has(roomId);
  }
}
