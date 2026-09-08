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
  dedupeTargets,
  resolveDestinations,
  postPollTo,
  reachesCreator,
  describeFailures,
  logFailures
} = require('./lib/destinations');
const { MAX_NOTIFICATIONS_PER_USER_PER_HOUR } = require('./lib/validation');

// A Slack client that records what it was asked to do. The whole point of
// moving this logic out of slack-poll-bot.js: the path from a picked person to
// a delivered DM crosses two API calls, and until now nothing exercised it.
//
// fail maps a call to the error Slack would return, in Slack's own shape -
// { data: { error } } - because that is what the code reads.
function stubClient({ fail = {} } = {}) {
  const calls = { open: [], post: [] };
  const boom = key => {
    const e = new Error(fail[key]);
    e.data = { error: fail[key] };
    return e;
  };
  return {
    calls,
    conversations: {
      open: async ({ users }) => {
        calls.open.push(users);
        if (fail[`open:${users}`]) throw boom(`open:${users}`);
        if (fail.open) throw boom('open');
        return { channel: { id: `D_${users}` } };
      }
    },
    chat: {
      postMessage: async ({ channel, text }) => {
        calls.post.push(channel);
        if (fail[`post:${channel}`]) throw boom(`post:${channel}`);
        return { ts: `ts_${channel}`, channel, text };
      }
    }
  };
}

const MSG = { text: '📊 Lunch', blocks: [] };

// The rate limit is process-local and keyed by recipient, so every test that
// cares about it needs a person nobody else has spent budget on.
let seq = 0;
const freshUser = () => `UFRESH${++seq}`; // real Slack ids are uppercase alphanumerics, no underscores

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

// ==================== picking a person actually DMs them ====================
//
// None of this had a test before. The report was "it still doesn't DM the
// people", the code read correctly, and the reason it could read correctly and
// still fail is that nothing here was ever run.

test('picking a person opens a DM with them and posts the poll there', async () => {
  const uid = freshUser();
  const client = stubClient();
  const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [uid] }, 'CCMD', 'UME');

  assert.deepStrictEqual(failures, [], 'a plain DM to a fresh person must not fail');
  assert.deepStrictEqual(client.calls.open, [uid], 'a person is reached by opening a DM with them');
  assert.deepStrictEqual(targets.map(t => t.channel), [`D_${uid}`]);

  const { posted } = await postPollTo(client, MSG, targets);
  assert.deepStrictEqual(client.calls.post, [`D_${uid}`], 'the poll has to be posted into that DM');
  assert.deepStrictEqual(posted.map(p => p.channelId), [`D_${uid}`]);
});

test('a channel and a person both get the poll, in one pass', async () => {
  const uid = freshUser();
  const client = stubClient();
  const { targets, failures } = await resolveDestinations(client, { channelIds: ['C1'], userIds: [uid] }, null, 'UME');
  assert.deepStrictEqual(failures, []);
  const { posted } = await postPollTo(client, MSG, targets);
  assert.deepStrictEqual(posted.map(p => p.channelId).sort(), ['C1', `D_${uid}`].sort(),
    'picking both is not a choice between them');
});

test('a missing scope is named, because no invite can fix it', async () => {
  const client = stubClient({ fail: { open: 'missing_scope' } });
  const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [freshUser()] }, null, 'UME');

  assert.deepStrictEqual(targets, [], 'a DM that cannot be opened is not a destination');
  assert.strictEqual(failures.length, 1);
  assert.match(describeFailures(failures), /im:write/,
    'the one cause a reader cannot fix by inviting anyone has to say what it is');
  assert.match(describeFailures(failures), /reinstall/i);
});

test('one unreachable person does not cost the others their poll', async () => {
  const [bad, good] = [freshUser(), freshUser()];
  const client = stubClient({ fail: { [`open:${bad}`]: 'user_not_found' } });
  const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [bad, good] }, null, 'UME');

  assert.deepStrictEqual(targets.map(t => t.channel), [`D_${good}`]);
  assert.deepStrictEqual(failures.map(f => f.label), [`<@${bad}>`]);
});

// ==================== the budget is charged on delivery ====================

test('a DM that never arrives does not cost the recipient a slot', async () => {
  // This is the fault that made the symptom permanent. The slot used to be
  // spent when the DM was requested, so a failing scope burned the cap five
  // times over and then started refusing on its own account - a feature that
  // had never delivered anything now had a reason not to.
  const uid = freshUser();
  const failing = stubClient({ fail: { open: 'missing_scope' } });
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR + 3; i++) {
    await resolveDestinations(failing, { channelIds: [], userIds: [uid] }, null, 'UME');
  }

  const working = stubClient();
  const { targets, failures } = await resolveDestinations(working, { channelIds: [], userIds: [uid] }, null, 'UME');
  assert.deepStrictEqual(failures, [],
    'the cap must not have been spent by DMs that never went out');
  assert.deepStrictEqual(targets.map(t => t.channel), [`D_${uid}`]);
});

test('a post that fails after the DM opens does not cost a slot either', async () => {
  const uid = freshUser();
  const client = stubClient({ fail: { [`post:D_${uid}`]: 'channel_not_found' } });
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR + 3; i++) {
    const { targets } = await resolveDestinations(client, { channelIds: [], userIds: [uid] }, null, 'UME');
    await postPollTo(client, MSG, targets);
  }

  const working = stubClient();
  const { failures } = await resolveDestinations(working, { channelIds: [], userIds: [uid] }, null, 'UME');
  assert.deepStrictEqual(failures, [], 'opening a DM is not delivering one');
});

test('a delivered DM does cost a slot, so the cap still holds', async () => {
  const uid = freshUser();
  const client = stubClient();
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR; i++) {
    const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [uid] }, null, 'UME');
    assert.deepStrictEqual(failures, [], `delivery ${i + 1} of the cap should be allowed`);
    await postPollTo(client, MSG, targets);
  }

  const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [uid] }, null, 'UME');
  assert.deepStrictEqual(targets, [], 'past the cap there is no destination');
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0].reason, /clears on its own/,
    'a cap the reader can wait out has to say so - otherwise it reads as broken');
});

test('sending to yourself is never rate limited', async () => {
  // The creator gets an automatic copy with no budget consulted, so charging
  // for the copy they asked for had it backwards: picking yourself was the one
  // way to be refused a poll you created.
  const me = freshUser();
  const client = stubClient();
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR + 5; i++) {
    const { targets, failures } = await resolveDestinations(client, { channelIds: [], userIds: [me] }, null, me);
    assert.deepStrictEqual(failures, [], `own copy ${i + 1} must not be refused`);
    assert.deepStrictEqual(targets.map(t => t.channel), [`D_${me}`]);
    await postPollTo(client, MSG, targets);
  }
});

test('someone else spending your budget does not lock you out of your own poll', async () => {
  const me = freshUser();
  const client = stubClient();
  for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_HOUR; i++) {
    const { targets } = await resolveDestinations(client, { channelIds: [], userIds: [me] }, null, 'USOMEONEELSE');
    await postPollTo(client, MSG, targets);
  }
  const { failures } = await resolveDestinations(client, { channelIds: [], userIds: [me] }, null, me);
  assert.deepStrictEqual(failures, [], 'your own poll is not someone else’s enthusiasm');
});

// ==================== the creator always gets a ballot ====================

test('a poll sent only to other people does not reach its creator', () => {
  assert.strictEqual(reachesCreator([{ channelId: 'D_U9' }], ['U9'], 'UME', false), false,
    'the creator would hold a receipt and no ballot');
});

test('picking yourself, or any channel, is a ballot', () => {
  assert.strictEqual(reachesCreator([{ channelId: 'D_UME' }], ['UME'], 'UME', false), true);
  assert.strictEqual(reachesCreator([{ channelId: 'C1' }], ['U9'], 'UME', false), true);
  assert.strictEqual(reachesCreator([{ channelId: 'G1' }], [], 'UME', false), true, 'a group DM is readable too');
});

test('a channel that refused the app counts as no ballot', () => {
  // reachesCreator reads what actually posted, not what was picked, so a
  // private channel the app was never invited to does not stand in for a copy.
  assert.strictEqual(reachesCreator([], ['U9'], 'UME', false), false);
});

// ==================== a refusal has to be recoverable ====================

test('every refusal names its Slack error verbatim', () => {
  // The advice is a guess about the cause; Slack's own string is the evidence.
  // Narrowing this poll's failure took a round of guessing precisely because
  // the only message carrying that string was thrown away unread.
  const said = describeFailures([
    { label: '<@U1>', reason: 'missing_scope' },
    { label: '<#C2>', reason: 'not_in_channel' }
  ]);
  assert.match(said, /missing_scope/, 'the reader cannot report a cause the message hides');
  assert.match(said, /not_in_channel/);
});

test('each kind of refusal gets the remedy that fits it, and only that one', () => {
  const scope  = describeFailures([{ label: '<@U1>', reason: 'missing_scope' }]);
  const invite = describeFailures([{ label: '<#C1>', reason: 'not_in_channel' }]);
  const gone   = describeFailures([{ label: '<@U1>', reason: 'user_disabled' }]);

  assert.match(scope, /im:write/);
  assert.ok(!/invite me to it/.test(scope), 'no invite fixes a missing scope');

  assert.match(invite, /invite me to it/);
  assert.ok(!/im:write/.test(invite), 'a channel the bot is not in is not a scope problem');

  assert.match(gone, /deactivated account/);
  assert.ok(!/im:write/.test(gone) && !/invite me to it/.test(gone),
    'a gone account has no remedy the reader can apply');
});

test('a refusal is written to the log as well, so it survives being missed', () => {
  const said = [];
  const warn = console.warn;
  console.warn = m => said.push(m);
  try {
    logFailures('poll_1', [{ label: '<@U1>', reason: 'missing_scope' }]);
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /poll_1/);
  assert.match(said[0], /<@U1>/);
  assert.match(said[0], /missing_scope/, 'the log is the copy that outlives the DM');
});
