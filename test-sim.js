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
  assert.deepStrictEqual(buttonsOn(message(sim, made.messageRefs[0])), ['view_results_modal', 'share_poll']);
});

scenario('a sleeping database costs the first press its three seconds, and the person is told to press again', async sim => {
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
}, { todo: 'AUDIT #5: More is only on active polls, so a closed poll has no Export in the channel' });

scenario('/poll-export works in a public channel the bot has not joined', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()] });
  await ama.command('/poll-export', made.id, { channel: 'C1' });
  assert.strictEqual(sim.slack.files.length, 1, ama.dms().map(m => m.text).join(' '));
}, { todo: 'AUDIT #6: the command uploads to the channel it ran in, which fails with a raw Slack error unless the bot was invited' });

scenario('a poll cannot be created with a close time that has already passed', async sim => {
  const ama = sim.user('UAMA');
  const made = await ama.createPoll({ questions: [LUNCH()], closeAt: new Date(Date.now() - 3600000).toISOString() });
  assert.strictEqual(made.messageRefs.length, 0, 'it was posted as an active poll');
}, { todo: 'AUDIT #7: nothing checks that the close time is in the future' });

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
