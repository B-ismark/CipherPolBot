// Tests for lib/compose.js — reading a question out of what somebody typed.
//
// The command-line parser is the one place a poll can be written without a form
// to validate it, so its edge cases are worth pinning down: it is the only
// input path where a stray separator decides whether a poll has two choices or
// three.

const test = require('node:test');
const assert = require('node:assert');

const { AUTO_OPTION_TYPES, parseOptions, parseComposeArgs, questionFormError } = require('./lib/compose');

// ==================== parseOptions ====================

test('choices split on newlines when there are any', () => {
  assert.deepStrictEqual(parseOptions('Thai\nSushi\nPizza'), ['Thai', 'Sushi', 'Pizza']);
});

test('choices split on commas when there are no newlines', () => {
  assert.deepStrictEqual(parseOptions('Thai, Sushi, Pizza'), ['Thai', 'Sushi', 'Pizza']);
});

test('a choice may contain a comma if the choices are on their own lines', () => {
  assert.deepStrictEqual(parseOptions('Thai, but late\nSushi'), ['Thai, but late', 'Sushi']);
});

test('blank and whitespace-only entries are dropped, not counted', () => {
  assert.deepStrictEqual(parseOptions('Thai,,  , Sushi,'), ['Thai', 'Sushi']);
});

test('nothing typed is no choices rather than a crash', () => {
  assert.deepStrictEqual(parseOptions(''), []);
  assert.deepStrictEqual(parseOptions(undefined), []);
});

// ==================== parseComposeArgs ====================

test('the question mark divides the question from its choices', () => {
  assert.deepStrictEqual(
    parseComposeArgs('Lunch? Thai, Sushi, Pizza'),
    { text: 'Lunch?', options: 'Thai\nSushi\nPizza' }
  );
});

test('the question keeps its question mark', () => {
  assert.strictEqual(parseComposeArgs('Ship on Friday? Yes, No').text, 'Ship on Friday?');
});

test('no question mark means the whole thing is the question', () => {
  assert.deepStrictEqual(
    parseComposeArgs('Pick a lunch spot'),
    { text: 'Pick a lunch spot', options: '' }
  );
});

test('a question with no choices after it leaves the choices empty', () => {
  assert.deepStrictEqual(parseComposeArgs('Lunch?'), { text: 'Lunch?', options: '' });
});

test('only the first question mark divides, so a choice may contain one', () => {
  assert.deepStrictEqual(
    parseComposeArgs('Which one? Really?, Truly?'),
    { text: 'Which one?', options: 'Really?\nTruly?' }
  );
});

test('no text at all prefills nothing, leaving the form untouched', () => {
  assert.deepStrictEqual(parseComposeArgs(''), {});
  assert.deepStrictEqual(parseComposeArgs('   '), {});
  assert.deepStrictEqual(parseComposeArgs(undefined), {});
});

test('surrounding whitespace never reaches the question or its choices', () => {
  assert.deepStrictEqual(
    parseComposeArgs('   Lunch?   Thai ,  Sushi   '),
    { text: 'Lunch?', options: 'Thai\nSushi' }
  );
});

// ==================== questionFormError ====================

test('a question with two choices is ready to post', () => {
  assert.strictEqual(
    questionFormError({ text: 'Lunch?', type: 'multiple_choice', optionsRaw: 'Thai\nSushi' }),
    null
  );
});

test('an unwritten question is reported against the question field', () => {
  assert.strictEqual(questionFormError({ text: '', type: 'multiple_choice', optionsRaw: 'Thai\nSushi' }), 'text');
});

test('a single choice is not a poll, and is reported against the choices', () => {
  assert.strictEqual(questionFormError({ text: 'Lunch?', type: 'multiple_choice', optionsRaw: 'Thai' }), 'options');
});

test('types that supply their own answers need no choices typed', () => {
  for (const type of AUTO_OPTION_TYPES) {
    assert.strictEqual(
      questionFormError({ text: 'Ship it?', type, optionsRaw: '' }),
      null,
      `${type} should not require choices`
    );
  }
});

test('ranking and likert still need their own items typed', () => {
  assert.strictEqual(questionFormError({ text: 'Rank these', type: 'ranking', optionsRaw: 'A' }), 'options');
  assert.strictEqual(questionFormError({ text: 'Rate these', type: 'likert', optionsRaw: '' }), 'options');
});

test('an empty form reports the question first, so one message covers it', () => {
  assert.strictEqual(questionFormError({}), 'text');
  assert.strictEqual(questionFormError(), 'text');
});

// ==================== the two together ====================

test('a command line with a question and two choices posts without more typing', () => {
  const prefill = parseComposeArgs('Lunch? Thai, Sushi');
  assert.strictEqual(
    questionFormError({ text: prefill.text, type: 'multiple_choice', optionsRaw: prefill.options }),
    null
  );
});

test('a command line with only a question still needs its choices', () => {
  const prefill = parseComposeArgs('Lunch?');
  assert.strictEqual(
    questionFormError({ text: prefill.text, type: 'multiple_choice', optionsRaw: prefill.options }),
    'options'
  );
});

test('a command line with only a question is enough for a yes/no poll', () => {
  const prefill = parseComposeArgs('Ship on Friday?');
  assert.strictEqual(
    questionFormError({ text: prefill.text, type: 'yes_no', optionsRaw: prefill.options }),
    null
  );
});
