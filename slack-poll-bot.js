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
  // Safe migrations for existing deployments
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS questions TEXT NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS allow_revote BOOLEAN NOT NULL DEFAULT false`);
}

async function savePoll(poll) {
  await pool.query(`
    INSERT INTO polls (id, title, description, questions, votes, anonymous, allow_revote, creator, channel_id, message_ts, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      questions = EXCLUDED.questions,
      votes = EXCLUDED.votes,
      anonymous = EXCLUDED.anonymous,
      allow_revote = EXCLUDED.allow_revote,
      creator = EXCLUDED.creator,
      channel_id = EXCLUDED.channel_id,
      message_ts = EXCLUDED.message_ts,
      status = EXCLUDED.status
  `, [
    poll.id,
    poll.title,
    poll.description || '',
    JSON.stringify(poll.questions),
    JSON.stringify(poll.votes),
    poll.anonymous || false,
    poll.allowRevote || false,
    poll.creator,
    poll.channelId,
    poll.messageTs || null,
    poll.status || 'active'
  ]);
}

function rowToPoll(row) {
  return {
    ...row,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    createdAt: row.created_at,
    allowRevote: row.allow_revote,
    questions: JSON.parse(row.questions || '[]'),
    votes: JSON.parse(row.votes || '{}')
  };
}

async function getPoll(pollId) {
  const { rows } = await pool.query('SELECT * FROM polls WHERE id = $1', [pollId]);
  if (!rows.length) return null;
  return rowToPoll(rows[0]);
}

async function getAllPolls() {
  const { rows } = await pool.query(
    "SELECT * FROM polls WHERE status = 'active' ORDER BY created_at DESC"
  );
  return rows.map(rowToPoll);
}

async function updatePollVotes(pollId, votes) {
  await pool.query('UPDATE polls SET votes = $1 WHERE id = $2', [JSON.stringify(votes), pollId]);
}

async function closePoll(pollId) {
  await pool.query("UPDATE polls SET status = 'closed' WHERE id = $1", [pollId]);
}

// ==================== APP SETUP ====================

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

function buildCreationModal(channelId, userId, savedQuestions = [], errorMsg = null, restore = {}) {
  const qNum = savedQuestions.length + 1;

  const savedBlocks = savedQuestions.length > 0 ? [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Questions added:*\n' + savedQuestions.map((q, i) => {
          const tag = q.allowMultiple ? ' _(multi-select)_' : '';
          return `*${i + 1}.* ${q.text}${tag}  _(${q.options.join(' · ')})_`;
        }).join('\n')
      }
    },
    { type: 'divider' }
  ] : [];

  const errorBlock = errorMsg ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: `⚠️ *${errorMsg}*` }
  }] : [];

  // Only show poll-level settings on the first question
  const pollSettingsBlocks = savedQuestions.length === 0 ? [
    {
      type: 'input',
      block_id: 'poll_title',
      label: { type: 'plain_text', text: 'Poll title' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Give your poll a name...' },
        ...(restore.pollTitle ? { initial_value: restore.pollTitle } : {})
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
        ...(restore.pollDescription ? { initial_value: restore.pollDescription } : {})
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
        options: [
          {
            text: { type: 'mrkdwn', text: '*Anonymous* — hide who voted for what' },
            value: 'anonymous'
          },
          {
            text: { type: 'mrkdwn', text: '*Allow vote changes* — voters can update their choice' },
            value: 'allow_revote'
          }
        ],
        ...(restore.pollSettings?.length ? {
          initial_options: restore.pollSettings.map(v => ({
            text: { type: 'mrkdwn', text: v === 'anonymous' ? '*Anonymous* — hide who voted for what' : '*Allow vote changes* — voters can update their choice' },
            value: v
          }))
        } : {})
      }
    },
    { type: 'divider' }
  ] : [];

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
      ...pollSettingsBlocks,
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${qNum} — Create question*` }
      },
      {
        type: 'input',
        block_id: 'question_text',
        label: { type: 'plain_text', text: 'Question' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Write your question...' },
          ...(restore.questionText ? { initial_value: restore.questionText } : {})
        }
      },
      {
        type: 'input',
        block_id: 'question_type',
        label: { type: 'plain_text', text: 'Question type' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: restore.questionType === 'yes_no'
            ? { text: { type: 'plain_text', text: 'Yes / No' }, value: 'yes_no' }
            : { text: { type: 'plain_text', text: 'Multiple choice' }, value: 'multiple_choice' },
          options: [
            { text: { type: 'plain_text', text: 'Multiple choice' }, value: 'multiple_choice' },
            { text: { type: 'plain_text', text: 'Yes / No' }, value: 'yes_no' }
          ]
        }
      },
      {
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
          ...(restore.questionOptions ? { initial_value: restore.questionOptions } : {})
        }
      },
      {
        type: 'input',
        block_id: 'allow_multiple',
        label: { type: 'plain_text', text: 'Question options' },
        optional: true,
        element: {
          type: 'checkboxes',
          action_id: 'value',
          options: [{
            text: { type: 'mrkdwn', text: '*Allow multiple selections* — voters can pick more than one' },
            value: 'multiple'
          }]
        }
      },
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
      ...(poll.description ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: poll.description }
      }] : []),
      { type: 'divider' },
      ...poll.questions.map((q, qi) => {
        const prevSelected = previousVotes[qi] || [];
        if (q.allowMultiple) {
          return {
            type: 'input',
            block_id: `vote_q${qi}`,
            label: { type: 'plain_text', text: `${qi + 1}. ${q.text}` },
            hint: { type: 'plain_text', text: 'Select all that apply' },
            element: {
              type: 'checkboxes',
              action_id: 'selected',
              options: q.options.map((opt, oi) => ({
                text: { type: 'mrkdwn', text: opt },
                value: String(oi)
              })),
              ...(prevSelected.length ? {
                initial_options: prevSelected.map(oi => ({
                  text: { type: 'mrkdwn', text: q.options[oi] },
                  value: String(oi)
                }))
              } : {})
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
            options: q.options.map((opt, oi) => ({
              text: { type: 'plain_text', text: opt },
              value: String(oi)
            })),
            ...(prevSelected.length ? {
              initial_option: {
                text: { type: 'plain_text', text: q.options[prevSelected[0]] },
                value: String(prevSelected[0])
              }
            } : {})
          }
        };
      })
    ]
  };
}

// ==================== POLL DISPLAY ====================

function buildPollBlocks(poll) {
  const questions = poll.questions || [];

  const metaTags = [];
  if (poll.anonymous) metaTags.push('🔒 Anonymous');
  if (poll.allowRevote) metaTags.push('🔄 Vote changes allowed');

  const questionBlocks = questions.flatMap((q, qi) => {
    const qVotes = poll.votes[qi] || {};
    const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);

    const optionBlocks = q.options.map((option, oi) => {
      const voters = qVotes[oi] || [];
      const count = voters.length;
      const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

      let voterLine = '';
      if (!poll.anonymous && count > 0) {
        voterLine = '\n' + voters.map(id => `<@${id}>`).join(' ');
      }

      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: totalVotes === 0
            ? `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}`
            : `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}\n${bar} ${count} ${count === 1 ? 'vote' : 'votes'} (${pct}%)${voterLine}`
        }
      };
    });

    const qLabel = q.allowMultiple ? `*${qi + 1}. ${q.text}*  _(select multiple)_` : `*${qi + 1}. ${q.text}*`;

    return [
      { type: 'section', text: { type: 'mrkdwn', text: qLabel } },
      ...optionBlocks,
      { type: 'divider' }
    ];
  });

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📊 *${poll.title}*` }
    },
    ...(poll.description ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: poll.description }
    }] : []),
    ...(metaTags.length ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: metaTags.join('  ·  ') }]
    }] : []),
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

function buildResultsBlocks(poll, heading = '📊 *Poll Results*') {
  const questions = poll.questions || [];

  const questionBlocks = questions.flatMap((q, qi) => {
    const qVotes = poll.votes[qi] || {};
    const totalVotes = Object.values(qVotes).reduce((s, v) => s + v.length, 0);

    const optionBlocks = q.options.map((option, oi) => {
      const voters = qVotes[oi] || [];
      const count = voters.length;
      const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

      let voterLine = '';
      if (!poll.anonymous && count > 0) {
        voterLine = '\n' + voters.map(id => `<@${id}>`).join(' ');
      }

      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${OPTION_EMOJIS[oi] || `${oi + 1}.`} ${option}\n${bar} ${count} ${count === 1 ? 'vote' : 'votes'} (${pct}%)${voterLine}`
        }
      };
    });

    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*${qi + 1}. ${q.text}*` } },
      ...optionBlocks,
      { type: 'divider' }
    ];
  });

  const totalParticipants = new Set(
    Object.values(poll.votes).flatMap(qv => Object.values(qv).flat())
  ).size;

  return [
    { type: 'header', text: { type: 'plain_text', text: heading.replace(/\*/g, '') } },
    { type: 'section', text: { type: 'mrkdwn', text: `📊 *${poll.title}*` } },
    ...(poll.description ? [{ type: 'section', text: { type: 'mrkdwn', text: poll.description } }] : []),
    { type: 'divider' },
    ...questionBlocks,
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${totalParticipants} ${totalParticipants === 1 ? 'participant' : 'participants'} • Created by <@${poll.creator}>${poll.anonymous ? '  ·  🔒 Anonymous' : ''}`
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
  await client.chat.postMessage({ channel, blocks: buildResultsBlocks(poll) });
});

app.command('/poll-share', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();

  if (!pollId) {
    return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-share POLL_ID`' });
  }
  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  }
  await client.chat.postMessage({ channel, blocks: buildResultsBlocks(poll, '📊 *Current Results*') });
});

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
      { type: 'header', text: { type: 'plain_text', text: 'Active Polls' } },
      ...activePolls.map((poll, i) => {
        const participants = new Set(
          Object.values(poll.votes).flatMap(qv => Object.values(qv).flat())
        ).size;
        const tags = [
          `${poll.questions.length} ${poll.questions.length === 1 ? 'question' : 'questions'}`,
          `${participants} ${participants === 1 ? 'participant' : 'participants'}`,
          ...(poll.anonymous ? ['🔒 Anonymous'] : []),
          ...(poll.allowRevote ? ['🔄 Revote on'] : [])
        ];
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${i + 1}. ${poll.title}*\nID: \`${poll.id}\`  ·  ${tags.join('  ·  ')}`
          }
        };
      })
    ]
  });
});

app.command('/poll-close', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const channel = await resolveChannel(client, body.channel_id, userId);
  const pollId = body.text.trim();

  if (!pollId) {
    return client.chat.postEphemeral({ channel, user: userId, text: '❌ Usage: `/poll-close POLL_ID`' });
  }
  const poll = await getPoll(pollId);
  if (!poll) {
    return client.chat.postEphemeral({ channel, user: userId, text: `❌ Poll not found: \`${pollId}\`` });
  }
  if (poll.creator !== userId) {
    return client.chat.postEphemeral({ channel, user: userId, text: '❌ Only the poll creator can close this poll.' });
  }

  await closePoll(pollId);

  // Post final results
  await client.chat.postMessage({
    channel,
    blocks: buildResultsBlocks({ ...poll, status: 'closed' }, '🔒 Final Results')
  });
});

// ==================== MODAL ACTIONS ====================

app.action('add_question', async ({ ack, body, client }) => {
  await ack();

  const { channelId, userId, savedQuestions } = JSON.parse(body.view.private_metadata);
  const values = body.view.state.values;

  // Read and preserve poll-level settings (only present on first question)
  const pollTitle = values.poll_title?.value?.value?.trim() || '';
  const pollDescription = values.poll_description?.value?.value?.trim() || '';
  const pollSettingsRaw = values.poll_settings?.value?.selected_options?.map(o => o.value) || [];

  const questionText = (values.question_text?.value?.value || '').trim();
  const questionType = values.question_type?.value?.selected_option?.value || 'multiple_choice';
  const optionsRaw = values.question_options?.value?.value || '';
  const allowMultiple = (values.allow_multiple?.value?.selected_options?.length || 0) > 0;

  const restore = {
    pollTitle, pollDescription, pollSettings: pollSettingsRaw,
    questionText, questionType, questionOptions: optionsRaw
  };

  if (!questionText) {
    return client.views.update({
      view_id: body.view.id,
      view: buildCreationModal(channelId, userId, savedQuestions, 'Please enter a question before adding another.', restore)
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
        view: buildCreationModal(channelId, userId, savedQuestions, 'Please enter at least 2 options (one per line).', restore)
      });
    }
  }

  const newQuestion = { text: questionText, type: questionType, options, allowMultiple };

  // Carry poll-level settings in private_metadata so they survive across add_question calls
  const updatedMeta = { channelId, userId, savedQuestions: [...savedQuestions, newQuestion], pollTitle, pollDescription, pollSettings: pollSettingsRaw };

  const updatedModal = buildCreationModal(channelId, userId, [...savedQuestions, newQuestion]);
  updatedModal.private_metadata = JSON.stringify(updatedMeta);

  await client.views.update({ view_id: body.view.id, view: updatedModal });
});

app.view('poll_submit', async ({ ack, body, view, client }) => {
  await ack();

  const meta = JSON.parse(view.private_metadata);
  const { channelId, userId } = meta;
  const values = view.state.values;

  // Poll-level fields (from first page of modal)
  const pollTitle = (values.poll_title?.value?.value || meta.pollTitle || '').trim();
  const pollDescription = (values.poll_description?.value?.value || meta.pollDescription || '').trim();
  const settingsSelected = values.poll_settings?.value?.selected_options?.map(o => o.value) || meta.pollSettings || [];
  const anonymous = settingsSelected.includes('anonymous');
  const allowRevote = settingsSelected.includes('allow_revote');

  // Current (last) question
  const questionText = (values.question_text?.value?.value || '').trim();
  const questionType = values.question_type?.value?.selected_option?.value || 'multiple_choice';
  const optionsRaw = values.question_options?.value?.value || '';
  const allowMultiple = (values.allow_multiple?.value?.selected_options?.length || 0) > 0;

  let options;
  if (questionType === 'yes_no') {
    options = ['Yes', 'No'];
  } else {
    options = optionsRaw.split('\n').map(o => o.trim()).filter(Boolean);
    if (options.length < 2) options = ['Option A', 'Option B'];
  }

  const allQuestions = questionText
    ? [...(meta.savedQuestions || []), { text: questionText, type: questionType, options, allowMultiple }]
    : (meta.savedQuestions || []);

  if (allQuestions.length === 0) return;

  const title = pollTitle || allQuestions[0].text;
  const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  const votes = {};
  allQuestions.forEach((q, qi) => {
    votes[qi] = {};
    q.options.forEach((_, oi) => { votes[qi][oi] = []; });
  });

  const poll = {
    id: pollId,
    title,
    description: pollDescription,
    questions: allQuestions,
    votes,
    anonymous,
    allowRevote,
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

  // Find previous votes for this user
  const previousVotes = {};
  Object.entries(poll.votes).forEach(([qi, qVotes]) => {
    Object.entries(qVotes).forEach(([oi, voters]) => {
      if (voters.includes(userId)) {
        if (!previousVotes[qi]) previousVotes[qi] = [];
        previousVotes[qi].push(parseInt(oi));
      }
    });
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

app.view('vote_submit', async ({ ack, body, view, client }) => {
  await ack();

  const { pollId } = JSON.parse(view.private_metadata);
  const userId = body.user.id;
  const poll = await getPoll(pollId);

  if (!poll || poll.status === 'closed') return;

  // Remove previous votes if revote is allowed
  if (poll.allowRevote) {
    Object.keys(poll.votes).forEach(qi => {
      Object.keys(poll.votes[qi]).forEach(oi => {
        poll.votes[qi][oi] = poll.votes[qi][oi].filter(id => id !== userId);
      });
    });
  } else {
    const hasVoted = Object.values(poll.votes).some(qv =>
      Object.values(qv).some(voters => voters.includes(userId))
    );
    if (hasVoted) return;
  }

  const values = view.state.values;
  poll.questions.forEach((q, qi) => {
    const blockId = `vote_q${qi}`;
    if (q.allowMultiple) {
      const selectedOptions = values[blockId]?.selected?.selected_options || [];
      selectedOptions.forEach(opt => {
        const oi = parseInt(opt.value);
        if (!poll.votes[qi][oi]) poll.votes[qi][oi] = [];
        poll.votes[qi][oi].push(userId);
      });
    } else {
      const selectedValue = values[blockId]?.selected?.selected_option?.value;
      if (selectedValue !== undefined) {
        const oi = parseInt(selectedValue);
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
