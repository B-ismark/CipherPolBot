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
  MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR,
  validatePollInputs,
  canCreatePoll,
  checkPollCreationRateLimit,
  checkShareRateLimit,
  checkNotificationRateLimit
} = require('./lib/validation');

const { canViewResults, isCreatorOrCoCreator } = require('./lib/policy');
const { installationKey, installationKeyFromOAuth } = require('./lib/install');
const { sslOptionFor } = require('./lib/db');
const { healthStatus, DB_UNHEALTHY_GRACE_MS } = require('./lib/health');

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

test('on_close hides live results from other members', () => {
  assert.strictEqual(canViewResults(poll('on_close'), 'U_STRANGER'), false);
  assert.strictEqual(canViewResults(poll('on_close'), null), false);
});

test('the creator and co-creators always see their own live results', () => {
  assert.strictEqual(canViewResults(poll('on_close'), 'U_CREATOR'), true);
  assert.strictEqual(canViewResults(poll('on_close', 'active', ['U_CO']), 'U_CO'), true);
  assert.strictEqual(canViewResults(poll('creator_only'), 'U_CREATOR'), true);
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

test('a workspace install is keyed by its workspace id', () => {
  assert.strictEqual(installationKey({ teamId: 'T1' }), 'T1');
  assert.strictEqual(installationKey({ teamId: 'T1', enterpriseId: 'E1' }), 'T1');
});

test('an org-wide install is keyed by its enterprise id', () => {
  assert.strictEqual(installationKey({ isEnterpriseInstall: true, enterpriseId: 'E1', teamId: 'T1' }), 'E1');
});

test('installationKey returns null when Slack sends neither id', () => {
  assert.strictEqual(installationKey({}), null);
  assert.strictEqual(installationKey(), null);
});

test('an oauth response maps to the same key, with team null for org-wide', () => {
  assert.strictEqual(installationKeyFromOAuth({ team: { id: 'T1' } }), 'T1');
  assert.strictEqual(installationKeyFromOAuth({ is_enterprise_install: true, enterprise: { id: 'E1' }, team: null }), 'E1');
  assert.strictEqual(installationKeyFromOAuth({}), null);
});

test('a remote database with no sslmode still gets verified TLS', () => {
  assert.deepStrictEqual(sslOptionFor('postgresql://u:p@db.example.com/app'), { rejectUnauthorized: true });
});

test('the connection string wins whenever it mentions ssl', () => {
  assert.strictEqual(sslOptionFor('postgresql://u:p@db.example.com/app?sslmode=verify-full'), undefined);
  assert.strictEqual(sslOptionFor('postgresql://u:p@db.example.com/app?sslmode=no-verify'), undefined);
  assert.strictEqual(sslOptionFor('postgresql://u:p@db.example.com/app?ssl=true'), undefined);
});

test('a local database is left alone, as is a missing or unparseable url', () => {
  assert.strictEqual(sslOptionFor('postgresql://u:p@localhost:5432/app'), undefined);
  assert.strictEqual(sslOptionFor('postgresql://u:p@127.0.0.1/app'), undefined);
  assert.strictEqual(sslOptionFor(undefined), undefined);
  assert.strictEqual(sslOptionFor('not a url'), undefined);
});

test('a healthy instance reports ok', () => {
  assert.deepStrictEqual(healthStatus({ schemaReady: true, dbOk: true }), { httpStatus: 200, status: 'ok' });
});

test('a brief database blip is degraded but does not trigger a restart', () => {
  assert.deepStrictEqual(
    healthStatus({ schemaReady: true, dbOk: false, dbFailingForMs: DB_UNHEALTHY_GRACE_MS - 1 }),
    { httpStatus: 200, status: 'degraded' });
});

test('a sustained outage fails the check so the instance is recycled', () => {
  assert.deepStrictEqual(
    healthStatus({ schemaReady: true, dbOk: false, dbFailingForMs: DB_UNHEALTHY_GRACE_MS }),
    { httpStatus: 503, status: 'degraded' });
});

test('an instance still creating its schema is never reported ready', () => {
  assert.deepStrictEqual(healthStatus({ schemaReady: false, dbOk: true }), { httpStatus: 503, status: 'degraded' });
  assert.deepStrictEqual(healthStatus({ schemaReady: false, dbOk: false }), { httpStatus: 503, status: 'degraded' });
});

// ---- the door check must not spend what the till collects ----------------

test('opening the poll creator does not use up a poll', async () => {
  const user = 'U_door_check';
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(canCreatePoll(user), true, 'looking is free, however often');
  }
  for (let i = 0; i < MAX_POLLS_PER_USER_PER_DAY; i++) {
    await checkPollCreationRateLimit(user);
  }
  assert.strictEqual(canCreatePoll(user), false, 'and the cap still arrives on time');
  await assert.rejects(() => checkPollCreationRateLimit(user), /maximum of/);
});

test('the door check and the cap agree on the boundary', async () => {
  const user = 'U_boundary';
  for (let i = 0; i < MAX_POLLS_PER_USER_PER_DAY - 1; i++) {
    await checkPollCreationRateLimit(user);
  }
  assert.strictEqual(canCreatePoll(user), true, 'one left means one left');
  await checkPollCreationRateLimit(user);
  assert.strictEqual(canCreatePoll(user), false);
});

// ---- sharing is what any member can do, so it is what needs a ceiling ----

test('sharing is capped per destination, not per share', async () => {
  const user = 'U_sharer';
  // Ten destinations at a time is the abuse shape, so ten must cost ten.
  assert.strictEqual(await checkShareRateLimit(user, 10), true);
  assert.strictEqual(await checkShareRateLimit(user, 10), true);
  assert.strictEqual(await checkShareRateLimit(user, 10), true);
  assert.strictEqual(
    await checkShareRateLimit(user, 1), false,
    `three shares of ten spend the whole ${MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR}-destination hour`
  );
});

test('a share too big for the remaining budget spends none of it', async () => {
  const user = 'U_partial';
  await checkShareRateLimit(user, MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR - 2);
  assert.strictEqual(await checkShareRateLimit(user, 5), false, 'refused, not truncated');
  assert.strictEqual(await checkShareRateLimit(user, 2), true, 'and the refusal cost nothing');
});

test('one person hitting the share cap does not gag anyone else', async () => {
  const loud = 'U_loud', quiet = 'U_quiet';
  await checkShareRateLimit(loud, MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR);
  assert.strictEqual(await checkShareRateLimit(loud, 1), false);
  assert.strictEqual(await checkShareRateLimit(quiet, 1), true);
});
