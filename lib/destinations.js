// Where a poll gets posted.
//
// Slack lets an app post into a public channel (chat:write.public covers ones
// it has not joined), a private channel or group DM it has been added to, and
// its own DM with any user in the workspace. It cannot post into a DM between
// two other people: it has no membership there and cannot be given one.
//
// So "share with a person" is not a conversation the picker can offer - it is
// the app's own DM with that person, which is why people are chosen by user id
// and turned into a channel with conversations.open at post time.

// A poll fanned out to more places than this is a mistake, not an intent, and
// every extra destination is another message to keep updated on every vote.
const MAX_DESTINATIONS = 10;

// Slack ids: a letter for the kind, then uppercase alphanumerics.
const ID_SHAPE = /^[A-Z][A-Z0-9]{1,}$/;

function dedupe(ids) {
  return [...new Set(ids)];
}

// Picked channels and people, cleaned up: non-ids dropped, duplicates removed.
// An empty pick means "post where the command was run", which is what
// fallbackChannelId is for - usedFallback says that is what happened, because
// the caller reports it differently.
function normalizeDestinations({ channelIds = [], userIds = [], fallbackChannelId = null } = {}) {
  const channels = dedupe(channelIds.filter(id => typeof id === 'string' && ID_SHAPE.test(id)));
  const users    = dedupe(userIds.filter(id => typeof id === 'string' && ID_SHAPE.test(id)));

  if (!channels.length && !users.length) {
    return {
      channels: fallbackChannelId ? [fallbackChannelId] : [],
      users: [],
      usedFallback: true
    };
  }
  return { channels, users, usedFallback: false };
}

// The pickers carry max_selected_items so Slack enforces this before submission;
// this is the backstop for a payload that arrives with more anyway.
function assertDestinationLimit({ channels = [], users = [] }) {
  const total = channels.length + users.length;
  if (total > MAX_DESTINATIONS) {
    throw new Error(`A poll can be posted to at most ${MAX_DESTINATIONS} places at once (you picked ${total}).`);
  }
}

// Two picks can land on the same channel - a person who is also reachable as an
// already-listed group DM, or the same channel picked in two rounds of the
// modal. Posting twice would give one poll two messages in one place, both
// updated on every vote.
function dedupeTargets(targets) {
  const seen = new Set();
  return targets.filter(t => {
    if (seen.has(t.channel)) return false;
    seen.add(t.channel);
    return true;
  });
}

module.exports = { MAX_DESTINATIONS, normalizeDestinations, assertDestinationLimit, dedupeTargets, dedupe };
