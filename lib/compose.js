// Reading a question out of what somebody typed — on a form or on the command
// line. Required by slack-poll-bot.js and exercised by test-compose.js; keep it
// the single source of truth so the tests cannot drift from what the bot does.

// Question types that supply their own answers, so no choices need typing.
const AUTO_OPTION_TYPES = ['yes_no', 'agree_disagree', 'scale_5', 'scale_10', 'nps', 'open_ended'];

// One choice per line, or comma-separated. Newlines win when both are present,
// so a choice may contain a comma as long as the choices are on their own lines.
function parseOptions(raw) {
  const sep = (raw || '').includes('\n') ? '\n' : ',';
  return (raw || '').split(sep).map(o => o.trim()).filter(Boolean);
}

// `/poll Lunch? Thai, Sushi, Pizza` - the whole poll on the command line.
//
// The text a slash command carries used to be thrown away, which meant the
// fastest route in was also the emptiest one. The question mark is the divider,
// because a question already ends in one: everything up to it is the question,
// the rest are the choices. No question mark and the whole thing is the
// question, with the choices left to fill in.
//
// This prefills the compose screen rather than posting outright - a typo that
// goes straight to a channel is not a saving - so it costs one click, not none.
// The shape returned is the one the question form wants for restoring itself.
function parseComposeArgs(text) {
  const raw = (text || '').trim();
  if (!raw) return {};
  const split = raw.indexOf('?');
  const question = (split === -1 ? raw : raw.slice(0, split + 1)).trim();
  const options = split === -1 ? [] : parseOptions(raw.slice(split + 1));
  return { text: question, options: options.join('\n') };
}

// Whether the question form has been filled in enough to become a question.
// Returns which field to complain about, or null when it is good.
function questionFormError({ text, type, optionsRaw } = {}) {
  if (!text) return 'text';
  if (!AUTO_OPTION_TYPES.includes(type) && parseOptions(optionsRaw).length < 2) return 'options';
  return null;
}

module.exports = { AUTO_OPTION_TYPES, parseOptions, parseComposeArgs, questionFormError };
