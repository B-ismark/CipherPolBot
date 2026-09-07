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
  checkNotificationRateLimit,
  draftFitsInView
} = require('./lib/validation');
const { isCreatorOrCoCreator, canViewResults, resultsHiddenReason } = require('./lib/policy');
const { getAllVoters, pollMessageRefs } = require('./lib/poll');
const {
  readDestinations, buildQuestionModal, DEFAULT_SHOW_RESULTS, buildComposeModal,
  buildOptionsModal, buildEditModal, buildPreviewModal, METADATA_FULL, readCurrentQuestion,
  readOptionsSettings, readComposeState, restoreQuestion, rebuildComposeView,
  buildQuestion, buildVoteModal, isInlineVotable, pollAdminHint, buildPollBlocks,
  buildShareModal, buildResultsBlocks, buildPostVoteModal, buildResultsModal,
  buildCloseConfirmModal, buildNoticeModal, pollListBlocks, buildPollCsv,
  dmRedirectNotice
} = require('./lib/views');
const { parseComposeArgs, questionFormError, formTypeFor } = require('./lib/compose');
const { installationKey, installationKeyFromOAuth } = require('./lib/install');
const { normalizeDestinations, assertDestinationLimit, dedupeTargets } = require('./lib/destinations');

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


// ==================== CONSTANTS ====================












// ==================== MODAL BUILDERS ====================























// ==================== POLL DISPLAY ====================










async function updatePollMessage(client, poll) {
  const refs = pollMessageRefs(poll);
  const blocks = buildPollBlocks(poll);
  await Promise.allSettled(refs.map(({ channelId, messageTs }) =>
    client.chat.update({ channel: channelId, ts: messageTs, text: `📊 ${poll.title}`, blocks })
  ));
}


// ==================== POLL CREATION HELPER ====================

async function createAndPostPoll(client, meta, teamId = null) {
  const { channelId, userId, savedQuestions, pollTitle, pollDescription, pollSettings = [], closeAt, showResults = DEFAULT_SHOW_RESULTS, orderByVotes = false, destChannels = [], destUsers = [] } = meta;

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








// ==================== COMMANDS ====================

// Slack invalidates a trigger_id after 3 seconds. On a host that sleeps when
// idle, the first command after a wake-up always loses that race, so say what
// happened instead of surfacing the raw API error (or nothing at all).
const WAKE_UP_MESSAGE = '⏳ The bot was waking up and missed the 3-second window Slack allows. Run the command again - it will open straight away.';

// Same cause, better offer: a slash command also hands us a response_url that
// stays good for 30 minutes, long after the 3-second trigger_id died. So the
// apology can land in the channel they typed in, carrying a button - and a
// button click arrives with a fresh trigger_id, which is the whole point.
function wakeUpPrompt(channelId, commandText) {
  return {
    response_type: 'ephemeral',
    text: WAKE_UP_MESSAGE,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '⏳ I was asleep and missed the 3-second window Slack allows. Press the button - it opens straight away.' } },
      { type: 'actions', elements: [
        {
          type: 'button', text: { type: 'plain_text', text: '📊  Open poll builder', emoji: true },
          action_id: 'open_poll_creator', style: 'primary',
          // Carries the command's own text as well as its channel, so anything
          // typed on the command line survives the nap too.
          value: JSON.stringify({ channelId: channelId || '', text: (commandText || '').slice(0, 1500) })
        }
      ] }
    ]
  };
}

// The button on that prompt used to carry a bare channel id. Read both shapes so
// a prompt posted before this change still opens.
function readWakeUpValue(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return { channelId: value || '' };
  }
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
    const prefill = parseComposeArgs(body.text);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildComposeModal(
        { channelId: body.channel_id, userId: body.user_id, savedQuestions: [] },
        'multiple_choice',
        prefill
      )
    });
  } catch (err) {
    console.error('/newpoll error:', err);
    if (isExpiredTrigger(err)) {
      try {
        return await respond(wakeUpPrompt(body.channel_id, body.text));
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
    const { channelId, text } = readWakeUpValue(action.value);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildComposeModal(
        { channelId: channelId || body.channel?.id || userId, userId, savedQuestions: [] },
        'multiple_choice',
        parseComposeArgs(text)
      )
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
      view: buildComposeModal({ channelId: shortcut.channel?.id || shortcut.user.id, userId: shortcut.user.id, savedQuestions: [] })
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
    await client.chat.postEphemeral({
      channel, user: userId,
      text: `${polls.length} active poll${polls.length !== 1 ? 's' : ''}`,
      blocks: pollListBlocks(polls)
    });
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
    await client.chat.postEphemeral({
      channel, user: userId,
      text: `${polls.length} closed poll${polls.length !== 1 ? 's' : ''}`,
      blocks: pollListBlocks(polls, { closed: true })
    });
  } catch (err) {
    console.error('/polls-archive error:', err);
    await dmUser(client, body.user_id, `❌ /polls-archive failed: ${err.message}`);
  }
});

// 📊 Results, from a poll list. The button on the poll message can assume the
// poll is closed and readable; this one cannot, so it checks the poll's own
// results setting and says why when the answer is no.
app.action('list_poll_results', async ({ ack, body, client, action, respond }) => {
  await ack();
  const userId = body.user.id;
  const deny = text => respond({ response_type: 'ephemeral', replace_original: false, text });
  try {
    const poll = await getPoll(action.value);
    if (!poll) return await deny('❌ That poll no longer exists.');
    if (!canViewResults(poll, userId)) return await deny(`🔒 ${resultsHiddenReason(poll)}.`);
    await client.views.open({ trigger_id: body.trigger_id, view: buildResultsModal(poll, userId) });
  } catch (err) {
    console.error('list_poll_results error:', err);
    await dmUser(client, userId, isExpiredTrigger(err)
      ? WAKE_UP_MESSAGE
      : `❌ Could not open those results: ${err.message}`);
  }
});

// ⬇️ Export, from a poll list. The CSV goes to the creator's own DM rather than
// wherever they pressed it: a file upload does not honour chat:write.public, so
// a channel the bot has not been invited to would simply fail - and per-voter
// rows are the creator's business anyway.
app.action('list_poll_export', async ({ ack, body, client, action, respond }) => {
  await ack();
  const userId = body.user.id;
  const deny = text => respond({ response_type: 'ephemeral', replace_original: false, text });
  try {
    const poll = await getPoll(action.value);
    if (!poll) return await deny('❌ That poll no longer exists.');
    if (!isCreatorOrCoCreator(poll, userId)) return await deny(`❌ Only <@${poll.creator}> can export this poll.`);
    const own = await client.conversations.open({ users: userId });
    await uploadPollCsv(client, poll, own.channel.id);
    await deny(`⬇️ The CSV for *${poll.title}* is in your DM with me.`);
  } catch (err) {
    console.error('list_poll_export error:', err);
    await dmUser(client, userId, `❌ Could not export that poll: ${err.message}`);
  }
});



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


// Upload that CSV wherever the request came from. File uploads do not honour
// chat:write.public, so this only works in a DM or a channel the bot is in -
// hence the failure being reported rather than swallowed.
async function uploadPollCsv(client, poll, channel) {
  await client.files.uploadV2({
    channel_id: channel,
    filename: `${poll.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}_results.csv`,
    content: buildPollCsv(poll),
    title: `Results: ${poll.title}`,
    initial_comment: `📊 Export for poll: *${poll.title}*  ·  ID: \`${poll.id}\``
  });
}

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
    await uploadPollCsv(client, poll, channel);
  } catch (err) {
    console.error('/poll-export error:', err);
    await dmUser(client, body.user_id, `❌ /poll-export failed: ${err.message}`);
  }
});

// ==================== COMPOSE SCREEN ACTIONS ====================

// Every button here runs readComposeState first. A block action arrives with
// the whole view state, so whatever has been typed - the question, the title,
// the destination picks - is folded into the metadata before another screen is
// pushed on top or this one is rebuilt underneath. That is what lets the flow
// be one screen with side trips, instead of a corridor of screens.

app.action('question_action', async ({ ack, body, client }) => {
  await ack();
  const { meta, question } = readComposeState(body.view);
  const [action, idxStr] = body.actions[0].selected_option.value.split(':');
  const idx = parseInt(idxStr);
  let qs = [...(meta.savedQuestions || [])];

  if (action === 'edit') {
    const q = qs[idx];
    if (!q) return;
    qs.splice(idx, 1);
    const editMeta = {
      ...meta, savedQuestions: qs, editingIndex: idx,
      draft: question, questionPageViewId: body.view.id
    };
    try {
      await client.views.push({
        trigger_id: body.trigger_id,
        view: buildQuestionModal(editMeta, formTypeFor(q), {
          text: q.text,
          options: ['multiple_choice', 'likert', 'ranking'].includes(q.type) ? q.options.join('\n') : ''
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

  try {
    await client.views.update({
      view_id: body.view.id,
      view: buildComposeModal({ ...meta, savedQuestions: qs }, question.type, restoreQuestion(question))
    });
  } catch (err) { console.warn('compose refresh failed:', err.message); }
});

// The type picker rewrites the form beneath it - a rating scale needs no choices
// typed, a ranking needs items rather than options. It lives on both the compose
// screen and the edit screen, so which one is being rebuilt is read off the view.
app.action('question_type_changed', async ({ ack, body, client }) => {
  await ack();
  const newType = body.actions[0].selected_option.value;

  if (body.view.callback_id === 'poll_compose_submit') {
    const { meta, question } = readComposeState(body.view);
    return client.views.update({
      view_id: body.view.id,
      view: buildComposeModal(meta, newType, restoreQuestion(question))
    });
  }

  const meta = JSON.parse(body.view.private_metadata);
  const question = readCurrentQuestion(body.view.state.values, (meta.savedQuestions || []).length + 1);
  await client.views.update({
    view_id: body.view.id,
    view: buildQuestionModal(meta, newType, restoreQuestion(question))
  });
});

app.action('add_another_question', async ({ ack, body, client }) => {
  await ack();
  const { meta, question } = readComposeState(body.view);

  const problem = questionFormError(question);
  if (problem) {
    return client.views.update({
      view_id: body.view.id,
      view: buildComposeModal(meta, question.type, restoreQuestion(question), problem === 'text'
        ? 'Write this question before adding another.'
        : 'Give this question at least 2 choices before adding another.')
    });
  }

  const updatedMeta = {
    ...meta,
    savedQuestions: [...(meta.savedQuestions || []), buildQuestion(question.text, question.type, question.optionsRaw)],
    editingIndex: null
  };

  // Refused here rather than accepted and then silently dropped by Slack: the
  // question still in the form is what would be lost, and it is still on screen
  // to be posted or shortened.
  if (!draftFitsInView(updatedMeta)) {
    return client.views.update({
      view_id: body.view.id,
      view: buildComposeModal(meta, question.type, restoreQuestion(question), METADATA_FULL)
    });
  }

  await client.views.update({ view_id: body.view.id, view: buildComposeModal(updatedMeta) });
});

app.action('compose_options', async ({ ack, body, client }) => {
  await ack();
  const { meta, question } = readComposeState(body.view);

  // The settings have to stay reachable however long the poll is, so when the
  // draft will not fit alongside it the half-typed question is what gives way -
  // and the screen says so, rather than losing it quietly.
  let carried = { ...meta, draft: question, composeViewId: body.view.id };
  const draftDropped = !draftFitsInView(carried);
  if (draftDropped) carried = { ...meta, composeViewId: body.view.id };

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: buildOptionsModal(carried, draftDropped)
    });
  } catch (err) {
    console.error('compose_options push error:', err);
    await dmUser(client, body.user.id, isExpiredTrigger(err)
      ? WAKE_UP_MESSAGE
      : `❌ Could not open the poll options: ${err.message}`);
  }
});

app.action('compose_preview', async ({ ack, body, client }) => {
  await ack();
  const { meta, question } = readComposeState(body.view);

  // A question still sitting in the form counts. A preview that left it out
  // would be a preview of a different poll from the one the button next to it
  // would post.
  const staged = questionFormError(question)
    ? [...(meta.savedQuestions || [])]
    : [...(meta.savedQuestions || []), buildQuestion(question.text, question.type, question.optionsRaw)];

  if (!staged.length) {
    return client.views.update({
      view_id: body.view.id,
      view: buildComposeModal(meta, question.type, restoreQuestion(question), 'Write a question first — there is nothing to preview yet.')
    });
  }

  // Unlike the options screen there is nothing here worth dropping to make it
  // fit: a preview of part of the poll would be worse than none. Post Poll is
  // right next to this button and does not go through a view at all.
  const carried = { ...meta, savedQuestions: staged };
  if (!draftFitsInView(carried)) {
    return client.views.update({
      view_id: body.view.id,
      view: buildComposeModal(meta, question.type, restoreQuestion(question), `${METADATA_FULL} Posting still works — it is only the preview that cannot carry this much.`)
    });
  }

  try {
    await client.views.push({ trigger_id: body.trigger_id, view: buildPreviewModal(carried) });
  } catch (err) {
    console.error('compose_preview push error:', err);
    await dmUser(client, body.user.id, isExpiredTrigger(err)
      ? WAKE_UP_MESSAGE
      : `❌ Could not open the preview: ${err.message}`);
  }
});

// ==================== VIEW SUBMISSIONS ====================

// 🚀 Post Poll, straight from the compose screen. This is the whole of the
// ordinary path: one screen, one submit.
app.view('poll_compose_submit', async ({ ack, body, view, client, context }) => {
  const { meta, qNum, question } = readComposeState(view);
  const alreadyHas = (meta.savedQuestions || []).length > 0;

  // Validated before the ack, because response_action:'errors' *is* the ack and
  // cannot follow one. A blank form is only an error when it is the only
  // question there is - with questions already added it means "no more". But a
  // form with choices and no question is a slip, not a decision, so it is
  // caught rather than quietly dropped along with what was typed in it.
  if (question.text || question.optionsRaw || !alreadyHas) {
    const problem = questionFormError(question);
    if (problem === 'text') {
      return await ack({ response_action: 'errors', errors: { [`q_text_${qNum}`]: 'Please enter a question.' } });
    }
    if (problem === 'options') {
      return await ack({ response_action: 'errors', errors: { [`q_options_${qNum}`]: 'Please enter at least 2 options.' } });
    }
  }

  const savedQuestions = question.text
    ? [...(meta.savedQuestions || []), buildQuestion(question.text, question.type, question.optionsRaw)]
    : [...(meta.savedQuestions || [])];

  // Ack inside Slack's 3-second window BEFORE doing any work: posting a poll is
  // several database and API round trips, and on a cold host that overran the
  // deadline, so the creator got "we had trouble connecting" on a poll that had
  // in fact been created.
  await ack({ response_action: 'clear' });
  await postComposedPoll(client, { ...meta, savedQuestions }, body, view, context);
});

app.view('poll_options_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const merged = { ...meta, ...readOptionsSettings(view.state.values, meta) };
  await ack();

  // Acking pops this screen off and reveals the compose screen, which is then
  // rebuilt so its summary line reflects what was just saved. Rebuilding from
  // the captured metadata is what keeps the question, title and picks intact.
  const composeViewId = meta.composeViewId || view.root_view_id;
  if (!composeViewId) return;
  try {
    await client.views.update({ view_id: composeViewId, view: rebuildComposeView(merged) });
  } catch (err) { console.warn('compose refresh failed:', err.message); }
});

// Only ever an edit now - adding a question happens on the compose screen.
app.view('question_submit', async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const qNum = (meta.savedQuestions || []).length + 1;
  const question = readCurrentQuestion(view.state.values, qNum);

  const problem = questionFormError(question);
  if (problem === 'text') {
    return await ack({ response_action: 'errors', errors: { [`q_text_${qNum}`]: 'Please enter a question.' } });
  }
  if (problem === 'options') {
    return await ack({ response_action: 'errors', errors: { [`q_options_${qNum}`]: 'Please enter at least 2 options.' } });
  }

  // Put back where it was taken from: question_action removes the question being
  // edited, so the index it was at is where the edited version belongs.
  const questions = [...(meta.savedQuestions || [])];
  const at = Number.isInteger(meta.editingIndex) ? meta.editingIndex : questions.length;
  questions.splice(at, 0, buildQuestion(question.text, question.type, question.optionsRaw));

  await ack();
  const composeViewId = meta.questionPageViewId || view.root_view_id;
  if (!composeViewId) return;
  try {
    await client.views.update({
      view_id: composeViewId,
      view: rebuildComposeView({ ...meta, savedQuestions: questions, editingIndex: null })
    });
  } catch (err) { console.warn('compose refresh failed:', err.message); }
});

// 🚀 Post Poll from the preview screen. The destinations were captured on the
// compose screen, so unlike before they arrive in the metadata rather than in
// this submission - which is why ← Back no longer resets them.
app.view('poll_preview_submit', async ({ ack, body, view, client, context }) => {
  const meta = JSON.parse(view.private_metadata);
  await ack({ response_action: 'clear' });
  await postComposedPoll(client, meta, body, view, context);
});

// Shared by both Post Poll buttons: create it, post it, and report where it
// went. The modal stack is already cleared by the time this runs, so every
// outcome has to be reported in a message.
async function postComposedPoll(client, meta, body, view, context) {
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
      // The copy lives in lib/views.js with the picker it names, so a test can
      // read it. See dmRedirectNotice.
      lines.push(dmRedirectNotice());
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
    console.error('postComposedPoll error:', err);
    // The modal is already gone, so the only way left to report this is a DM.
    await dmUser(client, meta.userId, `❌ ${err.message || 'Failed to create poll.'}`);
  }
}


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

// The ballot on the poll message itself. One press is one answer, which is why
// only list questions carry buttons - see isInlineVotable. Multi-question polls
// still work: every list question gets its own row, and anything that needs the
// modal is called out in the reply.
app.action(/^vote_option_/, async ({ ack, body, client, action, respond }) => {
  await ack();
  const userId = body.user.id;
  const [pollId, qiRaw, oiRaw] = `${action.value}`.split('::');
  const qi = Number(qiRaw), oi = Number(oiRaw);

  // Everything this handler says is ephemeral. A shared message cannot address
  // one person, and without a reply a press would look like it did nothing on a
  // poll whose tally is hidden.
  const tell = async text => {
    try { await respond({ response_type: 'ephemeral', replace_original: false, text }); }
    catch (err) { console.warn('inline vote reply failed:', err.message); }
  };

  const dbClient = await pool.connect();
  let finalPoll = null, note = null;
  try {
    await dbClient.query('BEGIN');
    const { rows } = await dbClient.query('SELECT * FROM polls WHERE id=$1 FOR UPDATE', [pollId]);
    if (!rows.length) {
      await dbClient.query('ROLLBACK');
      return await tell('❌ This poll no longer exists.');
    }
    const poll = rowToPoll(rows[0]);

    if (poll.status === 'closed') {
      await dbClient.query('ROLLBACK');
      return await tell('🔒 This poll is closed - your vote was *not* recorded.');
    }
    if (poll.closeAt && new Date() >= new Date(poll.closeAt)) {
      await dbClient.query("UPDATE polls SET status='closed' WHERE id=$1", [pollId]);
      await dbClient.query('COMMIT');
      await tell('⏰ This poll reached its close time - your vote was *not* recorded.');
      await updatePollMessage(client, { ...poll, status: 'closed' });
      await sendCloseNotifications(client, { ...poll, status: 'closed' });
      return;
    }

    const q = (poll.questions || [])[qi];
    if (!q || !isInlineVotable(q.type) || !(q.options || [])[oi]) {
      await dbClient.query('ROLLBACK');
      return await tell('⚠️ That option is not part of this poll any more. Press *🗳️ Vote* to answer it.');
    }

    poll.votes[qi] = poll.votes[qi] || {};
    const qv = poll.votes[qi];
    const picked = ids => (ids || []).includes(userId);
    const answered = Object.values(qv).some(picked);

    if (q.allowMultiple) {
      // Adding another choice is not changing your mind, so it is allowed even
      // when vote changes are off. Taking one back is.
      if (picked(qv[oi])) {
        if (!poll.allowRevote) {
          await dbClient.query('ROLLBACK');
          return await tell(`🔒 You already picked *${q.options[oi]}*, and the creator turned off vote changes.`);
        }
        qv[oi] = (qv[oi] || []).filter(id => id !== userId);
        note = `Took back your vote for *${q.options[oi]}*.`;
      } else {
        qv[oi] = [...(qv[oi] || []), userId];
        note = `Added your vote for *${q.options[oi]}*.`;
      }
    } else {
      if (answered && !poll.allowRevote) {
        await dbClient.query('ROLLBACK');
        return await tell('🔒 You have already answered this question, and the creator turned off vote changes.');
      }
      if (picked(qv[oi])) {
        await dbClient.query('ROLLBACK');
        return await tell(`✅ You already voted for *${q.options[oi]}* - nothing changed.`);
      }
      Object.keys(qv).forEach(k => { qv[k] = (qv[k] || []).filter(id => id !== userId); });
      qv[oi] = [...(qv[oi] || []), userId];
      note = `Your vote for *${q.options[oi]}* is in.`;
    }

    const voteTimestamps = poll.voteTimestamps || {};
    voteTimestamps[userId] = new Date().toISOString();
    await dbClient.query(
      'UPDATE polls SET votes=$1, vote_timestamps=$2 WHERE id=$3',
      [JSON.stringify(poll.votes), JSON.stringify(voteTimestamps), pollId]
    );
    await dbClient.query('COMMIT');
    poll.voteTimestamps = voteTimestamps;
    finalPoll = poll;
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (e) { /* transaction already gone */ }
    console.error('vote_option transaction error:', err.message);
    return await tell('⚠️ Something went wrong recording your vote. Nothing was saved - please try again.');
  } finally {
    dbClient.release();
  }

  // A press answers one question. If the poll has any that a button cannot
  // express, say so rather than letting someone think they are done.
  const needsModal = (finalPoll.questions || []).some(qq => !isInlineVotable(qq.type));
  await tell(`✅ ${note}${needsModal ? '  This poll also has questions that need the *🗳️ Vote* button.' : ''}`);
  await updatePollMessage(client, finalPoll);
});


app.action('view_results_modal', async ({ ack, body, client, action }) => {
  await ack();
  try {
    const poll = await getPoll(action.value);
    if (!poll) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildResultsModal(poll, body.user.id)
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
    // it was first posted - the same poll can be in several channels. But this
    // button is on the poll lists now as well, and those can be run anywhere:
    // a click from a channel the poll was never posted to falls back to the
    // poll's own channel rather than dropping its results into a bystander.
    const from = body.channel?.id;
    const showsThisPoll = from && pollMessageRefs(poll).some(r => r.channelId === from);
    const channel = showsThisPoll ? from : (poll.channelId || from);
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
