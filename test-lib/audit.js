// The shared audit: Slack's view limits, the platform rules we have learned the
// hard way, and one corpus of input designed to break things.
//
// This is deliberately a module rather than a section of a test file. A rule
// that lives in one test protects one screen; a rule that lives here protects
// every screen that passes through auditView - including screens nobody has
// written yet. Both rules currently in here were added after a real screen
// shipped broken, so the point is not theoretical: the value of the audit is
// that a fault, once understood, cannot come back anywhere.
//
// Add a rule here, never to a single test.

const assert = require('node:assert');

// ==================== Slack's documented limits ====================
//
// Slack does not partially render a bad view. It rejects the whole thing, shows
// the user nothing and says nothing, so these are the difference between a
// screen and a silent failure.

const LIMITS = {
  blocksPerView: 100,
  viewTitle: 24,
  buttonText: 75,
  headerText: 150,
  sectionText: 3000,
  contextElements: 10,
  actionElements: 25,
  privateMetadata: 3000,
  optionText: 75,
  placeholderText: 150,
  inputLabel: 2000
};

// Pictographs, dingbats, arrows and the variation selector - the ranges Slack
// has a :shortcode: for and will therefore escape in a view's chrome.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

// ==================== rules learned from shipped defects ====================

// An emoji is two UTF-16 code units. Any trim that slices between them leaves a
// lone surrogate, which reaches the reader as a broken glyph - and every string
// we trim is something a person typed, so one can sit exactly on the boundary.
//
// A high surrogate with no low one after it, or a low with no high before it.
// One regex scan rather than spreading the string into an array of characters:
// this runs on every text node of every screen for every input, and the array
// version was most of a forty-second test run on its own.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function halfEmoji(s) {
  return LONE_SURROGATE.test(String(s));
}

// A template hole that evaluated to nothing. Slack renders it happily, so it
// only ever shows up in a screenshot.
const TEMPLATE_HOLE = /\b(undefined|NaN|\[object Object\])\b/;

// Every string a person will read, with a path saying where it came from, so a
// failure names the field rather than making you search a JSON dump.
function* textNodes(node, path = '') {
  if (!node || typeof node !== 'object') return;
  if (typeof node.text === 'string') yield [path + '.text', node.text];
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') yield* textNodes(v, `${path}.${k}`);
  }
}

// The checks that apply to any user-visible text anywhere, whatever built it.
function auditText(node, label) {
  for (const [path, text] of textNodes(node)) {
    assert.ok(!halfEmoji(text),
      `${label}: ${path} carries half an emoji - a trim cut a surrogate pair: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, TEMPLATE_HOLE,
      `${label}: ${path} leaked a template hole: ${JSON.stringify(text)}`);
  }
  // Slack takes JSON. A structure that will not round-trip cannot be sent.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(node)), `${label}: does not survive JSON`);
}

function auditView(view, label) {
  assert.ok(view && Array.isArray(view.blocks), `${label}: not a view`);
  assert.ok(view.blocks.length <= LIMITS.blocksPerView,
    `${label}: ${view.blocks.length} blocks exceeds ${LIMITS.blocksPerView}`);

  for (const key of ['title', 'submit', 'close']) {
    if (view[key]) {
      assert.ok(view[key].text.length <= LIMITS.viewTitle,
        `${label}: ${key} "${view[key].text}" is ${view[key].text.length} chars, over ${LIMITS.viewTitle}`);
      // A modal's chrome is not block content: Slack escapes an emoji here back
      // into its :shortcode:, so "🚀 Post Poll" reaches the user reading
      // literally ":rocket: Post Poll". It renders fine inside a block, which
      // is what made this look like a mystery rather than a rule - the same
      // character worked three blocks further down the same screen.
      assert.doesNotMatch(view[key].text, EMOJI,
        `${label}: ${key} "${view[key].text}" carries an emoji, which Slack will show as a :shortcode:`);
    }
  }

  const meta = view.private_metadata || '';
  assert.ok(meta.length <= LIMITS.privateMetadata,
    `${label}: private_metadata is ${meta.length} chars, over ${LIMITS.privateMetadata}`);

  auditBlocks(view.blocks, label);
  // Only the chrome here: auditBlocks has already walked the blocks, and
  // walking the same tree twice per screen is pure cost.
  auditText({ title: view.title, submit: view.submit, close: view.close }, label);

  // Slack rejects a view whose input blocks collide on block_id, and the error
  // does not say which one.
  const ids = view.blocks.filter(b => b.block_id).map(b => b.block_id);
  assert.strictEqual(new Set(ids).size, ids.length, `${label}: duplicate block_id among ${ids.join(', ')}`);
}

function auditBlocks(blocks, label) {
  assert.ok(Array.isArray(blocks), `${label}: not a block list`);
  for (const b of blocks) {
    if (b.type === 'header') {
      assert.ok(b.text.text.length <= LIMITS.headerText,
        `${label}: header is ${b.text.text.length} chars, over ${LIMITS.headerText}`);
    }
    if (b.type === 'section' && b.text) {
      assert.ok(b.text.text.length <= LIMITS.sectionText,
        `${label}: section is ${b.text.text.length} chars, over ${LIMITS.sectionText}`);
    }
    if (b.type === 'context') {
      assert.ok(b.elements.length <= LIMITS.contextElements, `${label}: too many context elements`);
      for (const e of b.elements) {
        if (typeof e.text === 'string') continue;
        if (e.text) {
          assert.ok(e.text.text.length <= LIMITS.sectionText, `${label}: context element too long`);
        }
      }
    }
    if (b.type === 'actions') {
      assert.ok(b.elements.length <= LIMITS.actionElements, `${label}: too many action elements`);
      for (const e of b.elements) {
        if (e.type === 'button') {
          assert.ok(e.text.text.length <= LIMITS.buttonText,
            `${label}: button "${e.text.text}" is ${e.text.text.length} chars, over ${LIMITS.buttonText}`);
        }
      }
    }
    if (b.type === 'input') {
      assert.ok(!!b.block_id, `${label}: an input block has no block_id, so its value cannot be read back`);
      if (b.label) {
        assert.ok(b.label.text.length <= LIMITS.inputLabel, `${label}: input label too long`);
      }
    }
    // Selects reject an option label over 75 characters, and a placeholder over
    // 150 - the same silent whole-view rejection as everything else here.
    for (const el of [b.element, b.accessory, ...(b.elements || [])].filter(Boolean)) {
      if (el.placeholder) {
        assert.ok(el.placeholder.text.length <= LIMITS.placeholderText,
          `${label}: placeholder is ${el.placeholder.text.length} chars, over ${LIMITS.placeholderText}`);
      }
      const opts = [
        ...(el.options || []),
        ...(el.option_groups || []).flatMap(g => g.options || []),
        ...(el.initial_option ? [el.initial_option] : []),
        ...(el.initial_options || [])
      ];
      for (const o of opts) {
        assert.ok(o.text.text.length <= LIMITS.optionText,
          `${label}: option "${o.text.text}" is ${o.text.text.length} chars, over ${LIMITS.optionText}`);
      }
    }
  }
  auditText({ blocks }, label);
}

// ==================== the hostile corpus ====================
//
// One list, fed through every builder by test-hostile.js. Each entry is
// something a person can actually type into a poll, or something a platform
// treats specially. Adding an entry here retro-tests every screen at once,
// which is the only reason coverage of this kind is affordable.
//
// Each is [label, value] so a failure says which input broke it.
//
// The list is split because the two halves earn different promises. Anything a
// validator will actually accept has to build a screen Slack will render - that
// is a hard guarantee, and it is where both shipped defects lived. Input beyond
// every cap cannot reach a builder through the app at all, so demanding Slack
// validity of it would be asserting a state that does not exist; it is still
// run, to prove nothing throws and nothing comes out mangled.
const HOSTILE = [
  ['empty', ''],
  ['whitespace only', '   \t  '],
  ['single char', 'x'],

  // Length, up to what the validator permits. MAX_POLL_TITLE_LENGTH is 200 and
  // MAX_OPTION_TEXT_LENGTH is 200, while a Slack header caps at 150 and an
  // option label at 75 - so the legal range already overshoots the platform in
  // two places, which is the whole reason these are here.
  ['at the title cap', 'T'.repeat(200)],
  ['just over an option label', 'O'.repeat(76)],
  ['just over a header', 'H'.repeat(151)],
  ['one unbroken word', 'x'.repeat(200)],

  // Emoji. The half-emoji defect was exactly this, at exactly one length.
  ['emoji only', '🎉🎉🎉'],
  ['emoji astride the header trim', 'x'.repeat(148) + '🎉' + 'tail'],
  ['emoji astride the summary trim', 'x'.repeat(70) + '🎉' + 'tail'],
  ['zwj sequence', '👨‍👩‍👧‍👦 family day'],
  ['skin tone modifier', '👍🏽 approved'],
  ['flag (regional indicators)', '🇬🇭 Ghana office'],
  ['variation selector', '☑️ text-default symbol'],

  // Slack markup. These are not escaped by us anywhere, so the question is only
  // whether they can produce something malformed rather than merely ugly.
  ['unbalanced bold', '*not closed'],
  ['unbalanced code fence', '```not closed'],
  ['every marker at once', '*b* _i_ ~s~ `c` >q'],
  ['a fake channel mention', '<#C000000|not-real>'],
  ['a fake user mention', '<@U000000>'],
  ['a broadcast mention', '<!channel> everyone'],
  ['a bare angle bracket', 'a < b > c'],
  ['a link', '<https://example.com|click>'],

  // Whitespace and control characters.
  ['newlines', 'first line\nsecond line'],
  ['carriage return', 'first\r\nsecond'],
  ['tabs', 'a\tb\tc'],
  ['zero width space', 'in​visible'],
  ['rtl override', 'file‮gnp.exe'],

  // Direction and script.
  ['arabic', 'ما هو غدائك المفضل؟'],
  ['hebrew mixed with latin', 'שלום Lunch? כן'],
  ['cjk', '今日のランチは何にしますか'],
  ['combining marks', 'é́́́ stacked'],

  // Quoting and escaping.
  ['double quotes', 'He said "yes" loudly'],
  ['curly quotes', '“smart” quotes'],
  ['backslash', 'a\\b\\c'],
  ['json-looking', '{"text":"not json"}'],

  // Spreadsheet formula injection, for the CSV export.
  ['equals formula', '=SUM(A1:A9)'],
  ['plus formula', '+1+1'],
  ['minus formula', '-1-1'],
  ['at formula', '@SUM(A1)'],
  ['tab then formula', '\t=cmd|calc'],
  ['cr then formula', '\r=cmd|calc']
];

// Beyond anything the validator will pass, so no builder can be reached with
// it through the app. The promise here is only that it cannot crash or produce
// mangled text - not that the result fits a Slack view, because a poll of this
// shape cannot exist to be shown.
const EXTREME = [
  ['far over every cap', 'T'.repeat(5000)],
  ['twenty thousand characters', 'T'.repeat(20000)],
  ['many emoji over the cap', '🎉'.repeat(500)],
  ['newlines over the cap', 'line\n'.repeat(500)]
];

module.exports = {
  LIMITS, EMOJI, HOSTILE, EXTREME, TEMPLATE_HOLE,
  halfEmoji, textNodes, auditText, auditView, auditBlocks
};
