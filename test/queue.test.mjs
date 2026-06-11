import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAiQueue } from '../src/aiQueue.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('serializes AI jobs per room while allowing independent rooms', async () => {
  const queue = new RoomAiQueue({ onError: () => undefined });
  const order = [];

  queue.enqueue(1, async () => {
    order.push('a-start');
    await wait(30);
    order.push('a-end');
  });

  queue.enqueue(1, async () => {
    order.push('b-start');
    await wait(5);
    order.push('b-end');
  });

  queue.enqueue(2, async () => {
    order.push('c-start');
    await wait(5);
    order.push('c-end');
  });

  await wait(80);

  assert.deepEqual(
    order.filter((item) => item.startsWith('a') || item.startsWith('b')),
    ['a-start', 'a-end', 'b-start', 'b-end']
  );
  assert.ok(order.indexOf('c-start') < order.indexOf('a-end'));
});
