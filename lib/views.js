// The view layer: everything that turns a poll - or a poll being written - into
// Block Kit JSON, plus the readers that parse a submitted view back out again.
//
// Nothing in here touches Slack or the database. Every function is data in,
// blocks out, and that is what makes the screens testable at all: requiring the
// bot module starts a web server and connects to Postgres, so for as long as
// the builders lived in there they could only be checked by hand. They are
// exercised by test-views.js against Slack's documented view limits.
//
// Required by slack-poll-bot.js - keep it the single source of truth for what
// the app looks like, so the tests cannot drift from what people actually see.

const { MAX_DESTINATIONS, describeFailures } = require('./destinations');
const { canViewResults, resultsHiddenReason } = require('./policy');
const { getAllVoters, pollVotes, pollDisplayTitle } = require('./poll');
const {
  AUTO_OPTION_TYPES, MULTI_SELECT_FORM_TYPE, parseOptions,
  resolveQuestionType, formTypeFor
} = require('./compose');

// The two pickers, shared by the last step of poll creation and the Share modal.
// Kept together because the pair only makes sense as a pair: an app cannot post
// into a DM between two people, so a person is not a conversation to choose -
// they are a user id to open a DM with.
//
// That is also why the second label says who does the sending. Labelled
// "People" it read as "send this to Kwame", which is a thing Slack has no verb
// for: what actually happens is that this app knocks on his door, in its own DM
// with him, carrying a poll he did not ask for. Saying so in the label sets the
// expectation before the pick instead of apologising for it afterwards - and it
// frees both hints to spend their line on the part that is genuinely
// surprising, which is who ends up with a ballot.
//
// The wording has to be a promise - "I'll DM" - rather than a description
// like "DM from me". In a form, "me" is the person filling the form in: Email a
// copy to me, Remind me, Notify me. A label reading "DM from me" therefore says
// the opposite of the truth to the one reader who matters, and says it with
// more confidence than the vague label it replaced. Only a first-person verb
// pins the sender down, because the form-filler is not the one making promises.
//
// It is a noun with a parenthetical rather than a question, so it does not sit
// parallel with "Where to post" on the compose screen. That framing earns its
// keep - it is the only cue that the section is about destinations at all - and
// a promise cannot be phrased as a question, so the mismatch is the price.
const PEOPLE_LABEL = "People (I'll DM)";

function destinationBlocks({ channels = [], users = [], channelsLabel = 'Channels', peopleHint } = {}) {
  return [
    {
      type: 'input', block_id: 'poll_dest_channels',
      label: { type: 'plain_text', text: channelsLabel },
      optional: true,
      element: {
        type: 'multi_conversations_select', action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Pick channels...' },
        max_selected_items: MAX_DESTINATIONS,
        filter: { include: ['public', 'private'] },
        ...(channels.length ? { initial_conversations: channels } : {})
      }
    },
    {
      type: 'input', block_id: 'poll_dest_users',
      label: { type: 'plain_text', text: PEOPLE_LABEL },
      optional: true,
      hint: { type: 'plain_text', text: peopleHint || 'Pick yourself to get a copy you can vote in' },
      element: {
        type: 'multi_users_select', action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Pick people...' },
        max_selected_items: MAX_DESTINATIONS,
        ...(users.length ? { initial_users: users } : {})
      }
    }
  ];
}

// Shown after a poll runs in a DM between two people and has to land in the
// creator's own DM instead. It lives here, with the picker it names, for two
// reasons: it is copy, and copy in the bot module cannot be tested at all -
// requiring that file starts a web server and connects to Postgres, so this
// sentence went out unread by anything. It used to point at "Where to post",
// the channel picker, while telling the reader to pick a person.
function dmRedirectNotice() {
  return 'Slack does not let an app post into a DM between two people, so it could not go into the conversation you ran the command from. '
    // Ends on the label rather than reading through it: the name carries a
    // parenthetical, and a sentence that has to resume afterwards stumbles.
    + `Send it on with the button below, or next time pick them under *${PEOPLE_LABEL}*.`;
}

// ==================== what the creator is told afterwards ====================
//
// Three channels carry this, and they fail in different ways, which is why the
// reason appears in more than one of them on purpose:
//
//   the confirmation  always deliverable, gone on the next reload
//   the DM record     durable, and undeliverable when DMs are what is broken
//   the log           durable, and invisible to the reader
//
// The confirmation therefore carries the whole reason rather than pointing at
// the DM: the case this exists to diagnose is a DM that will not send, and a
// note saying "details are in your DM" would be a promise broken by the very
// fault it is reporting. The DM repeats it to survive a reload, framed as the
// copy it is. The log catches the case where neither was read.
//
// Both live here rather than in slack-poll-bot.js because that file cannot be
// required without opening a Postgres pool and binding a port - so copy kept
// there ships unread by any test, which is how a sentence pointing at the wrong
// picker, and a confirmation that announced a private failure to a whole
// channel, both got out.

function buildPostConfirmation({ poll, posted = [], failures = [], explainRedirect = false }) {
  const lines = [`✅ *${pollDisplayTitle(poll)}* was posted to ${posted.map(p => p.label).join(', ')}.`];
  if (explainRedirect) lines.push(dmRedirectNotice());
  if (failures.length) lines.push(`⚠️ ${describeFailures(failures)}`);
  if (posted.length > 1) lines.push('Votes cast in any of them count toward this one poll.');

  return {
    text: `✅ ${pollDisplayTitle(poll)} has been posted!`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
      ...(explainRedirect ? [{
        type: 'actions',
        elements: [{
          type: 'button', text: { type: 'plain_text', text: '📤  Send it on', emoji: true },
          style: 'primary', action_id: 'share_poll', value: poll.id
        }]
      }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: pollAdminHint(poll) }] }
    ]
  };
}

// The durable copy of a partial failure. Says it is a copy, so reading the same
// reason twice reads as a record rather than a stutter.
function failureRecord(poll, failures) {
  return [
    `⚠️ *${pollDisplayTitle(poll)}* posted, but not everywhere. Keeping this where you can find it:`,
    describeFailures(failures),
    `Everything that did post is live, and votes cast anywhere count toward the same poll.`
  ].join('\n\n');
}

// Nothing landed anywhere. The poll is kept, so this says how to send it once
// the reason is fixed.
function nowhereRecord(poll, failures) {
  return [
    `❌ *${pollDisplayTitle(poll)}* could not be posted anywhere.`,
    `⚠️ ${describeFailures(failures)}`,
    'Nothing you typed is lost - the poll is saved. Fix the reason above, then run `/polls-list` and press *📤 Send*.'
  ].join('\n\n');
}

// What the pickers came back with.
//
// A picker left alone still comes back, as an empty selection, and that means
// cleared - so an empty array is an answer and has to be kept. A picker that is
// not on the screen at all is a different thing entirely, and its key is left
// out rather than returned empty: readComposeState spreads this over the
// metadata, so a blank would overwrite picks the reader made on a screen that
// is no longer in front of them. No handler does that today - the screens
// without these blocks all read the metadata directly - but the failure mode is
// the reported one, a poll that quietly goes nowhere near the people picked for
// it, and it is one careless caller away.
function readDestinations(values) {
  const picked = {};
  const channels = values?.poll_dest_channels?.value?.selected_conversations;
  const users    = values?.poll_dest_users?.value?.selected_users;
  if (channels) picked.destChannels = channels;
  if (users)    picked.destUsers    = users;
  return picked;
}

// The conversation a command was run in, if it is one the app could post a poll
// into. A DM is not: the picker cannot offer it and the app cannot post there,
// so it is left unset and the fallback in resolveDestinations handles it.
function prefillableChannel(channelId) {
  return /^[CG]/.test(channelId || '') ? [channelId] : [];
}

function buildNoticeModal(title, text) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }]
  };
}

// Slack rejects oversized messages, so long lists are capped and say so.
const POLL_LIST_PAGE_SIZE = 20;

function truncationNote(total, shownCount) {
  if (total <= shownCount) return [];
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Showing ${shownCount} of ${total} - close old polls to shorten this list.` }]
  }];
}

const OPTION_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'Multiple choice' },
  { value: 'yes_no',          label: 'Yes / No' },
  { value: 'agree_disagree',  label: 'Agree / Disagree' },
  { value: 'scale_5',         label: '1-to-5 scale' },
  { value: 'scale_10',        label: '1-to-10 scale' },
  { value: 'nps',             label: 'NPS (0–10)' },
  { value: 'likert',          label: 'Likert matrix' },
  { value: 'ranking',         label: 'Ranking' },
  { value: 'open_ended',      label: 'Open ended' }
];

const QUESTION_TYPE_ICONS = {
  multiple_choice: '📋', yes_no: '✅', agree_disagree: '⚖️',
  scale_5: '⭐', scale_10: '🔢', nps: '📈',
  likert: '📊', ranking: '🏅', open_ended: '💬'
};

const LIKERT_SCALE = [
  { label: '1 — Strongly Disagree', value: '0' },
  { label: '2 — Disagree',          value: '1' },
  { label: '3 — Neutral',           value: '2' },
  { label: '4 — Agree',             value: '3' },
  { label: '5 — Strongly Agree',    value: '4' }
];

function getAutoOptions(type) {
  switch (type) {
    case 'yes_no':         return ['Yes', 'No'];
    case 'agree_disagree': return ['Strongly Agree', 'Agree', 'Neutral', 'Disagree', 'Strongly Disagree'];
    case 'scale_5':        return ['1', '2', '3', '4', '5'];
    case 'scale_10':       return ['1','2','3','4','5','6','7','8','9','10'];
    case 'nps':            return ['0','1','2','3','4','5','6','7','8','9','10'];
    case 'open_ended':     return [];
    default:               return [];
  }
}

function getTypeLabel(type) {
  return QUESTION_TYPES.find(t => t.value === type)?.label || type;
}

function getTypeIcon(type) {
  return QUESTION_TYPE_ICONS[type] || '❓';
}

// How a question describes itself. The type picker offers Multi-select as its
// own entry, so a question that takes several answers has to read that way
// wherever it is shown - otherwise the creator picks "☑️ Multi-select" and gets
// back "📋 Multiple choice · multi-select", which is the same fact told in a
// different vocabulary with a different icon. formTypeFor is the predicate so
// there is only one definition of what a multi-select question is.
function questionTypeIcon(q) {
  return formTypeFor(q) === MULTI_SELECT_FORM_TYPE ? '☑️' : getTypeIcon(q.type);
}

function questionTypeLabel(q) {
  return formTypeFor(q) === MULTI_SELECT_FORM_TYPE ? 'Multi-select' : getTypeLabel(q.type);
}

// What to call a question on screen. The validator requires text, so in normal
// running this always has some - but a builder is also fed stored rows, and one
// with an empty question posted "*1. undefined*" into a channel. A heading is
// exactly where a missing value is least visible while being written and most
// visible once shipped.
function questionText(q) {
  return q?.text || 'Untitled question';
}

// Grouped options for question type picker (Hick's Law — scannable categories)
const QUESTION_TYPE_GROUPS = [
  {
    label: { type: 'plain_text', text: 'Basic' },
    options: [
      // Two short, distinct words rather than one long phrase with the
      // difference tacked on the end: on a narrow phone the end is what gets
      // cut, and "Multiple choice — pick…" twice tells nobody anything. What it
      // means for voters is spelled out on the choices field below instead.
      { text: { type: 'plain_text', text: '📋 Multiple choice' }, value: 'multiple_choice' },
      { text: { type: 'plain_text', text: '☑️ Multi-select' },    value: 'multiple_select' },
      { text: { type: 'plain_text', text: '✅ Yes / No' },        value: 'yes_no' },
      { text: { type: 'plain_text', text: '⚖️ Agree / Disagree' }, value: 'agree_disagree' }
    ]
  },
  {
    label: { type: 'plain_text', text: 'Scales' },
    options: [
      { text: { type: 'plain_text', text: '⭐ 1-to-5 scale' },  value: 'scale_5' },
      { text: { type: 'plain_text', text: '🔢 1-to-10 scale' }, value: 'scale_10' },
      { text: { type: 'plain_text', text: '📈 NPS (0–10)' },    value: 'nps' }
    ]
  },
  {
    label: { type: 'plain_text', text: 'Advanced' },
    options: [
      { text: { type: 'plain_text', text: '📊 Likert matrix' }, value: 'likert' },
      { text: { type: 'plain_text', text: '🏅 Ranking' },       value: 'ranking' },
      { text: { type: 'plain_text', text: '💬 Open ended' },    value: 'open_ended' }
    ]
  }
];

function findTypeOption(type) {
  for (const group of QUESTION_TYPE_GROUPS) {
    const opt = group.options.find(o => o.value === type);
    if (opt) return opt;
  }
  return QUESTION_TYPE_GROUPS[0].options[0];
}

// The question form. `optional` makes the text and choices optional at the
// Slack level, which is what lets the compose screen be submitted once at least
// one question is already saved - the form there is for the *next* question, so
// leaving it blank has to mean "no more", not "you forgot something". With
// nothing saved yet the fields stay required, so Slack raises that inline
// without a round trip.
function questionFormBlocks(qNum, questionType = 'multiple_choice', restore = {}, { optional = false } = {}) {
  const needsOptions = !AUTO_OPTION_TYPES.includes(questionType);

  const blocks = [
    {
      type: 'input',
      block_id: `q_text_${qNum}`,
      label: { type: 'plain_text', text: 'Question' },
      optional,
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Write your question...' },
        ...(restore.text ? { initial_value: restore.text } : {})
      }
    },
    {
      type: 'input',
      block_id: `q_type_${qNum}`,
      label: { type: 'plain_text', text: 'Question type' },
      dispatch_action: true,
      element: {
        type: 'static_select',
        action_id: 'question_type_changed',
        option_groups: QUESTION_TYPE_GROUPS,
        initial_option: findTypeOption(questionType)
      }
    }
  ];

  if (needsOptions) {
    const isMulti   = questionType === MULTI_SELECT_FORM_TYPE;
    const isLikert  = questionType === 'likert';
    const isRanking = questionType === 'ranking';
    const optLabel  = isLikert  ? 'Statements to rate (one per line)'
                    : isRanking ? 'Items to rank (one per line)'
                    : isMulti   ? 'Answer choices — voters may pick several'
                    : 'Answer choices';
    const optHint   = isLikert  ? 'Each statement will be rated on a 1–5 Strongly Disagree → Strongly Agree scale'
                    : isRanking ? 'Voters will assign a rank to each item (1 = top choice)'
                    : 'One option per line, or separate with commas';
    const optPlaceholder = isLikert  ? 'The onboarding process is clear\nI feel supported by my team'
                         : isRanking ? 'Feature A\nFeature B\nFeature C'
                         : 'Option 1\nOption 2\nOption 3';
    blocks.push({
      type: 'input',
      block_id: `q_options_${qNum}`,
      label: { type: 'plain_text', text: optLabel },
      hint: { type: 'plain_text', text: optHint },
      optional,
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        multiline: true,
        placeholder: { type: 'plain_text', text: optPlaceholder },
        ...(restore.options ? { initial_value: restore.options } : {})
      }
    });
  } else if (questionType === 'open_ended') {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_💬 Open ended — voters will type a free-text response_' }]
    });
  } else {
    const preview = getAutoOptions(questionType).join(' · ');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Auto-generated options: ${preview}_` }]
    });
  }

  // No "allow multiple selections" checkbox: picking several is an entry in the
  // type picker above, which is one block fewer and puts the decision where the
  // kind of question is already being chosen.
  return blocks;
}

// The edit screen for a question that has already been added, pushed on top of
// the compose screen. Adding a question now happens on the compose screen
// itself, so this only ever edits one.
function buildQuestionModal(meta, currentType = 'multiple_choice', restore = {}, errorMsg = null) {
  const qNum = (meta.savedQuestions || []).length + 1;

  return {
    type: 'modal',
    callback_id: 'question_submit',
    title: { type: 'plain_text', text: 'Edit Question' },
    submit: { type: 'plain_text', text: 'Save Changes' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      ...questionFormBlocks(qNum, currentType, restore)
    ]
  };
}

const SHOW_RESULTS_OPTIONS = [
  { text: { type: 'plain_text', text: 'In real-time' },       value: 'realtime' },
  { text: { type: 'plain_text', text: 'After poll closes' },  value: 'on_close' },
  { text: { type: 'plain_text', text: 'Only to creator' },    value: 'creator_only' }
];

// A poll whose point is a visible tally should show one. Defaulting to the most
// restrictive setting meant the common intent cost two clicks in a dropdown, and
// left a question in the channel whose answers nobody could see.
const DEFAULT_SHOW_RESULTS = 'realtime';

const VOTING_SETTINGS_OPTIONS = [
  { text: { type: 'mrkdwn', text: '*Anonymous* — hide who voted for what' }, value: 'anonymous' },
  { text: { type: 'mrkdwn', text: '*Allow vote changes* — voters can update their choice' }, value: 'allow_revote' }
];

const ORDER_BY_VOTES_OPTIONS = [
  { text: { type: 'mrkdwn', text: '*Sort by vote count* — most-voted option first' }, value: 'yes' }
];

// What the poll will do, on one line, so the creator never has to open the
// options screen to find out what the defaults were - and, now that the title
// lives in there too, never has to open it to see what the poll is called. This
// line is what keeps moving things out of the way from turning into hiding them.
// One line reporting only what the creator has actually changed - and nothing
// at all when they have changed nothing, which is the common case.
//
// This used to list every setting including the defaults, ending with "edit
// under More options" while sitting directly beneath the More options button.
// That is a line of text explaining the button above it, and four values nobody
// chose. A summary earns its place by reporting a departure from the default:
// it is how you see that a trip to More options took effect, and it is silent
// when there is nothing to report. No emoji, because view text is a narrow
// column and these were decoration rather than meaning.
function settingsSummary(meta) {
  const { pollTitle = '', pollSettings = [], showResults = DEFAULT_SHOW_RESULTS, closeAt, orderByVotes = false } = meta;
  const parts = [
    ...(pollTitle ? [`Called “${pollTitle}”`] : []),
    ...(showResults === 'on_close' ? ['Results after close'] : []),
    ...(showResults === 'creator_only' ? ['Results for creator only'] : []),
    ...(pollSettings.includes('anonymous') ? ['Anonymous'] : []),
    ...(pollSettings.includes('allow_revote') ? ['Vote changes allowed'] : []),
    ...(orderByVotes ? ['Sorted by votes'] : []),
    ...(closeAt ? [`Closes ${new Date(closeAt).toLocaleString()}`] : [])
  ];
  // Two mobile lines is the whole budget: past that it stops being a glance.
  return parts.length ? clampText(parts.join('  ·  '), 80) : null;
}

// The whole poll on one screen, in the order it is thought of: the question
// first, then what it is called, then where it goes. Everything else has a
// working default and lives behind *More options*, so the ordinary poll - one
// question, a few choices, posted here - is a single submit.
//
// The three buttons are what keep it to one screen. Each is a block action, so
// each arrives with this view's full state: whatever has been typed, including
// the destination picks, is captured into private_metadata before another screen
// is pushed. That is why going back no longer resets the pickers.
function buildComposeModal(meta, currentType = 'multiple_choice', restore = {}, errorMsg = null) {
  const { savedQuestions = [], channelId } = meta;
  const qNum = savedQuestions.length + 1;
  const hasSaved = savedQuestions.length > 0;
  // ?? not ||, so a creator who clears the channel picker stays cleared.
  const destChannels = meta.destChannels ?? prefillableChannel(channelId);
  const destUsers    = meta.destUsers ?? [];
  const summary = settingsSummary(meta);

  return {
    type: 'modal',
    callback_id: 'poll_compose_submit',
    title: { type: 'plain_text', text: hasSaved ? `New Poll  (${savedQuestions.length})` : 'New Poll' },
    submit: { type: 'plain_text', text: 'Post Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      // ── Questions already added ──────────────────────
      ...(hasSaved ? [
        ...savedQuestionsBlocks(savedQuestions),
        { type: 'section', text: { type: 'mrkdwn', text: '*Add another question* — or leave this blank and post what you have.' } }
      ] : []),
      // ── The question ─────────────────────────────────
      ...questionFormBlocks(qNum, currentType, restore, { optional: hasSaved }),
      { type: 'divider' },
      // ── Where it goes ────────────────────────────────
      // No heading above these: two labelled pickers do not need a label of
      // their own, so the first one carries the framing instead.
      ...destinationBlocks({
        channels: destChannels,
        users: destUsers,
        channelsLabel: 'Where to post',
        peopleHint: 'Pick only people and you get a copy too, so you can vote.'
      }),
      {
        type: 'actions', block_id: 'compose_actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '＋  Add question' }, action_id: 'add_another_question' },
          { type: 'button', text: { type: 'plain_text', text: '⚙️  More options', emoji: true }, action_id: 'compose_options' },
          { type: 'button', text: { type: 'plain_text', text: '👁  Preview', emoji: true }, action_id: 'compose_preview' }
        ]
      },
      // Present only when there is something to report - see settingsSummary.
      ...(summary ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: summary }] }] : [])
    ]
  };
}

// Everything that has a sensible default, kept off the compose screen so it
// cannot make writing a question feel like filling in a form. Reached by a
// button, saved back into private_metadata, and summarised in one line on the
// screen it came from - so nothing here is hidden, only out of the way.
function buildOptionsModal(meta, draftDropped = false) {
  const {
    pollTitle = '', pollDescription = '',
    pollSettings = [], closeAt, showResults = DEFAULT_SHOW_RESULTS, orderByVotes = false
  } = meta;
  const activeSettings = pollSettings.filter(v => VOTING_SETTINGS_OPTIONS.some(o => o.value === v));

  return {
    type: 'modal',
    callback_id: 'poll_options_submit',
    title: { type: 'plain_text', text: 'Poll Options' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(draftDropped ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: '⚠️ *The question you were part-way through typing will not be here when you go back* — this poll is long enough that the draft no longer fits. Cancel, add that question first, then come back.' }
      }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'All of these have a working default — change only what you need.' }] },
      // The title is an override rather than an input: a poll with none is named
      // after its first question, so asking for it on the way in was asking
      // people to write the same sentence twice. It lives here with the other
      // things that have an answer already.
      {
        type: 'input', block_id: 'poll_title',
        label: { type: 'plain_text', text: 'Poll title' },
        optional: true,
        hint: { type: 'plain_text', text: 'Leave blank and the poll is named after its first question' },
        element: {
          type: 'plain_text_input', action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Only needed if it should differ from the question...' },
          ...(pollTitle ? { initial_value: pollTitle } : {})
        }
      },
      {
        type: 'input', block_id: 'poll_description',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
        hint: { type: 'plain_text', text: 'Markup stays literal here: *bold*, _italic_ and `code` render once the poll is posted' },
        element: {
          type: 'plain_text_input', action_id: 'value', multiline: true,
          placeholder: { type: 'plain_text', text: 'Add context or instructions (optional)...' },
          ...(pollDescription ? { initial_value: pollDescription } : {})
        }
      },
      { type: 'divider' },
      {
        type: 'input', block_id: 'poll_settings',
        label: { type: 'plain_text', text: 'Voting' },
        optional: true,
        element: {
          type: 'checkboxes', action_id: 'value',
          options: VOTING_SETTINGS_OPTIONS,
          ...(activeSettings.length ? { initial_options: activeSettings.map(v => VOTING_SETTINGS_OPTIONS.find(o => o.value === v)) } : {})
        }
      },
      {
        type: 'input', block_id: 'poll_show_results',
        label: { type: 'plain_text', text: 'Show results' },
        element: {
          type: 'static_select', action_id: 'value',
          options: SHOW_RESULTS_OPTIONS,
          initial_option: SHOW_RESULTS_OPTIONS.find(o => o.value === showResults) || SHOW_RESULTS_OPTIONS[0]
        }
      },
      {
        type: 'input', block_id: 'poll_order_by_votes',
        label: { type: 'plain_text', text: 'Result order' },
        optional: true,
        element: {
          type: 'checkboxes', action_id: 'value',
          options: ORDER_BY_VOTES_OPTIONS,
          ...(orderByVotes ? { initial_options: ORDER_BY_VOTES_OPTIONS } : {})
        }
      },
      {
        type: 'input', block_id: 'poll_close_at',
        label: { type: 'plain_text', text: 'Auto-close date & time' },
        optional: true,
        hint: { type: 'plain_text', text: 'Poll will stop accepting votes at this time' },
        element: {
          type: 'datetimepicker', action_id: 'value',
          ...(closeAt ? { initial_date_time: Math.floor(new Date(closeAt).getTime() / 1000) } : {})
        }
      }
    ]
  };
}

function buildEditModal(poll, errorMsg = null) {
  return {
    type: 'modal',
    callback_id: 'poll_edit_submit',
    title: { type: 'plain_text', text: 'Edit Poll' },
    submit: { type: 'plain_text', text: 'Save Changes' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      {
        type: 'input', block_id: 'edit_title',
        label: { type: 'plain_text', text: 'Poll title' },
        element: {
          type: 'plain_text_input', action_id: 'value',
          initial_value: pollDisplayTitle(poll)
        }
      },
      {
        type: 'input', block_id: 'edit_description',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
        hint: { type: 'plain_text', text: 'Markup stays literal here: *bold*, _italic_ and `code` render once the poll is posted' },
        element: {
          type: 'plain_text_input', action_id: 'value', multiline: true,
          placeholder: { type: 'plain_text', text: 'Add context or instructions (optional)...' },
          ...(poll.description ? { initial_value: poll.description } : {})
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Questions cannot be edited after votes have been cast._' }]
      }
    ]
  };
}

function savedQuestionsBlocks(savedQuestions) {
  if (!savedQuestions.length) return [];
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Questions added:*' } },
    ...savedQuestions.map((q, i) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}.* ${questionText(q)}\n_${questionTypeIcon(q)} ${questionTypeLabel(q)}${q.type !== 'open_ended' && q.options.length ? '  —  ' + q.options.slice(0, 4).join(', ') + (q.options.length > 4 ? '…' : '') : ''}_`
      },
      accessory: {
        type: 'overflow',
        action_id: 'question_action',
        options: [
          { text: { type: 'plain_text', text: '✏️  Edit' },     value: `edit:${i}` },
          { text: { type: 'plain_text', text: '⧉  Duplicate' }, value: `duplicate:${i}` },
          { text: { type: 'plain_text', text: '↑  Move Up' },   value: `move_up:${i}` },
          { text: { type: 'plain_text', text: '↓  Move Down' }, value: `move_down:${i}` },
          { text: { type: 'plain_text', text: '🗑️  Delete' },  value: `delete:${i}` }
        ]
      }
    })),
    { type: 'divider' }
  ];
}

// Where the poll is about to go, in words, for a screen that no longer carries
// the pickers themselves.
function describeDestinations(meta) {
  const channels = meta.destChannels ?? prefillableChannel(meta.channelId);
  const users    = meta.destUsers ?? [];
  const parts = [
    ...channels.map(c => `<#${c}>`),
    ...users.map(u => `<@${u}>`)
  ];
  return parts.length
    ? `*Posting to:* ${parts.join(', ')}`
    : '*Posting to:* the conversation you started from';
}

// Opt-in, not a toll booth. The pickers live on the compose screen now, so this
// screen only shows - which is all a preview was ever for, and means ← Back
// returns to a compose screen that still has everything on it.
function buildPreviewModal(meta) {
  const { savedQuestions = [], pollTitle, pollDescription, pollSettings = [], showResults, closeAt } = meta;
  const tags = [];
  if (pollSettings.includes('anonymous'))    tags.push('🔒 Anonymous');
  if (pollSettings.includes('allow_revote')) tags.push('🔄 Vote changes allowed');
  if (showResults === 'on_close')            tags.push('👁 Results after close');
  if (showResults === 'creator_only')        tags.push('👁 Results for creator only');
  if (closeAt)                               tags.push(`⏰ Closes ${new Date(closeAt).toLocaleString()}`);

  const questionBlocks = savedQuestions.flatMap((q, i) => [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}. ${questionText(q)}*\n_${questionTypeIcon(q)} ${questionTypeLabel(q)}_`
      }
    },
    ...(q.type === 'open_ended'
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: '_Voters will type a free-text response_' }] }]
      : q.options.map((opt, oi) => ({
          type: 'section',
          text: { type: 'mrkdwn', text: `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${opt}` }
        }))
    ),
    { type: 'divider' }
  ]);

  return {
    type: 'modal',
    callback_id: 'poll_preview_submit',
    title: { type: 'plain_text', text: 'Preview & Confirm' },
    submit: { type: 'plain_text', text: 'Post Poll' },
    close: { type: 'plain_text', text: 'Back' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText(pollTitle || 'Untitled Poll') } },
      ...(pollDescription ? [{ type: 'section', text: { type: 'mrkdwn', text: pollDescription } }] : []),
      ...(tags.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: tags.join('  ·  ') }] }] : []),
      { type: 'divider' },
      // A long poll can run past Slack's limit of 100 blocks in a view, so the
      // preview is what gives way - the destination line below it is the part
      // that has to survive.
      ...capBlocks(questionBlocks, 100 - FIXED_PREVIEW_BLOCKS),
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: describeDestinations(meta) } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${savedQuestions.length} question${savedQuestions.length === 1 ? '' : 's'} · ← Back to change anything`
        }]
      }
    ]
  };
}

// Header, description, tags, two dividers, the destination line and the footer -
// what the preview modal spends before any question.
const FIXED_PREVIEW_BLOCKS = 8;

// Slack rejects a message over 100 blocks outright. A long poll therefore has
// to be summarised rather than trimmed: cutting the tail off a ballot would
// silently drop questions people could otherwise answer, and they'd have no
// way to tell. So past the limit the whole question list collapses to one
// listing and everyone uses the modal, which is a view and gets its own 100.
const MAX_MESSAGE_BLOCKS = 100;

// A section caps at 3000 characters, which a listing of enough long questions
// will reach on its own.
// A Slack header caps at 150 characters, where MAX_POLL_TITLE_LENGTH allows a
// title of 200 - and Slack rejects the whole view or message rather than
// trimming it for you, silently, with nothing shown to the user. So every
// heading built from something a person typed goes through here.
const SLACK_HEADER_LIMIT = 150;

function headerText(text) {
  return clampText(String(text ?? ''), SLACK_HEADER_LIMIT);
}

// The same trap as the header, one screen further in. A select or checkbox
// option label caps at 75 characters where MAX_OPTION_TEXT_LENGTH allows 200,
// so an answer choice a creator was allowed to type built a vote modal Slack
// rejects whole - a poll that posts correctly and then cannot be voted on, with
// nothing shown to the voter to say why.
//
// initial_option has to match its entry in options exactly or Slack rejects the
// view for that instead, which is why every option label goes through one
// function rather than being trimmed at each site.
const SLACK_OPTION_LIMIT = 75;

function optionText(text) {
  return clampText(String(text ?? ''), SLACK_OPTION_LIMIT);
}

// Slack counts characters as UTF-16 code units, and an emoji is two of them.
// Cutting between the two halves leaves a lone surrogate, which reaches the
// reader as a broken glyph - and every string clamped here is something a
// person typed, so an emoji can sit exactly on the boundary. Step back one
// unit when it does.
//
// Grapheme clusters are a step further than this goes: cutting a skin tone or
// a ZWJ sequence still yields a valid character, just a plainer one, and
// clustering properly is not worth the dependency.
function clampText(text, limit = 2900) {
  if (text.length <= limit) return text;
  let cut = limit - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut--;
  return text.slice(0, cut) + '…';
}

function compactQuestionBlocks(poll) {
  const listing = (poll.questions || []).map((q, i) =>
    `${questionTypeIcon(q)}  *${i + 1}. ${questionText(q)}*${(q.options || []).length ? `  _${q.options.length} options_` : ''}`
  ).join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: clampText(listing) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_Too long to lay out in a message - use the button below to answer it._' }] },
    { type: 'divider' }
  ];
}

// Slack rejects a whole view over the block limit, so an over-long preview is
// trimmed with a line saying so rather than failing to open at all.
function capBlocks(blocks, limit) {
  if (blocks.length <= limit) return blocks;
  return [
    ...blocks.slice(0, limit - 1),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_…preview trimmed. All ${blocks.length} blocks of this poll will be posted._` }] }
  ];
}

function buildVoteModal(poll, previousVotes = {}) {
  const hasVoted = Object.keys(previousVotes).length > 0;
  const questionBlocks = poll.questions.flatMap((q, qi) => {
    const prev = previousVotes[qi] || [];
    const label = `${questionTypeIcon(q)}  ${qi + 1}. ${questionText(q)}`;

    if (q.type === 'open_ended') {
      return [{
        type: 'input',
        block_id: `vote_q${qi}`,
        label: { type: 'plain_text', text: label },
        element: {
          type: 'plain_text_input',
          action_id: 'response',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Type your response...' },
          ...(prev[0] ? { initial_value: prev[0] } : {})
        }
      }];
    }

    if (q.type === 'likert') {
      const likertOpts = LIKERT_SCALE.map(s => ({ text: { type: 'plain_text', text: s.label }, value: s.value }));
      return [
        { type: 'section', text: { type: 'mrkdwn', text: `*${label}*\n_Rate each statement on a 1–5 scale_` } },
        ...q.options.map((stmt, si) => ({
          type: 'input',
          block_id: `vote_q${qi}_s${si}`,
          label: { type: 'plain_text', text: stmt },
          element: {
            type: 'static_select',
            action_id: 'rating',
            placeholder: { type: 'plain_text', text: 'Choose a rating...' },
            options: likertOpts
          }
        }))
      ];
    }

    if (q.type === 'ranking') {
      const rankOpts = q.options.map((_, i) => ({
        text: { type: 'plain_text', text: `#${i + 1}` },
        value: String(i + 1)
      }));
      return [
        { type: 'section', text: { type: 'mrkdwn', text: `*${label}*\n_Assign a rank to each item — 1 = top choice_` } },
        ...q.options.map((opt, oi) => ({
          type: 'input',
          block_id: `vote_q${qi}_r${oi}`,
          label: { type: 'plain_text', text: opt },
          element: {
            type: 'static_select',
            action_id: 'rank',
            placeholder: { type: 'plain_text', text: 'Rank...' },
            options: rankOpts
          }
        }))
      ];
    }

    if (q.allowMultiple) {
      // Some Slack clients draw checkboxes as circles, which reads as a radio
      // group, so the label carries the affordance too - it is bold and above
      // the options, where the hint is grey and below them.
      return [{
        type: 'input',
        block_id: `vote_q${qi}`,
        label: { type: 'plain_text', text: `${label}  (choose one or more)` },
        hint: { type: 'plain_text', text: 'Select all that apply - more than one answer is allowed' },
        element: {
          type: 'checkboxes',
          action_id: 'selected',
          options: q.options.map((opt, oi) => ({ text: { type: 'mrkdwn', text: optionText(opt) }, value: String(oi) })),
          ...(prev.length ? { initial_options: prev.map(oi => ({ text: { type: 'mrkdwn', text: optionText(q.options[oi]) }, value: String(oi) })) } : {})
        }
      }];
    }

    return [{
      type: 'input',
      block_id: `vote_q${qi}`,
      label: { type: 'plain_text', text: label },
      element: {
        type: 'static_select',
        action_id: 'selected',
        placeholder: { type: 'plain_text', text: 'Select an option' },
        options: q.options.map((opt, oi) => ({ text: { type: 'plain_text', text: optionText(opt) }, value: String(oi) })),
        ...(prev.length ? { initial_option: { text: { type: 'plain_text', text: optionText(q.options[prev[0]]) }, value: String(prev[0]) } } : {})
      }
    }];
  });

  const notifyOpt = [{ text: { type: 'mrkdwn', text: '*Notify me when this poll closes*' }, value: 'notify' }];

  return {
    type: 'modal',
    callback_id: 'vote_submit',
    title: { type: 'plain_text', text: hasVoted ? 'Change Your Vote' : 'Cast Your Vote' },
    submit: { type: 'plain_text', text: hasVoted ? 'Update Vote' : 'Submit Vote' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText(pollDisplayTitle(poll)) } },
      ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: [
            `${poll.questions.length} question${poll.questions.length !== 1 ? 's' : ''}`,
            poll.anonymous ? '🔒 Anonymous' : null,
            poll.closeAt ? `⏰ Closes ${new Date(poll.closeAt).toLocaleString()}` : null
          ].filter(Boolean).join('  ·  ')
        }]
      },
      { type: 'divider' },
      ...questionBlocks,
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'vote_notify',
        label: { type: 'plain_text', text: 'Notifications' },
        optional: true,
        element: {
          type: 'checkboxes',
          action_id: 'value',
          options: notifyOpt
        }
      }
    ]
  };
}

function pollProgressBar(count, total, width = 16) {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((count / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Which questions can be answered by pressing one button. A ranking or a
// Likert grid cannot - there is no single click that means "third place" -
// so those keep sending people to the vote modal. This is deliberately the
// same set that gets the option-and-bar rendering below, so the two cannot
// drift apart.
function isInlineVotable(type) {
  return !['open_ended', 'likert', 'ranking'].includes(type);
}

// Slack renders one message for everyone, so an inline ballot cannot tick the
// option you chose or grey out the rest - only the vote modal knows who is
// reading. All this does is let you answer without opening anything, which
// for a one-question poll is the whole interaction.
function optionAccessory(poll, qi, oi, interactive) {
  if (!interactive) return {};
  return {
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: OPTION_EMOJIS[oi] || `${oi + 1}`, emoji: true },
      // Unique per option: Slack rejects a repeated action_id in one message.
      action_id: `vote_option_${qi}_${oi}`,
      value: `${poll.id}::${qi}::${oi}`
    }
  };
}

function buildQuestionResultBlock(q, qi, poll, viewerId = null, interactive = false) {
  const qVotes = pollVotes(poll)[qi] || {};

  if (!canViewResults(poll, viewerId)) {

    // Hiding the tally is a rule about numbers, not about the ballot. It used
    // to hide the options as well, which on the default setting left the
    // message as a question with no visible answers - nobody could see what
    // they were being asked to pick without opening a modal first.
    const head =
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${questionTypeIcon(q)}  *${qi + 1}. ${questionText(q)}*\n_${resultsHiddenReason(poll)}_` }
      };
    if (!isInlineVotable(q.type)) return [head, { type: 'divider' }];
    return [
      head,
      ...q.options.map((option, oi) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `${OPTION_EMOJIS[oi] || `${oi + 1}.`}  *${option}*` },
        ...optionAccessory(poll, qi, oi, interactive)
      })),
      { type: 'divider' }
    ];
  }

  if (q.type === 'open_ended') {
    const responses = Object.entries(qVotes);
    const count = responses.length;
    const body = count === 0
      ? '_No responses yet_'
      : poll.anonymous
        ? `_${count} anonymous response${count !== 1 ? 's' : ''}_`
        : responses.map(([uid, t]) => `> <@${uid}>:  ${t}`).join('\n');
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${questionTypeIcon(q)}  *${qi + 1}. ${questionText(q)}*\n_${count} response${count !== 1 ? 's' : ''}_\n${body}`
        }
      },
      { type: 'divider' }
    ];
  }

  if (q.type === 'likert') {
    const stmtBlocks = q.options.flatMap((stmt, si) => {
      const ratings = qVotes[si] || {};
      const total = Object.values(ratings).reduce((s, v) => s + v.length, 0);
      const bars = LIKERT_SCALE.map(({ label, value }) => {
        const cnt = (ratings[value] || []).length;
        const pct = total === 0 ? 0 : Math.round((cnt / total) * 100);
        const bar = pollProgressBar(cnt, total, 10);
        return `  \`${bar}\`  *${pct}%*  ${label}`;
      }).join('\n');
      return [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*${stmt}*  —  _${total} response${total !== 1 ? 's' : ''}_\n${bars}` }
      }];
    });
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `${questionTypeIcon(q)}  *${qi + 1}. ${questionText(q)}*` } },
      ...stmtBlocks,
      { type: 'divider' }
    ];
  }

  if (q.type === 'ranking') {
    const allRankings = Object.values(qVotes);
    const avgRanks = q.options.map((_, oi) => {
      if (!allRankings.length) return null;
      const ranks = allRankings.map(r => parseInt((r || '').split(',')[oi])).filter(n => !isNaN(n) && n > 0);
      return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
    });
    const sorted = q.options
      .map((opt, oi) => ({ opt, avg: avgRanks[oi] }))
      .sort((a, b) => (a.avg ?? 999) - (b.avg ?? 999));
    const medals = ['🥇', '🥈', '🥉'];
    const optBlocks = sorted.map(({ opt, avg }, rank) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${medals[rank] || `${rank + 1}.`}  *${opt}*  ${avg !== null ? `·  avg rank *${avg.toFixed(1)}*` : '·  _no votes yet_'}`
      }
    }));
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `${questionTypeIcon(q)}  *${qi + 1}. ${questionText(q)}*\n_${allRankings.length} response${allRankings.length !== 1 ? 's' : ''}_` } },
      ...optBlocks,
      { type: 'divider' }
    ];
  }

  const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
  const maxVotes   = totalVotes === 0 ? 0 : Math.max(...Object.values(qVotes).map(v => v.length));
  const typeHint   = `${questionTypeIcon(q)} _${questionTypeLabel(q)}${totalVotes > 0 ? `  ·  ${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` : ''}${interactive ? '  ·  press a number to vote' : ''}_`;

  let displayOptions = q.options.map((option, oi) => ({ option, oi }));
  if (poll.orderByVotes && totalVotes > 0) {
    displayOptions = displayOptions.sort((a, b) => (qVotes[b.oi] || []).length - (qVotes[a.oi] || []).length);
  }

  const optionBlocks = displayOptions.map(({ option, oi }) => {
    const voters   = qVotes[oi] || [];
    const count    = voters.length;
    const pct      = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
    const bar      = pollProgressBar(count, totalVotes);
    const isWinner = totalVotes > 0 && count === maxVotes && count > 0;
    const voterLine = !poll.anonymous && count > 0
      ? `\n${voters.map(id => `<@${id}>`).join('  ')}`
      : '';
    const statLine = totalVotes === 0
      ? '_No votes yet_'
      : `\`${bar}\`  *${pct}%*  (${count} vote${count !== 1 ? 's' : ''})`;

    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${OPTION_EMOJIS[oi] || `${oi + 1}.`}  *${option}*${isWinner ? '  🏆' : ''}\n${statLine}${voterLine}`
      },
      ...optionAccessory(poll, qi, oi, interactive)
    };
  });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${questionText(q)}*\n${typeHint}` } },
    ...optionBlocks,
    { type: 'divider' }
  ];
}

// Shown only to the creator: the id, and the commands that need it.
function pollAdminHint(poll) {
  // No /poll-close here: the poll message carries a Close button now.
  return [
    `ID: \`${poll.id}\``,
    `\`/poll-export ${poll.id}\``
  ].join('  ·  ');
}

function buildPollBlocks(poll) {
  const questions = poll.questions || [];
  const isClosed  = poll.status === 'closed';
  const participants = getAllVoters(poll).size;

  const statusParts = [
    isClosed ? '🔒 *Closed*' : '🟢 *Active*',
    poll.anonymous   ? '🔒 Anonymous'            : null,
    poll.allowRevote ? '🔄 Vote changes allowed'  : null,
    participants > 0 ? `*${participants}* participant${participants !== 1 ? 's' : ''}` : '_No responses yet_',
    poll.closeAt && !isClosed ? `⏰ Closes ${new Date(poll.closeAt).toLocaleString()}` : null
  ].filter(Boolean);

  // Closed poll: view results + share; Active poll: vote + share
  const actionButtons = isClosed
    ? [
        { type: 'button', text: { type: 'plain_text', text: '📊  View Results', emoji: true }, style: 'primary', action_id: 'view_results_modal', value: poll.id },
        // Posts the poll message (results included once closed) into another
        // channel - deliberately open to any member, unlike /poll-share.
        { type: 'button', text: { type: 'plain_text', text: '📤  Send', emoji: true }, action_id: 'share_poll', value: poll.id }
      ]
    : [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🗳️  Vote', emoji: true },
          style: 'primary',
          action_id: 'open_vote_modal',
          value: poll.id
        },
        { type: 'button', text: { type: 'plain_text', text: '📤  Send', emoji: true }, action_id: 'share_poll', value: poll.id },
        // Everyone sees this button - Slack cannot show one person a different
        // version of a message - so the handler turns away anyone who is not
        // running the poll. Without it, closing a poll that was created without
        // an auto-close time meant finding its id and typing a slash command.
        { type: 'button', text: { type: 'plain_text', text: '🔒  Close', emoji: true }, action_id: 'close_poll', value: poll.id }
      ];

  // Everything but the questions is fixed, so the questions are what has to
  // give when the message will not fit.
  const frame = questionBlocks => [
    { type: 'header', text: { type: 'plain_text', text: headerText(`📊  ${pollDisplayTitle(poll)}`), emoji: true } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusParts.join('  ·  ') }] },
    { type: 'divider' },
    ...questionBlocks,
    { type: 'actions', elements: actionButtons },
    {
      // The id and its commands used to sit here, on a message the whole
      // channel reads, when only the creator has any use for them. They are
      // sent privately when the poll is created, and `/polls-list` has them.
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Created by <@${poll.creator}>` }]
    }
  ];

  // A closed poll is a record rather than a ballot, so the buttons go with it -
  // and by then the tally is public anyway.
  const full = frame(questions.flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, null, !isClosed)));
  return full.length <= MAX_MESSAGE_BLOCKS ? full : frame(compactQuestionBlocks(poll));
}

function buildShareModal(poll) {
  const totalParticipants = getAllVoters(poll).size;

  return {
    type: 'modal',
    callback_id: 'share_poll_submit',
    title: { type: 'plain_text', text: 'Send Poll' },
    submit: { type: 'plain_text', text: 'Send Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${pollDisplayTitle(poll)}*\n_${poll.questions.length} question${poll.questions.length !== 1 ? 's' : ''}  ·  ${totalParticipants} participant${totalParticipants !== 1 ? 's' : ''}_`
        }
      },
      { type: 'divider' },
      ...destinationBlocks({ peopleHint: 'Pick yourself to get a copy you can vote in.' }),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'Votes cast anywhere it is posted count toward the same poll. For a private channel, invite me to it first.'
        }]
      }
    ]
  };
}

function buildResultsBlocks(poll, heading, viewerId = null) {
  const participants = getAllVoters(poll).size;
  return [
    { type: 'header', text: { type: 'plain_text', text: headerText(heading) } },
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${pollDisplayTitle(poll)}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants === 1 ? '' : 's'}  ·  Created by <@${poll.creator}>${poll.anonymous ? '  ·  🔒 Anonymous' : ''}` }] },
    { type: 'divider' },
    ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, viewerId))
  ];
}

function buildPostVoteModal(poll, viewerId = null) {
  const participants = getAllVoters(poll).size;
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Vote Recorded' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Your vote has been recorded for *${pollDisplayTitle(poll)}*!` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants !== 1 ? 's' : ''} so far` }] },
      { type: 'divider' },
      ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, viewerId))
    ]
  };
}

function readCurrentQuestion(values, qNum) {
  return {
    text:          (values[`q_text_${qNum}`]?.value?.value || '').trim(),
    type:          values[`q_type_${qNum}`]?.question_type_changed?.selected_option?.value || 'multiple_choice',
    optionsRaw:    values[`q_options_${qNum}`]?.value?.value || ''
  };
}

// What came back from the options screen. Absent blocks fall through to what the
// metadata already carried, so saving the screen without touching it is a no-op.
function readOptionsSettings(values, meta) {
  const closeAtRaw = values.poll_close_at?.value?.selected_date_time;
  return {
    pollTitle:       (values.poll_title?.value?.value       ?? meta.pollTitle       ?? '').trim(),
    pollDescription: (values.poll_description?.value?.value ?? meta.pollDescription ?? '').trim(),
    pollSettings: values.poll_settings?.value?.selected_options?.map(o => o.value) ?? meta.pollSettings ?? [],
    closeAt:      closeAtRaw ? new Date(closeAtRaw * 1000).toISOString() : null,
    showResults:  values.poll_show_results?.value?.selected_option?.value ?? meta.showResults ?? DEFAULT_SHOW_RESULTS,
    // Read straight from the checkbox rather than OR-ed with the metadata: this
    // screen is the only place it is set, so unticking it has to be able to turn
    // it off again.
    orderByVotes: (values.poll_order_by_votes?.value?.selected_options?.length ?? 0) > 0
  };
}

// Everything on the compose screen, folded back into the metadata. Every button
// on that screen calls this first: a block action arrives with the whole view
// state, so nothing typed is lost when another screen is pushed on top - the
// destination picks included, which is what used to be reset by ← Back.
function readComposeState(view) {
  const meta = JSON.parse(view.private_metadata);
  const values = view.state?.values || {};
  const qNum = (meta.savedQuestions || []).length + 1;
  // The title and description are not on this screen any more, so they simply
  // travel on in the metadata the options screen put them there.
  return {
    meta: { ...meta, ...readDestinations(values) },
    qNum,
    question: readCurrentQuestion(values, qNum)
  };
}

// What to say when draftFitsInView says no. The limit itself lives with the
// other limits in lib/validation.js; this is only the wording.
const METADATA_FULL = 'This draft is as long as the builder can carry — Slack limits how much a half-finished poll can hold. Post what you have, or shorten a question.';

// A question as read off a form, in the shape the form builder wants it back.
function restoreQuestion(q = {}) {
  return { text: q.text || '', options: q.optionsRaw || '' };
}

// Rebuild the compose screen from metadata alone, half-typed question and all.
// Used when a pushed screen has to refresh the screen underneath it, which is
// the only time the live view state is out of reach. The keys dropped here are
// carried for exactly that trip - a view id and a draft are about the journey,
// not about the poll - so they do not belong in the rebuilt view's metadata.
function rebuildComposeView(meta) {
  const { draft = {}, composeViewId, questionPageViewId, editingIndex, ...rest } = meta;
  return buildComposeModal(rest, draft.type || 'multiple_choice', restoreQuestion(draft));
}

// Takes the type as the *form* offers it - where "pick several" is its own
// entry - and returns the question in the shape polls have always been stored
// in, so nothing downstream or already in the database has to know about that.
function buildQuestion(text, formType, optionsRaw) {
  const { type, allowMultiple } = resolveQuestionType(formType);
  const options = AUTO_OPTION_TYPES.includes(type) ? getAutoOptions(type) : parseOptions(optionsRaw);
  return { text, type, options, allowMultiple };
}

// A row per poll: what it is, then everything you can do with it.
//
// The buttons are the whole point. Every one of these actions used to mean
// copying the poll's id out of this very list and pasting it into a slash
// command - which is a worse interaction than any number of clicks, because it
// is a transcription job. The id stays on the row, quietly, because `/poll-edit`
// has no button of its own yet.
function pollListBlocks(polls, { closed = false } = {}) {
  const shown = polls.slice(0, POLL_LIST_PAGE_SIZE);
  const button = (text, action_id, value) => ({
    type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id, value
  });

  return [
    { type: 'header', text: { type: 'plain_text', text: closed ? 'Closed Polls' : 'Active Polls' } },
    ...shown.flatMap((p, i) => {
      const participants = getAllVoters(p).size;
      const tags = [
        `${p.questions.length} question${p.questions.length !== 1 ? 's' : ''}`,
        `${participants} participant${participants !== 1 ? 's' : ''}`,
        `by <@${p.creator}>`,
        ...(p.anonymous   ? ['🔒 Anonymous'] : []),
        ...(p.allowRevote ? ['🔄 Revote on'] : []),
        ...(!closed && p.closeAt ? [`⏰ Closes ${new Date(p.closeAt).toLocaleString()}`] : [])
      ];
      return [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${i + 1}. ${pollDisplayTitle(p)}*\n${tags.join('  ·  ')}  ·  \`${p.id}\`` }
        },
        {
          type: 'actions',
          elements: [
            button('📊  Results', 'list_poll_results', p.id),
            button('📤  Send', 'share_poll', p.id),
            ...(closed ? [] : [button('🔒  Close', 'close_poll', p.id)]),
            button('⬇️  Export', 'list_poll_export', p.id)
          ]
        }
      ];
    }),
    ...truncationNote(polls.length, shown.length)
  ];
}

// Losing votes by accident cannot be undone, so closing a poll that has any is
// confirmed first. channelId travels in private_metadata because the final
// results are posted where the close was asked for, which the view submission
// does not otherwise know.
function buildCloseConfirmModal(poll, channelId, participants) {
  return {
    type: 'modal',
    callback_id: 'poll_close_confirm',
    title: { type: 'plain_text', text: 'Close Poll?' },
    submit: { type: 'plain_text', text: 'Close Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id, channelId }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Are you sure you want to close *${pollDisplayTitle(poll)}*?\n\n*${participants}* participant${participants !== 1 ? 's have' : ' has'} voted. This cannot be undone.`
        }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Closing the poll will notify opted-in participants and post final results.' }] }
    ]
  };
}

// The CSV a poll exports, shared by the slash command and the Export button on
// the poll lists - the button being the reason it is a function now.
function buildPollCsv(poll) {
  // A cell starting with any of these is executed as a formula by Excel and
  // Sheets, so prefix it with an apostrophe before quoting.
  const FORMULA_PREFIXES = ['=', '+', '-', '@', String.fromCharCode(9), String.fromCharCode(13)];
  const esc = v => {
    const raw = String(v == null ? '' : v);
    const safe = FORMULA_PREFIXES.includes(raw[0]) ? "'" + raw : raw;
    return '"' + safe.split('"').join('""') + '"';
  };
  const rows = [['Question', 'Type', 'Option / Statement', 'Votes / Response', 'Percentage', 'Voted At']];

  poll.questions.forEach((q, qi) => {
    const qVotes = pollVotes(poll)[qi] || {};
    if (q.type === 'open_ended') {
      Object.entries(qVotes).forEach(([uid, text]) => {
        const ts = poll.voteTimestamps?.[uid] || '';
        rows.push([q.text, questionTypeLabel(q), poll.anonymous ? '(anonymous)' : uid, text, '', ts]);
      });
      if (!Object.keys(qVotes).length) rows.push([q.text, questionTypeLabel(q), '(no responses)', '', '', '']);
    } else if (q.type === 'ranking') {
      const allRankings = Object.values(qVotes);
      q.options.forEach((opt, oi) => {
        const ranks = allRankings.map(r => parseInt((r || '').split(',')[oi])).filter(n => !isNaN(n) && n > 0);
        const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2) : 'N/A';
        rows.push([q.text, questionTypeLabel(q), opt, `avg rank: ${avg}`, '', '']);
      });
    } else if (q.type === 'likert') {
      q.options.forEach((stmt, si) => {
        const ratings = qVotes[si] || {};
        const total = Object.values(ratings).reduce((s, v) => s + v.length, 0);
        LIKERT_SCALE.forEach(({ label, value }) => {
          const cnt = (ratings[value] || []).length;
          const pct = total === 0 ? 0 : Math.round((cnt / total) * 100);
          rows.push([q.text, questionTypeLabel(q), `${stmt} — ${label}`, cnt, `${pct}%`, '']);
        });
      });
    } else {
      const total = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
      q.options.forEach((opt, oi) => {
        const voters = qVotes[oi] || [];
        const pct = total === 0 ? 0 : Math.round((voters.length / total) * 100);
        rows.push([q.text, questionTypeLabel(q), opt, voters.length, `${pct}%`, '']);
      });
    }
  });

  return rows.map(r => r.map(esc).join(',')).join('\n');
}

// "📊 View Results" button on closed poll message
// Shared by the View Results button on a closed poll and the Results button on
// the poll lists, so an active poll no longer gets a modal that calls itself
// closed. Slack caps a header at 150 characters where a title may run to 200,
// so the heading is trimmed rather than left to be rejected.
function buildResultsModal(poll, viewerId) {
  const participants = getAllVoters(poll).size;
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Poll Results' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText(pollDisplayTitle(poll)) } },
      ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${poll.status === 'closed' ? '🔒 Closed' : '🟢 Active'}  ·  *${participants}* participant${participants !== 1 ? 's' : ''}  ·  Created by <@${poll.creator}>`
        }]
      },
      { type: 'divider' },
      ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, viewerId))
    ]
  };
}

module.exports = {
  headerText,
  SLACK_HEADER_LIMIT,
  optionText,
  SLACK_OPTION_LIMIT,
  OPTION_EMOJIS,
  QUESTION_TYPES,
  LIKERT_SCALE,
  QUESTION_TYPE_ICONS,
  getAutoOptions,
  getTypeLabel,
  getTypeIcon,
  questionTypeIcon,
  questionTypeLabel,
  QUESTION_TYPE_GROUPS,
  findTypeOption,
  destinationBlocks,
  PEOPLE_LABEL,
  dmRedirectNotice,
  buildPostConfirmation,
  failureRecord,
  nowhereRecord,
  readDestinations,
  prefillableChannel,
  describeDestinations,
  questionFormBlocks,
  buildQuestionModal,
  savedQuestionsBlocks,
  SHOW_RESULTS_OPTIONS,
  DEFAULT_SHOW_RESULTS,
  VOTING_SETTINGS_OPTIONS,
  ORDER_BY_VOTES_OPTIONS,
  settingsSummary,
  buildComposeModal,
  buildOptionsModal,
  buildEditModal,
  buildPreviewModal,
  FIXED_PREVIEW_BLOCKS,
  MAX_MESSAGE_BLOCKS,
  METADATA_FULL,
  readCurrentQuestion,
  readOptionsSettings,
  readComposeState,
  restoreQuestion,
  rebuildComposeView,
  buildQuestion,
  clampText,
  compactQuestionBlocks,
  capBlocks,
  buildVoteModal,
  pollProgressBar,
  isInlineVotable,
  optionAccessory,
  buildQuestionResultBlock,
  pollAdminHint,
  buildPollBlocks,
  buildShareModal,
  buildResultsBlocks,
  buildPostVoteModal,
  buildResultsModal,
  buildCloseConfirmModal,
  buildNoticeModal,
  POLL_LIST_PAGE_SIZE,
  truncationNote,
  pollListBlocks,
  buildPollCsv,
};
