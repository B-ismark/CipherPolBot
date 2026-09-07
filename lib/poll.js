// Pure reads over a poll's stored data. Both the view layer and the handlers
// need these, and neither owns them: "how many distinct people answered" and
// "where are this poll's messages" are questions about a poll, not about a
// screen or a request. Required by slack-poll-bot.js and lib/views.js, and
// exercised by test-views.js.

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

// Every message this poll has. messageRefs is the current shape; polls created
// before it carry a single channelId/messageTs pair instead. Both callers have
// to agree on that fallback or they will disagree about where the poll is - one
// updating its messages, the other deciding where its final results belong.
function pollMessageRefs(poll) {
  if (poll.messageRefs?.length) return poll.messageRefs;
  return poll.channelId && poll.messageTs ? [{ channelId: poll.channelId, messageTs: poll.messageTs }] : [];
}

module.exports = { getAllVoters, pollMessageRefs };
