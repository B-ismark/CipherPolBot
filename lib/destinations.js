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

// Everything from normalizeDestinations down is pure. Everything below the
// divider takes a Slack client and is testable with a stub one, which is the
// whole reason it lives here: it used to sit in slack-poll-bot.js, and
// requiring that file opens a Postgres pool, so the path that turns a picked
// person into a delivered DM had no test of any kind. Three of the four faults
// fixed in this file were sitting in code that read correctly.

const {
  canNotify, spendNotification, notificationLimitMessage
} = require('./validation');

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

// ==================== the part that talks to Slack ====================

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

// Turns the channels and people someone picked into channels this app can
// actually post in. A person becomes the app's own DM with them - see the top
// of this file for why that is the only way to reach an individual.
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
    //
    // Except to yourself. The cap exists to protect people from someone else's
    // enthusiasm, and you are not someone else - a poll its own creator cannot
    // vote in is broken, which is why an unpicked creator gets a copy anyway,
    // with no budget consulted. Charging for the picked copy and not the
    // automatic one had it backwards: picking yourself was the one way to be
    // refused.
    const isSelf = uid === actorId;
    if (!isSelf && !canNotify(uid)) {
      failures.push({ label: `<@${uid}>`, reason: notificationLimitMessage() });
      continue;
    }
    try {
      const r = await client.conversations.open({ users: uid });
      targets.push({ channel: r.channel.id, label: `<@${uid}>`, spendFor: isSelf ? null : uid });
    } catch (e) {
      failures.push({ label: `<@${uid}>`, reason: e.data?.error || e.message });
    }
  }

  return { targets: dedupeTargets(targets), failures, redirected, usedFallback };
}

// Posts the poll into every target, keeping the ones that worked. Slack fails a
// single destination for its own reasons - a private channel the app was never
// invited to, a deactivated account - and that must not lose the others.
//
// Takes the built message rather than the poll: what a poll looks like is the
// view layer's business, and reaching for it here would have this module and
// lib/views.js require each other.
async function postPollTo(client, { text, blocks }, targets) {
  const results = await Promise.allSettled(targets.map(t =>
    client.chat.postMessage({ channel: t.channel, text, blocks })
      .then(r => ({ channelId: t.channel, messageTs: r.ts }))
  ));

  const posted = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      posted.push({ ...r.value, label: targets[i].label });
      // The recipient's hourly budget is charged here, once the DM has actually
      // arrived, and nowhere else. It used to be spent at the moment of asking,
      // so a DM that failed to open or failed to post still cost a slot: five
      // failures and the person was locked out of a feature that had never
      // delivered them anything. Retrying made it permanent.
      if (targets[i].spendFor) spendNotification(targets[i].spendFor);
    } else {
      failures.push({ label: targets[i].label, reason: r.reason?.data?.error || r.reason?.message });
    }
  });
  return { posted, failures };
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
// to offer, and the fix is usually the same one sentence. A missing scope is
// the exception worth naming: it is the one cause the reader cannot fix by
// inviting anyone, and the one that makes every DM fail at once.
//
// Slack's own error strings are kept verbatim alongside the advice. They are
// ugly, and they are the only thing that says which of several possible causes
// actually fired - the whole reason this poll's failure took a round of
// guessing to narrow down.
function describeFailures(failures) {
  const list = failures.map(f => `${f.label} (${f.reason})`).join(', ');
  const reasons = failures.map(f => `${f.reason}`).join(' ');
  return `Could not post to ${list}.`
    + (/not_in_channel|channel_not_found/.test(reasons)
        ? ' For a private channel, invite me to it first (`/invite @Cipher Pol`).' : '')
    + (/missing_scope/.test(reasons)
        ? ' A DM needs the `im:write` scope - if the app was installed before that was added, it has to be reinstalled to pick it up.' : '')
    + (/cannot_dm_bot|user_not_found|user_disabled|users_not_found/.test(reasons)
        ? ' A deactivated account, or an app rather than a person, cannot be sent a poll.' : '');
}

// Every refusal, in the log as well as in the message.
//
// The message can be missed - it is one line in a DM, and it used to be an
// ephemeral that vanished on the next reload - and when it is, there is nothing
// left anywhere that says why a poll went nowhere. This is the copy that
// survives being missed.
function logFailures(where, failures) {
  for (const f of failures) {
    console.warn(`${where}: could not post to ${f.label} - ${f.reason}`);
  }
}

// message_refs is stored, so it keeps only what a later chat.update needs - a
// label would be a copy of a channel name that goes stale on the first rename.
function toMessageRefs(posted) {
  return posted.map(({ channelId, messageTs }) => ({ channelId, messageTs }));
}

module.exports = {
  MAX_DESTINATIONS, normalizeDestinations, assertDestinationLimit, dedupeTargets, dedupe,
  resolveChannelInfo, resolveDestinations, postPollTo, reachesCreator, describeFailures, logFailures, toMessageRefs
};
