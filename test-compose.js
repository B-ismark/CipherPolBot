// Tests for lib/compose.js — reading a question out of what somebody typed.
//
// The command-line parser is the one place a poll can be written without a form
// to validate it, so its edge cases are worth pinning down: it is the only
// input path where a stray separator decides whether a poll has two choices or
// three.

const test = require('node:test');
const assert = require('node:assert');

const {
  AUTO_OPTION_TYPES, MULTI_SELECT_FORM_TYPE, parseOptions, parseComposeArgs,
  questionFormError, resolveQuestionType, formTypeFor
} = require('./lib/compose');

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

// ==================== form type <-> stored question ====================
//
// "Pick several" is an entry in the type picker rather than a checkbox, so the
// form speaks a slightly different language from the database. These two
// functions are the whole translation, and the round trip is what makes editing
// an existing question show the right entry selected.

// Every type the picker offers.
const FORM_TYPES = [
  'multiple_choice', MULTI_SELECT_FORM_TYPE, 'yes_no', 'agree_disagree',
  'scale_5', 'scale_10', 'nps', 'likert', 'ranking', 'open_ended'
];

test('picking several resolves to a multiple choice question that allows it', () => {
  assert.deepStrictEqual(resolveQuestionType(MULTI_SELECT_FORM_TYPE), { type: 'multiple_choice', allowMultiple: true });
});

test('picking one resolves to the same question type, without it', () => {
  assert.deepStrictEqual(resolveQuestionType('multiple_choice'), { type: 'multiple_choice', allowMultiple: false });
});

test('every other type passes through unchanged and never allows multiple', () => {
  for (const type of FORM_TYPES.filter(t => t !== MULTI_SELECT_FORM_TYPE)) {
    assert.deepStrictEqual(resolveQuestionType(type), { type, allowMultiple: false }, type);
  }
});

test('a missing type falls back to multiple choice rather than undefined', () => {
  assert.deepStrictEqual(resolveQuestionType(undefined), { type: 'multiple_choice', allowMultiple: false });
  assert.deepStrictEqual(resolveQuestionType(''), { type: 'multiple_choice', allowMultiple: false });
});

test('every form type survives a round trip, so editing preselects what was chosen', () => {
  for (const formType of FORM_TYPES) {
    assert.strictEqual(formTypeFor(resolveQuestionType(formType)), formType, formType);
  }
});

test('a multi-select question stored before this change maps back to the new entry', () => {
  // The stored shape is unchanged, so polls already in the database still edit
  // correctly - this is the case that would silently turn a multi-select
  // question into a single-choice one if the translation were one-way.
  const stored = { text: 'Pick any', type: 'multiple_choice', options: ['A', 'B'], allowMultiple: true };
  assert.strictEqual(formTypeFor(stored), MULTI_SELECT_FORM_TYPE);
});

test('formTypeFor tolerates a question with nothing on it', () => {
  assert.strictEqual(formTypeFor({}), 'multiple_choice');
  assert.strictEqual(formTypeFor(), 'multiple_choice');
});

test('picking several still needs at least two choices typed', () => {
  assert.strictEqual(questionFormError({ text: 'Pick any', type: MULTI_SELECT_FORM_TYPE, optionsRaw: 'A' }), 'options');
  assert.strictEqual(questionFormError({ text: 'Pick any', type: MULTI_SELECT_FORM_TYPE, optionsRaw: 'A\nB' }), null);
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
