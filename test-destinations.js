// Tests for where a poll gets posted.
// Run with: npm test   (node --test)
//
// These import the same module the bot requires — do not copy logic in here,
// or the tests will keep passing after the real rules change.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  MAX_DESTINATIONS,
  normalizeDestinations,
  assertDestinationLimit,
  dedupeTargets
} = require('./lib/destinations');

test('nothing picked falls back to the conversation the command came from', () => {
  const d = normalizeDestinations({ fallbackChannelId: 'C123' });
  assert.deepStrictEqual(d.channels, ['C123']);
  assert.deepStrictEqual(d.users, []);
  assert.strictEqual(d.usedFallback, true, 'the caller has to be able to explain a redirect');
});

test('a pick is never mixed with the fallback', () => {
  const d = normalizeDestinations({ channelIds: ['C999'], fallbackChannelId: 'C123' });
  assert.deepStrictEqual(d.channels, ['C999']);
  assert.strictEqual(d.usedFallback, false);
});

test('picking only people still ignores the fallback channel', () => {
  const d = normalizeDestinations({ userIds: ['U1'], fallbackChannelId: 'C123' });
  assert.deepStrictEqual(d.channels, [], 'the poll would appear somewhere nobody asked for');
  assert.deepStrictEqual(d.users, ['U1']);
  assert.strictEqual(d.usedFallback, false);
});

test('no fallback and no pick means no destination', () => {
  const d = normalizeDestinations({});
  assert.deepStrictEqual(d.channels, []);
  assert.deepStrictEqual(d.users, []);
});

test('the same place picked twice is posted to once', () => {
  const d = normalizeDestinations({ channelIds: ['C1', 'C1', 'C2'], userIds: ['U1', 'U1'] });
  assert.deepStrictEqual(d.channels, ['C1', 'C2']);
  assert.deepStrictEqual(d.users, ['U1']);
});

test('anything that is not an id shape is dropped', () => {
  const d = normalizeDestinations({
    channelIds: ['C1', '', null, 42, 'not-an-id', { id: 'C2' }],
    userIds: [undefined, 'U1']
  });
  assert.deepStrictEqual(d.channels, ['C1']);
  assert.deepStrictEqual(d.users, ['U1']);
});

test('a poll cannot be fanned out past the destination limit', () => {
  const channels = Array.from({ length: MAX_DESTINATIONS }, (_, i) => `C${i}`);
  assert.doesNotThrow(() => assertDestinationLimit({ channels, users: [] }));
  assert.throws(
    () => assertDestinationLimit({ channels, users: ['U1'] }),
    /at most 10 places/,
    'channels and people share one budget'
  );
});

test('two picks landing on one channel are posted to once', () => {
  const targets = dedupeTargets([
    { channel: 'D1', label: '<@U1>' },
    { channel: 'C1', label: '<#C1>' },
    { channel: 'D1', label: '<@U1>' }
  ]);
  assert.deepStrictEqual(targets.map(t => t.channel), ['D1', 'C1']);
});
