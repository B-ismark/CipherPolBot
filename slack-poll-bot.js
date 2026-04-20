require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { Pool } = require('pg');

// ==================== DATABASE ====================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      questions TEXT NOT NULL DEFAULT '[]',
      votes TEXT NOT NULL DEFAULT '{}',
      anonymous BOOLEAN NOT NULL DEFAULT false,
      allow_revote BOOLEAN NOT NULL DEFAULT false,
      creator TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_ts TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS questions TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS allow_revote BOOLEAN NOT NULL DEFAULT false`);
  // Drop legacy single-question column if it exists (old schema used 'question' singular)
  await pool.query(`ALTER TABLE polls DROP COLUMN IF EXISTS question`).catch(() => {});
}

async function savePoll(poll) {
  await pool.query(`
    INSERT INTO polls (id, title, description, questions, votes, anonymous, allow_revote, creator, channel_id, message_ts, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title, description=EXCLUDED.description, questions=EXCLUDED.questions,
      votes=EXCLUDED.votes, anonymous=EXCLUDED.anonymous, allow_revote=EXCLUDED.allow_revote,
      creator=EXCLUDED.creator, channel_id=EXCLUDED.channel_id,
      message_ts=EXCLUDED.message_ts, status=EXCLUDED.status
  `, [
    poll.id, poll.title, poll.description || '',
    JSON.stringify(poll.questions), JSON.stringify(poll.votes),
    poll.anonymous || false, poll.allowRevote || false,
    poll.creator, poll.channelId, poll.messageTs || null, poll.status || 'active'
  ]);
}

function rowToPoll(row) {
  return {
    ...row,
    channelId: row.channel_id, messageTs: row.message_ts, createdAt: row.created_at,
    allowRevote: row.allow_revote,
    questions: JSON.parse(row.questions || '[]'),
    votes: JSON.parse(row.votes || '{}')
  };
}

async function getPoll(id) {
  const { rows } = await pool.query('SELECT * FROM polls WHERE id = $1', [id]);
  return rows.length ? rowToPoll(rows[0]) : null;
}

async function getAllPolls() {
  const { rows } = await pool.query("SELECT * FROM polls WHERE status='active' ORDER BY created_at DESC");
  return rows.map(rowToPoll);
}

async function updatePollVotes(pollId, votes) {
  await pool.query('UPDATE polls SET votes=$1 WHERE id=$2', [JSON.stringify(votes), pollId]);
}

async function closePoll(pollId) {
  await pool.query("UPDATE polls SET status='closed' WHERE id=$1", [pollId]);
}

// ==================== APP SETUP ====================

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

app.error(async (err) => console.error('Bolt error:', JSON.stringify(err, null, 2)));

async function resolveChannel(client, channelId, userId) {
  if (channelId.startsWith('D')) {
    const r = await client.conversations.open({ users: userId });
    return r.channel.id;
  }
  return channelId;
}

async function notifyError(client, userId, text) {
  try {
    const r = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: r.channel.id, text });
  } catch (e) { console.error('notifyError failed:', e.message); }
}

// ==================== CONSTANTS ====================

const OPTION_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'Multiple choice' },
  { value: 'yes_no',          label: 'Yes / No' },
  { value: 'agree_disagree',  label: 'Agree / Disagree' },
  { value: 'scale_5',         label: '1-to-5 scale' },
  { value: 'scale_10',        label: '1-to-10 scale' },
  { value: 'nps',             label: 'NPS (0–10)' },
  { value: 'open_ended',      label: 'Open ended' }
];

// Types that auto-generate their options — no choices input needed
const AUTO_OPTION_TYPES = ['yes_no', 'agree_disagree', 'scale_5', 'scale_10', 'nps', 'open_ended'];

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

function parseOptions(raw) {
  const sep = raw.includes('\n') ? '\n' : ',';
  return raw.split(sep).map(o => o.trim()).filter(Boolean);
}

// ==================== MODAL BUILDERS ====================

// Question form blocks — used inside the pushed question modal.
// qNum keeps block IDs unique so Slack always renders fresh inputs.
function questionFormBlocks(qNum, questionType = 'multiple_choice', restore = {}) {
  const needsOptions = !AUTO_OPTION_TYPES.includes(questionType);
  const typeOptions = QUESTION_TYPES.map(t => ({
    text: { type: 'plain_text', text: t.label },
    value: t.value
  }));

  const blocks = [
    {
      type: 'input',
      block_id: `q_text_${qNum}`,
      label: { type: 'plain_text', text: 'Question' },
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
        options: typeOptions,
        initial_option: typeOptions.find(o => o.value === questionType) || typeOptions[0]
      }
    }
  ];

  if (needsOptions) {
    blocks.push({
      type: 'input',
      block_id: `q_options_${qNum}`,
      label: { type: 'plain_text', text: 'Answer choices' },
      hint: { type: 'plain_text', text: 'One option per line, or separate with commas — e.g. Python, JavaScript, Go' },
      optional: false,
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Option 1\nOption 2\nOption 3' },
        ...(restore.options ? { initial_value: restore.options } : {})
      }
    });
  } else if (questionType === 'open_ended') {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Open ended — voters will type a free-text response_' }]
    });
  } else {
    const preview = getAutoOptions(questionType).join(' · ');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Auto-generated options:  ${preview}_` }]
    });
  }

  blocks.push({
    type: 'input',
    block_id: `q_multiple_${qNum}`,
    label: { type: 'plain_text', text: 'Options' },
    optional: true,
    element: {
      type: 'checkboxes',
      action_id: 'value',
      options: [{
        text: { type: 'mrkdwn', text: '*Allow multiple selections*' },
        value: 'multiple'
      }],
      ...(restore.allowMultiple ? {
        initial_options: [{ text: { type: 'mrkdwn', text: '*Allow multiple selections*' }, value: 'multiple' }]
      } : {})
    }
  });

  return blocks;
}

// The pushed question-form modal (opened via views.push from the main modal)
function buildQuestionModal(meta, currentType = 'multiple_choice', restore = {}, errorMsg = null) {
  const { savedQuestions = [], editingIndex } = meta;
  const isEditing = editingIndex !== undefined && editingIndex !== null;
  const qNum = savedQuestions.length + 1;

  const savedCount = savedQuestions.length;
  const savedSummary = savedCount > 0
    ? `_${savedCount} ${savedCount === 1 ? 'question' : 'questions'} saved: ${savedQuestions.map((q, i) => `${i + 1}. ${q.text.length > 30 ? q.text.slice(0, 30) + '…' : q.text}`).join('  ·  ')}_`
    : '_No questions added yet_';

  const actionButtons = isEditing ? [] : [
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: savedSummary }]
    },
    {
      type: 'actions',
      block_id: 'question_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '＋  Add Another Question' },
          action_id: 'add_another_question'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✓  Create Poll' },
          style: 'primary',
          action_id: 'finish_and_create'
        }
      ]
    }
  ];

  return {
    type: 'modal',
    callback_id: 'question_submit',
    title: { type: 'plain_text', text: isEditing ? 'Edit Question' : 'New Question' },
    submit: { type: 'plain_text', text: isEditing ? 'Update' : '← Done (review)' },
    close: { type: 'plain_text', text: '← Back' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      ...questionFormBlocks(qNum, currentType, restore),
      ...actionButtons
    ]
  };
}

// Success modal shown after poll is created
function buildSuccessModal(pollTitle) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Poll Created! 🎉' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *${pollTitle || 'Your poll'}* has been posted to the channel.` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Head back to the chat to see it and start collecting votes.' }] }
    ]
  };
}

// The main creation modal — shows poll settings + saved question list.
// No inline question form; questions are added via the pushed modal.
function buildCreationModal(meta, errorMsg = null) {
  const { savedQuestions = [], pollTitle = '', pollDescription = '', pollSettings = [] } = meta;

  const settingsOptions = [
    { text: { type: 'mrkdwn', text: '*Anonymous* — hide who voted for what' }, value: 'anonymous' },
    { text: { type: 'mrkdwn', text: '*Allow vote changes* — voters can update their choice' }, value: 'allow_revote' }
  ];

  const activeSettings = pollSettings.filter(v => settingsOptions.some(o => o.value === v));

  return {
    type: 'modal',
    callback_id: 'poll_submit',
    title: { type: 'plain_text', text: 'Create a Poll' },
    submit: { type: 'plain_text', text: 'Create Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      {
        type: 'input',
        block_id: 'poll_title',
        label: { type: 'plain_text', text: 'Poll title' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Give your poll a name...' },
          ...(pollTitle ? { initial_value: pollTitle } : {})
        }
      },
      {
        type: 'input',
        block_id: 'poll_description',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Add context or instructions (optional)...' },
          ...(pollDescription ? { initial_value: pollDescription } : {})
        }
      },
      {
        type: 'input',
        block_id: 'poll_settings',
        label: { type: 'plain_text', text: 'Poll settings' },
        optional: true,
        element: {
          type: 'checkboxes',
          action_id: 'value',
          options: settingsOptions,
          ...(activeSettings.length ? {
            initial_options: activeSettings.map(v => settingsOptions.find(o => o.value === v))
          } : {})
        }
      },
      { type: 'divider' },
      ...savedQuestionsBlocks(savedQuestions),
      {
        type: 'actions',
        block_id: 'form_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '＋  Add Question' },
            action_id: 'add_question'
          },
          ...(savedQuestions.length > 0 ? [{
            type: 'button',
            text: { type: 'plain_text', text: 'Preview →' },
            style: 'primary',
            action_id: 'preview_poll'
          }] : [])
        ]
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
        text: `*${i + 1}.* ${q.text}\n_${getTypeLabel(q.type)}${q.allowMultiple ? ' · multi-select' : ''}${q.type !== 'open_ended' && q.options.length ? '  —  ' + q.options.slice(0, 4).join(', ') + (q.options.length > 4 ? '…' : '') : ''}_`
      },
      accessory: {
        type: 'overflow',
        action_id: 'question_action',
        options: [
          { text: { type: 'plain_text', text: '✏️  Edit' },           value: `edit:${i}` },
          { text: { type: 'plain_text', text: '⧉  Duplicate' },       value: `duplicate:${i}` },
          { text: { type: 'plain_text', text: '↑  Move Up' },         value: `move_up:${i}` },
          { text: { type: 'plain_text', text: '↓  Move Down' },       value: `move_down:${i}` },
          { text: { type: 'plain_text', text: '🗑️  Delete' },        value: `delete:${i}` }
        ]
      }
    })),
    { type: 'divider' }
  ];
}

function buildPreviewModal(meta) {
  const { savedQuestions = [], pollTitle, pollDescription, pollSettings = [] } = meta;
  const tags = [];
  if (pollSettings.includes('anonymous'))    tags.push('🔒 Anonymous');
  if (pollSettings.includes('allow_revote')) tags.push('🔄 Vote changes allowed');

  const questionBlocks = savedQuestions.flatMap((q, i) => [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}. ${q.text}*\n_${getTypeLabel(q.type)}${q.allowMultiple ? ' · multi-select' : ''}_`
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
    title: { type: 'plain_text', text: 'Preview Poll' },
    submit: { type: 'plain_text', text: '✓  Create Poll' },
    close: { type: 'plain_text', text: '← Back' },
    private_metadata: JSON.stringify(meta),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: pollTitle || 'Untitled Poll' } },
      ...(pollDescription ? [{ type: 'section', text: { type: 'mrkdwn', text: pollDescription } }] : []),
      ...(tags.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: tags.join('  ·  ') }] }] : []),
      { type: 'divider' },
      ...questionBlocks,
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${savedQuestions.length} ${savedQuestions.length === 1 ? 'question' : 'questions'} — review above then click *✓ Create Poll*` }]
      }
    ]
  };
}

function buildVoteModal(poll, previousVotes = {}) {
  return {
    type: 'modal',
    callback_id: 'vote_submit',
    title: { type: 'plain_text', text: 'Cast Your Vote' },
    submit: { type: 'plain_text', text: 'Submit Vote' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
      ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
      { type: 'divider' },
      ...poll.questions.map((q, qi) => {
        const prev = previousVotes[qi] || [];
        if (q.type === 'open_ended') {
          return {
            type: 'input',
            block_id: `vote_q${qi}`,
            label: { type: 'plain_text', text: `${qi + 1}. ${q.text}` },
            element: {
              type: 'plain_text_input',
              action_id: 'response',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Type your response...' },
              ...(prev[0] ? { initial_value: prev[0] } : {})
            }
          };
        }
        if (q.allowMultiple) {
          return {
            type: 'input',
            block_id: `vote_q${qi}`,
            label: { type: 'plain_text', text: `${qi + 1}. ${q.text}` },
            hint: { type: 'plain_text', text: 'Select all that apply' },
            element: {
              type: 'checkboxes',
              action_id: 'selected',
              options: q.options.map((opt, oi) => ({ text: { type: 'mrkdwn', text: opt }, value: String(oi) })),
              ...(prev.length ? { initial_options: prev.map(oi => ({ text: { type: 'mrkdwn', text: q.options[oi] }, value: String(oi) })) } : {})
            }
          };
        }
        return {
          type: 'input',
          block_id: `vote_q${qi}`,
          label: { type: 'plain_text', text: `${qi + 1}. ${q.text}` },
          element: {
            type: 'static_select',
            action_id: 'selected',
            placeholder: { type: 'plain_text', text: 'Select an option' },
            options: q.options.map((opt, oi) => ({ text: { type: 'plain_text', text: opt }, value: String(oi) })),
            ...(prev.length ? { initial_option: { text: { type: 'plain_text', text: q.options[prev[0]] }, value: String(prev[0]) } } : {})
          }
        };
      })
    ]
  };
}

// ==================== POLL DISPLAY ====================

function buildPollBlocks(poll) {
  const questions = poll.questions || [];
  const tags = [];
  if (poll.anonymous)   tags.push('🔒 Anonymous');
  if (poll.allowRevote) tags.push('🔄 Vote changes on');

  const questionBlocks = questions.flatMap((q, qi) => {
    const qVotes = poll.votes[qi] || {};

    if (q.type === 'open_ended') {
      const responses = Object.entries(qVotes);
      const count = responses.length;
      const responseLines = !poll.anonymous && count > 0
        ? responses.map(([uid, text]) => `> <@${uid}>: ${text}`).join('\n')
        : '';
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${qi + 1}. ${q.text}*\n_${count} ${count === 1 ? 'response' : 'responses'}_${responseLines ? '\n' + responseLines : ''}`
          }
        },
        { type: 'divider' }
      ];
    }

    const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
    const qLabel = q.allowMultiple ? `*${qi + 1}. ${q.text}*  _(multi-select)_` : `*${qi + 1}. ${q.text}*`;

    return [
      { type: 'section', text: { type: 'mrkdwn', text: qLabel } },
      ...q.options.map((option, oi) => {
        const voters = qVotes[oi] || [];
        const count = voters.length;
        const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        const voterLine = !poll.anonymous && count > 0 ? '\n' + voters.map(id => `<@${id}>`).join(' ') : '';
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: totalVotes === 0
              ? `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}`
              : `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}\n${bar} ${count} ${count === 1 ? 'vote' : 'votes'} (${pct}%)${voterLine}`
          }
        };
      }),
      { type: 'divider' }
    ];
  });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    ...(tags.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: tags.join('  ·  ') }] }] : []),
    { type: 'divider' },
    ...questionBlocks,
    {
      type: 'actions',
      elements: [{
        type: 'button', text: { type: 'plain_text', text: '🗳️ Vote' },
        style: 'primary', action_id: 'open_vote_modal', value: poll.id
      }]
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Created by <@${poll.creator}> • ID: \`${poll.id}\` • ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`
      }]
    }
  ];
}

function buildResultsBlocks(poll, heading) {
  const questions = poll.questions || [];
  const participants = new Set(
    Object.values(poll.votes).flatMap(qv => {
      const vals = Object.values(qv);
      if (!vals.length) return [];
      return Array.isArray(vals[0]) ? vals.flat() : Object.keys(qv);
    })
  ).size;

  const questionBlocks = questions.flatMap((q, qi) => {
    const qVotes = poll.votes[qi] || {};

    if (q.type === 'open_ended') {
      const responses = Object.entries(qVotes);
      return [
        { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*` } },
        ...(responses.length
          ? (poll.anonymous
              ? [{ type: 'section', text: { type: 'mrkdwn', text: `_${responses.length} response(s) — anonymous_` } }]
              : responses.map(([uid, text]) => ({ type: 'section', text: { type: 'mrkdwn', text: `> <@${uid}>: ${text}` } }))
            )
          : [{ type: 'section', text: { type: 'mrkdwn', text: '_No responses yet_' } }]
        ),
        { type: 'divider' }
      ];
    }

    const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*` } },
      ...q.options.map((opt, oi) => {
        const voters = qVotes[oi] || [];
        const count = voters.length;
        const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        const voterLine = !poll.anonymous && count > 0 ? '\n' + voters.map(id => `<@${id}>`).join(' ') : '';
        return {
          type: 'section',
          text: { type: 'mrkdwn', text: `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${opt}\n${bar} ${count} ${count === 1 ? 'vote' : 'votes'} (${pct}%)${voterLine}` }
        };
      }),
      { type: 'divider' }
    ];
  });

  return [
    { type: 'header', text: { type: 'plain_text', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'divider' },
    ...questionBlocks,
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${participants} ${participants === 1 ? 'participant' : 'participants'} • Created by <@${poll.creator}>${poll.anonymous ? '  ·  🔒 Anonymous' : ''}`
      }]
    }
  ];
}

async function updatePollMessage(client, poll) {
  try {
    await client.chat.update({ channel: poll.channelId, ts: poll.messageTs, blocks: buildPollBlocks(poll) });
  } catch (err) { console.error('updatePollMessage error:', err.message); }
}

// ==================== POLL CREATION HELPER ====================

async function createAndPostPoll(client, meta) {
  const { channelId, userId, savedQuestions, pollTitle, pollDescription, pollSettings = [] } = meta;

  const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  const votes = {};
  savedQuestions.forEach((q, qi) => {
    votes[qi] = q.type === 'open_ended'
      ? {}
      : Object.fromEntries(q.options.map((_, oi) => [oi, []]));
  });

  const poll = {
    id: pollId,
    title: pollTitle || savedQuestions[0]?.text || 'Poll',
    description: pollDescription || '',
    questions: savedQuestions,
    votes,
    anonymous: pollSettings.includes('anonymous'),
    allowRevote: pollSettings.includes('allow_revote'),
    creator: userId,
    channelId,
    status: 'active'
  };

  await savePoll(poll);
  const channel = await resolveChannel(client, channelId, userId);
  const result = await client.chat.postMessage({ channel, blocks: buildPollBlocks(poll) });
  poll.messageTs = result.ts;
  poll.channelId = channel;
  await savePoll(poll);
}

// ==================== HELPERS ====================

function readCurrentQuestion(values, qNum) {
  return {
    text:          (values[`q_text_${qNum}`]?.value?.value || '').trim(),
    type:          values[`q_type_${qNum}`]?.question_type_changed?.selected_option?.value || 'multiple_choice',
    optionsRaw:    values[`q_options_${qNum}`]?.value?.value || '',
    allowMultiple: (values[`q_multiple_${qNum}`]?.value?.selected_options?.length || 0) > 0
  };
}

function readMainModalSettings(values, meta) {
  return {
    pollTitle:       (values.poll_title?.value?.value       ?? meta.pollTitle       ?? '').trim(),
    pollDescription: (values.poll_description?.value?.value ?? meta.pollDescription ?? '').trim(),
    pollSettings:    values.poll_settings?.value?.selected_options?.map(o => o.value) ?? meta.pollSettings ?? []
  };
}

function buildQuestion(text, type, optionsRaw, allowMultiple) {
  const options = AUTO_OPTION_TYPES.includes(type) ? getAutoOptions(type) : parseOptions(optionsRaw);
  return { text, type, options, allowMultiple };
}

// ==================== COMMANDS ====================

app.command('/newpoll', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildCreationModal({ channelId: body.channel_id, userId: body.user_id, savedQuestions: [] })
    });
  } catch (err) {
    console.error('/newpoll error:', err);
    await notifyError(client, body.user_id, `❌ Could not open poll creator: ${err.message}`);
  }
});

app.command('/poll-results', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();
  if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-results POLL_ID`' });
  const poll = await getPoll(pollId);
  if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  await client.chat.postMessage({ channel, blocks: buildResultsBlocks(poll, 'Poll Results') });
});

app.command('/poll-share', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();
  if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-share POLL_ID`' });
  const poll = await getPoll(pollId);
  if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  await client.chat.postMessage({ channel, blocks: buildResultsBlocks(poll, 'Current Results') });
});

app.command('/polls-list', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const polls = await getAllPolls();
  if (!polls.length) return client.chat.postEphemeral({ channel, user: userId, text: '📭 No active polls right now.' });
  await client.chat.postMessage({
    channel,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Active Polls' } },
      ...polls.map((p, i) => {
        const participants = new Set(
          Object.values(p.votes).flatMap(qv => {
            const vals = Object.values(qv);
            return vals.length && Array.isArray(vals[0]) ? vals.flat() : Object.keys(qv);
          })
        ).size;
        const tags = [`${p.questions.length} q`, `${participants} participant${participants !== 1 ? 's' : ''}`,
          ...(p.anonymous ? ['🔒'] : []), ...(p.allowRevote ? ['🔄'] : [])];
        return { type: 'section', text: { type: 'mrkdwn', text: `*${i + 1}. ${p.title}*\nID: \`${p.id}\`  ·  ${tags.join('  ·  ')}` } };
      })
    ]
  });
});

app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();
  if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-close POLL_ID`' });
  const poll = await getPoll(pollId);
  if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  if (poll.creator !== userId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can close this poll.' });
  await closePoll(pollId);
  await client.chat.postMessage({ channel, blocks: buildResultsBlocks({ ...poll, status: 'closed' }, '🔒 Final Results') });
});

// ==================== MAIN MODAL ACTIONS ====================

// "＋ Add Question" button — saves current settings, then pushes the question form modal
app.action('add_question', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const settings = readMainModalSettings(values, meta);

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: buildQuestionModal({ ...meta, ...settings })
    });
  } catch (err) {
    console.error('add_question push error:', err);
  }
});

// "Preview →" button — validates questions exist, pushes preview modal
app.action('preview_poll', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const settings = readMainModalSettings(values, meta);
  const mergedMeta = { ...meta, ...settings };

  if (!meta.savedQuestions?.length) {
    return client.views.update({
      view_id: body.view.id,
      view: buildCreationModal(mergedMeta, 'Add at least one question before previewing.')
    });
  }

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: buildPreviewModal(mergedMeta)
    });
  } catch (err) {
    console.error('preview_poll push error:', err);
  }
});

// Overflow menu on saved questions: edit / duplicate / move / delete
app.action('question_action', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const [action, idxStr] = body.actions[0].selected_option.value.split(':');
  const idx = parseInt(idxStr);
  let qs = [...meta.savedQuestions];

  if (action === 'edit') {
    const q = qs[idx];
    qs.splice(idx, 1);
    const editMeta = { ...meta, savedQuestions: qs, editingIndex: idx };
    try {
      await client.views.push({
        trigger_id: body.trigger_id,
        view: buildQuestionModal(
          editMeta,
          q.type,
          {
            text: q.text,
            options: q.type === 'multiple_choice' ? q.options.join('\n') : '',
            allowMultiple: q.allowMultiple
          }
        )
      });
    } catch (err) {
      console.error('edit push error:', err);
    }
    return;
  }

  switch (action) {
    case 'duplicate':
      qs.splice(idx + 1, 0, { ...qs[idx] });
      break;
    case 'move_up':
      if (idx > 0) [qs[idx - 1], qs[idx]] = [qs[idx], qs[idx - 1]];
      break;
    case 'move_down':
      if (idx < qs.length - 1) [qs[idx], qs[idx + 1]] = [qs[idx + 1], qs[idx]];
      break;
    case 'delete':
      qs.splice(idx, 1);
      break;
  }

  const settings = readMainModalSettings(values, meta);
  await client.views.update({
    view_id: body.view.id,
    view: buildCreationModal({ ...meta, ...settings, savedQuestions: qs })
  });
});

// ==================== QUESTION MODAL ACTIONS ====================

// Dynamic show/hide of options field when type changes inside the pushed question modal
app.action('question_type_changed', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const qNum = meta.savedQuestions.length + 1;
  const newType = body.actions[0].selected_option.value;
  const currentText    = values[`q_text_${qNum}`]?.value?.value || '';
  const currentOptions = values[`q_options_${qNum}`]?.value?.value || '';
  const allowMultiple  = (values[`q_multiple_${qNum}`]?.value?.selected_options?.length || 0) > 0;

  await client.views.update({
    view_id: body.view.id,
    view: buildQuestionModal(meta, newType, { text: currentText, options: currentOptions, allowMultiple })
  });
});

// "＋ Add Another Question" — validates current form, saves question, resets form (stay in modal)
app.action('add_another_question', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const qNum = meta.savedQuestions.length + 1;
  const { text, type, optionsRaw, allowMultiple } = readCurrentQuestion(values, qNum);

  if (!text) {
    return client.views.update({
      view_id: body.view.id,
      view: buildQuestionModal(meta, type, { text, options: optionsRaw, allowMultiple }, 'Please enter a question.')
    });
  }
  if (!AUTO_OPTION_TYPES.includes(type) && parseOptions(optionsRaw).length < 2) {
    return client.views.update({
      view_id: body.view.id,
      view: buildQuestionModal(meta, type, { text, options: optionsRaw, allowMultiple }, 'Please enter at least 2 options.')
    });
  }

  const updatedMeta = {
    ...meta,
    savedQuestions: [...meta.savedQuestions, buildQuestion(text, type, optionsRaw, allowMultiple)],
    editingIndex: null
  };

  // Refresh the question modal with an empty form
  await client.views.update({
    view_id: body.view.id,
    view: buildQuestionModal(updatedMeta)
  });

  // Keep the main modal in sync
  try {
    await client.views.update({
      view_id: body.view.root_view_id,
      view: buildCreationModal(updatedMeta)
    });
  } catch (_) {}
});

// "✓ Create Poll" — validates, saves current question, creates poll, shows success
app.action('finish_and_create', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;
  const qNum = meta.savedQuestions.length + 1;
  const { text, type, optionsRaw, allowMultiple } = readCurrentQuestion(values, qNum);

  let allQuestions = [...meta.savedQuestions];

  // Include current in-progress question if it has text
  if (text) {
    if (!AUTO_OPTION_TYPES.includes(type) && parseOptions(optionsRaw).length < 2) {
      return client.views.update({
        view_id: body.view.id,
        view: buildQuestionModal(meta, type, { text, options: optionsRaw, allowMultiple }, 'Please enter at least 2 options.')
      });
    }
    allQuestions.push(buildQuestion(text, type, optionsRaw, allowMultiple));
  }

  if (allQuestions.length === 0) {
    return client.views.update({
      view_id: body.view.id,
      view: buildQuestionModal(meta, type, { text, options: optionsRaw, allowMultiple }, 'Please add at least one question.')
    });
  }

  try {
    await createAndPostPoll(client, { ...meta, savedQuestions: allQuestions });
    const title = meta.pollTitle || allQuestions[0]?.text || 'Poll';
    // Update both modals to success state so user sees a clean result
    await Promise.allSettled([
      client.views.update({ view_id: body.view.id,           view: buildSuccessModal(title) }),
      client.views.update({ view_id: body.view.root_view_id, view: buildSuccessModal(title) })
    ]);
  } catch (err) {
    console.error('finish_and_create error:', err);
    client.views.update({
      view_id: body.view.id,
      view: buildQuestionModal(meta, type, { text, options: optionsRaw, allowMultiple }, `Failed to create poll: ${err.message}`)
    });
    await notifyError(client, meta.userId, `❌ Failed to create poll: ${err.message}`);
  }
});

// ==================== VIEW SUBMISSIONS ====================

// Question form modal submitted — validates, adds question, updates parent modal
app.view('question_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const values = view.state.values;
  const qNum = meta.savedQuestions.length + 1;
  const { text, type, optionsRaw, allowMultiple } = readCurrentQuestion(values, qNum);

  if (!text) {
    return await ack({
      response_action: 'errors',
      errors: { [`q_text_${qNum}`]: 'Please enter a question.' }
    });
  }

  if (!AUTO_OPTION_TYPES.includes(type) && parseOptions(optionsRaw).length < 2) {
    return await ack({
      response_action: 'errors',
      errors: { [`q_options_${qNum}`]: 'Please enter at least 2 options.' }
    });
  }

  await ack(); // closes the pushed question modal, reveals the main modal

  const newQ = buildQuestion(text, type, optionsRaw, allowMultiple);
  let updatedQuestions = [...meta.savedQuestions];

  if (meta.editingIndex !== undefined && meta.editingIndex !== null) {
    updatedQuestions.splice(meta.editingIndex, 0, newQ);
  } else {
    updatedQuestions.push(newQ);
  }

  const updatedMeta = { ...meta, savedQuestions: updatedQuestions, editingIndex: null };

  try {
    await client.views.update({
      view_id: body.view.root_view_id,
      view: buildCreationModal(updatedMeta)
    });
  } catch (err) {
    console.error('question_submit: failed to update parent modal:', err.message);
  }
});

// Main creation modal submitted directly (without preview)
app.view('poll_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const values = view.state.values;
  const settings = readMainModalSettings(values, meta);

  if (!meta.savedQuestions?.length) {
    return await ack({
      response_action: 'update',
      view: buildCreationModal(
        { ...meta, ...settings },
        'Please add at least one question before creating the poll.'
      )
    });
  }

  await ack();

  try {
    await createAndPostPoll(client, { ...meta, ...settings });
  } catch (err) {
    console.error('poll_submit error:', err);
    await notifyError(client, meta.userId, `❌ Failed to create poll: ${err.message}`);
  }
});

// Preview modal — "✓ Create Poll" confirmed
app.view('poll_preview_submit', async ({ ack, body, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  try {
    await createAndPostPoll(client, meta);
  } catch (err) {
    console.error('poll_preview_submit error:', err);
    await notifyError(client, meta.userId, `❌ Failed to create poll: ${err.message}`);
  }
});

// Vote button on poll message
app.action('open_vote_modal', async ({ ack, body, client, action }) => {
  await ack();
  const poll = await getPoll(action.value);
  if (!poll) return;

  if (poll.status === 'closed') {
    return client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Poll Closed' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '🔒 This poll is no longer accepting votes.' } }]
      }
    });
  }

  const userId = body.user.id;
  const previousVotes = {};
  poll.questions.forEach((q, qi) => {
    const qv = poll.votes[qi] || {};
    if (q.type === 'open_ended') {
      if (qv[userId]) previousVotes[qi] = [qv[userId]];
    } else {
      Object.entries(qv).forEach(([oi, voters]) => {
        if (voters.includes(userId)) {
          if (!previousVotes[qi]) previousVotes[qi] = [];
          previousVotes[qi].push(parseInt(oi));
        }
      });
    }
  });

  const hasVoted = Object.keys(previousVotes).length > 0;
  if (hasVoted && !poll.allowRevote) {
    return client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Already Voted' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ You have already voted in this poll.' } }]
      }
    });
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildVoteModal(poll, hasVoted ? previousVotes : {})
  });
});

// Vote modal submitted
app.view('vote_submit', async ({ ack, body, view, client }) => {
  await ack();
  const { pollId } = JSON.parse(view.private_metadata);
  const userId = body.user.id;
  const poll = await getPoll(pollId);
  if (!poll || poll.status === 'closed') return;

  if (poll.allowRevote) {
    poll.questions.forEach((q, qi) => {
      if (q.type === 'open_ended') {
        delete poll.votes[qi][userId];
      } else {
        Object.keys(poll.votes[qi] || {}).forEach(oi => {
          poll.votes[qi][oi] = (poll.votes[qi][oi] || []).filter(id => id !== userId);
        });
      }
    });
  } else {
    const hasVoted = poll.questions.some((q, qi) => {
      const qv = poll.votes[qi] || {};
      return q.type === 'open_ended' ? !!qv[userId] : Object.values(qv).some(v => v.includes(userId));
    });
    if (hasVoted) return;
  }

  const values = view.state.values;
  poll.questions.forEach((q, qi) => {
    const block = values[`vote_q${qi}`];
    if (!block) return;
    if (q.type === 'open_ended') {
      const text = block.response?.value;
      if (text) poll.votes[qi][userId] = text;
    } else if (q.allowMultiple) {
      (block.selected?.selected_options || []).forEach(opt => {
        const oi = parseInt(opt.value);
        if (!poll.votes[qi][oi]) poll.votes[qi][oi] = [];
        poll.votes[qi][oi].push(userId);
      });
    } else {
      const sel = block.selected?.selected_option?.value;
      if (sel !== undefined) {
        const oi = parseInt(sel);
        if (!poll.votes[qi][oi]) poll.votes[qi][oi] = [];
        poll.votes[qi][oi].push(userId);
      }
    }
  });

  await updatePollVotes(pollId, poll.votes);
  await updatePollMessage(client, poll);
});

// ==================== HEALTH CHECK ====================

receiver.router.get('/', (req, res) => res.send('Slack Poll Bot is running ✓'));
receiver.router.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ==================== START ====================

(async () => {
  await initDb();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Slack Poll Bot is running!');
  console.log(`📍 Port: ${process.env.PORT || 3000}`);
  console.log(`💾 Database: Neon PostgreSQL`);
})();
