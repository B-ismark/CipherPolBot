// Input limits, poll validation and in-memory rate limiting.
// Required by slack-poll-bot.js and exercised by test-security.js — keep it the
// single source of truth so the tests cannot drift from what the bot enforces.

const MAX_POLL_TITLE_LENGTH = 200;
const MAX_POLL_DESCRIPTION_LENGTH = 1000;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_QUESTIONS_PER_POLL = 50;
const MAX_OPTIONS_PER_QUESTION = 10;
const MAX_POLLS_PER_USER_PER_DAY = 10;
const MAX_NOTIFY_SUBSCRIBERS_PER_POLL = 20;
const MAX_NOTIFICATIONS_PER_USER_PER_HOUR = 5;
// Anyone who can see a poll can send it on, by design - that is what sharing is.
// This is the ceiling on how far one person can fan one out per hour, counted
// per destination, because ten channels at a time is the abuse shape.
const MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR = 30;

// Process-local: all reset on restart. Move to the polls DB if abuse surviving
// a redeploy becomes a real concern.
const pollCreationTracker = {}; // { userId: [{ timestamp }] }
const notificationTracker = {}; // { userId: [{ timestamp }] }
const shareTracker = {};        // { userId: [{ timestamp }] }

// One window, three callers. cost is how much of the budget this one action
// spends: sharing to five channels is five, not one.
function withinLimit(tracker, userId, limit, windowMs, cost = 1) {
  const now = Date.now();
  const cutoff = now - windowMs;
  tracker[userId] = (tracker[userId] || []).filter(entry => entry.timestamp > cutoff);
  return tracker[userId].length + cost <= limit;
}

function spend(tracker, userId, cost = 1) {
  const now = Date.now();
  for (let i = 0; i < cost; i++) tracker[userId].push({ timestamp: now });
}

function validatePollInputs(title, description, questions) {
  if (!title || title.trim().length === 0) {
    throw new Error('Poll title is required.');
  }
  if (title.length > MAX_POLL_TITLE_LENGTH) {
    throw new Error(`Poll title exceeds maximum length of ${MAX_POLL_TITLE_LENGTH} characters.`);
  }
  if (description && description.length > MAX_POLL_DESCRIPTION_LENGTH) {
    throw new Error(`Poll description exceeds maximum length of ${MAX_POLL_DESCRIPTION_LENGTH} characters.`);
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('Poll must have at least one question.');
  }
  if (questions.length > MAX_QUESTIONS_PER_POLL) {
    throw new Error(`Poll exceeds maximum number of questions (${MAX_QUESTIONS_PER_POLL}).`);
  }
  questions.forEach((q, idx) => {
    if (!q.text || q.text.trim().length === 0) {
      throw new Error(`Question ${idx + 1}: text is required.`);
    }
    if (q.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new Error(`Question ${idx + 1}: exceeds maximum length of ${MAX_QUESTION_TEXT_LENGTH} characters.`);
    }
    if (q.options && Array.isArray(q.options)) {
      if (q.options.length > MAX_OPTIONS_PER_QUESTION) {
        throw new Error(`Question ${idx + 1}: exceeds maximum number of options (${MAX_OPTIONS_PER_QUESTION}).`);
      }
      q.options.forEach((opt, oidx) => {
        if (opt.length > MAX_OPTION_TEXT_LENGTH) {
          throw new Error(`Question ${idx + 1}, Option ${oidx + 1}: exceeds maximum length of ${MAX_OPTION_TEXT_LENGTH} characters.`);
        }
      });
    }
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Whether another poll would be allowed, without spending the budget on asking.
// Opening the modal and changing your mind must not cost a poll, so the check at
// the door and the check at the till have to be separate things.
function canCreatePoll(userId) {
  return withinLimit(pollCreationTracker, userId, MAX_POLLS_PER_USER_PER_DAY, DAY_MS);
}

function pollCreationLimitMessage() {
  return `Rate limit: You can create a maximum of ${MAX_POLLS_PER_USER_PER_DAY} polls per day.`;
}

async function checkPollCreationRateLimit(userId) {
  if (!canCreatePoll(userId)) throw new Error(pollCreationLimitMessage());
  spend(pollCreationTracker, userId);
}

// Sharing is open to anyone who can see the poll, so this is the only thing
// standing between one member and every channel in the workspace. Returns false
// rather than throwing: the share handler reports failures, it does not crash.
async function checkShareRateLimit(userId, destinationCount = 1) {
  if (!withinLimit(shareTracker, userId, MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR, HOUR_MS, destinationCount)) {
    return false;
  }
  spend(shareTracker, userId, destinationCount);
  return true;
}

async function checkNotificationRateLimit(userId) {
  if (!withinLimit(notificationTracker, userId, MAX_NOTIFICATIONS_PER_USER_PER_HOUR, HOUR_MS)) {
    return false; // this person has had their fill of DMs from us this hour
  }
  spend(notificationTracker, userId);
  return true;
}

module.exports = {
  MAX_POLL_TITLE_LENGTH,
  MAX_POLL_DESCRIPTION_LENGTH,
  MAX_QUESTION_TEXT_LENGTH,
  MAX_OPTION_TEXT_LENGTH,
  MAX_QUESTIONS_PER_POLL,
  MAX_OPTIONS_PER_QUESTION,
  MAX_POLLS_PER_USER_PER_DAY,
  MAX_NOTIFY_SUBSCRIBERS_PER_POLL,
  MAX_NOTIFICATIONS_PER_USER_PER_HOUR,
  MAX_SHARE_DESTINATIONS_PER_USER_PER_HOUR,
  validatePollInputs,
  canCreatePoll,
  pollCreationLimitMessage,
  checkPollCreationRateLimit,
  checkShareRateLimit,
  checkNotificationRateLimit
};
