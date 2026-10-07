// Boots the real bot against a fake Slack and a fake database, and lets a test
// act as the people using it.
//
//   const sim = await boot();
//   const ama = sim.user('UAMA');
//   const r = await ama.command('/polls-list', '', { channel: 'C1' });
//   r.ephemerals            // what Slack would have shown only to them
//   await sim.close();
//
// Nothing in slack-poll-bot.js is changed or reached around: `pg`,
// `@slack/bolt` and `@slack/web-api` are swapped for fakes at require time, so
// the handlers that run are the ones that ship, called the way Bolt calls them
// (with `ack`, `respond`, `client`, `body`, `action`, `view`).
//
// People can only press what they can see. `press` looks the button up in the
// message or modal in front of them and refuses if it is not there, so a
// scenario cannot cheat by firing an action the screen never offered.

const Module = require('node:module');
const path = require('node:path');
const { FakeDb } = require('./fake-pg');
const { FakeSlack, slackError } = require('./fake-slack');
const { auditView } = require('../test-lib/audit');

const ROOT = path.join(__dirname, '..');
const BOT = path.join(ROOT, 'slack-poll-bot.js');

// Real time plus whatever the test has skipped forward. Real time has to be in
// it: the bot reads Date.now() itself, and the fake database's NOW() must agree.
class Clock {
  constructor() { this.offset = 0; }
  now() { return Date.now() + this.offset; }
  advance(ms) { this.offset += ms; }
}

// ---- Bolt, as far as the bot uses it ----
function makeBoltFakes(sim) {
  class FakeApp {
    constructor(opts) {
      this.opts = opts;
      this.client = sim.slack.client;
      sim.app = this;
      this.handlers = { command: new Map(), action: [], view: new Map(), shortcut: new Map(), other: [] };
    }
    command(name, fn) { this.handlers.command.set(name, fn); }
    action(constraint, fn) { this.handlers.action.push({ constraint, fn }); }
    view(constraint, fn) {
      const id = typeof constraint === 'string' ? constraint : constraint.callback_id;
      this.handlers.view.set(id, fn);
    }
    shortcut(constraint, fn) { this.handlers.shortcut.set(typeof constraint === 'string' ? constraint : constraint.callback_id, fn); }
    event(...a) { this.handlers.other.push(['event', ...a]); }
    message(...a) { this.handlers.other.push(['message', ...a]); }
    options(...a) { this.handlers.other.push(['options', ...a]); }
    error(fn) { this.errorHandler = fn; }
    async start() { return {}; }
    async stop() {}
    findAction(actionId) {
      const hit = this.handlers.action.find(({ constraint }) => {
        if (typeof constraint === 'string') return constraint === actionId;
        if (constraint instanceof RegExp) return constraint.test(actionId);
        if (constraint.action_id !== undefined) {
          return constraint.action_id instanceof RegExp ? constraint.action_id.test(actionId) : constraint.action_id === actionId;
        }
        return false;
      });
      return hit && hit.fn;
    }
  }
  class FakeReceiver {
    constructor() {
      this.routes = new Map();
      this.router = {
        get: (p, fn) => this.routes.set(`GET ${p}`, fn),
        post: (p, fn) => this.routes.set(`POST ${p}`, fn),
        use: () => {}
      };
    }
  }
  return {
    App: FakeApp,
    ExpressReceiver: FakeReceiver,
    // Only the sweeper builds its own client, and only without SLACK_BOT_TOKEN.
    WebClient: function FakeWebClient() { return sim.slack.client; }
  };
}

// ---- the whole simulation ----
class Sim {
  constructor() {
    this.clock = new Clock();
    this.db = new FakeDb(this.clock);
    this.slack = new FakeSlack(this.clock);
    this.console = [];         // everything the bot logged: { level, text }
    this.timers = [];          // setInterval callbacks the bot registered
    this.users = new Map();
    this.restore = [];
  }

  user(id) {
    if (!this.users.has(id)) this.users.set(id, new User(this, id));
    return this.users.get(id);
  }

  // The sweeper the bot starts on a 60-second interval, run now.
  async sweep() {
    const [tick] = this.timers;
    if (!tick) throw new Error('the bot registered no sweeper');
    await tick.fn();
  }

  logged(level) { return this.console.filter(l => !level || l.level === level).map(l => l.text); }

  async close() {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
  }

  // ---- a window onto what happened since `mark()` ----
  mark() {
    return { log: this.slack.log.length, eph: this.slack.ephemerals.length, con: this.console.length, files: this.slack.files.length };
  }
  since(m) {
    const calls = this.slack.log.slice(m.log);
    return {
      calls,
      ephemerals: this.slack.ephemerals.slice(m.eph),
      files: this.slack.files.slice(m.files),
      errors: this.console.slice(m.con).filter(l => l.level === 'error').map(l => l.text),
      warnings: this.console.slice(m.con).filter(l => l.level === 'warn').map(l => l.text),
      apiErrors: []
    };
  }
}

// ---- one person ----
class User {
  constructor(sim, id) {
    this.sim = sim; this.id = id;
    this.responseUses = new Map();
  }

  get slack() { return this.sim.slack; }
  get top() { return this.slack.topView(this.id); }
  get stack() { return this.slack.stackOf(this.id); }

  // What this person has been told privately, newest last.
  whispers(channel) {
    return this.slack.ephemerals.filter(e => e.user === this.id && (!channel || e.channel === channel));
  }
  // What is in their DM with the bot.
  dms() {
    const dm = this.slack.channels.has(`D${this.id}`) ? `D${this.id}` : null;
    return dm ? [...this.slack.messages.values()].filter(m => m.channel === dm) : [];
  }

  baseContext() { return { teamId: 'T1', botToken: 'xoxb-fake' }; }

  makeRespond(responseUrl, source) {
    const uses = { n: 0 };
    return async msg => {
      if (++uses.n > 5) throw slackError('used_url', 'response_url allows five uses');
      const body = typeof msg === 'string' ? { text: msg } : msg;
      this.sim.slack.log.push({ method: 'respond', args: body, at: this.sim.clock.now() });
      if (body.delete_original && source?.message) { source.message.deleted = true; return; }
      if (body.replace_original && source?.message) {
        source.message.text = body.text; source.message.blocks = body.blocks;
        return;
      }
      if (body.response_type === 'in_channel') {
        const ts = this.slack.newTs();
        this.slack.messages.set(`${source.channel}:${ts}`, { channel: source.channel, ts, text: body.text, blocks: body.blocks, deleted: false });
        return;
      }
      this.slack.ephemerals.push({ channel: source?.channel, user: this.id, text: body.text, blocks: body.blocks, at: this.sim.clock.now(), via: 'respond' });
    };
  }

  // Runs a handler the way Bolt does and reports how it behaved.
  async dispatch(handler, args, { expectAck = true } = {}) {
    const sim = this.sim;
    const m = sim.mark();
    const acks = [];
    const ack = async payload => { acks.push(payload); };
    let thrown = null;
    try {
      await handler({ ack, logger: console, context: this.baseContext(), ...args });
    } catch (err) { thrown = err; }
    const result = sim.since(m);
    result.acks = acks;
    result.ackPayload = acks[0];
    result.thrown = thrown;
    result.problems = [];
    if (expectAck && acks.length === 0) result.problems.push('the handler never called ack()');
    if (acks.length > 1) result.problems.push(`the handler called ack() ${acks.length} times`);
    if (thrown) result.problems.push(`the handler threw: ${thrown.message}`);
    return result;
  }

  // ---- slash commands ----
  async command(name, text = '', { channel = 'C1' } = {}) {
    const fn = this.sim.app.handlers.command.get(name);
    if (!fn) throw new Error(`the bot has no ${name} command`);
    const source = { channel };
    const body = {
      command: name, text, user_id: this.id, user_name: this.id, channel_id: channel,
      team_id: 'T1', trigger_id: this.slack.newTrigger(this.id), response_url: 'https://hooks.slack.test/cmd'
    };
    const r = await this.dispatch(fn, { body, command: body, client: this.slack.client, respond: this.makeRespond(body.response_url, source), say: async () => {} });
    return this.finish(r);
  }

  // ---- pressing a button ----
  // `where` says what the person is looking at: a message in a channel
  // ({ channel, ts }), a private message ({ ephemeral: i }), or - by default -
  // the modal on top of their screen.
  async press(actionId, { value, option } = {}, where = {}) {
    const sim = this.sim;
    let blocks, source = {}, view = null, messageObj = null;
    if (where.channel && where.ts) {
      messageObj = this.slack.messages.get(`${where.channel}:${where.ts}`);
      if (!messageObj) throw new Error(`no message ${where.channel}:${where.ts}`);
      blocks = messageObj.blocks; source = { channel: where.channel, message: messageObj };
    } else if (where.ephemeral !== undefined) {
      const eph = this.whispers()[where.ephemeral];
      if (!eph) throw new Error(`no private message #${where.ephemeral}`);
      blocks = eph.blocks; source = { channel: eph.channel };
    } else if (where.forge && !this.top) {
      blocks = []; source = { channel: where.forgeChannel || 'C1' };
    } else {
      view = this.top;
      if (!view) throw new Error(`${this.id} has no modal open to press ${actionId} in`);
      blocks = view.view.blocks;
    }
    let el = findElement(blocks || [], actionId);
    // `forge` is for testing what the bot does when it is sent an action the
    // screen never offered - a stale message, or someone replaying a payload.
    if (!el && where.forge) el = { type: 'button', action_id: actionId };
    if (!el) throw new Error(`${this.id} cannot press ${actionId}: no such button on what they are looking at`);

    const handler = sim.app.findAction(actionId);
    if (!handler) throw new Error(`the bot has no handler for ${actionId}`);

    const action = { ...el, action_id: actionId, block_id: el.block_id || 'b' };
    if (el.type === 'static_select' || el.type === 'multi_static_select') {
      if (!option) throw new Error(`${actionId} is a dropdown: pass { option }`);
      action.selected_option = { value: option };
    }
    if (value !== undefined) action.value = value;
    const body = {
      type: 'block_actions', user: { id: this.id, team_id: 'T1' }, team: { id: 'T1' },
      trigger_id: this.slack.newTrigger(this.id), actions: [action],
      ...(view ? { view: { id: view.id, private_metadata: view.view.private_metadata || '', callback_id: view.view.callback_id, state: { values: where.values || {} }, type: 'modal' } } : {}),
      ...(source.channel ? { channel: { id: source.channel }, container: { type: 'message', channel_id: source.channel } } : {}),
      ...(messageObj ? { message: { ts: messageObj.ts, blocks: messageObj.blocks } } : {}),
      // A button inside a modal arrives with no response_url - which is the whole
      // reason the bot has to push and update there instead of replying.
      ...(view ? {} : { response_url: 'https://hooks.slack.test/action' })
    };
    const respond = view ? undefined : this.makeRespond(body.response_url, source);
    const r = await this.dispatch(handler, { body, action, client: this.slack.client, respond });
    return this.finish(r);
  }

  // ---- submitting the modal on top ----
  // `values` is Slack's view.state.values: { block_id: { action_id: {...} } }.
  async submit(values = {}) {
    const top = this.top;
    if (!top) throw new Error(`${this.id} has no modal open to submit`);
    const cb = top.view.callback_id;
    const fn = this.sim.app.handlers.view.get(cb);
    if (!fn) throw new Error(`the bot has no handler for the ${cb} modal`);
    if (!top.view.submit) throw new Error(`the ${cb} modal has no submit button`);
    const view = {
      id: top.id, callback_id: cb, type: 'modal', team_id: 'T1',
      private_metadata: top.view.private_metadata || '', state: { values },
      root_view_id: this.stack[0]?.id
    };
    const body = { type: 'view_submission', user: { id: this.id, team_id: 'T1' }, team: { id: 'T1' }, view, trigger_id: this.slack.newTrigger(this.id) };
    const r = await this.dispatch(fn, { body, view, client: this.slack.client });
    // What Slack does with the answer to the submission.
    const p = r.ackPayload;
    r.viewErrors = null;
    if (!p || !p.response_action) { this.slack.popView(this.id); }
    else if (p.response_action === 'clear') this.slack.closeAllViews(this.id);
    else if (p.response_action === 'errors') r.viewErrors = p.errors;
    else if (p.response_action === 'update') {
      try { auditView(p.view, 'response_action:update'); } catch (e) { r.problems.push(`Slack would reject this update: ${e.message}`); }
      top.view = p.view;
    } else if (p.response_action === 'push') {
      try { auditView(p.view, 'response_action:push'); } catch (e) { r.problems.push(`Slack would reject this push: ${e.message}`); }
      const id = `V${this.slack.seq.view++}`;
      this.slack.views.set(id, { id, user: this.id, view: p.view, open: true, hash: 1 });
      this.slack.stacks.get(this.id).push(id);
    }
    return this.finish(r);
  }

  // Submits a modal by its callback_id without it being on screen first: for
  // setting a scene (making a poll) rather than for testing the modal itself.
  async submitDirect(callbackId, { privateMetadata = '', values = {} } = {}) {
    const fn = this.sim.app.handlers.view.get(callbackId);
    if (!fn) throw new Error(`the bot has no handler for the ${callbackId} modal`);
    const view = { id: 'Vdirect', callback_id: callbackId, type: 'modal', team_id: 'T1', private_metadata: privateMetadata, state: { values } };
    const body = { type: 'view_submission', user: { id: this.id, team_id: 'T1' }, team: { id: 'T1' }, view, trigger_id: this.slack.newTrigger(this.id) };
    const r = await this.dispatch(fn, { body, view, client: this.slack.client });
    return this.finish(r);
  }

  // Makes a poll the way the bot does: the preview screen's Post button.
  // Returns the stored poll and where it landed.
  async createPoll({ questions, title = '', description = '', settings = [], showResults = 'realtime', channel = 'C1', closeAt = null, destChannels = [], destUsers = [] } = {}) {
    const meta = {
      channelId: channel, userId: this.id, savedQuestions: questions, pollTitle: title, pollDescription: description,
      pollSettings: settings, showResults, orderByVotes: false, closeAt, destChannels, destUsers
    };
    // The row this call made, not the newest: the clock may not have moved
    // since the last poll, so created_at alone can tie.
    const before = new Set(this.sim.db.rows().map(x => x.id));
    const r = await this.submitDirect('poll_preview_submit', { privateMetadata: JSON.stringify(meta) });
    const row = this.sim.db.rows().find(x => x.creator === this.id && !before.has(x.id));
    return { result: r, row, id: row && row.id, messageRefs: row ? JSON.parse(row.message_refs) : [] };
  }

  dismiss() { this.slack.popView(this.id); }

  finish(r) {
    r.modal = this.top ? this.top.view : null;
    return r;
  }
}

function* walkElements(blocks) {
  for (const b of blocks) {
    if (b.accessory) yield b.accessory;
    for (const e of b.elements || []) yield e;
    if (b.element) yield b.element;
  }
}
function findElement(blocks, actionId) {
  for (const e of walkElements(blocks)) if (e.action_id === actionId) return e;
  return null;
}

// ---- boot ----
async function boot({ env = {} } = {}) {
  const sim = new Sim();
  const saved = {};
  const setEnv = (k, v) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const baseEnv = {
    SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_SIGNING_SECRET: 'sim', DATABASE_URL: 'postgres://fake/fake',
    KEEPALIVE_URL: undefined, PORT: '0', ...env
  };
  for (const [k, v] of Object.entries(baseEnv)) setEnv(k, v);
  sim.restore.push(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  // Capture the bot's own logging: it is evidence, and it is noisy.
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level];
    console[level] = (...a) => { sim.console.push({ level: level === 'info' ? 'log' : level, text: a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }); };
    sim.restore.push(() => { console[level] = orig; });
  }

  const origLoad = Module._load;
  const bolt = makeBoltFakes(sim);
  Module._load = function (request, parent, isMain) {
    if (request === 'pg') return { Pool: function () { return sim.db.pool(); } };
    if (request === '@slack/bolt') return bolt;
    if (request === '@slack/web-api') return { WebClient: bolt.WebClient };
    return origLoad.apply(this, arguments);
  };
  const origSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => { sim.timers.push({ fn, ms }); return { unref() {}, ref() {} }; };
  const origExit = process.exit;
  process.exit = code => { sim.console.push({ level: 'error', text: `process.exit(${code}) called` }); };
  const origOn = process.on;
  process.on = function (ev, fn) { if (ev === 'SIGTERM' || ev === 'SIGINT') return this; return origOn.call(this, ev, fn); };
  const undoPatches = () => {
    Module._load = origLoad; global.setInterval = origSetInterval; process.exit = origExit; process.on = origOn;
  };

  // Fresh module state for every boot: rate limits and caches live in modules.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && !key.includes('node_modules') && !key.includes(`${path.sep}sim${path.sep}`) && !key.includes('test-lib')) delete require.cache[key];
  }
  require(BOT);
  // The bot starts itself in an async block: wait for it to finish its schema.
  for (let i = 0; i < 200 && sim.timers.length === 0; i++) await new Promise(r => setImmediate(r));
  undoPatches();
  if (sim.timers.length === 0) throw new Error(`the bot did not finish starting: ${sim.logged().join(' | ')}`);

  // A workspace with a few ordinary rooms.
  sim.slack.addChannel('C1', { type: 'public', name: 'general' });
  sim.slack.addChannel('C2', { type: 'public', name: 'random' });
  sim.slack.addChannel('G1', { type: 'private', botMember: false, name: 'leads' });

  return sim;
}

module.exports = { boot, Sim, User };
