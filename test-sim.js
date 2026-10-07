// The real bot, run against a fake Slack and a fake database (see sim/).
//
// The other test files check the screens the bot builds. These check what the
// bot does when people use it: the handlers that ship are called the way Bolt
// calls them, and what comes back is read the way a person would see it.
//
// Two kinds of test live here.
//   - Plain tests pin behaviour that is right today, so it stays right.
//   - `todo` tests are bugs the audit found (see AUDIT.md). Each states what the
//     bot SHOULD do and currently does not, so it fails today, is reported as
//     "todo" rather than a failure, and turns into a normal test the day the bug
//     is fixed - at which point delete the `todo` option.

const { test } = require('node:test');
const assert = require('node:assert');
const { boot } = require('./sim/harness');
const V = require('./lib/views');
const { MAX_POLLS_PER_USER_PER_DAY } = require('./lib/validation');

// ---- helpers ----
const Q = (text, options, extra = {}) => ({ text, type: 'multiple_choice', options, allowMultiple: false, ...extra });
const LUNCH = () => Q('Lunch?', ['Thai', 'Sushi', 'Pizza']);
const OPEN = text => ({ text, type: 'open_ended', options: [], allowMultiple: false });
const at = ref => ({ channel: ref.channelId, ts: ref.messageTs });
const message = (sim, ref) => sim.slack.messages.get(`${ref.channelId}:${ref.messageTs}`);
const text = node => JSON.stringify(node);
// What Slack reads markup in: every mrkdwn text, and a message's `text`.
// plain_text shows `<!channel>` as typed, so it is not a way in.
const mrkdwnOf = node => {
  const out = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mrkdwn' && typeof n.text === 'string') out.push(n.text);
    Object.values(n).forEach(walk);
  };
  walk(node);
  return [typeof node?.text === 'string' ? node.text : '', ...out].join('\n');
};
const buttonsOn = m => m.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements.map(e => e.action_id));
const actionsIn = view => view.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements.map(e => e.action_id));
const votesOf = (sim, id) => JSON.parse(sim.db.row(id).votes);
const announcements = sim => sim.slack.callsTo('chat.postMessage').filter(c => /Poll closed/.test(c.args.text));

// Runs `fn` against a fresh bot, and always puts the process back as it was.
function scenario(name, fn, opts) {
  test(name, opts, async () => {
    const sim = await boot();
    try { await fn(sim); } finally { await sim.close(); }
  });
}
// A person pressing something must not trip over the bot's own bookkeeping.
const clean = r => assert.deepStrictEqual(r.problems, [], `handler misbehaved: ${r.problems.join('; ')}`);

// ==================== the bot starts ====================

scenario('the bot boots on the fakes and registers its commands, buttons and screens', sim => {
  const commands = [...sim.app.handlers.command.keys()];
  for (const c of ['/newpoll', '/polls-list', '/poll-close', '/poll-export']) assert.ok(commands.includes(c), c);
  for (const v of ['poll_preview_submit', 'vote_submit', 'share_poll_submit', 'poll_close_confirm']) {
    assert.ok(sim.app.handlers.view.has(v), v);
  }
  assert.deepStrictEqual(sim.logged('error'), []);
});

// ==================== voting from the message ====================

scenario('a first vote is confirmed; changing it on a public poll stays quiet', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], settings: ['allow_revote'] });
  const ref = made.messageRefs[0];
  const kofi = sim.user('UKOFI');

  const first = await kofi.press('vote_option_0_0', {}, at(ref));
  clean(first);
  assert.deepStrictEqual(first.ephemerals.map(e => e.text), ['✅ Your vote for *Thai* is in.']);

  const change = await kofi.press('vote_option_0_1', {}, at(ref));
  clean(change);
  assert.deepStrictEqual(change.ephemerals, [], 'the poll already shows their name moving');
  assert.ok(text(message(sim, ref)).includes('<@UKOFI>'), 'and it does');
  assert.deepStrictEqual(votesOf(sim, made.id)[0], { 0: [], 1: ['UKOFI'], 2: [] });
});

scenario('an anonymous voter is told once, and nothing when they press their own answer again', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], settings: ['anonymous', 'allow_revote'] });
  const ref = made.messageRefs[0];
  const k = sim.user('UK');
  assert.strictEqual((await k.press('vote_option_0_0', {}, at(ref))).ephemerals.length, 1);
  assert.strictEqual((await k.press('vote_option_0_0', {}, at(ref))).ephemerals.length, 0);
  assert.strictEqual((await k.press('vote_option_0_1', {}, at(ref))).ephemerals.length, 1, 'a change on an anonymous poll has no other signal');
  assert.ok(!text(message(sim, ref)).includes('<@UK>'), 'nobody is named');
});

scenario('with vote changes off, a second answer is refused and the first stands', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], settings: [] });
  const ref = made.messageRefs[0];
  const k = sim.user('UK');
  await k.press('vote_option_0_0', {}, at(ref));
  const r = await k.press('vote_option_0_1', {}, at(ref));
  assert.match(r.ephemerals[0].text, /turned off vote changes/);
  assert.deepStrictEqual(votesOf(sim, made.id)[0][0], ['UK']);
});

scenario('twenty-five people voting at once lose no votes, and the message agrees with the database', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  sim.db.latencyMs = 5;
  await Promise.all(Array.from({ length: 25 }, (_, i) => sim.user(`UV${i}`).press(`vote_option_0_${i % 3}`, {}, at(ref))));
  const total = Object.values(votesOf(sim, made.id)[0]).reduce((n, a) => n + a.length, 0);
  assert.strictEqual(total, 25);
  assert.match(text(message(sim, ref)), /25 votes/);
});

scenario('a vote that races the creator closing the poll is either counted in the final results or refused', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  await ama.press('poll_more', {}, at(ref));
  sim.db.latencyMs = 3;
  const [vote, close] = await Promise.all([sim.user('UK').press('vote_option_0_0', {}, at(ref)), ama.press('more_close', {})]);
  clean(vote); clean(close);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1, 'announced exactly once');
  const counted = votesOf(sim, made.id)[0][0].includes('UK');
  assert.strictEqual(/1 vote|100%/.test(text(announcements(sim)[0].args.blocks)), counted, 'the announcement says what the database holds');
});

scenario('a vote after the close time is not recorded, and the poll closes with its results posted', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], closeAt: new Date(Date.now() + 40).toISOString() });
  await new Promise(r => setTimeout(r, 80));
  const r = await sim.user('UK').press('vote_option_0_0', {}, at(made.messageRefs[0]));
  assert.match(r.ephemerals[0].text, /reached its close time - your vote was \*not\* recorded/);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1);
});

scenario('the sweeper closes an overdue poll, updates its message and announces it', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], closeAt: new Date(Date.now() + 30).toISOString() });
  await new Promise(r => setTimeout(r, 60));
  await sim.sweep();
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1);
  assert.deepStrictEqual(buttonsOn(message(sim, made.messageRefs[0])), ['view_results_modal', 'poll_more']);
});

scenario('a database waking from sleep no longer costs the first press: a Loading screen opens and fills in', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  for (const [action, filled] of [['poll_more', 'more_send'], ['open_vote_modal', 'vote_submit']]) {
    const k = sim.user(`UK_${action}`);
    // A real second, then three more on the clock: four seconds in all, past
    // the press's three-second trigger.
    sim.db.before(/^SELECT \* FROM polls WHERE id/, async () => {
      await new Promise(r => setTimeout(r, 1000));
      sim.clock.advance(3000);
    });
    const r = await k.press(action, {}, at(ref));
    clean(r);
    const opened = r.calls.filter(c => c.method === 'views.open');
    assert.strictEqual(opened.length, 1, `${action}: one screen`);
    assert.match(text(opened[0].args.view.blocks), /Loading/);
    const shown = JSON.stringify(k.top.view);
    assert.ok(shown.includes(filled), `${action} filled in: ${shown.slice(0, 200)}`);
    assert.deepStrictEqual(r.ephemerals, [], `${action}: nobody is told to press again`);
  }
});

// A real second, then three more on the clock, before the next poll lookup:
// four seconds in all, past the three-second trigger.
const coldNextLookup = sim => sim.db.before(/^SELECT \* FROM polls WHERE id/, async () => {
  await new Promise(r => setTimeout(r, 1000));
  sim.clock.advance(3000);
});

scenario('a database waking from sleep no longer costs /poll-edit, /poll-close or a Close button their screen', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  await sim.user('UK').press('vote_option_0_0', {}, at(ref));
  message(sim, ref).blocks.find(b => b.type === 'actions').elements.push(
    { type: 'button', text: { type: 'plain_text', text: '🔒  Close' }, action_id: 'close_poll', value: made.id });
  const tries = [
    ['/poll-edit', () => ama.command('/poll-edit', made.id), 'poll_edit_submit'],
    ['/poll-close', () => ama.command('/poll-close', made.id), 'poll_close_confirm'],
    ['the Close button', () => ama.press('close_poll', {}, at(ref)), 'poll_close_confirm']
  ];
  for (const [what, run, filled] of tries) {
    coldNextLookup(sim);
    const r = await run();
    clean(r);
    const opened = r.calls.filter(c => c.method === 'views.open');
    assert.strictEqual(opened.length, 1, `${what}: one screen`);
    assert.match(text(opened[0].args.view.blocks), /Loading/, what);
    assert.strictEqual(ama.top.view.callback_id, filled, `${what} filled in`);
    assert.deepStrictEqual(r.ephemerals, [], `${what}: nobody is told to press again`);
    assert.deepStrictEqual(ama.dms(), [], `${what}: or sent a DM`);
    ama.dismiss();
  }
  // The filled-in confirmation still does its job.
  coldNextLookup(sim);
  await ama.command('/poll-close', made.id);
  clean(await ama.submit({}));
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1);
});

scenario('a database waking from sleep no longer costs the Results button on a poll list', async sim => {
  const lunch = await sim.user('UAMA').createPoll({ title: 'Lunch vote', questions: [LUNCH()] });
  const secret = await sim.user('UAMA').createPoll({ title: 'Secret vote', questions: [LUNCH()], showResults: 'on_close' });
  const k = sim.user('UK');
  await k.command('/polls-list', '', { channel: 'C1' });
  const list = k.whispers().length - 1;

  // Cold: the Loading screen fills in with the results.
  coldNextLookup(sim);
  const r = await k.press('list_poll_results', { value: lunch.id }, { ephemeral: list });
  clean(r);
  assert.match(text(r.calls.find(c => c.method === 'views.open').args.view.blocks), /Loading/);
  assert.match(text(k.top.view.blocks), /Lunch vote/);
  assert.deepStrictEqual(r.ephemerals, [], 'nobody is told to press again');
  k.dismiss();

  // Hidden results: said where they are looking - the placeholder when slow,
  // a private message as before when quick.
  coldNextLookup(sim);
  clean(await k.press('list_poll_results', { value: secret.id }, { ephemeral: list }));
  assert.match(text(k.top.view.blocks), /Results visible after poll closes/);
  k.dismiss();
  const quick = await k.press('list_poll_results', { value: secret.id }, { ephemeral: list });
  clean(quick);
  assert.strictEqual(k.top, null);
  assert.match(quick.ephemerals[0].text, /Results visible after poll closes/);
});

scenario('when a slow /poll-close or /poll-edit ends in a message, it is shown on the Loading screen', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  coldNextLookup(sim);
  const missing = await ama.command('/poll-edit', 'nope');
  clean(missing);
  assert.match(text(ama.top.view.blocks), /Poll not found/);
  assert.deepStrictEqual(missing.ephemerals, [], 'said once, where they are looking');
  ama.dismiss();
  // No votes, so it closes without asking - and the screen has to say so.
  coldNextLookup(sim);
  const closed = await ama.command('/poll-close', made.id);
  clean(closed);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.match(text(ama.top.view.blocks), /is closed/);
  assert.strictEqual(announcements(sim).length, 1);
});

scenario('too late even for the Loading screen, an answer that is only a message still arrives', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  // The trigger is gone before the placeholder can use it.
  const expiredFirst = () => sim.db.before(/^SELECT \* FROM polls WHERE id/, async () => {
    sim.clock.advance(3000);
    await new Promise(r => setTimeout(r, 1000));
  });
  expiredFirst();
  const missing = await ama.command('/poll-edit', 'nope');
  clean(missing);
  assert.match(missing.ephemerals[0].text, /Poll not found/);
  assert.deepStrictEqual(ama.dms(), [], 'not told to run it again');
  // No votes: it closes, and the person is not told to try again.
  expiredFirst();
  const closed = await ama.command('/poll-close', made.id);
  clean(closed);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1);
  assert.deepStrictEqual(ama.dms(), [], 'not told to run it again');
});

scenario('closing the Loading screen does not swallow an answer that was only a message', async sim => {
  const ama = sim.user('UAMA');
  sim.db.before(/^SELECT \* FROM polls WHERE id/, async () => {
    await new Promise(r => setTimeout(r, 1000));
    ama.dismiss();
  });
  const r = await ama.command('/poll-edit', 'nope');
  clean(r);
  assert.match(r.ephemerals[0].text, /Poll not found/);
});

scenario('a quick /poll-close or /poll-edit answers as it always did, with no extra screen', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const missing = await ama.command('/poll-edit', 'nope');
  assert.match(missing.ephemerals[0].text, /Poll not found/);
  assert.strictEqual(ama.top, null);
  const closed = await ama.command('/poll-close', made.id);
  clean(closed);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.deepStrictEqual(closed.calls.filter(c => c.method === 'views.open'), [], 'no votes: closed without a screen');
  assert.deepStrictEqual(closed.ephemerals, [], 'the announcement in the channel says it');
});

scenario('closing the Loading screen before it fills in is not reported as a failure', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const k = sim.user('UKCLOSE');
  sim.db.before(/^SELECT \* FROM polls WHERE id/, async () => {
    await new Promise(r => setTimeout(r, 1000));
    k.dismiss();
  });
  const r = await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  clean(r);
  assert.strictEqual(r.calls.filter(c => c.method === 'views.update').length, 1, 'it tried to fill it in');
  assert.strictEqual(k.top, null, 'and left it closed');
  assert.deepStrictEqual(r.ephemerals, [], 'nobody is told something went wrong');
});

scenario('a press that reaches the bot too late to open anything is told to press again', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  sim.db.latencyMs = 4000;
  for (const [action, args] of [['poll_more', {}], ['open_vote_modal', {}]]) {
    const r = await sim.user('UK').press(action, args, at(ref));
    assert.strictEqual(r.modal, null, `${action} cannot open`);
    assert.match(r.ephemerals[0].text, /missed the 3-second window/);
  }
});

// ==================== the More screen ====================

scenario('More shows a voter Send and Results, and the creator also Export and Close', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  assert.deepStrictEqual(buttonsOn(message(sim, ref)), ['open_vote_modal', 'poll_more']);
  await sim.user('UK').press('poll_more', {}, at(ref));
  assert.deepStrictEqual(actionsIn(sim.user('UK').top.view), ['more_results', 'more_send']);
  await ama.press('poll_more', {}, at(ref));
  assert.deepStrictEqual(actionsIn(ama.top.view), ['more_results', 'more_send', 'more_export', 'more_close']);
});

scenario('a voter replaying Close or Export from More is refused, and nothing happens', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const k = sim.user('UK');
  await k.press('more_close', { value: made.id }, { forge: true });
  await k.press('more_export', { value: made.id }, { forge: true });
  assert.strictEqual(sim.db.row(made.id).status, 'active');
  assert.strictEqual(sim.slack.files.length, 0);
  assert.ok(k.dms().some(m => /Only <@UAMA> can close/.test(m.text)));
  assert.ok(k.dms().some(m => /Only <@UAMA> can export/.test(m.text)));
});

scenario('an old Close button on a posted message is refused to voters and works for the creator', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  message(sim, ref).blocks.find(b => b.type === 'actions').elements.push(
    { type: 'button', text: { type: 'plain_text', text: '🔒  Close' }, action_id: 'close_poll', value: made.id });
  const refused = await sim.user('UK').press('close_poll', {}, at(ref));
  assert.match(refused.ephemerals[0].text, /Only <@UAMA> can close this poll/);
  assert.strictEqual(sim.db.row(made.id).status, 'active');
  await ama.press('close_poll', {}, at(ref));
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
});

scenario('closing a poll with votes asks first, ends the whole stack, and announces once', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  await sim.user('UK').press('vote_option_0_0', {}, at(ref));
  await ama.press('poll_more', {}, at(ref));
  await ama.press('more_close', {});
  assert.deepStrictEqual(ama.stack.map(v => v.view.title.text), ['Poll options', 'Close Poll?']);
  const done = await ama.submit({});
  clean(done);
  assert.strictEqual(ama.stack.length, 0, 'nothing left behind offering to close a closed poll');
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.strictEqual(announcements(sim).length, 1);
});

scenario('pressing Close twice announces once', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.press('poll_more', {}, at(made.messageRefs[0]));
  await Promise.all([ama.press('more_close', {}), ama.press('more_close', {})]);
  assert.strictEqual(announcements(sim).length, 1);
});

scenario('Export from More puts the CSV in the creator\'s DM', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.press('poll_more', {}, at(made.messageRefs[0]));
  const r = await ama.press('more_export', {});
  clean(r);
  assert.strictEqual(sim.slack.files.length, 1);
  assert.strictEqual(sim.slack.files[0].channel, 'DUAMA');
  assert.match(text(ama.top.view.blocks), /in your DM with me/);
});

scenario('Send from More goes out, reports what failed, and refuses a channel the poll is already in', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const k = sim.user('UK');
  const pick = (channels, users = []) => ({
    poll_dest_channels: { value: { type: 'multi_conversations_select', selected_conversations: channels } },
    poll_dest_users: { value: { type: 'multi_users_select', selected_users: users } }
  });
  await k.press('poll_more', {}, at(made.messageRefs[0]));
  await k.press('more_send', {});
  clean(await k.submit(pick(['C2', 'G1'])));
  assert.deepStrictEqual(JSON.parse(sim.db.row(made.id).message_refs).map(r => r.channelId), ['C1', 'C2']);
  assert.ok(k.dms().some(m => /sent to <#C2>/.test(m.text) && /invite me to it first/.test(m.text)), 'the private channel failure is explained');
  await k.press('poll_more', {}, at(made.messageRefs[0]));
  await k.press('more_send', {});
  await k.submit(pick(['C2']));
  assert.ok(k.dms().some(m => /already posted in <#C2>/.test(m.text)));
});

scenario('Send with nothing picked stays open and says what is missing', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const k = sim.user('UK');
  await k.press('poll_more', {}, at(made.messageRefs[0]));
  await k.press('more_send', {});
  const pick = (channels, users) => ({
    poll_dest_channels: { value: { type: 'multi_conversations_select', selected_conversations: channels } },
    poll_dest_users: { value: { type: 'multi_users_select', selected_users: users } }
  });
  // Slack sends both pickers, empty - and an older client may leave them out.
  for (const values of [pick([], []), {}]) {
    const r = await k.submit(values);
    clean(r);
    assert.match(r.viewErrors?.poll_dest_channels || '', /Pick at least one channel or person/);
    assert.strictEqual(k.top.view.callback_id, 'share_poll_submit', 'the Send screen is still open');
  }
  // Ten in each picker is allowed; eleven in all is not.
  const many = await k.submit(pick(['C2', 'C3', 'C4', 'C5', 'C6', 'C7'], ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']));
  clean(many);
  assert.match(many.viewErrors?.poll_dest_channels || '', /at most 10 .*you picked 12/);
  assert.strictEqual(k.top.view.callback_id, 'share_poll_submit');
  assert.deepStrictEqual(k.dms(), [], 'nothing arrives in a DM');
});

scenario('a Vote press on a poll that has closed shows the final results, with no id to type', async sim => {
  const ama = sim.user('UAMA'), k = sim.user('UK');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-close', made.id);
  // A Vote button that outlived the close - a copy whose update was missed.
  const r = await k.press('open_vote_modal', { value: made.id }, { forge: true });
  clean(r);
  const shown = JSON.stringify(k.top.view.blocks);
  assert.match(shown, /no longer takes votes/);
  assert.match(shown, /Thai/, 'the results are on the screen');
  assert.doesNotMatch(shown, /poll-results|poll_\d/);
});

scenario('the CSV names the people who wrote answers, and keeps their Slack ID beside the name', async sim => {
  const ama = sim.user('UAMA'), k = sim.user('UK');
  const made = await ama.createPoll({ questions: [{ text: 'Thoughts?', type: 'open_ended', options: [], allowMultiple: false }] });
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  const input = k.top.view.blocks.find(b => b.type === 'input');
  clean(await k.submit({ [input.block_id]: { [input.element.action_id]: { type: 'plain_text_input', value: 'Loved it' } } }));
  clean(await ama.command('/poll-export', made.id));
  assert.match(sim.slack.files.at(-1).content, /"Person UK \(UK\)","Loved it"/);
});

scenario('before the app is reinstalled with users:read, the CSV still goes out, with IDs alone', async sim => {
  const ama = sim.user('UAMA'), k = sim.user('UK');
  const made = await ama.createPoll({ questions: [{ text: 'Thoughts?', type: 'open_ended', options: [], allowMultiple: false }] });
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  const input = k.top.view.blocks.find(b => b.type === 'input');
  clean(await k.submit({ [input.block_id]: { [input.element.action_id]: { type: 'plain_text_input', value: 'Loved it' } } }));
  const missing = new Error('An API error occurred: missing_scope');
  missing.data = { ok: false, error: 'missing_scope' };
  sim.slack.failNext('users.info', missing, { times: 1 });
  clean(await ama.command('/poll-export', made.id));
  assert.match(sim.slack.files.at(-1).content, /"UK","Loved it"/);
});

scenario('a rate limit on the name lookups ends them, and the export goes out with ids', async sim => {
  const ama = sim.user('UAMA');
  const open = { text: 'Thoughts?', type: 'open_ended', options: [], allowMultiple: false };
  const made = await ama.createPoll({ questions: [open] });
  // Twenty-five people answered: three rounds of lookups if nothing stops them.
  const answers = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`UV${i}`, 'Yes']));
  sim.db.row(made.id).votes = JSON.stringify({ 0: answers });
  const limited = new Error('A rate-limit has been reached');
  limited.code = 'slack_webapi_rate_limited_error';
  sim.slack.failNext('users.info', limited, { times: 1 });
  const r = await ama.command('/poll-export', made.id);
  clean(r);
  assert.strictEqual(r.calls.filter(c => c.method === 'users.info').length, 10, 'stopped after the round that hit the limit');
  assert.match(sim.slack.files.at(-1).content, /"UV24","Yes"/);
});

// ==================== who is offered what ====================

scenario('the poll list offers Close and Export only to the people who run the poll', async sim => {
  await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  await sim.user('UK').command('/polls-list', '', { channel: 'C1' });
  await sim.user('UAMA').command('/polls-list', '', { channel: 'C1' });
  const ids = u => sim.user(u).whispers().flatMap(w => (w.blocks || []).filter(b => b.type === 'actions').flatMap(b => b.elements.map(e => e.action_id)));
  assert.deepStrictEqual(ids('UK'), ['list_poll_results', 'share_poll']);
  assert.deepStrictEqual(ids('UAMA'), ['list_poll_results', 'share_poll', 'close_poll', 'list_poll_export']);
});

scenario('a voter cannot edit, close or export through the slash commands', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const k = sim.user('UK');
  for (const c of ['/poll-edit', '/poll-close', '/poll-export']) await k.command(c, made.id, { channel: 'C1' });
  assert.strictEqual(sim.db.row(made.id).status, 'active');
  assert.strictEqual(k.top, null);
  assert.strictEqual(k.whispers().filter(w => /Only/.test(w.text)).length, 3);
});

scenario('hidden results stay hidden on the message and on the voter\'s More screen', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], showResults: 'on_close' });
  const ref = made.messageRefs[0];
  const k = sim.user('UK');
  await k.press('vote_option_0_0', {}, at(ref));
  assert.ok(!/1 vote|100%|<@UK>/.test(text(message(sim, ref))));
  await k.press('poll_more', {}, at(ref));
  assert.deepStrictEqual(actionsIn(k.top.view), ['more_send']);
  assert.match(text(k.top.view.blocks), /Results visible after poll closes/);
});

// ==================== creating polls ====================

scenario('a poll to a private channel the bot is not in is saved, and the creator is told how to fix it', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()], destChannels: ['G1'] });
  assert.deepStrictEqual(made.messageRefs, []);
  assert.ok(sim.db.row(made.id), 'the poll is kept');
  assert.match(ama.dms().map(m => m.text).join('\n'), /invite me to it first/);
});

scenario('a poll sent to a person also gives its creator a copy to vote in', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], destChannels: [], destUsers: ['UBOB'] });
  assert.deepStrictEqual(made.messageRefs.map(r => r.channelId).sort(), ['DUAMA', 'DUBOB']);
  const bob = sim.user('UBOB');
  const v = await bob.press('vote_option_0_0', {}, at(made.messageRefs.find(r => r.channelId === 'DUBOB')));
  assert.match(v.ephemerals[0].text, /Your vote for \*Thai\* is in/);
});

scenario('the poll builder works from /newpoll to a posted poll', async sim => {
  const ama = sim.user('UAMA');
  const typed = (n, textValue, type, options) => ({
    [`q_text_${n}`]: { value: { type: 'plain_text_input', value: textValue } },
    [`q_type_${n}`]: { question_type_changed: { type: 'static_select', selected_option: { value: type } } },
    ...(options !== undefined ? { [`q_options_${n}`]: { value: { type: 'plain_text_input', value: options } } } : {})
  });
  clean(await ama.command('/newpoll', '', { channel: 'C1' }));
  assert.strictEqual(ama.top.view.title.text, 'New Poll');

  clean(await ama.press('add_another_question', {}, { values: typed(1, 'Where should we eat?', 'multiple_choice', 'Thai\nSushi\nPizza') }));
  assert.match(text(ama.top.view.blocks), /Where should we eat\?/);

  clean(await ama.press('compose_options', {}, { values: typed(2, '', 'multiple_choice', '') }));
  assert.deepStrictEqual(ama.stack.map(v => v.view.title.text), ['New Poll  (1)', 'Poll Options']);
  clean(await ama.submit({
    poll_title: { value: { type: 'plain_text_input', value: 'Friday lunch' } },
    poll_settings: { value: { type: 'checkboxes', selected_options: [{ value: 'allow_revote' }] } },
    poll_show_results: { value: { type: 'static_select', selected_option: { value: 'realtime' } } }
  }));

  clean(await ama.press('compose_preview', {}, { values: typed(2, '', 'multiple_choice', '') }));
  assert.strictEqual(ama.top.view.callback_id, 'poll_preview_submit');
  clean(await ama.submit({}));

  assert.strictEqual(ama.stack.length, 0);
  const row = sim.db.rows()[0];
  assert.strictEqual(row.title, 'Friday lunch');
  assert.strictEqual(row.allow_revote, true);
  assert.deepStrictEqual(sim.slack.messages.size, 1);
  assert.deepStrictEqual(sim.logged('error'), []);
});

scenario('every question type that can be posted can also be voted on in the modal', async sim => {
  const types = ['multiple_choice', 'multiple_select', 'yes_no', 'agree_disagree', 'scale_5', 'scale_10', 'likert', 'ranking', 'open_ended'];
  const made = await sim.user('UAMA').createPoll({ questions: types.map((t, i) => V.buildQuestion(`Q${i} ${t}?`, t, 'Alpha\nBeta\nGamma')) });
  assert.strictEqual(made.messageRefs.length, 1, sim.user('UAMA').dms().map(m => m.text).join(' '));
  const k = sim.user('UK');
  const opened = await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  clean(opened);
  assert.ok(opened.modal, 'the vote modal opens');
});

// What Slack sends for a ballot: the answer picked, and the notify box as it
// stands - including a tick it was opened with and nobody touched.
const ballot = (view, pick, notify) => {
  const input = view.blocks.find(b => b.type === 'input' && b.block_id === 'vote_q0');
  const box = view.blocks.find(b => b.block_id === 'vote_notify').element;
  const ticked = notify ?? (box.initial_options || []);
  return {
    vote_q0: { [input.element.action_id]: { type: input.element.type, selected_option: input.element.options[pick] } },
    vote_notify: { value: { type: 'checkboxes', selected_options: ticked } }
  };
};

scenario('changing your vote keeps your ask to be told when the poll closes', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()], settings: ['allow_revote'] });
  const k = sim.user('UEFUA');
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  clean(await k.submit(ballot(k.top.view, 0, [{ value: 'notify' }])));
  k.dismiss();
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  clean(await k.submit(ballot(k.top.view, 1)));
  assert.deepStrictEqual(JSON.parse(sim.db.row(made.id).notify_on_close), ['UEFUA']);
});

scenario('the "poll closed" DM opens the final results', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ title: 'Team lunch', questions: [LUNCH()] });
  const k = sim.user('UEFUA');
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  clean(await k.submit(ballot(k.top.view, 0, [{ value: 'notify' }])));
  k.dismiss();
  await ama.command('/poll-close', made.id);
  clean(await ama.submit({}));
  const dm = k.dms().find(m => /has been closed/.test(JSON.stringify(m.blocks)));
  assert.ok(dm, 'the DM arrived');
  const visible = dm.blocks.flatMap(b => [b.text?.text, ...(b.elements || []).map(e => e.text?.text ?? e.text)]).join(' ');
  assert.doesNotMatch(visible, /poll_\d/, 'no raw id to decode');
  const r = await k.press('view_results_modal', {}, { channel: dm.channel, ts: dm.ts });
  clean(r);
  assert.match(JSON.stringify(k.top.view.blocks), /Team lunch/);
});

scenario('after posting, the creator is shown how to change the title', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const said = JSON.stringify(sim.user('UAMA').whispers().concat(sim.user('UAMA').dms()).map(m => m.blocks));
  assert.ok(said.includes(`/poll-edit ${made.id}`), said.slice(0, 300));
});

scenario('with vote changes off, the vote modal says so once you have voted', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()], settings: [] });
  const k = sim.user('UK');
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  const input = k.top.view.blocks.find(b => b.type === 'input');
  const done = await k.submit({ [input.block_id]: { [input.element.action_id]: { type: 'radio_buttons', selected_option: input.element.options[0] } } });
  clean(done);
  assert.strictEqual(k.top.view.title.text, 'Vote Recorded');
  k.dismiss();
  const again = await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  assert.strictEqual(again.modal.title.text, 'Already Voted');
});

scenario('every handler on the voter and creator paths acks exactly once', async sim => {
  const ama = sim.user('UAMA'), k = sim.user('UK');
  const made = await ama.createPoll({ questions: [LUNCH()], settings: ['allow_revote'] });
  const ref = made.messageRefs[0];
  const seen = [];
  seen.push(await k.press('vote_option_0_0', {}, at(ref)));
  seen.push(await k.press('vote_option_0_1', {}, at(ref)));
  seen.push(await k.press('poll_more', {}, at(ref)));
  seen.push(await k.press('more_results', {}));
  k.dismiss(); k.dismiss();
  seen.push(await k.command('/polls-list', '', { channel: 'C1' }));
  seen.push(await ama.command('/poll-results', made.id, { channel: 'C1' }));
  seen.push(await ama.command('/poll-edit', made.id, { channel: 'C1' }));
  for (const r of seen) clean(r);
});

// ==================== known problems (see AUDIT.md) ====================

scenario('a poll cannot ping the whole channel through its title, options or description', async sim => {
  const made = await sim.user('UAMA').createPoll({
    title: '<!channel> free pizza <!here>', description: '<!everyone>',
    questions: [Q('<!channel> ok?', ['<!channel>', 'No'])]
  });
  const m = message(sim, made.messageRefs[0]);
  assert.doesNotMatch(mrkdwnOf(m), /<!(channel|here|everyone)>/, 'Slack reads these as @channel / @here / @everyone');
});

scenario('a poll cannot carry a link whose visible text hides its destination', async sim => {
  const made = await sim.user('UAMA').createPoll({ title: 'Sign in <https://evil.example|here>', questions: [LUNCH()] });
  const m = message(sim, made.messageRefs[0]);
  assert.doesNotMatch(mrkdwnOf(m), /<https:\/\/evil\.example\|here>/);
});

scenario('a voter\'s written answer cannot ping the channel when the results are posted', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [OPEN('Ideas?')] });
  const k = sim.user('UK');
  await k.press('open_vote_modal', {}, at(made.messageRefs[0]));
  await k.submit({ vote_q0: { response: { type: 'plain_text_input', value: '<!channel> urgent' } } });
  await ama.command('/poll-close', made.id);
  await ama.submit({});
  const [final] = announcements(sim);
  assert.doesNotMatch(mrkdwnOf(final.args), /<!channel>/);
});

scenario('the message tally always matches the database, however votes interleave', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [Q('Lunch?', ['Thai', 'Sushi'])] });
  const ref = made.messageRefs[0];
  const real = sim.slack.client.chat.update;
  let n = 0;
  sim.slack.client.chat.update = async args => { if (++n === 1) await new Promise(r => setTimeout(r, 40)); return real(args); };
  await Promise.all([
    sim.user('UA').press('vote_option_0_0', {}, at(ref)),
    new Promise(r => setTimeout(r, 5)).then(() => sim.user('UB').press('vote_option_0_1', {}, at(ref)))
  ]);
  const votes = Object.values(votesOf(sim, made.id)[0]).flat().length;
  assert.strictEqual(votes, 2);
  assert.match(text(message(sim, ref)), /\*2\* participants/, 'the slower refresh must not overwrite the newer one');
});

scenario('a poll with an NPS question can be posted', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [V.buildQuestion('How likely are you to recommend us?', 'nps', '')] });
  assert.strictEqual(made.messageRefs.length, 1, ama.dms().map(m => m.text).join(' '));
});

scenario('a poll that fails to post does not use up the creator\'s daily allowance', async sim => {
  const ama = sim.user('UAMA');
  // G1 is a private channel the app was never invited to, so nothing posts.
  for (let i = 0; i < MAX_POLLS_PER_USER_PER_DAY; i++) await ama.createPoll({ questions: [LUNCH()], destChannels: ['G1'] });
  const ok = await ama.createPoll({ questions: [LUNCH()] });
  assert.strictEqual(ok.messageRefs.length, 1, ama.dms().map(m => m.text).slice(-1).join(' '));
});

scenario('a closed poll\'s message still gives its creator a way to export', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const ref = made.messageRefs[0];
  await ama.press('poll_more', {}, at(ref));
  await ama.press('more_close', {});
  assert.ok(buttonsOn(message(sim, ref)).includes('poll_more'), `closed message offers: ${buttonsOn(message(sim, ref))}`);
  await ama.press('poll_more', {}, at(ref));
  assert.ok(actionsIn(ama.top.view).includes('more_export'));
  await ama.press('more_export', {});
  assert.strictEqual(sim.slack.files.length, 1);
});

scenario('/poll-export works in a public channel the bot has not joined', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  const r = await ama.command('/poll-export', made.id, { channel: 'C1' });
  assert.strictEqual(sim.slack.files.length, 1, ama.dms().map(m => m.text).join(' '));
  assert.match(r.ephemerals[0].text, /is in your DM with me/);
});

scenario('a poll cannot be created with a close time that has already passed', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()], closeAt: new Date(Date.now() - 3600000).toISOString() });
  assert.strictEqual(made.messageRefs.length, 0, 'it was posted as an active poll');
});

scenario('the options screen refuses a close time that has already passed', async sim => {
  const ama = sim.user('UAMA');
  await ama.command('/newpoll');
  await ama.press('compose_options', {});
  const r = await ama.submit({ poll_close_at: { value: { type: 'datetimepicker', selected_date_time: Math.floor(Date.now() / 1000) - 60 } } });
  assert.deepStrictEqual(Object.keys(r.viewErrors || {}), ['poll_close_at']);
});

scenario('Post from the preview keeps the draft when the close time has passed', async sim => {
  const ama = sim.user('UAMA');
  const meta = { channelId: 'C1', userId: 'UAMA', savedQuestions: [LUNCH()], closeAt: new Date(Date.now() - 60000).toISOString() };
  const r = await ama.submitDirect('poll_preview_submit', { privateMetadata: JSON.stringify(meta) });
  assert.strictEqual(r.ackPayload?.response_action, 'update', 'the screens were cleared, and the draft with them');
  assert.match(text(r.ackPayload.view.blocks), /already passed/);
  assert.strictEqual(sim.db.rows().length, 0);
});

scenario('Post refuses a close time that passed while the poll was being written', async sim => {
  const ama = sim.user('UAMA');
  const meta = { channelId: 'C1', userId: 'UAMA', savedQuestions: [LUNCH()], closeAt: new Date(Date.now() - 60000).toISOString() };
  const r = await ama.submitDirect('poll_compose_submit', { privateMetadata: JSON.stringify(meta) });
  assert.match(r.ackPayload?.errors?.q_text_2 || '', /already passed/);
  assert.strictEqual(sim.db.rows().length, 0);
});

scenario('a poll with a paragraph from each of ten people still updates', async sim => {
  const made = await sim.user('UAMA').createPoll({ questions: [OPEN('What should we change?'), LUNCH()] });
  const ref = made.messageRefs[0];
  // An ordinary retro: ten people, a few sentences each.
  for (let i = 0; i < 10; i++) {
    const p = sim.user(`UP${i}`);
    await p.press('open_vote_modal', {}, at(ref));
    await p.submit({ vote_q0: { response: { type: 'plain_text_input', value: 'A sentence of honest feedback. '.repeat(10) } } });
  }
  await sim.user('UE').press('vote_option_1_0', {}, at(ref));
  assert.match(text(message(sim, ref)), /<@UE>/, 'the message stopped showing new votes');
  assert.match(text(message(sim, ref)), /and 1 more/, 'and says what it is not showing');
  await sim.user('UAMA').command('/poll-close', made.id);
  await sim.user('UAMA').submit({});
  assert.strictEqual(announcements(sim).length, 1, 'the final results were posted');
});

// These four put someone else's action into the gap between the bot reading a
// poll and writing it back. The gap is whatever the bot does there, so they
// match any write rather than today's statement - a fix may change it.
const WRITE = /^(INSERT INTO|UPDATE) polls/;

scenario('a vote cast while the poll is still being posted is kept', async sim => {
  // A voter presses the moment the message appears, before the bot has
  // recorded where it posted it.
  const post = sim.slack.client.chat.postMessage;
  let voted = null;
  sim.slack.client.chat.postMessage = async args => {
    const r = await post(args);
    if (!voted && args.channel === 'C1') {
      voted = sim.user('UK').press('vote_option_0_0', {}, { channel: 'C1', ts: r.ts });
      await voted;
    }
    return r;
  };
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  assert.deepStrictEqual((await voted).ephemerals.map(e => e.text), ['✅ Your vote for *Thai* is in.']);
  assert.deepStrictEqual(votesOf(sim, made.id)[0][0], ['UK'], 'the voter was told it counted');
});

scenario('an edit does not undo a vote that lands while it is saving', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-edit', made.id);
  sim.db.before(WRITE, () => sim.user('UK').press('vote_option_0_1', {}, at(made.messageRefs[0])));
  await ama.submit({ edit_title: { value: { value: 'Lunch, Friday' } } });
  await sim.db.settle();
  assert.strictEqual(sim.db.row(made.id).title, 'Lunch, Friday');
  assert.deepStrictEqual(votesOf(sim, made.id)[0][1], ['UK']);
});

scenario('an edit cannot reopen a poll that closed while it was saving', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-edit', made.id);
  sim.db.before(WRITE, () => sim.user('UAMA').command('/poll-close', made.id));
  await ama.submit({ edit_title: { value: { value: 'Lunch, Friday' } } });
  await sim.db.settle();
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  assert.ok(!buttonsOn(message(sim, made.messageRefs[0])).includes('open_vote_modal'), 'its final results are out, and it takes votes again');
});

scenario('a closed poll cannot be edited', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-close', made.id);
  assert.strictEqual(sim.db.row(made.id).status, 'closed');
  const r = await ama.command('/poll-edit', made.id);
  assert.strictEqual(r.modal, null);
  assert.match(r.ephemerals[0].text, /has closed, so it can no longer be edited/);
});

scenario('an edit that saves slowly shows Saving, then the result, never an error', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-edit', made.id);
  // Past the two seconds the bot gives itself before Slack's three run out.
  sim.db.before(/^UPDATE polls SET title/, () => new Promise(r => setTimeout(r, 2100)));
  const r = await ama.submit({ edit_title: { value: { value: 'Lunch, Friday' } } });
  assert.match(text(r.ackPayload.view.blocks), /Saving your edit/);
  const later = r.calls.filter(c => c.method === 'views.update');
  assert.strictEqual(later.length, 1);
  assert.match(text(later[0].args.view.blocks), /has been updated/);
  assert.match(text(message(sim, made.messageRefs[0])), /Lunch, Friday/);
});

scenario('two people sending a poll at the same moment both get a copy that stays in step', async sim => {
  sim.slack.addChannel('C3', { type: 'public', name: 'social' });
  const made = await sim.user('UAMA').createPoll({ questions: [LUNCH()] });
  const pick = ch => ({ poll_dest_channels: { value: { type: 'multi_conversations_select', selected_conversations: [ch] } } });
  const [k, e] = [sim.user('UK'), sim.user('UE')];
  for (const p of [k, e]) { await p.press('poll_more', {}, at(made.messageRefs[0])); await p.press('more_send', {}); }
  sim.db.before(WRITE, () => e.submit(pick('C3')));
  await k.submit(pick('C2'));
  await sim.db.settle();
  assert.deepStrictEqual(JSON.parse(sim.db.row(made.id).message_refs).map(r => r.channelId).sort(), ['C1', 'C2', 'C3'],
    'the forgotten copy never updates and never shows the poll closed');
});
