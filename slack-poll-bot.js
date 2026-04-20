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
      questions TEXT NOT NULL DEFAULT '[]',
      votes TEXT NOT NULL DEFAULT '{}',
      creator TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_ts TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Safe migration for existing deployments
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS questions TEXT NOT NULL DEFAULT '[]'`);
}

async function savePoll(poll) {
  await pool.query(`
    INSERT INTO polls (id, title, questions, votes, creator, channel_id, message_ts, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      questions = EXCLUDED.questions,
      votes = EXCLUDED.votes,
      creator = EXCLUDED.creator,
      channel_id = EXCLUDED.channel_id,
      message_ts = EXCLUDED.message_ts,
      status = EXCLUDED.status
  `, [
    poll.id,
    poll.title,
    JSON.stringify(poll.questions),
    JSON.stringify(poll.votes),
    poll.creator,
    poll.channelId,
    poll.messageTs || null,
    poll.status || 'active'
  ]);
}

async function getPoll(pollId) {
  const { rows } = await pool.query('SELECT * FROM polls WHERE id = $1', [pollId]);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    ...row,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    createdAt: row.created_at,
    questions: JSON.parse(row.questions || '[]'),
    votes: JSON.parse(row.votes || '{}')
  };
}

async function getAllPolls() {
  const { rows } = await pool.query(
    "SELECT * FROM polls WHERE status = 'active' ORDER BY created_at DESC"
  );
  return rows.map(row => ({
    ...row,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    questions: JSON.parse(row.questions || '[]'),
    votes: JSON.parse(row.votes || '{}')
  }));
}

async function updatePollVotes(pollId, votes) {
  await pool.query('UPDATE polls SET votes = $1 WHERE id = $2', [JSON.stringify(votes), pollId]);
}

async function closePoll(pollId) {
  await pool.query("UPDATE polls SET status = 'closed' WHERE id = $1", [pollId]);
}

// ==================== SLACK APP ====================

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

app.error(async (error) => {
  console.error('Bolt error:', JSON.stringify(error, null, 2));
});

async function resolveChannel(client, channelId, userId) {
  if (channelId.startsWith('D')) {
    const result = await client.conversations.open({ users: userId });
    return result.channel.id;
  }
  return channelId;
}

const OPTION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ==================== MODAL BUILDERS ====================

function buildCreationModal(channelId, userId, savedQuestions = [], errorMsg = null, initialValues = {}) {
  const qNum = savedQuestions.length + 1;

  const savedBlocks = savedQuestions.length > 0 ? [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Questions added so far:*\n' + savedQuestions.map((q, i) =>
          `*${i + 1}.* ${q.text}  _(${q.options.join(' · ')})_`
        ).join('\n')
      }
    },
    { type: 'divider' }
  ] : [];

  const errorBlock = errorMsg ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` }
  }] : [];

  const textInput = {
    type: 'input',
    block_id: 'question_text',
    label: { type: 'plain_text', text: 'Question' },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      placeholder: { type: 'plain_text', text: 'Write your question...' },
      ...(initialValues.text ? { initial_value: initialValues.text } : {})
    }
  };

  const typeInput = {
    type: 'input',
    block_id: 'question_type',
    label: { type: 'plain_text', text: 'Question type' },
    element: {
      type: 'static_select',
      action_id: 'value',
      initial_option: initialValues.type === 'yes_no'
        ? { text: { type: 'plain_text', text: 'Yes / No' }, value: 'yes_no' }
        : { text: { type: 'plain_text', text: 'Multiple choice' }, value: 'multiple_choice' },
      options: [
        { text: { type: 'plain_text', text: 'Multiple choice' }, value: 'multiple_choice' },
        { text: { type: 'plain_text', text: 'Yes / No' }, value: 'yes_no' }
      ]
    }
  };

  const optionsInput = {
    type: 'input',
    block_id: 'question_options',
    label: { type: 'plain_text', text: 'Enter choices below' },
    hint: { type: 'plain_text', text: 'One option per line. Leave blank for Yes/No questions.' },
    optional: true,
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      placeholder: { type: 'plain_text', text: 'Option 1\nOption 2\nOption 3' },
      ...(initialValues.options ? { initial_value: initialValues.options } : {})
    }
  };

  return {
    type: 'modal',
    callback_id: 'poll_submit',
    title: { type: 'plain_text', text: 'Create a Poll' },
    submit: { type: 'plain_text', text: 'Create Poll' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ channelId, userId, savedQuestions }),
    blocks: [
      ...savedBlocks,
      ...errorBlock,
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${qNum} — Create question*` }
      },
      textInput,
      typeInput,
      optionsInput,
      { type: 'divider' },
      {
        type: 'actions',
        block_id: 'form_actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '+ Add Question' },
          action_id: 'add_question'
        }]
      }
    ]
  };
}

function buildVoteModal(poll) {
  return {
    type: 'modal',
    callback_id: 'vote_submit',
    title: { type: 'plain_text', text: 'Cast Your Vote' },
    submit: { type: 'plain_text', text: 'Submit Vote' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pollId: poll.id }),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
      { type: 'divider' },
      ...poll.questions.map((q, qi) => ({
        type: 'input',
        block_id: `vote_q${qi}`,
        label: { type: 'plain_text', text: `${qi + 1}. ${q.text}` },
        element: {
          type: 'static_select',
          action_id: 'selected',
          placeholder: { type: 'plain_text', text: 'Select an option' },
          options: q.options.map((opt, oi) => ({
            text: { type: 'plain_text', text: opt },
            value: String(oi)
          }))
        }
      }))
    ]
  };
}

// ==================== POLL MESSAGE DISPLAY ====================

function buildPollBlocks(poll) {
  const questions = poll.questions || [];

  const questionBlocks = questions.flatMap((q, qi) => {
    const qVotes = poll.votes[qi] || {};
    const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);

    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*` }
      },
      ...q.options.map((option, oi) => {
        const votes = (qVotes[oi] || []).length;
        const pct = totalVotes === 0 ? 0 : Math.round((votes / totalVotes) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: totalVotes === 0
              ? `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}`
              : `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}\n${bar} ${votes} ${votes === 1 ? 'vote' : 'votes'} (${pct}%)`
          }
        };
      }),
      { type: 'divider' }
    ];
  });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    { type: 'divider' },
    ...questionBlocks,
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🗳️ Vote' },
        style: 'primary',
        action_id: 'open_vote_modal',
        value: poll.id
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

async function updatePollMessage(client, poll) {
  try {
    await client.chat.update({
      channel: poll.channelId,
      ts: poll.messageTs,
      blocks: buildPollBlocks(poll)
    });
  } catch (err) {
    console.error('Error updating poll message:', err.message);
  }
}

// ==================== COMMANDS ====================

// /newpoll — opens the creation modal
app.command('/newpoll', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildCreationModal(body.channel_id, body.user_id)
    });
  } catch (err) {
    console.error('/newpoll error:', err);
    const channel = await resolveChannel(client, body.channel_id, body.user_id);
    await client.chat.postEphemeral({
      channel,
      user: body.user_id,
      text: `❌ Could not open modal: ${err.message}`
    });
  }
});

// /poll-results — show results for a poll
app.command('/poll-results', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();

  if (!pollId) {
    return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-results POLL_ID`' });
  }
  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  }
  await client.chat.postMessage({ channel, blocks: buildPollBlocks(poll) });
});

// /polls-list — list all active polls
app.command('/polls-list', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const activePolls = await getAllPolls();

  if (activePolls.length === 0) {
    return client.chat.postEphemeral({ channel, user: userId, text: '📭 No active polls right now.' });
  }
  await client.chat.postMessage({
    channel,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📋 Active Polls' } },
      ...activePolls.map((poll, i) => {
        const totalVotes = Object.values(poll.votes).reduce((s, qv) =>
          s + Object.values(qv).reduce((ss, v) => ss + v.length, 0), 0);
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${i + 1}. *${poll.title}*\n   ID: \`${poll.id}\` • ${poll.questions.length} questions • ${totalVotes} votes`
          }
        };
      })
    ]
  });
});

// /poll-close — close a poll (creator only)
app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();

  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  }
  if (poll.creator !== userId) {
    return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can close this poll.' });
  }
  await closePoll(pollId);
  await client.chat.postMessage({ channel, text: `🔒 Poll closed: *${poll.title}*` });
});

// ==================== MODAL ACTIONS ====================

// "Add Question" button in creation modal
app.action('add_question', async ({ ack, body, client }) => {
  await ack();

  const { channelId, userId, savedQuestions } = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;

  const questionText = (values.question_text?.value?.value || '').trim();
  const questionType = values.question_type?.value?.selected_option?.value || 'multiple_choice';
  const optionsRaw = values.question_options?.value?.value || '';

  if (!questionText) {
    return client.views.update({
      view_id: body.view.id,
      view: buildCreationModal(channelId, userId, savedQuestions,
        'Please enter a question before adding another.',
        { text: questionText, type: questionType, options: optionsRaw }
      )
    });
  }

  let options;
  if (questionType === 'yes_no') {
    options = ['Yes', 'No'];
  } else {
    options = optionsRaw.split('\n').map(o => o.trim()).filter(Boolean);
    if (options.length < 2) {
      return client.views.update({
        view_id: body.view.id,
        view: buildCreationModal(channelId, userId, savedQuestions,
          'Please enter at least 2 options (one per line).',
          { text: questionText, type: questionType, options: optionsRaw }
        )
      });
    }
  }

  const updatedQuestions = [...savedQuestions, { text: questionText, type: questionType, options }];
  await client.views.update({
    view_id: body.view.id,
    view: buildCreationModal(channelId, userId, updatedQuestions)
  });
});

// Poll creation modal submitted
app.view('poll_submit', async ({ ack, body, view, client }) => {
  await ack();

  const { channelId, userId, savedQuestions } = JSON.parse(view.private_metadata);
  const values = view.state.values;

  const questionText = (values.question_text?.value?.value || '').trim();
  const questionType = values.question_type?.value?.selected_option?.value || 'multiple_choice';
  const optionsRaw = values.question_options?.value?.value || '';

  let options;
  if (questionType === 'yes_no') {
    options = ['Yes', 'No'];
  } else {
    options = optionsRaw.split('\n').map(o => o.trim()).filter(Boolean);
    if (options.length < 2) options = ['Option A', 'Option B'];
  }

  const allQuestions = questionText
    ? [...savedQuestions, { text: questionText, type: questionType, options }]
    : savedQuestions;

  if (allQuestions.length === 0) return;

  const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  const votes = {};
  allQuestions.forEach((q, qi) => {
    votes[qi] = {};
    q.options.forEach((_, oi) => { votes[qi][oi] = []; });
  });

  const poll = {
    id: pollId,
    title: allQuestions[0].text,
    questions: allQuestions,
    votes,
    creator: userId,
    channelId,
    status: 'active'
  };

  try {
    await savePoll(poll);
    const channel = await resolveChannel(client, channelId, userId);
    const result = await client.chat.postMessage({ channel, blocks: buildPollBlocks(poll) });
    poll.messageTs = result.ts;
    poll.channelId = channel;
    await savePoll(poll);
  } catch (err) {
    console.error('poll_submit error:', err);
  }
});

// "Vote" button on poll message — opens voting modal
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
  const hasVoted = Object.values(poll.votes).some(qVotes =>
    Object.values(qVotes).some(voters => voters.includes(userId))
  );

  if (hasVoted) {
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
    view: buildVoteModal(poll)
  });
});

// Voting modal submitted
app.view('vote_submit', async ({ ack, body, view, client }) => {
  await ack();

  const { pollId } = JSON.parse(view.private_metadata);
  const userId = body.user.id;
  const poll = await getPoll(pollId);

  if (!poll || poll.status === 'closed') return;

  const hasVoted = Object.values(poll.votes).some(qVotes =>
    Object.values(qVotes).some(voters => voters.includes(userId))
  );
  if (hasVoted) return;

  const values = view.state.values;
  poll.questions.forEach((q, qi) => {
    const selectedValue = values[`vote_q${qi}`]?.selected?.selected_option?.value;
    if (selectedValue !== undefined) {
      const oi = parseInt(selectedValue);
      if (!poll.votes[qi]) poll.votes[qi] = {};
      if (!poll.votes[qi][oi]) poll.votes[qi][oi] = [];
      poll.votes[qi][oi].push(userId);
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
