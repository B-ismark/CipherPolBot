// Every builder, against one corpus of difficult input, and against the
// numeric limits swept rather than sampled.
//
// Why this file exists: two defects shipped past 133 tests in one afternoon.
// Neither was a missing test - both were a missing *kind* of test. The screens
// were each checked with input somebody chose by hand, which means coverage was
// only ever as good as that person's imagination on that day.
//
// So the inputs live in one list (test-lib/audit.js) and every screen gets all
// of them. Add one entry there and every screen ever written is retested for
// it, which is the only way this stays affordable.
//
// And limits are walked, not sampled. The half-emoji defect fired at exactly
// one offset out of forty: a hand-picked case sits in the middle of a range,
// and faults live at its edges.

const { test } = require('node:test');
const assert = require('node:assert');

const V = require('./lib/views');
const { HOSTILE, EXTREME, auditView, auditBlocks, auditText, halfEmoji } = require('./test-lib/audit');
const {
  MAX_POLL_TITLE_LENGTH, MAX_QUESTIONS_PER_POLL, MAX_OPTIONS_PER_QUESTION,
  MAX_VIEW_METADATA, draftFitsInView
} = require('./lib/validation');

// ==================== the surfaces ====================
//
// Every builder, with the hostile string threaded into whichever field a person
// actually types. A surface returns a view, a block list, or a string, and says
// which so the right audit runs.

const q = (text, options = ['Thai', 'Sushi']) =>
  ({ text, type: 'multiple_choice', options, allowMultiple: false });

const pollWith = (s, over = {}) => ({
  id: 'poll_1706234567_abc12345',
  title: s,
  description: s,
  questions: [q(s, [s, 'Sushi'])],
  votes: { 0: { 0: ['U1', 'U2'], 1: ['U3'] } },
  anonymous: false,
  allowRevote: false,
  creator: 'U0123456789',
  status: 'active',
  showResults: 'realtime',
  voteTimestamps: { U1: Date.now() },
  messageRefs: [{ channelId: 'C1', messageTs: '1' }],
  ...over
});

const draftWith = s => ({
  channelId: 'C0123456789',
  userId: 'U0123456789',
  pollTitle: s,
  pollDescription: s,
  savedQuestions: [q(s, [s, 'Sushi'])]
});

const SURFACES = [
  ['compose/typed',      s => ({ view: V.buildComposeModal(draftWith(s), 'multiple_choice', { text: s, options: `${s}\nSushi` }) })],
  ['compose/error',      s => ({ view: V.buildComposeModal(draftWith(s), 'multiple_choice', {}, s) })],
  ['compose/multi',      s => ({ view: V.buildComposeModal(draftWith(s), 'multiple_select', { text: s, options: `${s}\n${s}` }) })],
  ['options',            s => ({ view: V.buildOptionsModal(draftWith(s)) })],
  ['options/dropped',    s => ({ view: V.buildOptionsModal(draftWith(s), true) })],
  ['preview',            s => ({ view: V.buildPreviewModal(draftWith(s)) })],
  ['question-edit',      s => ({ view: V.buildQuestionModal(draftWith(s), 'multiple_choice', { text: s, options: `${s}\nSushi` }) })],
  ['poll-edit',          s => ({ view: V.buildEditModal(pollWith(s)) })],
  ['poll-edit/error',    s => ({ view: V.buildEditModal(pollWith(s), s) })],
  ['vote/fresh',         s => ({ view: V.buildVoteModal(pollWith(s)) })],
  ['vote/changing',      s => ({ view: V.buildVoteModal(pollWith(s), { 0: ['0'] }) })],
  ['share',              s => ({ view: V.buildShareModal(pollWith(s)) })],
  ['close-confirm',      s => ({ view: V.buildCloseConfirmModal(pollWith(s), 'C1', 3) })],
  ['results-modal',      s => ({ view: V.buildResultsModal(pollWith(s), 'U0123456789') })],
  ['results/hidden',     s => ({ view: V.buildResultsModal(pollWith(s, { showResults: 'creator_only' }), 'U9') })],
  ['post-vote',          s => ({ view: V.buildPostVoteModal(pollWith(s), 'U1') })],
  ['notice',             s => ({ view: V.buildNoticeModal('Heads up', s) })],
  ['poll-message',       s => ({ blocks: V.buildPollBlocks(pollWith(s)) })],
  ['poll-message/closed', s => ({ blocks: V.buildPollBlocks(pollWith(s, { status: 'closed' })) })],
  ['results-blocks',     s => ({ blocks: V.buildResultsBlocks(pollWith(s), s) })],
  ['poll-list',          s => ({ blocks: V.pollListBlocks([pollWith(s), pollWith(s)]) })],
  ['poll-list/archive',  s => ({ blocks: V.pollListBlocks([pollWith(s, { status: 'closed' })], { closed: true }) })],
  ['csv',                s => ({ csv: V.buildPollCsv(pollWith(s)) })]
];

// Every question type, because buildVoteModal branches on it and each branch
// builds its options differently - checkboxes, a rating select, a rank select,
// a plain text input. A corpus that only ever asks a multiple-choice question
// leaves most of that unvisited: a mutation removing the clamp from the
// checkbox branch alone went unnoticed until these were added.
const FORM_TYPES = [
  'multiple_choice', 'multiple_select', 'yes_no', 'agree_disagree',
  'scale_5', 'scale_10', 'nps', 'likert', 'ranking', 'open_ended'
];

// A question of each type, holding the hostile string wherever a person types.
const typedQuestion = (formType, s) => {
  const q = V.buildQuestion(s, formType, `${s}\nSecond choice`);
  return q.options.length ? q : { ...q, options: [] };
};

// Votes shaped the way each type actually stores them, so the results and CSV
// paths see a populated question rather than an empty one.
const votesFor = q => {
  if (q.type === 'open_ended') return { 0: { U1: 'a typed answer' } };
  // A ranking is stored as one comma-joined string of positions per voter,
  // which is why it is read back with .split - a shape worth copying exactly
  // rather than guessing, since guessing it wrong is what these tests are for.
  if (q.type === 'ranking')    return { 0: { U1: '1,2', U2: '2,1' } };
  if (q.type === 'likert')     return { 0: { 0: { 2: ['U1'] }, 1: { 4: ['U2'] } } };
  return { 0: { 0: ['U1', 'U2'], 1: ['U3'] } };
};

for (const formType of FORM_TYPES) {
  const build = s => {
    const q = typedQuestion(formType, s);
    return pollWith(s, { questions: [q], votes: votesFor(q) });
  };
  SURFACES.push(
    [`vote/${formType}`,      s => ({ view: V.buildVoteModal(build(s)) })],
    [`vote/${formType}/again`, s => {
      const p = build(s);
      return { view: V.buildVoteModal(p, votesFor(p.questions[0])[0].U1 ? {} : { 0: ['0'] }) };
    }],
    [`message/${formType}`,   s => ({ blocks: V.buildPollBlocks(build(s)) })],
    [`results/${formType}`,   s => ({ view: V.buildResultsModal(build(s), 'U0123456789') })],
    [`csv/${formType}`,       s => ({ csv: V.buildPollCsv(build(s)) })]
  );
}

// ==================== the corpus, through every surface ====================

for (const [name, build] of SURFACES) {
  test(`${name} survives every hostile input`, () => {
    for (const [inputName, value] of HOSTILE) {
      const label = `${name} <- ${inputName}`;
      let out;
      assert.doesNotThrow(() => { out = build(value); }, `${label}: threw`);

      // A draft rides in private_metadata, which caps at 3000 characters, and
      // the handlers refuse to push a screen past it. So an oversized draft is
      // not a broken view - it is a view the guard must never let be built, and
      // that is the thing worth asserting.
      if (out.view?.private_metadata && out.view.private_metadata.length > MAX_VIEW_METADATA) {
        assert.strictEqual(draftFitsInView(JSON.parse(out.view.private_metadata)), false,
          `${label}: metadata is over the cap but the guard would have allowed it`);
        continue;
      }

      if (out.view) auditView(out.view, label);
      if (out.blocks) auditBlocks(out.blocks, label);
      if (out.csv) auditCsv(out.csv, label, value);
    }
  });

  test(`${name} does not crash or mangle text on absurd input`, () => {
    // No Slack-limit promise here: input this large cannot reach a builder
    // through the app, so the only guarantees are that it survives and that
    // nothing comes back with half a character in it.
    for (const [inputName, value] of EXTREME) {
      const label = `${name} <- ${inputName}`;
      let out;
      assert.doesNotThrow(() => { out = build(value); }, `${label}: threw`);
      auditText(out.view || { blocks: out.blocks } || { csv: out.csv }, label);
    }
  });
}

// A CSV is not Block Kit, so it gets its own rules - but it is fed from the
// same corpus, which is the point.
function auditCsv(csv, label, input) {
  assert.strictEqual(typeof csv, 'string', `${label}: not a string`);
  assert.ok(!halfEmoji(csv), `${label}: CSV carries half an emoji`);

  // Every field is quoted, so parse on quote boundaries rather than commas.
  const fields = csv.match(/"(?:[^"]|"")*"/g) || [];
  for (const f of fields) {
    const body = f.slice(1, -1);
    // A single quote inside a quoted field ends it. Doubling is the escape.
    assert.doesNotMatch(body.replace(/""/g, ''), /"/,
      `${label}: a field has an unescaped quote: ${f.slice(0, 60)}`);
    // A spreadsheet treats these as the start of a formula, not text.
    assert.doesNotMatch(body, /^[=+\-@\t\r]/,
      `${label}: a field opens with a formula character: ${JSON.stringify(body.slice(0, 20))}`);
  }
  if (/^[=+\-@]/.test(input)) {
    assert.ok(csv.includes("'" + input.slice(0, 8)),
      `${label}: a formula-looking answer should be prefixed with an apostrophe`);
  }
}

// ==================== limits, walked rather than sampled ====================

test('a poll title of any length builds valid screens, at every length', () => {
  // The header trim caps at 150 and titles are allowed 200, so the interesting
  // range straddles both. Walk it: the defect this replaces fired at exactly
  // one offset, which a hand-picked case would have stepped over.
  for (let n = 0; n <= MAX_POLL_TITLE_LENGTH + 60; n++) {
    const title = 'T'.repeat(n);
    auditBlocks(V.buildPollBlocks(pollWith(title)), `title-len-${n}/message`);
    auditView(V.buildResultsModal(pollWith(title), 'U0123456789'), `title-len-${n}/results`);
    auditView(V.buildEditModal(pollWith(title)), `title-len-${n}/edit`);
    auditView(V.buildShareModal(pollWith(title)), `title-len-${n}/share`);
  }
});

test('an emoji at every offset near a trim is never cut in half', () => {
  // Slide one emoji across both trim boundaries a character at a time. Only the
  // offsets where it straddles the cut can fail, and there are two of them in
  // the whole range - which is why sampling missed this.
  for (let n = 100; n <= 220; n++) {
    const title = 'T'.repeat(n) + '🎉' + 'tail'.repeat(30);
    auditBlocks(V.buildPollBlocks(pollWith(title)), `emoji-at-${n}/message`);
    auditView(V.buildResultsModal(pollWith(title), 'U0123456789'), `emoji-at-${n}/results`);
    const summary = V.settingsSummary({ pollTitle: title, pollSettings: ['anonymous'] });
    assert.ok(!halfEmoji(summary), `emoji-at-${n}: summary cut an emoji`);
  }
});

test('a question of any length keeps every section inside Slack\'s limit', () => {
  // A section caps at 3000 characters. Question text is capped at 500 and
  // option text at 200, but ten long options plus a long question is how you
  // reach 3000 without any single field being over its own limit.
  for (let n = 0; n <= 600; n += 25) {
    const opts = Array.from({ length: MAX_OPTIONS_PER_QUESTION }, () => 'O'.repeat(Math.min(n, 200)));
    const p = pollWith('t', { questions: [q('Q'.repeat(n), opts)], votes: { 0: {} } });
    auditBlocks(V.buildPollBlocks(p), `q-len-${n}/message`);
    auditView(V.buildVoteModal(p), `q-len-${n}/vote`);
    auditView(V.buildResultsModal(p, 'U0123456789'), `q-len-${n}/results`);
  }
});

test('every option count from none to the maximum builds a votable screen', () => {
  for (let n = 0; n <= MAX_OPTIONS_PER_QUESTION; n++) {
    const opts = Array.from({ length: n }, (_, i) => `Option ${i + 1}`);
    const p = pollWith('t', { questions: [q('Pick one', opts)], votes: { 0: {} } });
    auditView(V.buildVoteModal(p), `opts-${n}/vote`);
    auditBlocks(V.buildPollBlocks(p), `opts-${n}/message`);
  }
});

test('every question count builds a valid screen, or is refused before it is built', () => {
  // The draft rides in private_metadata, which caps at 3000 characters. The
  // contract is that draftFitsInView agrees exactly with that cap, and that any
  // draft it accepts builds a screen Slack will take. Walking every count is
  // what proves the guard is not merely approximately right.
  let acceptedUpTo = 0;
  for (let n = 1; n <= MAX_QUESTIONS_PER_POLL; n++) {
    const meta = {
      channelId: 'C0123456789', userId: 'U0123456789',
      savedQuestions: Array.from({ length: n }, (_, i) => q(`Question number ${i + 1}?`))
    };
    const fits = draftFitsInView(meta);
    assert.strictEqual(fits, JSON.stringify(meta).length <= MAX_VIEW_METADATA,
      `questions-${n}: the guard disagrees with the actual metadata size`);
    if (!fits) continue;
    acceptedUpTo = n;
    auditView(V.buildComposeModal(meta), `questions-${n}/compose`);
    auditView(V.buildPreviewModal(meta), `questions-${n}/preview`);
  }
  // If this ever reads 0 the walk above stopped testing anything.
  assert.ok(acceptedUpTo >= 5, `the guard should accept an ordinary poll, accepted only ${acceptedUpTo}`);
});

test('a poll list of any length stays inside the block limit', () => {
  for (let n = 0; n <= 40; n++) {
    const polls = Array.from({ length: n }, () => pollWith('Team lunch vote'));
    auditBlocks(V.pollListBlocks(polls), `list-${n}`);
  }
});

test('every vote count renders a bar, including none and all', () => {
  // A progress bar divides by a total, which is zero before anyone votes.
  for (let voters = 0; voters <= 12; voters++) {
    const votes = { 0: { 0: Array.from({ length: voters }, (_, i) => `U${i}`) } };
    const p = pollWith('t', { questions: [q('Pick one')], votes });
    auditBlocks(V.buildPollBlocks(p), `voters-${voters}/message`);
    auditView(V.buildResultsModal(p, 'U0123456789'), `voters-${voters}/results`);
    auditText({ csv: V.buildPollCsv(p) }, `voters-${voters}/csv`);
  }
});

// ==================== the shapes stored data can actually be ====================

test('a poll missing anything optional still builds every screen', () => {
  // Rows written before a field existed are the real hostile input: they are
  // already in the database and no validator will ever see them again. This is
  // the class the legacy messageRefs defect belonged to.
  const shapes = [
    ['no description',   { description: undefined }],
    ['no votes',         { votes: undefined }],
    ['no voteTimestamps', { voteTimestamps: undefined }],
    ['no messageRefs',   { messageRefs: undefined, channelId: 'C1', messageTs: '1' }],
    ['no refs at all',   { messageRefs: undefined }],
    ['no settings',      { showResults: undefined, anonymous: undefined, allowRevote: undefined }],
    ['no title',         { title: undefined }],
    ['no questions',     { questions: [] }],
    ['anonymous',        { anonymous: true }],
    ['closed',           { status: 'closed' }],
    ['question with no options', { questions: [q('Say anything', [])] }],
    ['question with no text',    { questions: [q(undefined)] }]
  ];
  for (const [name, over] of shapes) {
    const p = pollWith('Team lunch', over);
    assert.doesNotThrow(() => {
      auditBlocks(V.buildPollBlocks(p), `${name}/message`);
      auditView(V.buildResultsModal(p, 'U0123456789'), `${name}/results`);
      auditView(V.buildShareModal(p), `${name}/share`);
      auditBlocks(V.pollListBlocks([p]), `${name}/list`);
      V.buildPollCsv(p);
    }, `${name}: a stored poll of this shape should still render`);
  }
});
