require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { sslOptionFor } = require('./lib/db');
const { healthStatus } = require('./lib/health');
const { Pool } = require('pg');

// ==================== DATABASE ====================

// TLS is driven by sslmode in DATABASE_URL (use sslmode=verify-full for hosted
// Postgres), falling back to verified TLS for a remote host whose URL says
// nothing - see lib/db.js. Do not add ssl: { rejectUnauthorized: false }: it
// would let a MITM read the connection credentials and every vote.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOptionFor(process.env.DATABASE_URL),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

// Without this an error on an idle client takes the process down.
pool.on('error', err => console.error('pg pool error:', err.message));

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
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS show_results TEXT NOT NULL DEFAULT 'creator_only'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS order_by_votes BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS message_refs TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS notify_on_close TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS co_creators TEXT NOT NULL DEFAULT '[]'`);
  // Holds the installation key (see lib/install.js): the enterprise id for an
  // org-wide install, the workspace id otherwise. Needed to pick the right bot
  // token for polls the bot acts on by itself (the auto-close sweeper). Null on
  // polls created before this column existed.
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS team_id TEXT`);
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
    INSERT INTO polls (id, title, description, questions, votes, anonymous, allow_revote, creator, channel_id, message_ts, status, close_at, vote_timestamps, show_results, order_by_votes, message_refs, notify_on_close, co_creators, team_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title, description=EXCLUDED.description, questions=EXCLUDED.questions,
      votes=EXCLUDED.votes, anonymous=EXCLUDED.anonymous, allow_revote=EXCLUDED.allow_revote,
      creator=EXCLUDED.creator, channel_id=EXCLUDED.channel_id,
      message_ts=EXCLUDED.message_ts, status=EXCLUDED.status,
      close_at=EXCLUDED.close_at, vote_timestamps=EXCLUDED.vote_timestamps,
      show_results=EXCLUDED.show_results, order_by_votes=EXCLUDED.order_by_votes,
      message_refs=EXCLUDED.message_refs, notify_on_close=EXCLUDED.notify_on_close,
      co_creators=EXCLUDED.co_creators,
      team_id=COALESCE(EXCLUDED.team_id, polls.team_id)
  `, [
    poll.id, poll.title, poll.description || '',
    JSON.stringify(poll.questions), JSON.stringify(poll.votes),
    poll.anonymous || false, poll.allowRevote || false,
    poll.creator, poll.channelId, poll.messageTs || null, poll.status || 'active',
    poll.closeAt || null, JSON.stringify(poll.voteTimestamps || {}),
    poll.showResults || 'creator_only', poll.orderByVotes || false,
    JSON.stringify(poll.messageRefs || []),
    JSON.stringify(poll.notifyOnClose || []),
    JSON.stringify(poll.coCreators || []),
    poll.teamId || null
  ]);
}

function rowToPoll(row) {
  return {
    ...row,
    channelId: row.channel_id, messageTs: row.message_ts, createdAt: row.created_at,
    allowRevote: row.allow_revote, closeAt: row.close_at, teamId: row.team_id,
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

// The port is bound before the schema is created (Render kills a service that
// opens no port within ~60s), so for the first few seconds of a boot the bot is
// answering Slack while its migrations are still running. Reads and writes of
// existing columns are fine - the tables are already there - but the first boot
// after a deploy that ADDs a column would fail on it. Rather than surface
// "column does not exist" to whoever happened to create a poll in that window,
// work that writes polls waits for the migrations to finish.
let schemaReady = false;
let markSchemaReady;
const schemaReadyPromise = new Promise(resolve => { markSchemaReady = resolve; });

async function awaitSchema(timeoutMs) {
  if (schemaReady) return true;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([schemaReadyPromise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const AUTO_CLOSE_SWEEP_MS = 60 * 1000;
const KEEPALIVE_MS = 5 * 60 * 1000;

// Clients the sweeper builds for itself, keyed by team. Request handlers get
// their client from Bolt and never come through here.
const teamClients = new Map();

async function clientForPoll(poll) {
  // Single-workspace deployments have one token for everything.
  if (process.env.SLACK_BOT_TOKEN) return app.client;

  let teamId = poll.teamId;
  if (!teamId) {
    // Polls created before team_id existed: unambiguous if only one
    // installation has ever been recorded.
    const { rows } = await pool.query('SELECT team_id FROM slack_installations LIMIT 2');
    if (rows.length !== 1) return null;
    teamId = rows[0].team_id;
  }
  if (teamClients.has(teamId)) return teamClients.get(teamId);

  const { rows } = await pool.query('SELECT data FROM slack_installations WHERE team_id = $1', [teamId]);
  if (!rows.length) return null;
  const token = JSON.parse(rows[0].data).access_token;
  if (!token) return null;
  const client = new WebClient(token);
  teamClients.set(teamId, client);
  return client;
}

// close_at used to be honoured only when someone tried to vote after it passed,
// so a quiet poll stayed "Active" for ever. The UPDATE is atomic, so a vote
// holding the row lock cannot be closed twice.
async function sweepOverduePolls() {
  const { rows } = await pool.query(
    "UPDATE polls SET status='closed' WHERE status='active' AND close_at IS NOT NULL AND close_at <= NOW() RETURNING *"
  );
  if (!rows.length) return 0;
  console.log(`⏰ Auto-closed ${rows.length} overdue poll(s)`);
  for (const row of rows) {
    const poll = rowToPoll(row);
    try {
      const client = await clientForPoll(poll);
      if (!client) {
        console.warn(`auto-closed ${poll.id} in the database only: no bot token for team ${poll.teamId || 'unknown'}`);
        continue;
      }
      await updatePollMessage(client, poll);
      await sendCloseNotifications(client, poll);
    } catch (err) {
      console.warn(`auto-close follow-up failed for ${poll.id}:`, err.message);
    }
  }
  return rows.length;
}

// ==================== SECURITY: RATE LIMITING & VALIDATION ====================
// Limits, validation and rate limiting live in ./lib/validation.js so
// test-security.js exercises the same code the bot runs.
const {
  MAX_POLL_TITLE_LENGTH,
  MAX_POLL_DESCRIPTION_LENGTH,
  MAX_NOTIFY_SUBSCRIBERS_PER_POLL,
  MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR,
  validatePollInputs,
  canCreatePoll,
  pollCreationLimitMessage,
  checkPollCreationRateLimit,
  checkShareRateLimit,
  checkNotificationRateLimit
} = require('./lib/validation');
const { isCreatorOrCoCreator, canViewResults, resultsHiddenReason } = require('./lib/policy');
const { installationKey, installationKeyFromOAuth } = require('./lib/install');
const {
  MAX_DESTINATIONS, normalizeDestinations, assertDestinationLimit, dedupeTargets
} = require('./lib/destinations');

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
  authorize: async ({ teamId, enterpriseId, isEnterpriseInstall }) => {
    // Fast path: skip DB entirely when static token is configured
    if (process.env.SLACK_BOT_TOKEN) {
      return { botToken: process.env.SLACK_BOT_TOKEN };
    }
    // OAuth multi-workspace path
    const id = installationKey({ isEnterpriseInstall, enterpriseId, teamId });
    try {
      const { rows } = await pool.query(
        'SELECT data FROM slack_installations WHERE team_id = $1', [id]
      );
      if (rows.length) {
        const d = JSON.parse(rows[0].data);
        return { botToken: d.access_token, botUserId: d.bot_user_id };
      }
    } catch (err) {
      console.error('authorize DB error:', err.message);
    }
    throw new Error('No installation found. Please install the bot first.');
  }
});

app.error(async (err) => console.error('Bolt error:', JSON.stringify(err, null, 2)));

// Slack does not let an app post into a DM between two people: it has no
// membership there and cannot be given one. So a command run in such a DM is
// answered in the user's own DM with the bot instead. redirected says whether
// that substitution happened, so the caller can explain itself - a DM with the
// bot is also a D channel, and that one needs no explanation.
async function resolveChannelInfo(client, channelId, userId) {
  if (!channelId.startsWith('D')) return { channel: channelId, redirected: false };
  const r = await client.conversations.open({ users: userId });
  return { channel: r.channel.id, redirected: r.channel.id !== channelId };
}

async function resolveChannel(client, channelId, userId) {
  const { channel } = await resolveChannelInfo(client, channelId, userId);
  return channel;
}

// Turns the channels and people someone picked into channels this app can
// actually post in. A person becomes the app's own DM with them - see
// lib/destinations.js for why that is the only way to reach an individual.
//
// Returns a label per target so the confirmation can name where the poll went
// without a second round of API calls, and the failures separately: one
// unreachable destination must not stop the others.
async function resolveDestinations(client, { channelIds, userIds }, fallbackChannelId, actorId) {
  const { channels, users, usedFallback } = normalizeDestinations({ channelIds, userIds, fallbackChannelId });
  assertDestinationLimit({ channels, users });

  const targets = [];
  const failures = [];
  let redirected = false;

  for (const id of channels) {
    // Only the fallback can be a DM between two people, because the picker does
    // not offer those. That one needs substituting; a picked channel does not.
    if (usedFallback) {
      const info = await resolveChannelInfo(client, id, actorId);
      redirected = info.redirected;
      targets.push({ channel: info.channel, label: info.redirected ? 'our DM' : `<#${info.channel}>` });
    } else {
      targets.push({ channel: id, label: `<#${id}>` });
    }
  }

  for (const uid of users) {
    // Anyone in the workspace can share a poll, so this is also what stops one
    // person being sent a stream of them. The budget is shared with close
    // notifications, on purpose: it is a cap on DMs this app sends them.
    if (!await checkNotificationRateLimit(uid)) {
      failures.push({ label: `<@${uid}>`, reason: 'already had several poll DMs from me this hour' });
      continue;
    }
    try {
      const r = await client.conversations.open({ users: uid });
      targets.push({ channel: r.channel.id, label: `<@${uid}>` });
    } catch (e) {
      failures.push({ label: `<@${uid}>`, reason: e.data?.error || e.message });
    }
  }

  return { targets: dedupeTargets(targets), failures, redirected, usedFallback };
}

// Posts the poll into every target, keeping the ones that worked. Slack fails a
// single destination for its own reasons - a private channel the app was never
// invited to, a deactivated account - and that must not lose the others.
async function postPollTo(client, poll, targets) {
  const blocks = buildPollBlocks(poll);
  const results = await Promise.allSettled(targets.map(t =>
    client.chat.postMessage({ channel: t.channel, text: `📊 ${poll.title}`, blocks })
      .then(r => ({ channelId: t.channel, messageTs: r.ts }))
  ));

  const posted = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') posted.push({ ...r.value, label: targets[i].label });
    else failures.push({ label: targets[i].label, reason: r.reason?.data?.error || r.reason?.message });
  });
  return { posted, failures };
}

// message_refs is stored, so it keeps only what a later chat.update needs - a
// label would be a copy of a channel name that goes stale on the first rename.
function toMessageRefs(posted) {
  return posted.map(({ channelId, messageTs }) => ({ channelId, messageTs }));
}

// The two pickers, shared by the last step of poll creation and the Share modal.
// Kept together because the pair only makes sense as a pair: an app cannot post
// into a DM between two people, so a person is not a conversation to choose -
// they are a user id to open a DM with.
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
      label: { type: 'plain_text', text: 'People' },
      optional: true,
      hint: { type: 'plain_text', text: peopleHint || 'Each person gets the poll in their own DM with me' },
      element: {
        type: 'multi_users_select', action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Pick people...' },
        max_selected_items: MAX_DESTINATIONS,
        ...(users.length ? { initial_users: users } : {})
      }
    }
  ];
}

// What the pickers came back with. Both blocks are optional, so both can be
// absent from the submission entirely.
function readDestinations(values) {
  return {
    destChannels: values?.poll_dest_channels?.value?.selected_conversations || [],
    destUsers:    values?.poll_dest_users?.value?.selected_users || []
  };
}

// The conversation a command was run in, if it is one the app could post a poll
// into. A DM is not: the picker cannot offer it and the app cannot post there,
// so it is left unset and the fallback in resolveDestinations handles it.
function prefillableChannel(channelId) {
  return /^[CG]/.test(channelId || '') ? [channelId] : [];
}

// Whether the poll landed somewhere its creator can read and vote in.
//
// A channel they picked counts - the picker only offers conversations they can
// open. Their own DM counts, whether they picked themselves or fell back to it.
// A poll sent only to other people does not: the creator would have a receipt
// and no ballot.
function reachesCreator(posted, destUsers, creatorId, usedFallback) {
  if (usedFallback) return true;
  if ((destUsers || []).includes(creatorId)) return true;
  return posted.some(p => /^[CG]/.test(p.channelId));
}

// Slack returns these when the app cannot post somewhere the picker was willing
// to offer, and the fix is always the same one sentence.
function describeFailures(failures) {
  const list = failures.map(f => `${f.label} (${f.reason})`).join(', ');
  const needsInvite = failures.some(f => /not_in_channel|channel_not_found/.test(`${f.reason}`));
  return `Could not post to ${list}.${needsInvite ? ' For a private channel, invite me to it first (\`/invite @Cipher Pol\`).' : ''}`;
}

// The way to reach one person when there is no channel to answer in, or when
// the answer should not be in one. Every caller supplies its own marker, so this
// carries good news and bad alike.
async function dmUser(client, userId, text) {
  try {
    const r = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: r.channel.id, text });
  } catch (e) { console.error('dmUser failed:', e.message); }
}

function buildNoticeModal(title, text) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }]
  };
}

// ==================== CONSTANTS ====================

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
  const orderOpt = [{ text: { type: 'mrkdwn', text: '*Sort by vote count* — most-voted option first' }, value: 'yes' }];

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
          options: settingsOptions,
          ...(activeSettings.length ? { initial_options: activeSettings.map(v => settingsOptions.find(o => o.value === v)) } : {})
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
          options: orderOpt,
          ...(orderByVotes ? { initial_options: orderOpt } : {})
        }
      },
      { type: 'divider' },
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
  // ?? not ||, so a creator who clears the channel picker stays cleared.
  const destChannels = meta.destChannels ?? prefillableChannel(meta.channelId);
  const destUsers    = meta.destUsers ?? [];
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
      // A long poll can run past Slack's limit of 100 blocks in a view, and the
      // pickers below are the point of this screen - so the preview is what
      // gives way, not the thing you came here to do.
      ...capBlocks(questionBlocks, 100 - FIXED_PREVIEW_BLOCKS),
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Where to post*' } },
      ...destinationBlocks({
        channels: destChannels,
        users: destUsers,
        peopleHint: 'Each person gets the poll in their own DM with me. Pick only people and you get your own copy too, so you can vote.'
      }),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${savedQuestions.length} question${savedQuestions.length === 1 ? '' : 's'} · Leave both pickers empty to post in the conversation you started from`
        }]
      }
    ]
  };
}

// Header, description, tags, three dividers, the Where to post heading, two
// pickers and the footer - what the preview modal spends before any question.
const FIXED_PREVIEW_BLOCKS = 10;

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

function buildQuestionResultBlock(q, qi, poll, viewerId = null) {
  const qVotes = poll.votes[qi] || {};

  if (!canViewResults(poll, viewerId)) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${getTypeIcon(q.type)}  *${qi + 1}. ${q.text}*\n_${resultsHiddenReason(poll)}_` }
      },
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

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊  ${poll.title}`, emoji: true } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusParts.join('  ·  ') }] },
    { type: 'divider' },
    ...questions.flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll)),
    { type: 'actions', elements: actionButtons },
    {
      // The id and its commands used to sit here, on a message the whole
      // channel reads, when only the creator has any use for them. They are
      // sent privately when the poll is created, and `/polls-list` has them.
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Created by <@${poll.creator}>` }]
    }
  ];
}

function buildShareModal(poll) {
  const totalParticipants = getAllVoters(poll).size;

  return {
    type: 'modal',
    callback_id: 'share_poll_submit',
    title: { type: 'plain_text', text: 'Send Poll' },
    submit: { type: 'plain_text', text: '📤  Send Poll' },
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
      ...destinationBlocks({ peopleHint: 'Each person gets the poll in their own DM with me. Pick yourself to get a copy you can vote in.' }),
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
    { type: 'header', text: { type: 'plain_text', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants === 1 ? '' : 's'}  ·  Created by <@${poll.creator}>${poll.anonymous ? '  ·  🔒 Anonymous' : ''}` }] },
    { type: 'divider' },
    ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, viewerId))
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

function buildPostVoteModal(poll, viewerId = null) {
  const participants = getAllVoters(poll).size;
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '✅ Vote Recorded' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Your vote has been recorded for *${poll.title}*!` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*${participants}* participant${participants !== 1 ? 's' : ''} so far` }] },
      { type: 'divider' },
      ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, viewerId))
    ]
  };
}

// ==================== POLL CREATION HELPER ====================

async function createAndPostPoll(client, meta, teamId = null) {
  const { channelId, userId, savedQuestions, pollTitle, pollDescription, pollSettings = [], closeAt, showResults = 'creator_only', orderByVotes = false, destChannels = [], destUsers = [] } = meta;

  // The submission has already been acked, so nothing here is racing Slack's
  // 3-second deadline and this wait costs nothing once the bot is up.
  if (!await awaitSchema(20000)) {
    throw new Error('The bot is still starting up. Please try again in a few seconds.');
  }

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
    teamId,
    closeAt: closeAt || null,
    showResults,
    orderByVotes,
    voteTimestamps: {},
    notifyOnClose: [],
    coCreators: [],
    status: 'active'
  };

  await savePoll(poll);

  const { targets, failures, redirected, usedFallback } = await resolveDestinations(
    client, { channelIds: destChannels, userIds: destUsers }, channelId, userId
  );
  if (!targets.length) {
    throw new Error(failures.length ? describeFailures(failures) : 'There was nowhere to post this poll.');
  }

  const { posted, failures: postFailures } = await postPollTo(client, poll, targets);
  const allFailures = [...failures, ...postFailures];

  // Nothing landed. The poll is not deleted: every question the creator just
  // typed is in that row, the usual cause is fixable (a private channel the app
  // has not been invited to yet), and /polls-list can send it once it is fixed.
  // Throwing here used to leave the same row behind anyway, just without
  // telling anyone it was there.
  if (!posted.length) {
    return { poll, channel: null, posted: [], failures: allFailures, redirected, usedFallback, nowhere: true };
  }

  // A poll its own creator cannot vote in is broken, not a preference. Sending
  // it only to other people left them with nothing to click - the confirmation
  // is a receipt, not a poll - so they get their own copy. Based on what
  // actually posted, so a private channel that refused the app counts as no
  // copy at all.
  if (!reachesCreator(posted, destUsers, userId, usedFallback)) {
    try {
      const own = await client.conversations.open({ users: userId });
      if (!posted.some(p => p.channelId === own.channel.id)) {
        const r = await client.chat.postMessage({
          channel: own.channel.id, text: `📊 ${poll.title}`, blocks: buildPollBlocks(poll)
        });
        posted.push({ channelId: own.channel.id, messageTs: r.ts, label: 'you (so you can vote)' });
      }
    } catch (e) {
      // Not fatal: the poll is posted where it was asked to go. Say so instead.
      allFailures.push({ label: 'your own DM', reason: e.data?.error || e.message });
    }
  }

  poll.messageRefs = toMessageRefs(posted);
  poll.channelId = posted[0].channelId;
  poll.messageTs = posted[0].messageTs;
  await savePoll(poll);
  return { poll, channel: posted[0].channelId, posted, failures: allFailures, redirected, usedFallback };
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

// Slack invalidates a trigger_id after 3 seconds. On a host that sleeps when
// idle, the first command after a wake-up always loses that race, so say what
// happened instead of surfacing the raw API error (or nothing at all).
const WAKE_UP_MESSAGE = '⏳ The bot was waking up and missed the 3-second window Slack allows. Run the command again - it will open straight away.';

// Same cause, better offer: a slash command also hands us a response_url that
// stays good for 30 minutes, long after the 3-second trigger_id died. So the
// apology can land in the channel they typed in, carrying a button - and a
// button click arrives with a fresh trigger_id, which is the whole point.
function wakeUpPrompt(channelId) {
  return {
    response_type: 'ephemeral',
    text: WAKE_UP_MESSAGE,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '⏳ I was asleep and missed the 3-second window Slack allows. Press the button - it opens straight away.' } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '📊  Open poll builder', emoji: true }, action_id: 'open_poll_creator', value: channelId || '', style: 'primary' }
      ] }
    ]
  };
}

function isExpiredTrigger(err) {
  return `${err.data?.error || err.message}`.includes('expired_trigger_id');
}

async function handleNewPoll({ ack, body, client, respond }) {
  await ack();
  try {
    // Checked here as well as at the till, because the till is the Post button
    // on the last screen - discovering the cap there costs the creator every
    // question they just typed. canCreatePoll only looks; it does not spend.
    if (!canCreatePoll(body.user_id)) {
      return await dmUser(client, body.user_id, `⏳ ${pollCreationLimitMessage()}`);
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildCreationModal({ channelId: body.channel_id, userId: body.user_id, savedQuestions: [] })
    });
  } catch (err) {
    console.error('/newpoll error:', err);
    if (isExpiredTrigger(err)) {
      try {
        return await respond(wakeUpPrompt(body.channel_id));
      } catch (e) {
        // response_url can fail too (30 minutes gone, or five uses spent). The
        // DM is the floor: they hear something either way.
        console.warn('wake-up prompt failed:', e.message);
      }
      return await dmUser(client, body.user_id, WAKE_UP_MESSAGE);
    }
    await dmUser(client, body.user_id, `❌ Could not open poll creator: ${err.message}`);
  }
}

// The button on that prompt. It opens the same modal the command would have,
// prefilled with the channel the command was typed in - not the one this click
// came from, which for an ephemeral is the same thing anyway.
app.action('open_poll_creator', async ({ ack, body, client, action, respond }) => {
  await ack();
  const userId = body.user.id;
  try {
    if (!canCreatePoll(userId)) {
      return await dmUser(client, userId, `⏳ ${pollCreationLimitMessage()}`);
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildCreationModal({ channelId: action.value || body.channel?.id || userId, userId, savedQuestions: [] })
    });
    // The prompt has done its job; clear it so the channel is not left with a
    // stale apology and a button that now opens a second modal.
    try { await respond({ delete_original: true }); } catch (e) { /* already gone */ }
  } catch (err) {
    console.error('open_poll_creator error:', err);
    await dmUser(client, userId, `❌ Could not open poll creator: ${err.message}`);
  }
});

app.command('/newpoll', handleNewPoll);
app.command('/poll', handleNewPoll);

app.shortcut('create_poll', async ({ ack, shortcut, client }) => {
  await ack();
  try {
    if (!canCreatePoll(shortcut.user.id)) {
      return await dmUser(client, shortcut.user.id, `⏳ ${pollCreationLimitMessage()}`);
    }
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildCreationModal({ channelId: shortcut.channel?.id || shortcut.user.id, userId: shortcut.user.id, savedQuestions: [] })
    });
  } catch (err) {
    console.error('create_poll shortcut error:', err);
    await dmUser(client, shortcut.user.id, isExpiredTrigger(err)
      ? WAKE_UP_MESSAGE
      : `❌ Could not open poll creator: ${err.message}`);
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
    if (!canViewResults(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: `🔒 ${resultsHiddenReason(poll)}.` });
    await client.chat.postEphemeral({ channel, user: userId, text: `📊 Results: ${poll.title}`, blocks: buildResultsBlocks(poll, 'Poll Results', userId) });
  } catch (err) {
    console.error('/poll-results error:', err);
    await dmUser(client, body.user_id, `❌ /poll-results failed: ${err.message}`);
  }
});

app.command('/poll-share', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-share POLL_ID` - posts the *results* into this channel. To send another copy of the poll itself, press *📤 Send* on the poll.' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    if (!isCreatorOrCoCreator(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can post results to a channel. Use `/poll-results` to view them privately.' });
    // Voters were told these results were restricted, so do not let one command
    // publish them to a channel while the poll is still open.
    if (!canViewResults(poll, null)) return client.chat.postEphemeral({
      channel,
      user: userId,
      text: `🔒 Results for this poll are restricted (${resultsHiddenReason(poll).toLowerCase()}), so they cannot be posted to a channel yet. Close the poll with \`/poll-close ${poll.id}\`, or change the setting with \`/poll-edit ${poll.id}\`.`
    });
    await client.chat.postMessage({ channel, text: `📊 Current results: ${poll.title}`, blocks: buildResultsBlocks(poll, 'Current Results', userId) });
  } catch (err) {
    console.error('/poll-share error:', err);
    await dmUser(client, body.user_id, `❌ /poll-share failed: ${err.message}`);
  }
});

app.command('/polls-list', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const polls = await getAllPolls('active');
    if (!polls.length) return client.chat.postEphemeral({ channel, user: userId, text: '📭 No active polls right now. Use `/polls-archive` to see closed polls.' });
    const shown = polls.slice(0, POLL_LIST_PAGE_SIZE);
    const listBlocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Active Polls' } },
      ...shown.map((p, i) => {
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
          text: { type: 'mrkdwn', text: `*${i + 1}. ${p.title}*\nID: \`${p.id}\`  ·  ${tags.join('  ·  ')}` },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '📤  Send', emoji: true },
            action_id: 'share_poll',
            value: p.id
          }
        };
      }),
      ...truncationNote(polls.length, shown.length)
    ];
    await client.chat.postEphemeral({ channel, user: userId, text: `${polls.length} active poll${polls.length !== 1 ? 's' : ''}`, blocks: listBlocks });
  } catch (err) {
    console.error('/polls-list error:', err);
    await dmUser(client, body.user_id, `❌ /polls-list failed: ${err.message}`);
  }
});

app.command('/polls-archive', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const polls = await getAllPolls('closed');
    if (!polls.length) return client.chat.postEphemeral({ channel, user: userId, text: '📭 No closed polls yet.' });
    const shown = polls.slice(0, POLL_LIST_PAGE_SIZE);
    const listBlocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Closed Polls' } },
      ...shown.map((p, i) => {
        const participants = getAllVoters(p).size;
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${i + 1}. ${p.title}*\nID: \`${p.id}\`  ·  ${participants} participant${participants !== 1 ? 's' : ''}  ·  ${p.questions.length} question${p.questions.length !== 1 ? 's' : ''}  ·  Created by <@${p.creator}>`
          }
        };
      }),
      ...truncationNote(polls.length, shown.length),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Use \`/poll-results POLL_ID\` to view full results` }] }
    ];
    await client.chat.postEphemeral({ channel, user: userId, text: `${polls.length} closed poll${polls.length !== 1 ? 's' : ''}`, blocks: listBlocks });
  } catch (err) {
    console.error('/polls-archive error:', err);
    await dmUser(client, body.user_id, `❌ /polls-archive failed: ${err.message}`);
  }
});

// Losing votes by accident cannot be undone, so closing a poll that has any is
// confirmed first. channelId travels in private_metadata because the final
// results are posted where the close was asked for, which the view submission
// does not otherwise know.
function buildCloseConfirmModal(poll, channelId, participants) {
  return {
    type: 'modal',
    callback_id: 'poll_close_confirm',
    title: { type: 'plain_text', text: 'Close Poll?' },
    submit: { type: 'plain_text', text: '🔒  Close Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id, channelId }),
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
  };
}

// Closing is the same three steps wherever it was triggered from: every copy of
// the poll message has to stop offering a vote, the final results have to be
// posted, and everyone who asked to be told has to be told.
async function finalizePollClose(client, poll, channel) {
  await closePoll(poll.id);
  const closed = { ...poll, status: 'closed' };
  await updatePollMessage(client, closed);
  await client.chat.postMessage({
    channel,
    text: `🔒 Poll closed: ${poll.title}`,
    blocks: buildResultsBlocks(closed, '🔒 Final Results')
  });
  await sendCloseNotifications(client, closed);
  return closed;
}

app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user_id;
    const channel = await resolveChannel(client, body.channel_id, userId);
    const pollId = body.text.trim().replace(/`/g, '');
    if (!pollId) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-close POLL_ID`' });
    const poll = await getPoll(pollId);
    if (!poll) return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
    if (!isCreatorOrCoCreator(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can close this poll.' });
    if (poll.status === 'closed') return client.chat.postEphemeral({ channel, user: userId, text: '⚠️ This poll is already closed.' });

    const participants = getAllVoters(poll).size;
    // Require confirmation when votes exist (error prevention)
    if (participants > 0) {
      return client.views.open({
        trigger_id: body.trigger_id,
        view: buildCloseConfirmModal(poll, channel, participants)
      });
    }

    await finalizePollClose(client, poll, channel);
  } catch (err) {
    console.error('/poll-close error:', err);
    await dmUser(client, body.user_id, `❌ /poll-close failed: ${err.message}`);
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
    if (!isCreatorOrCoCreator(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can edit this poll.' });
    await client.views.open({ trigger_id: body.trigger_id, view: buildEditModal(poll) });
  } catch (err) {
    console.error('/poll-edit error:', err);
    await dmUser(client, body.user_id, `❌ /poll-edit failed: ${err.message}`);
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

    if (!isCreatorOrCoCreator(poll, userId)) return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can export this poll.' });

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
    await dmUser(client, body.user_id, `❌ /poll-export failed: ${err.message}`);
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
  try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (err) { console.warn('modal refresh failed:', err.message); }
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
  try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (err) { console.warn('modal refresh failed:', err.message); }
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
      try { await client.views.update({ view_id: questionPageViewId, view: buildQuestionModal(updatedMeta) }); } catch (err) { console.warn('modal refresh failed:', err.message); }
    }
    try { await client.views.update({ view_id: body.view.root_view_id, view: buildCreationModal(updatedMeta) }); } catch (err) { console.warn('modal refresh failed:', err.message); }
  } else {
    await ack({ response_action: 'push', view: buildPreviewModal(updatedMeta) });
  }
});

app.view('poll_preview_submit', async ({ ack, body, view, client, context }) => {
  // The destinations are picked on this modal, so they arrive in the submission
  // rather than in the metadata that has been carried since the first screen.
  const meta = { ...JSON.parse(view.private_metadata), ...readDestinations(view.state?.values) };

  // Ack inside Slack's 3-second window BEFORE doing any work: posting a poll
  // is several database and API round trips, and on a cold host that overran
  // the deadline, so the user got "we had trouble connecting" on a poll that
  // had in fact been created. Clearing the stack leaves no stale modal behind.
  await ack({ response_action: 'clear' });

  try {
    // Same key authorize() resolved this request with, so the auto-close
    // sweeper can find the token again later.
    const teamId = installationKey({
      isEnterpriseInstall: context.isEnterpriseInstall ?? body.is_enterprise_install,
      enterpriseId: context.enterpriseId ?? body.enterprise?.id,
      teamId: context.teamId ?? body.team?.id ?? view.team_id
    });
    const { poll, posted, failures, redirected, usedFallback, nowhere } = await createAndPostPoll(client, meta, teamId);

    if (nowhere) {
      // A DM, not an ephemeral: this needs acting on later, and an ephemeral is
      // gone on the next reload.
      return await dmUser(client, meta.userId, [
        `❌ *${poll.title}* could not be posted anywhere.`,
        `⚠️ ${describeFailures(failures)}`,
        `Nothing you typed is lost - the poll is saved. Fix the reason above, then run \`/polls-list\` and press *📤 Send*.`
      ].join('\n\n'));
    }

    const lines = [`✅ *${poll.title}* was posted to ${posted.map(p => p.label).join(', ')}.`];

    // Only the fallback can land the poll somewhere the creator did not choose,
    // and only when the command came from a DM between two people.
    const explainRedirect = usedFallback && redirected;
    if (explainRedirect) {
      lines.push('Slack does not let an app post into a DM between two people, so it could not go into the conversation you ran the command from. Send it on with the button below, or pick the people you want under *Where to post* next time.');
    }
    if (failures.length) lines.push(`⚠️ ${describeFailures(failures)}`);
    if (posted.length > 1) lines.push('Votes cast in any of them count toward this one poll.');

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
      ...(explainRedirect ? [{
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: '📤  Send it on', emoji: true }, style: 'primary', action_id: 'share_poll', value: poll.id }]
      }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: pollAdminHint(poll) }] }
    ];
    const text = `✅ ${poll.title} has been posted!`;

    // Confirm where the command was run - somewhere the creator can certainly
    // read. A DM between two people is not, so that becomes our own DM.
    const confirmChannel = await resolveChannel(client, meta.channelId, meta.userId);
    if (explainRedirect) {
      // A real message rather than an ephemeral one: the button has to survive a
      // reload, and opening the share modal here instead would race Slack's
      // 3-second trigger_id, which the poll we just posted has already spent.
      await client.chat.postMessage({ channel: confirmChannel, text, blocks });
    } else {
      await client.chat.postEphemeral({ channel: confirmChannel, user: meta.userId, text, blocks });
    }
  } catch (err) {
    console.error('poll_preview_submit error:', err);
    // The modal is already gone, so the only way left to report this is a DM.
    await dmUser(client, meta.userId, `❌ ${err.message || 'Failed to create poll.'}`);
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
  const { destChannels: channelIds, destUsers: userIds } = readDestinations(view.state?.values);
  const actor = body.user.id;

  try {
    const poll = await getPoll(pollId);
    if (!poll) return;

    // No fallback here: an empty picker means nothing was picked, not that the
    // poll should be posted a second time where it already is.
    const { targets, failures } = await resolveDestinations(client, { channelIds, userIds }, null, actor);

    // Anyone who can see a poll can send it on - that is the point - so this is
    // the only thing between one member and every channel in the workspace.
    // Counted per destination, since ten at a time is the abuse shape.
    if (targets.length && !await checkShareRateLimit(actor, targets.length)) {
      return await dmUser(client, actor, `⏳ You have shared polls to ${MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR} places in the last hour, which is the limit. Try again later.`);
    }

    // One poll with two messages in the same place is two things to keep in
    // step on every vote, and reads as a duplicate to everyone there.
    const already = new Set((poll.messageRefs || []).map(r => r.channelId));
    const fresh = targets.filter(t => !already.has(t.channel));

    if (!fresh.length && !failures.length) {
      return await dmUser(client, actor, targets.length
        ? `⚠️ *${poll.title}* is already posted in ${targets.map(t => t.label).join(', ')}.`
        : '⚠️ Pick at least one channel or person to send the poll to.');
    }

    const { posted, failures: postFailures } = await postPollTo(client, poll, fresh);
    if (posted.length) {
      const refs = [...(poll.messageRefs || []), ...toMessageRefs(posted)];
      await pool.query('UPDATE polls SET message_refs=$1 WHERE id=$2', [JSON.stringify(refs), pollId]);
    }

    const parts = [];
    if (posted.length) parts.push(`✅ *${poll.title}* sent to ${posted.map(p => p.label).join(', ')}.`);
    const allFailures = [...failures, ...postFailures];
    if (allFailures.length) parts.push(`⚠️ ${describeFailures(allFailures)}`);
    await dmUser(client, actor, parts.join('\n\n'));
  } catch (err) {
    console.error('share_poll_submit error:', err);
    await dmUser(client, actor, `❌ Failed to share poll: ${err.message}`);
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

  // Unlike poll creation, this handler still has to ack within Slack's 3
  // seconds (its results view has to be part of the ack), so the wait is short.
  // It costs nothing once the bot is up, and a vote cast during a boot is told
  // to retry rather than hitting a half-migrated schema.
  if (!await awaitSchema(2000)) {
    return ack({
      response_action: 'update',
      view: buildNoticeModal('Starting Up', '⏳ The bot is still starting up and did not record your vote. Try again in a few seconds.')
    });
  }

  const dbClient = await pool.connect();
  let finalPoll = null;
  try {
    await dbClient.query('BEGIN');
    const { rows } = await dbClient.query('SELECT * FROM polls WHERE id=$1 FOR UPDATE', [pollId]);

    if (!rows.length || rows[0].status === 'closed') {
      await dbClient.query('ROLLBACK');
      await ack({
        response_action: 'update',
        view: buildNoticeModal('Poll Closed', '🔒 This poll is closed - your vote was *not* recorded.')
      });
      return;
    }

    const poll = rowToPoll(rows[0]);

    if (poll.closeAt && new Date() >= new Date(poll.closeAt)) {
      await dbClient.query("UPDATE polls SET status='closed' WHERE id=$1", [pollId]);
      await dbClient.query('COMMIT');
      await ack({
        response_action: 'update',
        view: buildNoticeModal('Poll Closed', '⏰ This poll reached its close time - your vote was *not* recorded.')
      });
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
      await ack({
        response_action: 'update',
        view: buildNoticeModal('Already Voted', 'You have already voted in this poll, and the creator turned off vote changes.')
      });
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
    await ack({
      response_action: 'update',
      view: buildNoticeModal('Vote Not Saved', '⚠️ Something went wrong recording your vote. Nothing was saved - please try again.')
    });
    return;
  } finally {
    dbClient.release();
  }

  await ack({ response_action: 'update', view: buildPostVoteModal(finalPoll, userId) });
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
          ...(poll.questions || []).flatMap((q, qi) => buildQuestionResultBlock(q, qi, poll, body.user.id))
        ]
      }
    });
  } catch (err) {
    console.error('view_results_modal error:', err);
  }
});

// The Close button on the poll message. It is visible to the whole channel, so
// this is where the poll's own permissions are enforced.
app.action('close_poll', async ({ ack, body, client, action, respond }) => {
  await ack();
  const userId = body.user.id;
  const deny = text => respond({ response_type: 'ephemeral', replace_original: false, text });

  try {
    const poll = await getPoll(action.value);
    if (!poll) return await deny('❌ That poll no longer exists.');
    if (!isCreatorOrCoCreator(poll, userId)) {
      return await deny(`❌ Only <@${poll.creator}> can close this poll.`);
    }
    if (poll.status === 'closed') return await deny('⚠️ This poll is already closed.');

    // Final results belong where the poll was being read, not necessarily where
    // it was first posted - the same poll can be in several channels.
    const channel = body.channel?.id || poll.channelId;
    const participants = getAllVoters(poll).size;
    if (participants > 0) {
      return await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCloseConfirmModal(poll, channel, participants)
      });
    }
    await finalizePollClose(client, poll, channel);
  } catch (err) {
    console.error('close_poll error:', err);
    await dmUser(client, userId, isExpiredTrigger(err)
      ? WAKE_UP_MESSAGE
      : `❌ Could not close poll: ${err.message}`);
  }
});

// Confirmation modal shown by the Close button and by /poll-close when the poll
// already has votes.
app.view('poll_close_confirm', async ({ ack, body, view, client }) => {
  await ack();
  const { pollId, channelId } = JSON.parse(view.private_metadata);
  const userId = body.user.id;
  try {
    const poll = await getPoll(pollId);
    if (!poll || poll.status === 'closed') return;
    // Checked again here, not only where the modal was opened: co-creators can
    // be removed, and this is the step that actually ends the poll.
    if (!isCreatorOrCoCreator(poll, userId)) {
      return await dmUser(client, userId, `❌ Only <@${poll.creator}> can close this poll.`);
    }
    await finalizePollClose(client, poll, channelId);
  } catch (err) {
    console.error('poll_close_confirm error:', err);
    await dmUser(client, userId, `❌ Failed to close poll: ${err.message}`);
  }
});

// ==================== HEALTH CHECK ====================

// / is liveness: the process is answering. /health is readiness: it also
// reaches the database, so a monitor pointed at it catches an instance that is
// up but useless, not just one that is asleep.
receiver.router.get('/', (req, res) => res.send('Slack Poll Bot is running ✓'));

const HEALTH_CACHE_MS = 15000;
let lastDbCheck = { at: 0, ok: false, latencyMs: null };
let dbFailingSince = null;

async function checkDatabase() {
  // Cached so a monitor on a short interval - or several - cannot turn the
  // health endpoint into load of its own.
  if (Date.now() - lastDbCheck.at < HEALTH_CACHE_MS) return lastDbCheck;
  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    dbFailingSince = null;
    lastDbCheck = { at: Date.now(), ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    // Logged, not returned: a pg error can name the database host and user,
    // and this endpoint is public.
    console.warn('health check: database unreachable:', err.message);
    if (dbFailingSince === null) dbFailingSince = Date.now();
    lastDbCheck = { at: Date.now(), ok: false, latencyMs: null };
  }
  return lastDbCheck;
}

receiver.router.get('/health', async (req, res) => {
  const db = await checkDatabase();
  const dbFailingForMs = dbFailingSince === null ? 0 : Date.now() - dbFailingSince;
  const { httpStatus, status } = healthStatus({ schemaReady, dbOk: db.ok, dbFailingForMs });
  res.status(httpStatus).json({
    status,
    uptime: Math.round(process.uptime()),
    schema: schemaReady ? 'ready' : 'initialising',
    database: db.ok ? 'ok' : 'unreachable',
    ...(db.latencyMs === null ? {} : { databaseLatencyMs: db.latencyMs }),
    ...(dbFailingForMs ? { databaseFailingForMs: dbFailingForMs } : {})
  });
});

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
    const key = installationKeyFromOAuth(result);
    if (!key) throw new Error('Slack returned an installation with no team or enterprise id.');
    await pool.query(
      `INSERT INTO slack_installations (team_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (team_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [key, JSON.stringify(result)]
    );
    console.log(`✅ Installed for ${key}${result.is_enterprise_install ? ' (org-wide)' : ''}`);
    res.send('<h2>✅ CipherPol Bot installed!</h2><p>You can close this window and return to Slack.</p>');
  } catch (e) {
    console.error('OAuth redirect error:', e.message);
    res.status(500).send(`<h2>❌ Installation failed</h2><p>${e.message}</p>`);
  }
});

// ==================== START ====================

// Hosts that sleep when idle (Render's free tier after 15 minutes) make the
// first slash command after the nap fail: waking up takes longer than the 3
// seconds Slack allows. Pinging ourselves keeps the clock from ever reaching
// 15 minutes. It cannot WAKE a sleeping instance - only an outside request
// does that - so pair it with an external monitor for real coverage.
function startKeepalive() {
  const url = process.env.KEEPALIVE_URL;
  if (!url) return null;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) console.warn(`keepalive ping returned ${res.status}`);
    } catch (err) {
      console.warn('keepalive ping failed:', err.message);
    }
  }, KEEPALIVE_MS);
  console.log(`💓 Keepalive: pinging ${url} every ${KEEPALIVE_MS / 60000} minutes`);
  return timer;
}

async function initDbWithRetry(attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.error(`DB init attempt ${attempt}/${attempts} failed:`, err.message);
      if (attempt === attempts) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 15000)));
    }
  }
}

(async () => {
  const port = process.env.PORT || 3000;

  // Bind the port first: Render kills a web service that opens no port within
  // ~60s, and a cold Neon connection plus migrations can take longer than that
  // (see bdeeb05). Only then set up the schema.
  await app.start(port);
  console.log(`⚡️ Server listening on port ${port}`);

  // Nothing works without the schema, so exit rather than serve requests that
  // all throw "relation does not exist" - the port is already bound, so the
  // host sees a clean crash and restarts us.
  try {
    await initDbWithRetry();
    schemaReady = true;
    markSchemaReady();
    console.log('💾 Database ready');
  } catch (err) {
    console.error('Fatal: database unavailable after retries:', err.message);
    process.exit(1);
  }

  // The sweeper resolves a bot token per poll, so it works for OAuth installs
  // too - see clientForPoll.
  const sweepTimer = setInterval(
    () => sweepOverduePolls().catch(err => console.warn('auto-close sweep failed:', err.message)),
    AUTO_CLOSE_SWEEP_MS
  );

  const keepaliveTimer = startKeepalive();

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received - shutting down`);
    clearInterval(sweepTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    try { await app.stop(); } catch (err) { console.warn('server close failed:', err.message); }
    try { await pool.end(); } catch (err) { console.warn('pool close failed:', err.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Not awaited: catching up on polls that expired while we were down must not
  // delay the shutdown handlers above, and nothing below depends on it.
  sweepOverduePolls().catch(err => console.warn('startup sweep failed:', err.message));
})().catch(err => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
