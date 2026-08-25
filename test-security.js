// Security tests for the shared validation and results-visibility logic.
// Run with: npm test   (node --test)
//
// These import the same modules the bot requires — do not copy logic in here,
// or the tests will keep passing after the real rules change.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_POLL,
  MAX_POLLS_PER_USER_PER_DAY,
  MAX_NOTIFICATIONS_PER_USER_PER_HOUR,
  validatePollInputs,
  checkPollCreationRateLimit,
  checkNotificationRateLimit
} = require('./lib/validation');

const { canViewResults, isCreatorOrCoCreator } = require('./lib/policy');

const q = (text = 'Q1', options = ['A', 'B']) => ({ text, options });

test('rejects a title over the limit', () => {
  assert.throws(() => validatePollInputs('x'.repeat(201), '', [q()]), /exceeds maximum length/);
});

test('rejects a description over the limit', () => {
  assert.throws(() => validatePollInputs('Title', 'x'.repeat(1001), [q()]), /exceeds maximum length/);
});

test('rejects question text over the limit', () => {
  assert.throws(() => validatePollInputs('Title', '', [q('x'.repeat(501))]), /exceeds maximum length/);
});

test('rejects option text over the limit', () => {
  assert.throws(() => validatePollInputs('Title', '', [q('Q1', ['A', 'x'.repeat(201)])]), /exceeds maximum length/);
});

test('rejects too many options in one question', () => {
  const options = Array.from({ length: MAX_OPTIONS_PER_QUESTION + 1 }, (_, i) => `Option ${i + 1}`);
  assert.throws(() => validatePollInputs('Title', '', [q('Q1', options)]), /exceeds maximum number of options/);
});

test('rejects too many questions in one poll', () => {
  const questions = Array.from({ length: MAX_QUESTIONS_PER_POLL + 1 }, (_, i) => q(`Q${i + 1}`));
  assert.throws(() => validatePollInputs('Title', '', questions), /exceeds maximum number of questions/);
});

test('rejects a missing title and an empty question list', () => {
  assert.throws(() => validatePollInputs('', '', [q()]), /title is required/);
  assert.throws(() => validatePollInputs('Title', '', []), /at least one question/);
});

test('accepts a valid poll', () => {
  validatePollInputs('Good Poll Title', 'A good description', [
    q('Question 1?', ['Yes', 'No']),
    q('Question 2?', ['Agree', 'Disagree', 'Neutral'])
  ]);
});

test('poll creation rate limit blocks the request after the daily quota', async () => {
  const userId = 'rate-limit-user';
  for (let i = 0; i < MAX_POLLS_PER_USER_PER_DAY; i++) {
    await checkPollCreationRateLimit(userId);
  }
  await assert.rejects(() => checkPollCreationRateLimit(userId), /Rate limit/);
});

test('notification rate limit stops allowing sends after the hourly quota', async () => {
  const userId = 'notify-rate-limit-user';
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR; i++) {
    assert.strictEqual(await checkNotificationRateLimit(userId), true);
  }
  assert.strictEqual(await checkNotificationRateLimit(userId), false);
});

const poll = (showResults, status = 'active', coCreators = []) =>
  ({ showResults, status, creator: 'U_CREATOR', coCreators });

test('realtime results are visible to everyone', () => {
  assert.strictEqual(canViewResults(poll('realtime'), 'U_STRANGER'), true);
});

test('creator_only hides live results from other members', () => {
  assert.strictEqual(canViewResults(poll('creator_only'), 'U_STRANGER'), false);
});

test('creator_only shows live results to the creator and co-creators', () => {
  assert.strictEqual(canViewResults(poll('creator_only'), 'U_CREATOR'), true);
  assert.strictEqual(canViewResults(poll('creator_only', 'active', ['U_CO']), 'U_CO'), true);
});

test('creator_only hides live results on shared surfaces (no viewer)', () => {
  assert.strictEqual(canViewResults(poll('creator_only'), null), false);
});

test('on_close hides live results from everyone, creator included', () => {
  assert.strictEqual(canViewResults(poll('on_close'), 'U_CREATOR'), false);
  assert.strictEqual(canViewResults(poll('on_close'), 'U_STRANGER'), false);
});

test('closing a poll makes results visible to everyone', () => {
  assert.strictEqual(canViewResults(poll('creator_only', 'closed'), 'U_STRANGER'), true);
  assert.strictEqual(canViewResults(poll('on_close', 'closed'), 'U_STRANGER'), true);
});

test('poll management is limited to the creator and co-creators', () => {
  assert.strictEqual(isCreatorOrCoCreator(poll('realtime'), 'U_CREATOR'), true);
  assert.strictEqual(isCreatorOrCoCreator(poll('realtime', 'active', ['U_CO']), 'U_CO'), true);
  assert.strictEqual(isCreatorOrCoCreator(poll('realtime'), 'U_STRANGER'), false);
});
