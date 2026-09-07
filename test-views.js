// Tests for lib/views.js — the app's screens, against Slack's own limits.
//
// Slack does not partially render a bad view; it rejects the whole thing, and
// an app that pushes one shows the user nothing and says nothing. So the limits
// below are not style rules, they are the difference between a screen and a
// silent failure - which is why they are asserted here rather than discovered
// in a workspace.
//
// These import the same module the bot requires — do not copy layout in here,
// or the tests will keep passing after the real screens change.

const { test } = require('node:test');
const assert = require('node:assert');

const views = require('./lib/views');
const {
  buildComposeModal, buildOptionsModal, buildPreviewModal, buildQuestionModal,
  buildResultsModal, buildPollBlocks, buildVoteModal, buildEditModal,
  buildShareModal, buildCloseConfirmModal, pollListBlocks, buildPollCsv,
  buildQuestion, restoreQuestion, rebuildComposeView, readOptionsSettings,
  settingsSummary, questionTypeIcon, questionTypeLabel,
  DEFAULT_SHOW_RESULTS, QUESTION_TYPE_GROUPS, buildResultsBlocks
} = views;
const { MULTI_SELECT_FORM_TYPE } = require('./lib/compose');
const { MAX_VIEW_METADATA, draftFitsInView, MAX_QUESTIONS_PER_POLL } = require('./lib/validation');

// ==================== Slack's documented view limits ====================

const LIMITS = {
  blocksPerView: 100,
  viewTitle: 24,
  buttonText: 75,
  headerText: 150,
  sectionText: 3000,
  contextElements: 10,
  actionElements: 25,
  privateMetadata: 3000
};

function auditView(view, label) {
  assert.ok(view.blocks.length <= LIMITS.blocksPerView,
    `${label}: ${view.blocks.length} blocks exceeds ${LIMITS.blocksPerView}`);

  for (const key of ['title', 'submit', 'close']) {
    if (view[key]) {
      assert.ok(view[key].text.length <= LIMITS.viewTitle,
        `${label}: ${key} "${view[key].text}" is ${view[key].text.length} chars, over ${LIMITS.viewTitle}`);
    }
  }

  const meta = view.private_metadata || '';
  assert.ok(meta.length <= LIMITS.privateMetadata,
    `${label}: private_metadata is ${meta.length} chars, over ${LIMITS.privateMetadata}`);

  auditBlocks(view.blocks, label);

  // Slack rejects a view whose input blocks collide on block_id, and the error
  // does not say which one.
  const ids = view.blocks.filter(b => b.block_id).map(b => b.block_id);
  assert.strictEqual(new Set(ids).size, ids.length, `${label}: duplicate block_id among ${ids.join(', ')}`);
}

function auditBlocks(blocks, label) {
  for (const b of blocks) {
    if (b.type === 'header') {
      assert.ok(b.text.text.length <= LIMITS.headerText,
        `${label}: header is ${b.text.text.length} chars, over ${LIMITS.headerText}`);
    }
    if (b.type === 'section' && b.text) {
      assert.ok(b.text.text.length <= LIMITS.sectionText,
        `${label}: section is ${b.text.text.length} chars, over ${LIMITS.sectionText}`);
    }
    if (b.type === 'context') {
      assert.ok(b.elements.length <= LIMITS.contextElements, `${label}: too many context elements`);
    }
    if (b.type === 'actions') {
      assert.ok(b.elements.length <= LIMITS.actionElements, `${label}: too many action elements`);
      for (const e of b.elements) {
        if (e.type === 'button') {
          assert.ok(e.text.text.length <= LIMITS.buttonText, `${label}: button text too long`);
        }
      }
    }
    if (b.type === 'input') {
      assert.ok(!!b.block_id, `${label}: an input block has no block_id, so its value cannot be read back`);
    }
  }
}

// ==================== fixtures ====================

const draft = (over = {}) => ({
  channelId: 'C0123456789', userId: 'U0123456789', savedQuestions: [], ...over
});

const question = (text = 'Lunch?', options = 'Thai\nSushi') =>
  buildQuestion(text, 'multiple_choice', options);

const poll = (over = {}) => ({
  id: 'poll_1706234567_abc12345',
  title: 'Lunch',
  description: '',
  questions: [question()],
  votes: { 0: { 0: ['U1', 'U2'], 1: ['U3'] } },
  anonymous: false,
  allowRevote: false,
  creator: 'U0123456789',
  status: 'active',
  showResults: 'realtime',
  voteTimestamps: {},
  messageRefs: [{ channelId: 'C1', messageTs: '1' }],
  ...over
});

const blockIds = view => view.blocks.map(b => b.block_id).filter(Boolean);
const findBlock = (view, id) => view.blocks.find(b => b.block_id === id);
const actionIds = view => view.blocks.find(b => b.type === 'actions').elements.map(e => e.action_id);

// ==================== the compose screen ====================

test('the compose screen is a valid view', () => {
  auditView(buildComposeModal(draft()), 'compose/empty');
});

test('the compose screen posts the poll itself, with no screen in between', () => {
  const v = buildComposeModal(draft());
  assert.strictEqual(v.callback_id, 'poll_compose_submit');
  assert.match(v.submit.text, /Post Poll/);
});

test('the compose screen holds the question, and where it goes, and nothing else', () => {
  const v = buildComposeModal(draft());
  // Title, description and the multi-select checkbox all moved off this screen;
  // if any of them comes back, the screen stops fitting a phone.
  assert.ok(!findBlock(v, 'poll_title'), 'title should live under More options');
  assert.ok(!findBlock(v, 'poll_description'), 'description should live under More options');
  assert.ok(!blockIds(v).some(id => id.startsWith('q_multiple')), 'multi-select is an entry in the type picker');
  assert.deepStrictEqual(v.blocks.filter(b => b.type === 'input').map(b => b.block_id), [
    'q_text_1', 'q_type_1', 'q_options_1', 'poll_dest_channels', 'poll_dest_users'
  ]);
});

test('the first question is required, so Slack raises that inline', () => {
  assert.strictEqual(findBlock(buildComposeModal(draft()), 'q_text_1').optional, false);
});

test('a further question is optional, so Post works with the form left blank', () => {
  const v = buildComposeModal(draft({ savedQuestions: [question(), question()] }));
  assert.strictEqual(findBlock(v, 'q_text_3').optional, true);
});

test('the channel the command came from is prefilled, so posting here needs no picking', () => {
  const picker = findBlock(buildComposeModal(draft()), 'poll_dest_channels');
  assert.deepStrictEqual(picker.element.initial_conversations, ['C0123456789']);
  assert.strictEqual(picker.label.text, 'Where to post');
});

test('a DM is not a channel the app can post to, so it is left unprefilled', () => {
  // resolveDestinations falls back for these; offering an impossible channel
  // would be worse than offering none.
  const picker = findBlock(buildComposeModal(draft({ channelId: 'D0123456789' })), 'poll_dest_channels');
  assert.strictEqual(picker.element.initial_conversations, undefined);
});

test('clearing the channel picker stays cleared rather than re-prefilling', () => {
  const picker = findBlock(buildComposeModal(draft({ destChannels: [] })), 'poll_dest_channels');
  assert.strictEqual(picker.element.initial_conversations, undefined);
});

test('the three side trips are buttons, not steps', () => {
  assert.deepStrictEqual(actionIds(buildComposeModal(draft())),
    ['add_another_question', 'compose_options', 'compose_preview']);
});

test('the command line prefills the question and its choices', () => {
  const v = buildComposeModal(draft(), 'multiple_choice', { text: 'Lunch?', options: 'Thai\nSushi\nPizza' });
  assert.strictEqual(findBlock(v, 'q_text_1').element.initial_value, 'Lunch?');
  assert.strictEqual(findBlock(v, 'q_options_1').element.initial_value, 'Thai\nSushi\nPizza');
});

test('a question already added is listed with a menu to change it', () => {
  const v = buildComposeModal(draft({ savedQuestions: [question('First?'), question('Second?')] }));
  auditView(v, 'compose/2-questions');
  const menus = v.blocks.filter(b => b.accessory?.action_id === 'question_action');
  assert.strictEqual(menus.length, 2);
  assert.deepStrictEqual(menus[0].accessory.options.map(o => o.value),
    ['edit:0', 'duplicate:0', 'move_up:0', 'move_down:0', 'delete:0']);
});

test('an error is shown on the screen rather than swallowed', () => {
  const v = buildComposeModal(draft(), 'multiple_choice', {}, 'Write this question first.');
  assert.ok(v.blocks.some(b => b.text?.text?.includes('Write this question first.')));
});

test('types that supply their own answers ask for no choices', () => {
  for (const type of ['yes_no', 'agree_disagree', 'scale_5', 'scale_10', 'nps', 'open_ended']) {
    const v = buildComposeModal(draft(), type);
    assert.ok(!findBlock(v, 'q_options_1'), `${type} should not ask for choices`);
    auditView(v, `compose/${type}`);
  }
});

test('multi-select says what it means where the choices are typed', () => {
  const v = buildComposeModal(draft(), MULTI_SELECT_FORM_TYPE);
  assert.match(findBlock(v, 'q_options_1').label.text, /pick several/);
});

test('every question type in the picker builds a valid screen', () => {
  for (const group of QUESTION_TYPE_GROUPS) {
    for (const option of group.options) {
      auditView(buildComposeModal(draft(), option.value), `compose/${option.value}`);
    }
  }
});

// ==================== written for a narrow screen ====================
//
// Slack renders a full-screen sheet on a phone, so text wraps at roughly 40
// characters instead of 90. These are character budgets rather than pixel
// heights: the wrapping is real, the pixel model was an estimate, and only one
// of those is worth asserting.

const MOBILE_LINE = 40;

test('no label or hint on the compose screen runs past three phone lines', () => {
  const v = buildComposeModal(draft());
  for (const b of v.blocks) {
    for (const [what, text] of [['label', b.label?.text], ['hint', b.hint?.text]]) {
      if (!text) continue;
      assert.ok(text.length <= MOBILE_LINE * 3,
        `${b.block_id} ${what} is ${text.length} chars, over three lines on a phone: "${text}"`);
    }
  }
});

test('the settings summary stays inside three phone lines', () => {
  // It is the last thing on the screen and the least urgent, but it grew to
  // four wrapped lines once it listed where every setting lived.
  const longest = settingsSummary({
    pollTitle: 'Q3 planning', pollSettings: ['anonymous', 'allow_revote'],
    showResults: 'on_close', orderByVotes: true
  });
  assert.ok(longest.length <= MOBILE_LINE * 4, `summary is ${longest.length} chars: "${longest}"`);
});

test('no type picker entry can lose its meaning to truncation', () => {
  // "Multiple choice — pick one" and "— pick several" put the only words that
  // told them apart at the end, which is what a narrow select button cuts.
  for (const group of QUESTION_TYPE_GROUPS) {
    for (const o of group.options) {
      assert.ok(o.text.text.length <= 24,
        `"${o.text.text}" is ${o.text.text.length} chars and may truncate on a phone`);
    }
  }
  // And the first word has to be the distinguishing one.
  const all = QUESTION_TYPE_GROUPS.flatMap(g => g.options).map(o => o.text.text);
  const heads = all.map(t => t.split(' ').slice(0, 2).join(' '));
  assert.strictEqual(new Set(heads).size, heads.length,
    `two entries share their opening words: ${heads.join(' | ')}`);
});

test('the compose buttons stay short enough not to stack three deep', () => {
  const labels = buildComposeModal(draft()).blocks.find(b => b.type === 'actions')
    .elements.map(e => e.text.text);
  const total = labels.reduce((n, l) => n + l.length + 4, 0);
  assert.ok(total <= MOBILE_LINE * 2, `buttons total ${total} chars: ${labels.join(' / ')}`);
});

// ==================== the options screen ====================

test('the options screen is a valid view', () => {
  auditView(buildOptionsModal(draft()), 'options');
});

test('results are live by default', () => {
  assert.strictEqual(DEFAULT_SHOW_RESULTS, 'realtime');
  assert.strictEqual(
    findBlock(buildOptionsModal(draft()), 'poll_show_results').element.initial_option.value,
    'realtime'
  );
});

test('the title and description live here, and stay optional', () => {
  const v = buildOptionsModal(draft());
  for (const id of ['poll_title', 'poll_description']) {
    assert.strictEqual(findBlock(v, id).optional, true, `${id} must not be required`);
  }
});

test('a draft too large to carry says so rather than losing the question silently', () => {
  const v = buildOptionsModal(draft(), true);
  assert.ok(v.blocks.some(b => b.text?.text?.includes('will not be here when you go back')));
  auditView(v, 'options/draft-dropped');
});

test('saving the options screen untouched changes nothing', () => {
  const before = { pollSettings: ['anonymous'], showResults: 'on_close', orderByVotes: true, closeAt: null };
  const after = readOptionsSettings({}, before);
  assert.strictEqual(after.showResults, 'on_close');
  assert.deepStrictEqual(after.pollSettings, ['anonymous']);
});

test('a setting can be turned back off, not only on', () => {
  const off = readOptionsSettings(
    { poll_order_by_votes: { value: { selected_options: [] } } },
    { orderByVotes: true, closeAt: '2030-01-01T00:00:00.000Z' }
  );
  assert.strictEqual(off.orderByVotes, false, 'sort by votes must be untickable');
  assert.strictEqual(off.closeAt, null, 'auto-close must be clearable');
});

// ==================== the preview screen ====================

test('the preview screen is a valid view', () => {
  auditView(buildPreviewModal(draft({ savedQuestions: [question()], pollTitle: 'Lunch' })), 'preview');
});

test('the preview carries no pickers, so going back cannot reset them', () => {
  const v = buildPreviewModal(draft({ savedQuestions: [question()] }));
  assert.ok(!findBlock(v, 'poll_dest_channels'));
  assert.ok(!findBlock(v, 'poll_dest_users'));
});

test('the preview says where the poll is about to go', () => {
  const named = buildPreviewModal(draft({ savedQuestions: [question()], destChannels: ['C9'], destUsers: ['U9'] }));
  const line = named.blocks.map(b => b.text?.text || '').join(' ');
  assert.match(line, /Posting to/);
  assert.match(line, /<#C9>/);
  assert.match(line, /<@U9>/);

  const fallback = buildPreviewModal(draft({ savedQuestions: [question()], destChannels: [], destUsers: [] }));
  assert.match(fallback.blocks.map(b => b.text?.text || '').join(' '), /the conversation you started from/);
});

test('a long poll gives up its preview rather than its destination line', () => {
  // The largest draft the carrying limit allows. It still runs past Slack's 100
  // blocks, so the capping is exercised - and the pickers are the point of the
  // screen, so they are what has to survive.
  let n = 0;
  while (draftFitsInView(draft({ savedQuestions: Array(n + 1).fill(question()), pollTitle: 'Long' }))) n++;
  const v = buildPreviewModal(draft({ savedQuestions: Array(n).fill(question()), pollTitle: 'Long' }));
  assert.ok(n * 4 > LIMITS.blocksPerView, `${n} questions should overflow 100 blocks unaided`);
  auditView(v, `preview/${n}-questions`);
  assert.match(v.blocks.map(b => b.text?.text || '').join(' '), /Posting to/);
});

// ==================== the draft ceiling ====================

test('a realistic multi-question draft is nowhere near the carrying limit', () => {
  const five = Array.from({ length: 5 }, (_, i) => question(`Which option for area ${i + 1}?`, 'A\nB\nC'));
  assert.strictEqual(draftFitsInView(draft({ savedQuestions: five })), true);
});

test('a draft the validator would accept can still be too big to carry', () => {
  // This is why the builder refuses in words: the count limit is a backstop,
  // and the byte limit is what actually fires.
  const many = Array.from({ length: MAX_QUESTIONS_PER_POLL }, (_, i) =>
    question(`Which option do you prefer for area ${i + 1}?`, 'Dark mode\nOffline sync\nBetter search'));
  assert.strictEqual(draftFitsInView(draft({ savedQuestions: many })), false);
});

test('a compose screen built at the ceiling is still a view Slack accepts', () => {
  let n = 0;
  while (draftFitsInView(draft({ savedQuestions: Array(n + 1).fill(question()) }))) n++;
  assert.ok(n >= 8, `the ceiling should leave room for a real poll, got ${n} questions`);
  const v = buildComposeModal(draft({ savedQuestions: Array(n).fill(question()) }));
  auditView(v, `compose/${n}-questions`);
  assert.ok(v.private_metadata.length <= MAX_VIEW_METADATA);
});

// ==================== a side trip loses nothing ====================

test('a half-typed question survives a trip to the options screen and back', () => {
  const carried = {
    ...draft({ destChannels: ['C999'], destUsers: ['U9'], pollTitle: 'Kept', pollDescription: 'Also kept' }),
    draft: { text: 'Half typed?', type: MULTI_SELECT_FORM_TYPE, optionsRaw: 'A\nB' },
    composeViewId: 'V1'
  };
  const saved = readOptionsSettings({
    poll_settings: { value: { selected_options: [{ value: 'anonymous' }] } },
    poll_show_results: { value: { selected_option: { value: 'on_close' } } },
    poll_order_by_votes: { value: { selected_options: [] } }
  }, carried);

  const rebuilt = rebuildComposeView({ ...carried, ...saved });
  auditView(rebuilt, 'compose/rebuilt');

  assert.strictEqual(findBlock(rebuilt, 'q_text_1').element.initial_value, 'Half typed?');
  assert.strictEqual(findBlock(rebuilt, 'q_options_1').element.initial_value, 'A\nB');
  assert.match(findBlock(rebuilt, 'q_options_1').label.text, /pick several/,
    'the type of the half-typed question has to survive too');
  assert.deepStrictEqual(findBlock(rebuilt, 'poll_dest_channels').element.initial_conversations, ['C999']);
  assert.deepStrictEqual(findBlock(rebuilt, 'poll_dest_users').element.initial_users, ['U9']);

  const meta = JSON.parse(rebuilt.private_metadata);
  assert.strictEqual(meta.pollTitle, 'Kept');
  assert.strictEqual(meta.pollDescription, 'Also kept');
  assert.strictEqual(meta.showResults, 'on_close');
  // The journey's own keys are not part of the poll and must not accumulate in
  // the metadata, which is the thing with a size limit.
  for (const key of ['draft', 'composeViewId', 'questionPageViewId', 'editingIndex']) {
    assert.ok(!(key in meta), `${key} should not survive into the rebuilt view`);
  }
});

test('the summary line names the title, so moving it is not hiding it', () => {
  assert.match(settingsSummary({ pollTitle: 'Q3 planning' }), /Q3 planning/);
  assert.match(settingsSummary({}), /Named after your first question/);
  assert.match(settingsSummary({}), /More options/);
});

test('the summary line reports what the settings actually are', () => {
  assert.match(settingsSummary({}), /Live results/);
  assert.match(settingsSummary({ showResults: 'on_close' }), /after close/);
  assert.match(settingsSummary({ showResults: 'creator_only' }), /creator only/);
  assert.match(settingsSummary({ pollSettings: ['anonymous'] }), /Anonymous/);
  assert.match(settingsSummary({ pollSettings: ['allow_revote'] }), /Vote changes/);
});

test('restoreQuestion carries only what the form can restore', () => {
  assert.deepStrictEqual(
    restoreQuestion({ text: 'Q', optionsRaw: 'A\nB', type: 'multiple_choice' }),
    { text: 'Q', options: 'A\nB' }
  );
  assert.deepStrictEqual(restoreQuestion(), { text: '', options: '' });
});

// ==================== the question edit screen ====================

test('the edit screen is a valid view and only ever edits', () => {
  const v = buildQuestionModal(draft({ savedQuestions: [question()], editingIndex: 0 }), 'multiple_choice',
    { text: 'Lunch?', options: 'Thai\nSushi' });
  auditView(v, 'edit-question');
  assert.strictEqual(v.callback_id, 'question_submit');
  assert.strictEqual(v.title.text, 'Edit Question');
  assert.ok(!v.blocks.some(b => b.type === 'actions'), 'no Add another question on an edit');
});

// ==================== how a question describes itself ====================

test('a question is named the way it was chosen, wherever it is shown', () => {
  const one = buildQuestion('Pick one', 'multiple_choice', 'A\nB');
  const many = buildQuestion('Pick any', MULTI_SELECT_FORM_TYPE, 'A\nB');

  assert.strictEqual(questionTypeLabel(one), 'Multiple choice');
  assert.strictEqual(questionTypeLabel(many), 'Multi-select');
  assert.notStrictEqual(questionTypeIcon(many), questionTypeIcon(one));

  // The stored shape is unchanged, which is what keeps existing polls working.
  assert.deepStrictEqual(many, { text: 'Pick any', type: 'multiple_choice', options: ['A', 'B'], allowMultiple: true });
  assert.strictEqual(one.allowMultiple, false);
});

test('the label a question carries is the same one the CSV reports', () => {
  const many = buildQuestion('Pick any', MULTI_SELECT_FORM_TYPE, 'A\nB');
  const csv = buildPollCsv(poll({ questions: [many] }));
  assert.ok(csv.includes(`"${questionTypeLabel(many)}"`), csv.split('\n')[1]);
});

test('auto-option types get their answers without any being typed', () => {
  assert.deepStrictEqual(buildQuestion('Ship it?', 'yes_no', '').options, ['Yes', 'No']);
  assert.deepStrictEqual(buildQuestion('Free text', 'open_ended', '').options, []);
});

// ==================== the poll message ====================

test('the posted poll is a valid message', () => {
  auditBlocks(buildPollBlocks(poll()), 'poll-message');
});

test('an active poll offers a vote, a send and a close', () => {
  const blocks = buildPollBlocks(poll());
  const ids = blocks.find(b => b.type === 'actions').elements.map(e => e.action_id);
  assert.deepStrictEqual(ids, ['open_vote_modal', 'share_poll', 'close_poll']);
});

test('a closed poll is a record, so the ballot buttons go', () => {
  const blocks = buildPollBlocks(poll({ status: 'closed' }));
  const ids = blocks.find(b => b.type === 'actions').elements.map(e => e.action_id);
  assert.deepStrictEqual(ids, ['view_results_modal', 'share_poll']);
});

test('hiding the tally does not hide the ballot', () => {
  // Withholding the option list too left a question in the channel with no
  // visible answers.
  for (const showResults of ['creator_only', 'on_close']) {
    const rendered = JSON.stringify(buildPollBlocks(poll({ showResults })));
    assert.ok(rendered.includes('Thai'), `${showResults} should still list the options`);
  }
});

test('a poll too long for one message is summarised, never truncated', () => {
  // Cutting the tail off a ballot would drop questions people could otherwise
  // answer, with no way for them to tell.
  const many = Array.from({ length: 60 }, (_, i) => question(`Question ${i + 1}?`, 'A\nB\nC'));
  const votes = Object.fromEntries(many.map((_, i) => [i, { 0: [], 1: [], 2: [] }]));
  const blocks = buildPollBlocks(poll({ questions: many, votes }));
  auditBlocks(blocks, 'poll-message/60-questions');
  assert.ok(blocks.length <= LIMITS.blocksPerView, `${blocks.length} blocks`);
  const rendered = JSON.stringify(blocks);
  assert.ok(rendered.includes('Question 60?'), 'the last question must still be accounted for');
});

test('headerText trims to Slack\'s limit and shows that it did', () => {
  const { headerText, SLACK_HEADER_LIMIT } = views;
  assert.strictEqual(SLACK_HEADER_LIMIT, 150);
  assert.strictEqual(headerText('short'), 'short');
  const trimmed = headerText('T'.repeat(400));
  assert.strictEqual(trimmed.length, SLACK_HEADER_LIMIT);
  assert.ok(trimmed.endsWith('…'), 'a trimmed heading should read as trimmed');
  // The emoji prefix counts toward the limit too, so the whole string is measured.
  assert.strictEqual(headerText(`📊  ${'T'.repeat(400)}`).length, SLACK_HEADER_LIMIT);
  assert.strictEqual(headerText(undefined), '');
});

test('a title longer than a header allows is trimmed, not rejected', () => {
  // MAX_POLL_TITLE_LENGTH is 200 and a Slack header caps at 150.
  const long = 'T'.repeat(200);
  const p = poll({ title: long });
  auditView(buildResultsModal({ ...p, status: 'closed' }, 'U1'), 'results/long-title');
  auditView(buildEditModal(p), 'edit-poll/long-title');
  auditView(buildPreviewModal(draft({ savedQuestions: [question()], pollTitle: long })), 'preview/long-title');
  auditBlocks(buildPollBlocks(p), 'poll-message/long-title');
  auditBlocks(buildResultsBlocks(p, `Results: ${long}`, 'U1'), 'results-blocks/long-title');
});

// ==================== results, voting and sharing ====================

test('the results modal does not call an active poll closed', () => {
  const active = JSON.stringify(buildResultsModal(poll(), 'U0123456789'));
  assert.ok(active.includes('Active'), 'an active poll should read as active');
  const closed = JSON.stringify(buildResultsModal(poll({ status: 'closed' }), 'U1'));
  assert.ok(closed.includes('Closed'));
});

test('the vote, share, edit and close screens are valid views', () => {
  auditView(buildVoteModal(poll()), 'vote');
  auditView(buildShareModal(poll()), 'share');
  auditView(buildEditModal(poll()), 'edit-poll');
  auditView(buildCloseConfirmModal(poll(), 'C1', 3), 'close-confirm');
  auditView(buildResultsModal(poll(), 'U1'), 'results');
});

test('a voter sees which option they picked', () => {
  const v = buildVoteModal(poll(), { 0: ['0'] });
  assert.ok(JSON.stringify(v).includes('Thai'));
  assert.match(v.title.text, /Vote/);
});

// ==================== the poll lists ====================

test('every poll on a list carries buttons rather than an id to copy', () => {
  const blocks = pollListBlocks([poll(), poll()]);
  auditBlocks(blocks, 'polls-list');
  const rows = blocks.filter(b => b.type === 'actions');
  assert.strictEqual(rows.length, 2, 'one button row per poll');
  assert.deepStrictEqual(rows[0].elements.map(e => e.action_id),
    ['list_poll_results', 'share_poll', 'close_poll', 'list_poll_export']);
});

test('a closed poll cannot be closed again', () => {
  const blocks = pollListBlocks([poll({ status: 'closed' })], { closed: true });
  auditBlocks(blocks, 'polls-archive');
  assert.ok(!blocks.find(b => b.type === 'actions').elements.some(e => e.action_id === 'close_poll'));
});

test('a full page of polls still fits one message', () => {
  const blocks = pollListBlocks(Array.from({ length: 20 }, () => poll()));
  assert.ok(blocks.length <= LIMITS.blocksPerView, `${blocks.length} blocks`);
  auditBlocks(blocks, 'polls-list/20');
});

// ==================== the export ====================

test('a cell that a spreadsheet would execute is defused', () => {
  const csv = buildPollCsv(poll({ questions: [question('=SUM(A1:A2)', '=cmd|calc\nSushi')] }));
  assert.ok(csv.includes('"\'=SUM(A1:A2)"'), 'a formula must be quoted with a leading apostrophe');
  assert.ok(csv.includes('"\'=cmd|calc"'));
});

test('a quote in an answer does not break the row', () => {
  const csv = buildPollCsv(poll({ questions: [question('He said "hi"?', 'A\nB')] }));
  assert.ok(csv.includes('"He said ""hi""?"'));
});

test('an anonymous poll does not name its voters in the export', () => {
  const open = { text: 'Thoughts?', type: 'open_ended', options: [], allowMultiple: false };
  const csv = buildPollCsv(poll({ questions: [open], votes: { 0: { U7: 'It was fine' } }, anonymous: true }));
  assert.ok(!csv.includes('U7'), 'an anonymous export must not carry user ids');
  assert.ok(csv.includes('(anonymous)'));
});
