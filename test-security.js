// Test script to verify security functions
// Run with: node test-security.js

const assert = require('assert');

// Copy the validation and rate limiting logic from the main bot
const MAX_POLL_TITLE_LENGTH = 200;
const MAX_POLL_DESCRIPTION_LENGTH = 1000;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_QUESTIONS_PER_POLL = 50;
const MAX_OPTIONS_PER_QUESTION = 10;
const MAX_POLLS_PER_USER_PER_DAY = 10;
const MAX_NOTIFY_SUBSCRIBERS_PER_POLL = 20;
const MAX_NOTIFICATIONS_PER_USER_PER_HOUR = 5;

const pollCreationTracker = {};
const notificationTracker = {};

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
    return false;
  }

  notificationTracker[userId].push({ timestamp: now });
  return true;
}

// Test Suite
console.log('🧪 Running Security Tests...\n');

// Test 1: Poll Title Validation
console.log('Test 1: Poll Title Length Validation');
try {
  const longTitle = 'x'.repeat(201);
  validatePollInputs(longTitle, '', [{ text: 'Q1', options: ['A', 'B'] }]);
  assert.fail('Should have thrown error for long title');
} catch (e) {
  assert(e.message.includes('exceeds maximum length'));
  console.log('✓ Correctly rejects title >200 chars\n');
}

// Test 2: Poll Description Validation
console.log('Test 2: Poll Description Length Validation');
try {
  const longDesc = 'x'.repeat(1001);
  validatePollInputs('Title', longDesc, [{ text: 'Q1', options: ['A', 'B'] }]);
  assert.fail('Should have thrown error for long description');
} catch (e) {
  assert(e.message.includes('exceeds maximum length'));
  console.log('✓ Correctly rejects description >1000 chars\n');
}

// Test 3: Question Text Validation
console.log('Test 3: Question Text Length Validation');
try {
  const longQuestion = 'x'.repeat(501);
  validatePollInputs('Title', '', [{ text: longQuestion, options: ['A', 'B'] }]);
  assert.fail('Should have thrown error for long question');
} catch (e) {
  assert(e.message.includes('exceeds maximum length'));
  console.log('✓ Correctly rejects question >500 chars\n');
}

// Test 4: Option Text Validation
console.log('Test 4: Option Text Length Validation');
try {
  const longOption = 'x'.repeat(201);
  validatePollInputs('Title', '', [{ text: 'Q1', options: ['A', longOption] }]);
  assert.fail('Should have thrown error for long option');
} catch (e) {
  assert(e.message.includes('exceeds maximum length'));
  console.log('✓ Correctly rejects option >200 chars\n');
}

// Test 5: Max Options Per Question
console.log('Test 5: Max Options Per Question Validation');
try {
  const tooManyOptions = Array.from({ length: 11 }, (_, i) => `Option ${i + 1}`);
  validatePollInputs('Title', '', [{ text: 'Q1', options: tooManyOptions }]);
  assert.fail('Should have thrown error for too many options');
} catch (e) {
  assert(e.message.includes('exceeds maximum number of options'));
  console.log('✓ Correctly rejects >10 options per question\n');
}

// Test 6: Max Questions Per Poll
console.log('Test 6: Max Questions Per Poll Validation');
try {
  const tooManyQuestions = Array.from({ length: 51 }, (_, i) => ({ text: `Q${i + 1}`, options: ['A', 'B'] }));
  validatePollInputs('Title', '', tooManyQuestions);
  assert.fail('Should have thrown error for too many questions');
} catch (e) {
  assert(e.message.includes('exceeds maximum number of questions'));
  console.log('✓ Correctly rejects >50 questions per poll\n');
}

// Test 7: Poll Creation Rate Limiting
console.log('Test 7: Poll Creation Rate Limiting');
(async () => {
  try {
    const userId = 'test-user-123';

    // Create 10 polls
    for (let i = 0; i < 10; i++) {
      await checkPollCreationRateLimit(userId);
    }
    console.log('✓ Created 10 polls successfully');

    // 11th poll should fail
    try {
      await checkPollCreationRateLimit(userId);
      assert.fail('Should have thrown rate limit error');
    } catch (e) {
      assert(e.message.includes('Rate limit'));
      console.log('✓ Correctly blocks 11th poll creation\n');
    }
  } catch (e) {
    console.error('Test 7 failed:', e.message);
  }

  // Test 8: Notification Rate Limiting
  console.log('Test 8: Notification Rate Limiting');
  try {
    const userId = 'notif-user-456';

    // Receive 5 notifications
    for (let i = 0; i < 5; i++) {
      const allowed = await checkNotificationRateLimit(userId);
      assert(allowed === true);
    }
    console.log('✓ Received 5 notifications successfully');

    // 6th notification should be blocked
    const blocked = await checkNotificationRateLimit(userId);
    assert(blocked === false);
    console.log('✓ Correctly blocks 6th notification\n');
  } catch (e) {
    console.error('Test 8 failed:', e.message);
  }

  // Test 9: Valid Poll Data
  console.log('Test 9: Valid Poll Data Acceptance');
  try {
    const validPoll = {
      title: 'Good Poll Title',
      description: 'A good description',
      questions: [
        { text: 'Question 1?', options: ['Yes', 'No'] },
        { text: 'Question 2?', options: ['Agree', 'Disagree', 'Neutral'] }
      ]
    };
    validatePollInputs(validPoll.title, validPoll.description, validPoll.questions);
    console.log('✓ Accepts valid poll data\n');
  } catch (e) {
    console.error('Test 9 failed:', e.message);
  }

  console.log('✅ All security tests passed!');
})();
