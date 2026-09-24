import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertInside, redactUrl, runId, sanitizeId, screenshotName } from './lib/paths.mjs';

test('ids and screenshot names are filename safe', () => {
  assert.equal(sanitizeId('../../Home Page!?'), 'home-page');
  assert.equal(sanitizeId(''), 'unnamed');
  assert.equal(screenshotName('../Home', 390, 'LIGHT', 'Error State'), 'home__390__light__error-state.png');
  assert.match(runId(new Date('2026-09-24T12:34:56Z'), 'a1b2'), /^20260924-123456-a1b2$/);
});

test('assertInside refuses traversal and accepts a child', () => {
  const root = join(process.cwd(), 'run');
  assert.equal(assertInside(root, join(root, 'screens', 'home.png')), join(root, 'screens', 'home.png'));
  assert.throws(() => assertInside(root, join(root, '..', 'escape.json')), /escapes/);
});

test('URL redaction removes credentials and query values', () => {
  const redacted = redactUrl('https://user:secret@example.test/path?token=abc&empty=#part');
  assert.equal(redacted, 'https://example.test/path?token=REDACTED&empty=REDACTED#part');
  assert.ok(!redacted.includes('secret'));
  assert.ok(!redacted.includes('abc'));
});
