require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { Pool } = require('pg');

// ==================== DATABASE ====================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
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
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS close_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS vote_timestamps TEXT NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS show_results TEXT NOT NULL DEFAULT 'realtime'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS order_by_votes BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS message_refs TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS notify_on_close TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS co_creators TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls DROP COLUMN IF EXISTS question`).catch(() => {});
  await pool.query(`ALTER TABLE polls DROP COLUMN IF EXISTS options`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_installations (
      team_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function savePoll(poll) {
  await pool.query(`
    INSERT INTO polls (id, title, description, questions, votes, anonymous, allow_revote, creator, channel_id, message_ts, status, close_at, vote_timestamps, show_results, order_by_votes, message_refs, notify_on_close, co_creators)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title, description=EXCLUDED.description, questions=EXCLUDED.questions,
      votes=EXCLUDED.votes, anonymous=EXCLUDED.anonymous, allow_revote=EXCLUDED.allow_revote,
      creator=EXCLUDED.creator, channel_id=EXCLUDED.channel_id,
      message_ts=EXCLUDED.message_ts, status=EXCLUDED.status,
      close_at=EXCLUDED.close_at, vote_timestamps=EXCLUDED.vote_timestamps,
      show_results=EXCLUDED.show_results, order_by_votes=EXCLUDED.order_by_votes,
      message_refs=EXCLUDED.message_refs, notify_on_close=EXCLUDED.notify_on_close,
      co_creators=EXCLUDED.co_creators
  `, [
    poll.id, poll.title, poll.description || '',
    JSON.stringify(poll.questions), JSON.stringify(poll.votes),
    poll.anonymous || false, poll.allowRevote || false,
    poll.creator, poll.channelId, poll.messageTs || null, poll.status || 'active',
    poll.closeAt || null, JSON.stringify(poll.voteTimestamps || {}),
    poll.showResults || 'creator_only', poll.orderByVotes || false,
    JSON.stringify(poll.messageRefs || []),
    JSON.stringify(poll.notifyOnClose || []),
    JSON.stringify(poll.coCreators || [])
  ]);
}

function rowToPoll(row) {
  return {
    ...row,
    channelId: row.channel_id, messageTs: row.message_ts, createdAt: row.created_at,
    allowRevote: row.allow_revote, closeAt: row.close_at,
    showResults: row.show_results || 'creator_only',
    orderByVotes: row.order_by_votes || false,
    messageRefs: JSON.parse(row.message_refs || '[]'),
    questions: JSON.parse(row.questions || '[]'),
    votes: JSON.parse(row.votes || '{}'),
    voteTimestamps: JSON.parse(row.vote_timestamps || '{}'),
    notifyOnClose: JSON.parse(row.notify_on_close || '[]'),
    coCreators: JSON.parse(row.co_creators || '[]')
  };
}

function getAllVoters(poll) {
  const voters = new Set();
  Object.entries(poll.votes).forEach(([qi, qv]) => {
    const q = poll.questions[parseInt(qi)];
    if (!q) return;
    if (q.type === 'open_ended' || q.type === 'ranking') {
      Object.keys(qv).forEach(uid => voters.add(uid));
    } else if (q.type === 'likert') {
      Object.values(qv).forEach(ratings =>
        Object.values(ratings).forEach(uids => uids.forEach(uid => voters.add(uid)))
      );
    } else {
      Object.values(qv).forEach(uids => uids.forEach(uid => voters.add(uid)));
    }
  });
  return voters;
}

async function getPoll(id) {
  const { rows } = await pool.query('SELECT * FROM polls WHERE id = $1', [id]);
  return rows.length ? rowToPoll(rows[0]) : null;
}

async function getAllPolls(status = 'active') {
  const { rows } = await pool.query("SELECT * FROM polls WHERE status=$1 ORDER BY created_at DESC", [status]);
  return rows.map(rowToPoll);
}

async function updatePollVotes(pollId, votes, voteTimestamps) {
  await pool.query(
    'UPDATE polls SET votes=$1, vote_timestamps=$2 WHERE id=$3',
    [JSON.stringify(votes), JSON.stringify(voteTimestamps || {}), pollId]
  );
}

async function closePoll(pollId) {
  await pool.query("UPDATE polls SET status='closed' WHERE id=$1", [pollId]);
}

// ==================== SECURITY: RATE LIMITING & VALIDATION ====================

const MAX_POLL_TITLE_LENGTH = 200;
const MAX_POLL_DESCRIPTION_LENGTH = 1000;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_QUESTIONS_PER_POLL = 50;
const MAX_OPTIONS_PER_QUESTION = 10;
const MAX_POLLS_PER_USER_PER_DAY = 10;
const MAX_NOTIFY_SUBSCRIBERS_PER_POLL = 20;
const MAX_NOTIFICATIONS_PER_USER_PER_HOUR = 5;

const pollCreationTracker = {}; // { userId: [{ timestamp }] }
const notificationTracker = {}; // { userId: [{ timestamp }] }

function validatePollInputs(title, description, questions) {
  if (!title || title.trim().length === 0) {
    throw new Error('Poll title is required.');
  }
  if (title.length > MAX_POLL_TITLE_LENGTH) {
    throw new Error(`Poll title exceeds maximum length of ${MAX_POLL_TITLE_LENGTH} characters.`);
  }
  if (description && description.length > MAX_POLL_DESCRIPTION_LENGTH) {
    throw new Error(`Poll description exceeds maximum length of ${MAX_POLL_DESCRIPTION_LENGTH} characters.`);
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('Poll must have at least one question.');
  }
  if (questions.length > MAX_QUESTIONS_PER_POLL) {
    throw new Error(`Poll exceeds maximum number of questions (${MAX_QUESTIONS_PER_POLL}).`);
  }
  questions.forEach((q, idx) => {
    if (!q.text || q.text.trim().length === 0) {
      throw new Error(`Question ${idx + 1}: text is required.`);
    }
    if (q.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new Error(`Question ${idx + 1}: exceeds maximum length of ${MAX_QUESTION_TEXT_LENGTH} characters.`);
    }
    if (q.options && Array.isArray(q.options)) {
      if (q.options.length > MAX_OPTIONS_PER_QUESTION) {
        throw new Error(`Question ${idx + 1}: exceeds maximum number of options (${MAX_OPTIONS_PER_QUESTION}).`);
      }
      q.options.forEach((opt, oidx) => {
        if (opt.length > MAX_OPTION_TEXT_LENGTH) {
          throw new Error(`Question ${idx + 1}, Option ${oidx + 1}: exceeds maximum length of ${MAX_OPTION_TEXT_LENGTH} characters.`);
        }
      });
    }
  });
}

async function checkPollCreationRateLimit(userId) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  if (!pollCreationTracker[userId]) {
    pollCreationTracker[userId] = [];
  }

  pollCreationTracker[userId] = pollCreationTracker[userId].filter(entry => entry.timestamp > dayAgo);

  if (pollCreationTracker[userId].length >= MAX_POLLS_PER_USER_PER_DAY) {
    throw new Error(`Rate limit: You can create a maximum of ${MAX_POLLS_PER_USER_PER_DAY} polls per day.`);
  }

  pollCreationTracker[userId].push({ timestamp: now });
}

async function checkNotificationRateLimit(userId) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  if (!notificationTracker[userId]) {
    notificationTracker[userId] = [];
  }

  notificationTracker[userId] = notificationTracker[userId].filter(entry => entry.timestamp > hourAgo);

  if (notificationTracker[userId].length >= MAX_NOTIFICATIONS_PER_USER_PER_HOUR) {
    return false; // User has hit limit for this hour
  }

  notificationTracker[userId].push({ timestamp: now });
  return true;
}

async function sendCloseNotifications(client, poll) {
  const notifyUsers = (poll.notifyOnClose || []).slice(0, MAX_NOTIFY_SUBSCRIBERS_PER_POLL);
  if (!notifyUsers.length) return;
  await Promise.allSettled(notifyUsers.map(async uid => {
    try {
      const allowed = await checkNotificationRateLimit(uid);
      if (!allowed) return; // User has hit their hourly notification limit
      const dm = await client.conversations.open({ users: uid });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text: `🔒 Poll closed: *${poll.title}*`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `🔒 The poll *${poll.title}* has been closed.` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Created by <@${poll.creator}>  ·  ID: \`${poll.id}\`` }] }
        ]
      });
    } catch (e) { console.error('notify error:', e.message); }
  }));
}

// ==================== APP SETUP ====================

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });

const app = new App({
  receiver,
  authorize: async ({ teamId, enterpriseId }) => {
    const id = teamId || enterpriseId;
    const { rows } = await pool.query(
      'SELECT data FROM slack_installations WHERE team_id = $1', [id]
    );
    if (rows.length) {
      const d = JSON.parse(rows[0].data);
      return { botToken: d.access_token, botUserId: d.bot_user_id };
    }
    if (process.env.SLACK_BOT_TOKEN) {
      return { botToken: process.env.SLACK_BOT_TOKEN };
    }
    throw new Error('No installation found. Please install the bot first.');
  }
});

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

function isCreatorOrAdmin(poll, userId) {
  return poll.creator === userId || (poll.coCreators || []).includes(userId);
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

function getTypeIcon(type) {
  return QUESTION_TYPE_ICONS[type] || '❓';
}

function parseOptions(raw) {
  const sep = raw.includes('\n') ? '\n' : ',';
  return raw.split(sep).map(o => o.trim()).filter(Boolean);
}

// ==================== MODAL BUILDERS ====================

// Grouped options for question type picker (Hick's Law — scannable categories)
const QUESTION_TYPE_GROUPS = [
  {
    label: { type: 'plain_text', text: 'Basic' },
    options: [
      { text: { type: 'plain_text', text: '📋 Multiple choice' }, value: 'multiple_choice' },
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

function questionFormBlocks(qNum, questionType = 'multiple_choice', restore = {}) {
  const needsOptions = !AUTO_OPTION_TYPES.includes(questionType);

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
        option_groups: QUESTION_TYPE_GROUPS,
        initial_option: findTypeOption(questionType)
      }
    }
  ];

  if (needsOptions) {
    const isLikert  = questionType === 'likert';
    const isRanking = questionType === 'ranking';
    const optLabel  = isLikert  ? 'Statements to rate (one per line)'
                    : isRanking ? 'Items to rank (one per line)'
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
      optional: false,
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

  // Only show multi-select for applicable types
  const multiSelectApplicable = !['open_ended', 'yes_no', 'agree_disagree', 'scale_5', 'scale_10', 'nps', 'likert', 'ranking'].includes(questionType);
  if (multiSelectApplicable) {
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
  }

  return blocks;
}

function buildQuestionModal(meta, currentType = 'multiple_choice', restore = {}, errorMsg = null) {
  const { savedQuestions = [], editingIndex } = meta;
  const isEditing = editingIndex !== undefined && editingIndex !== null;
  const qNum = savedQuestions.length + 1;

  const addButton = isEditing ? [] : [
    { type: 'divider' },
    {
      type: 'actions',
      block_id: 'question_actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '＋  Add another question' },
        action_id: 'add_another_question'
      }]
    }
  ];

  return {
    type: 'modal',
    callback_id: 'question_submit',
    title: { type: 'plain_text', text: isEditing ? 'Edit Question' : 'Add Question' },
    submit: { type: 'plain_text', text: isEditing ? 'Save Changes' : 'Continue →' },
    close: { type: 'plain_text', text: '← Back' },
    notify_on_close: true,
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(savedQuestions.length > 0 && !isEditing ? [
        ...savedQuestionsBlocks(savedQuestions),
        { type: 'section', text: { type: 'mrkdwn', text: '*Add another question:*' } }
      ] : []),
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      ...questionFormBlocks(qNum, currentType, restore),
      ...addButton
    ]
  };
}

function buildSuccessModal(pollTitle) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Poll Created!' },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *${pollTitle || 'Your poll'}* has been posted to the channel.` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Head back to the chat to see it and start collecting votes.' }] }
    ]
  };
}

const SHOW_RESULTS_OPTIONS = [
  { text: { type: 'plain_text', text: 'In real-time' },       value: 'realtime' },
  { text: { type: 'plain_text', text: 'After poll closes' },  value: 'on_close' },
  { text: { type: 'plain_text', text: 'Only to creator' },    value: 'creator_only' }
];

function buildCreationModal(meta, errorMsg = null) {
  const {
    pollTitle = '', pollDescription = '', pollSettings = [],
    closeAt, showResults = 'creator_only', orderByVotes = false
  } = meta;

  const settingsOptions = [
    { text: { type: 'mrkdwn', text: '*Anonymous* — hide who voted for what' }, value: 'anonymous' },
    { text: { type: 'mrkdwn', text: '*Allow vote changes* — voters can update their choice' }, value: 'allow_revote' }
  ];
  const activeSettings = pollSettings.filter(v => settingsOptions.some(o => o.value === v));
  const orderOpt = [{ text: { type: 'mrkdwn', text: '*Yes* — sort options by vote count' }, value: 'yes' }];

  return {
    type: 'modal',
    callback_id: 'poll_submit',
    title: { type: 'plain_text', text: 'Create Poll' },
    submit: { type: 'plain_text', text: meta.savedQuestions?.length ? `＋  Add Questions  (${meta.savedQuestions.length} added)` : '＋  Add Questions' },
    close: { type: 'plain_text', text: 'Cancel' },
    notify_on_close: true,
    private_metadata: JSON.stringify(meta),
    blocks: [
      ...(errorMsg ? [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` } }] : []),
      // ── Questions summary (progressive disclosure) ────
      ...((meta.savedQuestions?.length) ? [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Questions added (${meta.savedQuestions.length}):*\n` +
              meta.savedQuestions.map((q, i) => `${i + 1}. ${getTypeIcon(q.type)} ${q.text}`).join('\n')
          }
        },
        { type: 'divider' }
      ] : []),
      // ── Content ──────────────────────────────────────
      {
        type: 'input', block_id: 'poll_title',
        label: { type: 'plain_text', text: 'Poll title' },
        element: {
          type: 'plain_text_input', action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Give your poll a name...' },
          ...(pollTitle ? { initial_value: pollTitle } : {})
        }
      },
      {
        type: 'input', block_id: 'poll_description',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
        hint: { type: 'plain_text', text: 'Supports *bold*, _italic_, and `code` formatting' },
        element: {
          type: 'plain_text_input', action_id: 'value', multiline: true,
          placeholder: { type: 'plain_text', text: 'Add context or instructions (optional)...' },
          ...(pollDescription ? { initial_value: pollDescription } : {})
        }
      },
      // ── Privacy & Voting ──────────────────────────────
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Privacy & Voting*' } },
      {
        type: 'input', block_id: 'poll_settings',
        label: { type: 'plain_text', text: 'Options' },
        optional: true,
        element: {
          type: 'checkboxes', action_id: 'value',
          options: settingsOptions,
          ...(activeSettings.length ? { initial_options: activeSettings.map(v => settingsOptions.find(o => o.value === v)) } : {})
        }
      },
      // ── Results ───────────────────────────────────────
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Results*' } },
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
        label: { type: 'plain_text', text: 'Sort by most votes' },
        optional: true,
        element: {
          type: 'checkboxes', action_id: 'value',
          options: orderOpt,
          ...(orderByVotes ? { initial_options: orderOpt } : {})
        }
      },
      // ── Schedule ──────────────────────────────────────
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Schedule*' } },
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
          initial_value: poll.title
        }
      },
      {
        type: 'input', block_id: 'edit_description',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
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
        text: `*${i + 1}.* ${q.text}\n_${getTypeIcon(q.type)} ${getTypeLabel(q.type)}${q.allowMultiple ? ' · multi-select' : ''}${q.type !== 'open_ended' && q.options.length ? '  —  ' + q.options.slice(0, 4).join(', ') + (q.options.length > 4 ? '…' : '') : ''}_`
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
        text: `*${i + 1}. ${q.text}*\n_${getTypeIcon(q.type)} ${getTypeLabel(q.type)}${q.allowMultiple ? ' · multi-select' : ''}_`
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
    submit: { type: 'plain_text', text: '🚀  Post Poll' },
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
        elements: [{ type: 'mrkdwn', text: `${savedQuestions.length} question${savedQuestions.length === 1 ? '' : 's'} · Click *🚀 Post Poll* to publish` }]
      }
    ]
  };
}

function buildVoteModal(poll, previousVotes = {}) {
  const hasVoted = Object.keys(previousVotes).length > 0;
  const questionBlocks = poll.questions.flatMap((q, qi) => {
    const prev = previousVotes[qi] || [];
    const label = `${getTypeIcon(q.type)}  ${qi + 1}. ${q.text}`;

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
      return [{
        type: 'input',
        block_id: `vote_q${qi}`,
        label: { type: 'plain_text', text: label },
        hint: { type: 'plain_text', text: 'Select all that apply' },
        element: {
          type: 'checkboxes',
          action_id: 'selected',
          options: q.options.map((opt, oi) => ({ text: { type: 'mrkdwn', text: opt }, value: String(oi) })),
          ...(prev.length ? { initial_options: prev.map(oi => ({ text: { type: 'mrkdwn', text: q.options[oi] }, value: String(oi) })) } : {})
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
        options: q.options.map((opt, oi) => ({ text: { type: 'plain_text', text: opt }, value: String(oi) })),
        ...(prev.length ? { initial_option: { text: { type: 'plain_text', text: q.options[prev[0]] }, value: String(prev[0]) } } : {})
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
      { type: 'header', text: { type: 'plain_text', text: poll.title } },
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

// ==================== POLL DISPLAY ====================

function pollProgressBar(count, total, width = 16) {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((count / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildQuestionResultBlock(q, qi, poll) {
  const qVotes = poll.votes[qi] || {};

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
          text: `${getTypeIcon(q.type)}  *${qi + 1}. ${q.text}*\n_${count} response${count !== 1 ? 's' : ''}_\n${body}`
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
      { type: 'section', text: { type: 'mrkdwn', text: `${getTypeIcon(q.type)}  *${qi + 1}. ${q.text}*` } },
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
      { type: 'section', text: { type: 'mrkdwn', text: `${getTypeIcon(q.type)}  *${qi + 1}. ${q.text}*\n_${allRankings.length} response${allRankings.length !== 1 ? 's' : ''}_` } },
      ...optBlocks,
      { type: 'divider' }
    ];
  }

  const isClosed = poll.status === 'closed';
  if (poll.showResults === 'on_close' && !isClosed) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*\n_Results visible after poll closes_` } },
      { type: 'divider' }
    ];
  }
  if (poll.showResults === 'creator_only' && !isClosed) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*\n_Results visible only to the creator_` } },
      { type: 'divider' }
    ];
  }

  const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
  const maxVotes   = totalVotes === 0 ? 0 : Math.max(...Object.values(qVotes).map(v => v.length));
  const typeHint   = `${getTypeIcon(q.type)} _${getTypeLabel(q.type)}${q.allowMultiple ? ' · multi-select' : ''}${totalVotes > 0 ? `  ·  ${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` : ''}_`;

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
      }
    };
  });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*\n${typeHint}` } },
    ...optionBlocks,
    { type: 'divider' }
  ];
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

  const hasAnyVotes = participants > 0;

  const voteLabel = hasAnyVotes && poll.allowRevote
    ? '🔄  Change Vote'
    : participants > 0
      ? `🗳️  Vote  ·  ${participants} voted`
      : '🗳️  Vote';

  // Closed poll: view results + share; Active poll: vote + share
  const actionButtons = isClosed
    ? [
        { type: 'button', text: { type: 'plain_text', text: '📊  View Results', emoji: true }, style: 'primary', action_id: 'view_results_modal', value: poll.id },
        { type: 'button', text: { type: 'plain_text', text: '📤  Share Results', emoji: true }, action_id: 'share_poll', value: poll.id }
      ]
    : [
        {
          type: 'button',
          text: { type: 'plain_text', text: voteLabel, emoji: true },
          style: 'primary',
          action_id: 'open_vote_modal',
          value: poll.id
        },
        { type: 'button', text: { type: 'plain_text', text: '📤  Share', emoji: true }, action_id: 'share_poll', value: poll.id }
      ];

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊  ${poll.title}`, emoji: true } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusParts.join('  ·  ') }] },
    { type: 'divider' },
    ...questions.flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll)),
    { type: 'actions', elements: actionButtons },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Created by <@${poll.creator}>  ·  ID: \`${poll.id}\`  ·  \`/poll-share ${poll.id}\`  ·  \`/poll-export ${poll.id}\``
      }]
    }
  ];
}

function buildShareModal(poll) {
  const totalParticipants = getAllVoters(poll).size;

  return {
    type: 'modal',
    callback_id: 'share_poll_submit',
    title: { type: 'plain_text', text: 'Share Poll' },
    submit: { type: 'plain_text', text: '📤  Post to Channel' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${poll.title}*\n_${poll.questions.length} question${poll.questions.length !== 1 ? 's' : ''}  ·  ${totalParticipants} participant${totalParticipants !== 1 ? 's' : ''}_`
        }
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'share_channel',
        label: { type: 'plain_text', text: 'Post to channel' },
        element: {
          type: 'conversations_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Choose a channel...' },
          filter: { include: ['public', 'private', 'im', 'mpim'], exclude_bot_users: true }
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'Votes cast from any channel count toward the same poll.'
        }]
      }
    ]
  };
}

function buildResultsBlocks(poll, heading) {
  const participants = getAllVoters(poll).size;
  return [
    { type: 'header', text: { type: 'plain_text', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants === 1 ? '' : 's'}  ·  Created by <@${poll.creator}>${poll.anonymous ? '  ·  🔒 Anonymous' : ''}` }] },
    { type: 'divider' },
    ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll))
  ];
}

async function updatePollMessage(client, poll) {
  const refs = poll.messageRefs?.length
    ? poll.messageRefs
    : (poll.channelId && poll.messageTs ? [{ channelId: poll.channelId, messageTs: poll.messageTs }] : []);
  const blocks = buildPollBlocks(poll);
  await Promise.allSettled(refs.map(({ channelId, messageTs }) =>
    client.chat.update({ channel: channelId, ts: messageTs, text: `📊 ${poll.title}`, blocks })
  ));
}

function buildPostVoteModal(poll) {
  const participants = getAllVoters(poll).size;
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '✅ Vote Recorded' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Your vote has been recorded for *${poll.title}*!` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants !== 1 ? 's' : ''} so far` }] },
      { type: 'divider' },
      ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, { ...poll, showResults: 'realtime' }))
    ]
  };
}

// ==================== POLL CREATION HELPER ====================

async function createAndPostPoll(client, meta) {
  const { channelId, userId, savedQuestions, pollTitle, pollDescription, pollSettings = [], closeAt, showResults = 'creator_only', orderByVotes = false } = meta;

  // Rate limiting check
  await checkPollCreationRateLimit(userId);

  // Input validation
  const title = (pollTitle || savedQuestions[0]?.text || '').trim();
  const description = (pollDescription || '').trim();
  validatePollInputs(title, description, savedQuestions);

  const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  const votes = {};
  savedQuestions.forEach((q, qi) => {
    if (q.type === 'open_ended' || q.type === 'ranking') {
      votes[qi] = {};
    } else if (q.type === 'likert') {
      votes[qi] = {};
    } else {
      votes[qi] = Object.fromEntries(q.options.map((_, oi) => [oi, []]));
    }
  });

  const poll = {
    id: pollId,
    title,
    description,
    questions: savedQuestions,
    votes,
    anonymous: pollSettings.includes('anonymous'),
    allowRevote: pollSettings.includes('allow_revote'),
    creator: userId,
    channelId,
    closeAt: closeAt || null,
    showResults,
    orderByVotes,
    voteTimestamps: {},
    notifyOnClose: [],
    coCreators: [],
    status: 'active'
  };

  await savePoll(poll);
  const channel = await resolveChannel(client, channelId, userId);
  const result = await client.chat.postMessage({
    channel,
    text: `📊 ${poll.title}`,
    blocks: buildPollBlocks(poll)
  });
  poll.messageTs = result.ts;
  poll.channelId = channel;
  poll.messageRefs = [{ channelId: channel, messageTs: result.ts }];
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
  const closeAtRaw = values.poll_close_at?.value?.selected_date_time;
  return {
    pollTitle:       (values.poll_title?.value?.value       ?? meta.pollTitle       ?? '').trim(),
    pollDescription: (values.poll_description?.value?.value ?? meta.pollDescription ?? '').trim(),
    pollSettings:    values.poll_settings?.value?.selected_options?.map(o => o.value) ?? meta.pollSettings ?? [],
    closeAt:         closeAtRaw ? new Date(closeAtRaw * 1000).toISOString() : (meta.closeAt || null),
    showResults:     values.poll_show_results?.value?.selected_option?.value ?? meta.showResults ?? 'creator_only',
    orderByVotes:    (values.poll_order_by_votes?.value?.selected_options?.length ?? 0) > 0 || (meta.orderByVotes ?? false)
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
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-results POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    await client.chat.postMessage({ channel, text: `📊 Results: ${poll.title}`, blocks: buildResultsBlocks(poll, 'Poll Results') });
  } catch (err) {
    console.error('/poll-results error:', err);
    await notifyError(client, body.user_id, `❌ /poll-results failed: ${err.message}`);
  }
});

app.command('/poll-share', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-share POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    await client.chat.postMessage({ channel, text: `📊 Current results: ${poll.title}`, blocks: buildResultsBlocks(poll, 'Current Results') });
  } catch (err) {
    console.error('/poll-share error:', err);
    await notifyError(client, body.user_id, `❌ /poll-share failed: ${err.message}`);
  }
});

app.command('/polls-list', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const polls = await getAllPolls('active');
    if (!polls.length) return client.chat.postEphemeral({ channel, user: userId, text: '📭 No active polls right now. Use `/polls-archive` to see closed polls.' });
    const listBlocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Active Polls' } },
      ...polls.map((p, i) => {
        const participants = getAllVoters(p).size;
        const tags = [
          `${p.questions.length} question${p.questions.length !== 1 ? 's' : ''}`,
          `${participants} participant${participants !== 1 ? 's' : ''}`,
          ...(p.anonymous   ? ['🔒 Anonymous'] : []),
          ...(p.allowRevote ? ['🔄 Revote on'] : []),
          ...(p.closeAt     ? [`⏰ Closes ${new Date(p.closeAt).toLocaleString()}`] : [])
        ];
        return {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${i + 1}. ${p.title}*\nID: \`${p.id}\`  ·  ${tags.join('  ·  ')}` }
        };
      })
    ];
    await client.chat.postEphemeral({ channel, user: userId, text: `${polls.length} active poll${polls.length !== 1 ? 's' : ''}`, blocks: listBlocks });
  } catch (err) {
    console.error('/polls-list error:', err);
    await notifyError(client, body.user_id, `❌ /polls-list failed: ${err.message}`);
  }
});

app.command('/polls-archive', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const polls = await getAllPolls('closed');
    if (!polls.length) return client.chat.postEphemeral({ channel, user: userId, text: '📭 No closed polls yet.' });
    const listBlocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Closed Polls' } },
      ...polls.slice(0, 20).map((p, i) => {
        const participants = getAllVoters(p).size;
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${i + 1}. ${p.title}*\nID: \`${p.id}\`  ·  ${participants} participant${participants !== 1 ? 's' : ''}  ·  ${p.questions.length} question${p.questions.length !== 1 ? 's' : ''}  ·  Created by <@${p.creator}>`
          }
        };
      }),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Use \`/poll-results POLL_ID\` to view full results` }] }
    ];
    await client.chat.postEphemeral({ channel, user: userId, text: `${polls.length} closed poll${polls.length !== 1 ? 's' : ''}`, blocks: listBlocks });
  } catch (err) {
    console.error('/polls-archive error:', err);
    await notifyError(client, body.user_id, `❌ /polls-archive failed: ${err.message}`);
  }
});

app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-close POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    if (!isCreatorOrAdmin(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can close this poll.' });
    if (poll.status === 'closed') return client.chat.postEphemeral({ channel, user: userId, text: '⚠️ This poll is already closed.' });

    const participants = getAllVoters(poll).size;
    // Require confirmation when votes exist (error prevention)
    if (participants > 0) {
      return client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'poll_close_confirm',
          title: { type: 'plain_text', text: 'Close Poll?' },
          submit: { type: 'plain_text', text: '🔒  Close Poll' },
          close: { type: 'plain_text', text: 'Cancel' },
          private_metadata: JSON.stringify({ pollId, channelId: channel }),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Are you sure you want to close *${poll.title}*?\n\n*${participants}* participant${participants !== 1 ? 's have' : ' has'} voted. This cannot be undone.`
              }
            },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Closing the poll will notify opted-in participants and post final results.' }] }
          ]
        }
      });
    }

    await closePoll(pollId);
    const closedPoll = { ...poll, status: 'closed' };
    await updatePollMessage(client, closedPoll);
    await client.chat.postMessage({ channel, text: `🔒 Poll closed: ${poll.title}`, blocks: buildResultsBlocks(closedPoll, '🔒 Final Results') });
    await sendCloseNotifications(client, closedPoll);
  } catch (err) {
    console.error('/poll-close error:', err);
    await notifyError(client, body.user_id, `❌ /poll-close failed: ${err.message}`);
  }
});

app.command('/poll-edit', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-edit POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    if (!isCreatorOrAdmin(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can edit this poll.' });
    await client.views.open({ trigger_id: body.trigger_id, view: buildEditModal(poll) });
  } catch (err) {
    console.error('/poll-edit error:', err);
    await notifyError(client, body.user_id, `❌ /poll-edit failed: ${err.message}`);
  }
});

app.command('/poll-export', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-export POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });

    const esc = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Question', 'Type', 'Option / Statement', 'Votes / Response', 'Percentage', 'Voted At']];

    poll.questions.forEach((q, qi) => {
      const qVotes = poll.votes[qi] || {};
      if (q.type === 'open_ended') {
        Object.entries(qVotes).forEach(([uid, text]) => {
          const ts = poll.voteTimestamps?.[uid] || '';
          rows.push([q.text, getTypeLabel(q.type), poll.anonymous ? '(anonymous)' : uid, text, '', ts]);
        });
        if (!Object.keys(qVotes).length) rows.push([q.text, getTypeLabel(q.type), '(no responses)', '', '', '']);
      } else if (q.type === 'ranking') {
        const allRankings = Object.values(qVotes);
        q.options.forEach((opt, oi) => {
          const ranks = allRankings.map(r => parseInt((r || '').split(',')[oi])).filter(n => !isNaN(n) && n > 0);
          const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2) : 'N/A';
          rows.push([q.text, getTypeLabel(q.type), opt, `avg rank: ${avg}`, '', '']);
        });
      } else if (q.type === 'likert') {
        q.options.forEach((stmt, si) => {
          const ratings = qVotes[si] || {};
          const total = Object.values(ratings).reduce((s, v) => s + v.length, 0);
          LIKERT_SCALE.forEach(({ label, value }) => {
            const cnt = (ratings[value] || []).length;
            const pct = total === 0 ? 0 : Math.round((cnt / total) * 100);
            rows.push([q.text, getTypeLabel(q.type), `${stmt} — ${label}`, cnt, `${pct}%`, '']);
          });
        });
      } else {
        const total = Object.values(qVotes).reduce((s, v) => s + v.length, 0);
        q.options.forEach((opt, oi) => {
          const voters = qVotes[oi] || [];
          const pct = total === 0 ? 0 : Math.round((voters.length / total) * 100);
          rows.push([q.text, getTypeLabel(q.type), opt, voters.length, `${pct}%`, '']);
        });
      }
    });

    const csv = rows.map(r => r.map(esc).join(',')).join('\n');
    await client.files.uploadV2({
      channel_id: channel,
      filename: `${poll.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}_results.csv`,
      content: csv,
      title: `Results: ${poll.title}`,
      initial_comment: `📊 Export for poll: *${poll.title}*  ·  ID: \`${poll.id}\``
    });
  } catch (err) {
    console.error('/poll-export error:', err);
    await notifyError(client, body.user_id, `❌ /poll-export failed: ${err.message}`);
  }
});

// ==================== MAIN MODAL ACTIONS ====================

app.action('question_action', async ({ ack, body, client }) => {
  await ack();
  const meta = JSON.parse(body.view.private_metadata);
  const [action, idxStr] = body.actions[0].selected_option.value.split(':');
  const idx = parseInt(idxStr);
  let qs = [...meta.savedQuestions];

  if (action === 'edit') {
    const q = qs[idx];
    qs.splice(idx, 1);
    const editMeta = { ...meta, savedQuestions: qs, editingIndex: idx, questionPageViewId: body.view.id };
    try {
      await client.views.push({
        trigger_id: body.trigger_id,
        view: buildQuestionModal(editMeta, q.type, {
          text: q.text,
          options: ['multiple_choice', 'likert', 'ranking'].includes(q.type) ? q.options.join('\n') : '',
          allowMultiple: q.allowMultiple
        })
      });
    } catch (err) { console.error('edit push error:', err); }
    return;
  }

  switch (action) {
    case 'duplicate': qs.splice(idx + 1, 0, { ...qs[idx] }); break;
    case 'move_up':   if (idx > 0) [qs[idx - 1], qs[idx]] = [qs[idx], qs[idx - 1]]; break;
    case 'move_down': if (idx < qs.length - 1) [qs[idx], qs[idx + 1]] = [qs[idx + 1], qs[idx]]; break;
    case 'delete':    qs.splice(idx, 1); break;
  }

  const updatedMeta = { ...meta, savedQuestions: qs };
  await client.views.update({ view_id: body.view.id, view: buildQuestionModal(updatedMeta) });
  try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (_) {}
});

// ==================== QUESTION MODAL ACTIONS ====================

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

  await client.views.update({ view_id: body.view.id, view: buildQuestionModal(updatedMeta) });
  try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (_) {}
});

// ==================== VIEW SUBMISSIONS ====================

app.view('poll_submit', async ({ ack, body, view }) => {
  const meta = JSON.parse(view.private_metadata);
  const values = view.state.values;
  const settings = readMainModalSettings(values, meta);
  const mergedMeta = { ...meta, ...settings };

  await ack({
    response_action: 'push',
    view: buildQuestionModal(mergedMeta)
  });
});

app.view('question_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const values = view.state.values;
  const qNum = meta.savedQuestions.length + 1;
  const isEditing = meta.editingIndex !== undefined && meta.editingIndex !== null;
  const { text, type, optionsRaw, allowMultiple } = readCurrentQuestion(values, qNum);

  if (!text && !isEditing) {
    if (!meta.savedQuestions?.length) {
      return await ack({ response_action: 'errors', errors: { [`q_text_${qNum}`]: 'Please enter a question.' } });
    }
    return await ack({ response_action: 'push', view: buildPreviewModal(meta) });
  }

  if (text) {
    if (!AUTO_OPTION_TYPES.includes(type) && parseOptions(optionsRaw).length < 2) {
      return await ack({ response_action: 'errors', errors: { [`q_options_${qNum}`]: 'Please enter at least 2 options.' } });
    }
  }

  const newQ = text ? buildQuestion(text, type, optionsRaw, allowMultiple) : null;
  let updatedQuestions = [...meta.savedQuestions];
  if (isEditing && newQ) {
    updatedQuestions.splice(meta.editingIndex, 0, newQ);
  } else if (newQ) {
    updatedQuestions.push(newQ);
  }

  if (!updatedQuestions.length) {
    return await ack({ response_action: 'errors', errors: { [`q_text_${qNum}`]: 'Please add at least one question.' } });
  }

  const updatedMeta = { ...meta, savedQuestions: updatedQuestions, editingIndex: null };

  if (isEditing) {
    await ack();
    const questionPageViewId = meta.questionPageViewId;
    if (questionPageViewId) {
      try { await client.views.update({ view_id: questionPageViewId, view: buildQuestionModal(updatedMeta) }); } catch (_) {}
    }
    try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (_) {}
  } else {
    await ack({ response_action: 'push', view: buildPreviewModal(updatedMeta) });
  }
});

app.view('poll_preview_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  try {
    await createAndPostPoll(client, meta);
    const title = meta.pollTitle || meta.savedQuestions[0]?.text || 'Poll';
    await ack({ response_action: 'update', view: buildSuccessModal(title) });
  } catch (err) {
    console.error('poll_preview_submit error:', err);
    await ack();
    const errorMsg = err.message || 'Failed to create poll.';
    await notifyError(client, meta.userId, `❌ ${errorMsg}`);
  }
});

app.view('poll_edit_submit', async ({ ack, body, view, client }) => {
  const { pollId } = JSON.parse(view.private_metadata);
  const values = view.state.values;
  const newTitle = (values.edit_title?.value?.value || '').trim();
  const newDesc  = (values.edit_description?.value?.value || '').trim();

  if (!newTitle) {
    return await ack({ response_action: 'errors', errors: { edit_title: 'Title is required.' } });
  }
  if (newTitle.length > MAX_POLL_TITLE_LENGTH) {
    return await ack({ response_action: 'errors', errors: { edit_title: `Title exceeds maximum length of ${MAX_POLL_TITLE_LENGTH} characters.` } });
  }
  if (newDesc.length > MAX_POLL_DESCRIPTION_LENGTH) {
    return await ack({ response_action: 'errors', errors: { edit_description: `Description exceeds maximum length of ${MAX_POLL_DESCRIPTION_LENGTH} characters.` } });
  }

  try {
    const poll = await getPoll(pollId);
    if (!poll) { await ack(); return; }
    const updated = { ...poll, title: newTitle, description: newDesc };
    await savePoll(updated);
    await updatePollMessage(client, updated);
    await ack({ response_action: 'update', view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Poll Updated' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${newTitle}* has been updated.` } }]
    }});
  } catch (err) {
    console.error('poll_edit_submit error:', err);
    await ack();
  }
});

app.action('share_poll', async ({ ack, body, client, action }) => {
  await ack();
  try {
    const poll = await getPoll(action.value);
    if (!poll) return;
    await client.views.open({ trigger_id: body.trigger_id, view: buildShareModal(poll) });
  } catch (err) {
    console.error('share_poll error:', err);
  }
});

app.view('share_poll_submit', async ({ ack, body, view, client }) => {
  await ack();
  const { pollId } = JSON.parse(view.private_metadata);
  const channelId = view.state.values.share_channel?.value?.selected_conversation;
  if (!channelId) return;

  try {
    const poll = await getPoll(pollId);
    if (!poll) return;
    const result = await client.chat.postMessage({
      channel: channelId,
      text: `📊 ${poll.title}`,
      blocks: buildPollBlocks(poll)
    });
    const updatedRefs = [...(poll.messageRefs || []), { channelId, messageTs: result.ts }];
    await pool.query('UPDATE polls SET message_refs=$1 WHERE id=$2', [JSON.stringify(updatedRefs), pollId]);
  } catch (err) {
    console.error('share_poll_submit error:', err);
    await notifyError(client, body.user.id, `❌ Failed to share poll: ${err.message}`);
  }
});

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
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '🔒 This poll is no longer accepting votes.' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Use \`/poll-results ${poll.id}\` to view the final results.` }] }
        ]
      }
    });
  }

  const userId = body.user.id;
  const previousVotes = {};
  poll.questions.forEach((q, qi) => {
    const qv = poll.votes[qi] || {};
    if (q.type === 'open_ended') {
      if (qv[userId]) previousVotes[qi] = [qv[userId]];
    } else if (q.type === 'ranking' || q.type === 'likert') {
      if (qv[userId] || Object.values(qv).some(r => typeof r === 'object' && Object.values(r).some(v => v.includes && v.includes(userId)))) {
        previousVotes[qi] = true;
      }
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
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '✅ You have already submitted your vote for this poll.' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Vote changes are not allowed for this poll.' }] }
        ]
      }
    });
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildVoteModal(poll, hasVoted ? previousVotes : {})
  });
});

app.view('vote_submit', async ({ ack, body, view, client }) => {
  const { pollId } = JSON.parse(view.private_metadata);
  const userId = body.user.id;
  const values = view.state.values;
  const wantsNotify = (values.vote_notify?.value?.selected_options || []).some(o => o.value === 'notify');

  const dbClient = await pool.connect();
  let finalPoll = null;
  try {
    await dbClient.query('BEGIN');
    const { rows } = await dbClient.query('SELECT * FROM polls WHERE id=$1 FOR UPDATE', [pollId]);

    if (!rows.length || rows[0].status === 'closed') {
      await dbClient.query('ROLLBACK');
      await ack();
      return;
    }

    const poll = rowToPoll(rows[0]);

    if (poll.closeAt && new Date() >= new Date(poll.closeAt)) {
      await dbClient.query("UPDATE polls SET status='closed' WHERE id=$1", [pollId]);
      await dbClient.query('COMMIT');
      await ack();
      await updatePollMessage(client, { ...poll, status: 'closed' });
      await sendCloseNotifications(client, { ...poll, status: 'closed' });
      return;
    }

    const hasVoted = poll.questions.some((q, qi) => {
      const qv = poll.votes[qi] || {};
      if (q.type === 'open_ended' || q.type === 'ranking') return !!qv[userId];
      if (q.type === 'likert') return Object.values(qv).some(r => typeof r === 'object' && Object.values(r).some(v => Array.isArray(v) && v.includes(userId)));
      return Object.values(qv).some(v => Array.isArray(v) && v.includes(userId));
    });

    if (hasVoted && !poll.allowRevote) {
      await dbClient.query('ROLLBACK');
      await ack();
      return;
    }

    if (hasVoted) {
      poll.questions.forEach((q, qi) => {
        if (q.type === 'open_ended' || q.type === 'ranking') {
          delete poll.votes[qi][userId];
        } else if (q.type === 'likert') {
          Object.values(poll.votes[qi] || {}).forEach(ratings => {
            Object.keys(ratings).forEach(ri => { ratings[ri] = (ratings[ri] || []).filter(id => id !== userId); });
          });
        } else {
          Object.keys(poll.votes[qi] || {}).forEach(oi => {
            poll.votes[qi][oi] = (poll.votes[qi][oi] || []).filter(id => id !== userId);
          });
        }
      });
    }

    const voteTimestamps = poll.voteTimestamps || {};
    voteTimestamps[userId] = new Date().toISOString();

    poll.questions.forEach((q, qi) => {
      if (q.type === 'likert') {
        if (!poll.votes[qi]) poll.votes[qi] = {};
        q.options.forEach((_, si) => {
          const block = values[`vote_q${qi}_s${si}`];
          const rating = block?.rating?.selected_option?.value;
          if (rating !== undefined) {
            if (!poll.votes[qi][si]) poll.votes[qi][si] = {};
            if (!poll.votes[qi][si][rating]) poll.votes[qi][si][rating] = [];
            poll.votes[qi][si][rating].push(userId);
          }
        });
        return;
      }
      if (q.type === 'ranking') {
        const ranks = q.options.map((_, oi) => values[`vote_q${qi}_r${oi}`]?.rank?.selected_option?.value || '0');
        poll.votes[qi][userId] = ranks.join(',');
        return;
      }
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

    // Update notification preference
    const notifyList = new Set(poll.notifyOnClose || []);
    if (wantsNotify) notifyList.add(userId);
    else notifyList.delete(userId);
    poll.notifyOnClose = [...notifyList];

    await dbClient.query(
      'UPDATE polls SET votes=$1, vote_timestamps=$2, notify_on_close=$3 WHERE id=$4',
      [JSON.stringify(poll.votes), JSON.stringify(voteTimestamps), JSON.stringify(poll.notifyOnClose), pollId]
    );
    await dbClient.query('COMMIT');
    poll.voteTimestamps = voteTimestamps;
    finalPoll = poll;
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('vote_submit transaction error:', err.message);
    await ack();
    return;
  } finally {
    dbClient.release();
  }

  await ack({ response_action: 'update', view: buildPostVoteModal(finalPoll) });
  await updatePollMessage(client, finalPoll);
});

// "📊 View Results" button on closed poll message
app.action('view_results_modal', async ({ ack, body, client, action }) => {
  await ack();
  try {
    const poll = await getPoll(action.value);
    if (!poll) return;
    const participants = getAllVoters(poll).size;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Poll Results' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: poll.title } },
          ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
          { type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 Closed  ·  *${participants}* participant${participants !== 1 ? 's' : ''}  ·  Created by <@${poll.creator}>` }] },
          { type: 'divider' },
          ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll))
        ]
      }
    });
  } catch (err) {
    console.error('view_results_modal error:', err);
  }
});

// Confirmation modal for /poll-close when votes exist
app.view('poll_close_confirm', async ({ ack, body, view, client }) => {
  await ack();
  const { pollId, channelId } = JSON.parse(view.private_metadata);
  try {
    const poll = await getPoll(pollId);
    if (!poll || poll.status === 'closed') return;
    await closePoll(pollId);
    const closedPoll = { ...poll, status: 'closed' };
    await updatePollMessage(client, closedPoll);
    await client.chat.postMessage({ channel: channelId, text: `🔒 Poll closed: ${poll.title}`, blocks: buildResultsBlocks(closedPoll, '🔒 Final Results') });
    await sendCloseNotifications(client, closedPoll);
  } catch (err) {
    console.error('poll_close_confirm error:', err);
    await notifyError(client, body.user.id, `❌ Failed to close poll: ${err.message}`);
  }
});

// ==================== HEALTH CHECK ====================

receiver.router.get('/', (req, res) => res.send('Slack Poll Bot is running ✓'));
receiver.router.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

receiver.router.get('/slack/oauth_redirect', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`❌ OAuth error: ${error}`);
  if (!code) return res.status(400).send('❌ Missing authorization code.');
  try {
    const result = await app.client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code
    });
    await pool.query(
      `INSERT INTO slack_installations (team_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (team_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [result.team.id, JSON.stringify(result)]
    );
    res.send('<h2>✅ CipherPol Bot installed!</h2><p>You can close this window and return to Slack.</p>');
  } catch (e) {
    console.error('OAuth redirect error:', e.message);
    res.status(500).send(`<h2>❌ Installation failed</h2><p>${e.message}</p>`);
  }
});

// ==================== START ====================

(async () => {
  const port = process.env.PORT || 3000;

  await app.start(port);
  console.log(`⚡️ Server listening on port ${port}`);

  try {
    await initDb();
    console.log('💾 Database ready');
  } catch (err) {
    console.error('⚠️  DB init error (will retry on next request):', err.message);
  }
})();
