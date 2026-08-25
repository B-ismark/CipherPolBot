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

// Process-local: both reset on restart. Move to the polls DB if abuse survives
// a redeploy becomes a real concern.
const pollCreationTracker = {}; // { userId: [{ timestamp }] }
const notificationTracker = {}; // { userId: [{ timestamp }] }

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

async function checkPollCreationRateLimit(userId) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  if (!pollCreationTracker[userId]) {
    pollCreationTracker[userId] = [];
  }

  pollCreationTracker[userId] = pollCreationTracker[userId].filter(entry => entry.timestamp > dayAgo);

  if (pollCreationTracker[userId].length >= MAX_POLLS_PER_USER_PER_DAY) {
    throw new Error(`Rate limit: You can create a maximum of ${MAX_POLLS_PER_USER_PER_DAY} polls per day.`);
  }

  pollCreationTracker[userId].push({ timestamp: now });
}

async function checkNotificationRateLimit(userId) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  if (!notificationTracker[userId]) {
    notificationTracker[userId] = [];
  }

  notificationTracker[userId] = notificationTracker[userId].filter(entry => entry.timestamp > hourAgo);

  if (notificationTracker[userId].length >= MAX_NOTIFICATIONS_PER_USER_PER_HOUR) {
    return false; // User has hit limit for this hour
  }

  notificationTracker[userId].push({ timestamp: now });
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
  validatePollInputs,
  checkPollCreationRateLimit,
  checkNotificationRateLimit
};
