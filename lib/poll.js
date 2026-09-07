// Pure reads over a poll's stored data. Both the view layer and the handlers
// need these, and neither owns them: "how many distinct people answered" and
// "where are this poll's messages" are questions about a poll, not about a
// screen or a request. Required by slack-poll-bot.js and lib/views.js, and
// exercised by test-views.js.

// Every answer cast, whatever shape the stored row is in. A poll is created
// with an empty object, so in normal running this is never absent - but a row
// whose column came back null crashes anything that indexes into it, and
// `poll.votes[qi] || {}` guards the wrong level: it throws before the fallback
// can apply. That fault took out the whole poll list rather than one poll,
// because the list maps over every row a person owns.
//
// Same reason pollMessageRefs exists: every caller has to agree on the fallback
// or they disagree about the poll.
function pollVotes(poll) {
  return poll?.votes || {};
}

function getAllVoters(poll) {
  const voters = new Set();
  Object.entries(pollVotes(poll)).forEach(([qi, qv]) => {
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

// What to call a poll on screen. The title is optional at creation - a
// single-question poll is named after its question - and createAndPostPoll
// already applies exactly this fallback when it stores one. Repeating the rule
// here is what keeps a row written by an older version, or one whose title
// somehow came back empty, from being posted to a channel reading "undefined".
function pollDisplayTitle(poll) {
  return poll?.title || poll?.questions?.[0]?.text || 'Poll';
}

module.exports = { getAllVoters, pollMessageRefs, pollVotes, pollDisplayTitle };
