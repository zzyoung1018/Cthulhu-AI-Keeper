import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestUrl } from '../src/app.js';

test('handles malformed Host headers without crashing', () => {
  const url = parseRequestUrl({
    url: '/',
    headers: { host: '008.153.147.137' }
  });

  assert.equal(url.pathname, '/');
  assert.equal(url.origin, 'http://localhost');
});
