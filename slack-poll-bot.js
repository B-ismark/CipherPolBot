require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { Pool } = require('pg');

// ==================== DATABASE SETUP (Neon PostgreSQL) ====================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      votes TEXT NOT NULL,
      creator TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_ts TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function savePoll(poll) {
  await pool.query(`
    INSERT INTO polls (id, question, options, votes, creator, channel_id, message_ts, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE SET
      question = EXCLUDED.question,
      options = EXCLUDED.options,
      votes = EXCLUDED.votes,
      creator = EXCLUDED.creator,
      channel_id = EXCLUDED.channel_id,
      message_ts = EXCLUDED.message_ts,
      status = EXCLUDED.status
  `, [
    poll.id,
    poll.question,
    JSON.stringify(poll.options),
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
    options: JSON.parse(row.options),
    votes: JSON.parse(row.votes)
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
    options: JSON.parse(row.options),
    votes: JSON.parse(row.votes)
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

const OPTION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ==================== COMMANDS ====================

// /newpoll - Create a new poll
app.command('/newpoll', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user_id;

  try {
    const parts = body.text.split('|').map(p => p.trim()).filter(Boolean);

    if (parts.length < 3) {
      return client.chat.postEphemeral({
        channel: body.channel_id,
        user: userId,
        text: '❌ Invalid format. Usage:\n`/newpoll Your question? | Option A | Option B | Option C`'
      });
    }

    const [question, ...options] = parts;

    if (options.length > 10) {
      return client.chat.postEphemeral({
        channel: body.channel_id,
        user: userId,
        text: '❌ Maximum 10 options allowed.'
      });
    }

    const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    const poll = {
      id: pollId,
      question,
      options,
      votes: Object.fromEntries(options.map((_, i) => [i, []])),
      creator: userId,
      channelId: body.channel_id,
      status: 'active'
    };

    await savePoll(poll);

    const result = await client.chat.postMessage({
      channel: body.channel_id,
      blocks: buildPollBlocks(poll)
    });

    poll.messageTs = result.ts;
    await savePoll(poll);
  } catch (err) {
    console.error('/newpoll error:', err);
    await client.chat.postEphemeral({
      channel: body.channel_id,
      user: userId,
      text: `❌ Something went wrong: ${err.message}`
    });
  }
});

// /poll-results - Show results for a poll
app.command('/poll-results', async ({ ack, body, client }) => {
  await ack();

  const pollId = body.text.trim();
  if (!pollId) {
    return client.chat.postEphemeral({
      channel: body.channel_id,
      user: body.user_id,
      text: '❌ Usage: `/poll-results POLL_ID`'
    });
  }

  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({
      channel: body.channel_id,
      user: body.user_id,
      text: `❌ Poll not found: \`${pollId}\``
    });
  }

  const totalVotes = Object.values(poll.votes).reduce((sum, v) => sum + v.length, 0);

  await client.chat.postMessage({
    channel: body.channel_id,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📊 ${poll.question}` } },
      ...poll.options.map((option, i) => {
        const votes = poll.votes[i].length;
        const pct = totalVotes === 0 ? 0 : Math.round((votes / totalVotes) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${OPTION_EMOJIS[i]} *${option}*\n${bar} ${votes} votes (${pct}%)`
          }
        };
      }),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Total votes: *${totalVotes}* • Status: *${poll.status}* • Created by <@${poll.creator}>`
        }]
      }
    ]
  });
});

// /polls-list - List all active polls
app.command('/polls-list', async ({ ack, body, client }) => {
  await ack();

  const activePolls = await getAllPolls();

  if (activePolls.length === 0) {
    return client.chat.postEphemeral({
      channel: body.channel_id,
      user: body.user_id,
      text: '📭 No active polls right now.'
    });
  }

  await client.chat.postMessage({
    channel: body.channel_id,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📋 Active Polls' } },
      ...activePolls.map((poll, i) => {
        const totalVotes = Object.values(poll.votes).reduce((s, v) => s + v.length, 0);
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${i + 1}. *${poll.question}*\n   ID: \`${poll.id}\` • Votes: ${totalVotes}`
          }
        };
      })
    ]
  });
});

// /poll-close - Close a poll (creator only)
app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();

  const pollId = body.text.trim();
  const userId = body.user_id;

  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({
      channel: body.channel_id,
      user: userId,
      text: `❌ Poll not found: \`${pollId}\``
    });
  }

  if (poll.creator !== userId) {
    return client.chat.postEphemeral({
      channel: body.channel_id,
      user: userId,
      text: '❌ Only the poll creator can close this poll.'
    });
  }

  await closePoll(pollId);

  await client.chat.postMessage({
    channel: body.channel_id,
    text: `🔒 Poll closed: *${poll.question}*`
  });
});

// ==================== VOTE HANDLER ====================

app.action(/^vote_.*/, async ({ ack, body, client, action }) => {
  await ack();

  const userId = body.user.id;
  const match = action.action_id.match(/^vote_(.+)_(\d+)$/);
  if (!match) return;

  const [, pollId, optionIndex] = match;
  const optIdx = parseInt(optionIndex);

  const poll = await getPoll(pollId);
  if (!poll) return;

  if (poll.status === 'closed') {
    return client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Poll Closed' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '🔒 This poll is no longer accepting votes.' } }]
      }
    });
  }

  const hasVoted = Object.values(poll.votes).some(voters => voters.includes(userId));
  if (hasVoted) {
    return client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Already Voted' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ You have already voted in this poll!' } }]
      }
    });
  }

  poll.votes[optIdx].push(userId);
  await updatePollVotes(pollId, poll.votes);
  await updatePollMessage(client, poll);

  return client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Vote Recorded ✓' },
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ Your vote for *${poll.options[optIdx]}* has been recorded!` } }]
    }
  });
});

// ==================== HELPERS ====================

function buildPollBlocks(poll) {
  const totalVotes = Object.values(poll.votes).reduce((s, v) => s + v.length, 0);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.question}*` } },
    ...poll.options.map((option, i) => {
      const votes = poll.votes[i].length;
      const pct = totalVotes === 0 ? 0 : Math.round((votes / totalVotes) * 100);
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: totalVotes === 0
            ? `${OPTION_EMOJIS[i]} *${option}*`
            : `${OPTION_EMOJIS[i]} *${option}*\n${bar} ${votes} ${votes === 1 ? 'vote' : 'votes'} (${pct}%)`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Vote' },
          action_id: `vote_${poll.id}_${i}`
        }
      };
    }),
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Created by <@${poll.creator}> • ID: \`${poll.id}\` • ${totalVotes} total ${totalVotes === 1 ? 'vote' : 'votes'}`
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

// ==================== HEALTH CHECK (for Render keep-alive) ====================

receiver.router.get('/', (req, res) => {
  res.send('Slack Poll Bot is running ✓');
});

receiver.router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ==================== START ====================

(async () => {
  await initDb();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Slack Poll Bot is running!');
  console.log(`📍 Port: ${process.env.PORT || 3000}`);
  console.log(`💾 Database: Neon PostgreSQL`);
})();
