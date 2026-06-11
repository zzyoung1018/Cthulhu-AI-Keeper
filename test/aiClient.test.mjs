import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChatCompletion } from '../src/aiClient.js';

test('streams OpenAI-compatible chat completion chunks', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你推"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开门"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      }),
      { status: 200 }
    );
  };

  try {
    const chunks = [];
    for await (const chunk of streamChatCompletion(
      {
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.7,
        timeoutMs: 10_000,
        localFallback: false
      },
      [{ role: 'user', content: 'continue' }]
    )) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, ['你推', '开门']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
