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

// Which questions this person has already answered, by index. The vote button
// and the vote submission each used to carry their own copy of this test and
// both asked only "has this person answered anything". That was harmless while
// the modal was the only way to vote - it answers every question at once - but
// the message's own buttons answer one question at a time, so with vote changes
// off, one press locked the person out of every question still waiting.
function answeredQuestions(poll, userId) {
  const answered = new Set();
  (poll?.questions || []).forEach((q, qi) => {
    const qv = pollVotes(poll)[qi] || {};
    const has = q.type === 'open_ended' || q.type === 'ranking'
      ? !!qv[userId]
      : q.type === 'likert'
        ? Object.values(qv).some(r => r && typeof r === 'object' &&
            Object.values(r).some(v => Array.isArray(v) && v.includes(userId)))
        : Object.values(qv).some(v => Array.isArray(v) && v.includes(userId));
    if (has) answered.add(qi);
  });
  return answered;
}

// What this person may still do on a poll, decided once for the Vote button
// and the vote submission both - two copies of the old "has voted" test are
// how the lock-out bug happened. With vote changes off, answered questions are
// locked and the poll is finished once every question is answered; with them
// on, nothing is ever locked.
function votingState(poll, userId) {
  const answered = answeredQuestions(poll, userId);
  const locked = poll?.allowRevote ? new Set() : answered;
  const total = (poll?.questions || []).length;
  return { answered, locked, finished: total > 0 && locked.size === total };
}

// This person's answers, in the shape the vote modal pre-fills from: option
// indexes for a list question, [text] for an open one, { ratings: {statement:
// rating} } for a Likert grid and { ranks: [...] } for a ranking. The last two
// used to come back as a bare `true`, so "Change Your Vote" opened on a blank
// grid and every rating had to be given again to change one.
function previousAnswers(poll, userId) {
  const answers = {};
  (poll?.questions || []).forEach((q, qi) => {
    const qv = pollVotes(poll)[qi] || {};
    if (q.type === 'open_ended') {
      if (qv[userId]) answers[qi] = [qv[userId]];
    } else if (q.type === 'ranking') {
      if (qv[userId]) answers[qi] = { ranks: String(qv[userId]).split(',') };
    } else if (q.type === 'likert') {
      const ratings = {};
      Object.entries(qv).forEach(([si, byRating]) => {
        Object.entries(byRating || {}).forEach(([rating, uids]) => {
          if (Array.isArray(uids) && uids.includes(userId)) ratings[si] = rating;
        });
      });
      if (Object.keys(ratings).length) answers[qi] = { ratings };
    } else {
      const picked = Object.entries(qv)
        .filter(([, uids]) => Array.isArray(uids) && uids.includes(userId))
        .map(([oi]) => parseInt(oi, 10));
      if (picked.length) answers[qi] = picked;
    }
  });
  return answers;
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

module.exports = { getAllVoters, answeredQuestions, votingState, previousAnswers, pollMessageRefs, pollVotes, pollDisplayTitle };
