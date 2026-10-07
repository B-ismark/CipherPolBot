// A stand-in for the Slack workspace the bot talks to.
//
// It keeps the state Slack keeps - which channels exist and whether the bot is
// in them, what every posted message currently says, which modals each person
// has open - and it refuses what Slack refuses:
//
//   - a trigger_id that is older than three seconds, or already used;
//   - a view or message over Slack's limits (checked with the same auditors the
//     unit tests use, so a screen that passes one passes the other);
//   - posting to a private channel the bot is not in, or uploading to a channel
//     it has not joined;
//   - views.update / views.push on a view that is no longer open, or a stack
//     deeper than three.
//
// Every API call is recorded in `log`, in order, which is what a scenario reads
// back to say "this is what the person would have seen".

const assert = require('node:assert');
const { auditView, auditMessage } = require('../test-lib/audit');

const TRIGGER_LIFETIME_MS = 3000;
const MAX_VIEW_STACK = 3;

function slackError(code, message) {
  const err = new Error(`An API error occurred: ${code}${message ? ` (${message})` : ''}`);
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: code };
  return err;
}

class FakeSlack {
  constructor(clock) {
    this.clock = clock;
    this.log = [];
    this.channels = new Map();   // id -> { type, botMember, name }
    this.messages = new Map();   // `${channel}:${ts}` -> { channel, ts, text, blocks, deleted }
    this.ephemerals = [];        // { channel, user, text, blocks, at }
    this.files = [];
    this.triggers = new Map();   // id -> { user, issuedAt, used }
    this.views = new Map();      // viewId -> { id, user, view, open }
    this.stacks = new Map();     // user -> [viewId...]
    this.seq = { ts: 1, trigger: 1, view: 1 };
    this.faults = [];
    this.client = this.buildClient();
  }

  // ---- the workspace ----
  addChannel(id, { type = 'public', botMember = false, name = id } = {}) {
    this.channels.set(id, { type, botMember, name });
    return id;
  }
  channel(id) { return this.channels.get(id); }

  newTs() { return `${1700000000 + this.seq.ts++}.000100`; }
  newTrigger(user) {
    const id = `trig_${this.seq.trigger++}`;
    this.triggers.set(id, { user, issuedAt: this.clock.now(), used: false });
    return id;
  }

  failNext(method, error, { times = 1 } = {}) { this.faults.push({ method, error, times }); }
  callsTo(method) { return this.log.filter(c => c.method === method); }

  // ---- views each person has open ----
  stackOf(user) { return (this.stacks.get(user) || []).map(id => this.views.get(id)).filter(v => v && v.open); }
  topView(user) { const s = this.stackOf(user); return s[s.length - 1] || null; }
  closeAllViews(user) {
    for (const id of this.stacks.get(user) || []) { const v = this.views.get(id); if (v) v.open = false; }
    this.stacks.set(user, []);
  }
  popView(user) {
    const stack = this.stacks.get(user) || [];
    const id = stack.pop();
    if (id && this.views.get(id)) this.views.get(id).open = false;
  }

  // ---- the API surface the bot uses ----
  buildClient() {
    const self = this;
    const call = (method, args, fn) => async () => {
      self.log.push({ method, args, at: self.clock.now() });
      const i = self.faults.findIndex(f => f.method === method);
      if (i >= 0) {
        const f = self.faults[i];
        if (--f.times <= 0) self.faults.splice(i, 1);
        throw f.error;
      }
      return fn();
    };
    const lintMessage = (blocks, label) => {
      if (!blocks) return;
      try { auditMessage(blocks, label); }
      catch (e) { throw slackError('invalid_blocks', e.message); }
    };
    const lintView = (view, label) => {
      try { auditView(view, label); }
      catch (e) { throw slackError('invalid_arguments', e.message); }
    };
    const needChannel = channel => {
      const c = self.channels.get(channel);
      if (!c) throw slackError('channel_not_found');
      return c;
    };
    // What Slack lets an app with chat:write.public do: post to any public
    // channel, but only to a private one or a group DM it is a member of.
    const canPost = c => c.type === 'public' || c.botMember;

    const useTrigger = (id, label) => {
      const t = self.triggers.get(id);
      if (!t) throw slackError('invalid_trigger_id');
      if (t.used) throw slackError('exchanged_trigger_id', 'already used');
      if (self.clock.now() - t.issuedAt > TRIGGER_LIFETIME_MS) throw slackError('expired_trigger_id', `${label}: ${self.clock.now() - t.issuedAt}ms old`);
      t.used = true;
      return t;
    };

    const register = (user, view, mode) => {
      const id = `V${self.seq.view++}`;
      self.views.set(id, { id, user, view, open: true, hash: 1 });
      const stack = self.stacks.get(user) || [];
      if (mode === 'open') { for (const old of stack) if (self.views.get(old)) self.views.get(old).open = false; self.stacks.set(user, [id]); }
      else stack.push(id) && self.stacks.set(user, stack);
      return id;
    };

    return {
      chat: {
        postMessage: async args => call('chat.postMessage', args, () => {
          const c = needChannel(args.channel);
          if (!canPost(c)) throw slackError(c.type === 'private' ? 'channel_not_found' : 'not_in_channel');
          lintMessage(args.blocks, 'chat.postMessage');
          const ts = self.newTs();
          self.messages.set(`${args.channel}:${ts}`, { channel: args.channel, ts, text: args.text, blocks: args.blocks, deleted: false });
          return { ok: true, channel: args.channel, ts };
        })(),
        update: async args => call('chat.update', args, () => {
          needChannel(args.channel);
          const m = self.messages.get(`${args.channel}:${args.ts}`);
          if (!m || m.deleted) throw slackError('message_not_found');
          lintMessage(args.blocks, 'chat.update');
          m.text = args.text; m.blocks = args.blocks;
          return { ok: true, channel: args.channel, ts: args.ts };
        })(),
        postEphemeral: async args => call('chat.postEphemeral', args, () => {
          const c = needChannel(args.channel);
          if (!canPost(c)) throw slackError(c.type === 'private' ? 'channel_not_found' : 'not_in_channel');
          lintMessage(args.blocks, 'chat.postEphemeral');
          self.ephemerals.push({ channel: args.channel, user: args.user, text: args.text, blocks: args.blocks, at: self.clock.now() });
          return { ok: true, message_ts: self.newTs() };
        })()
      },
      conversations: {
        open: async args => call('conversations.open', args, () => {
          const users = args.users ? String(args.users).split(',') : [];
          if (users.length !== 1) throw slackError('not_supported', 'the fake only opens one-person DMs');
          const id = `D${users[0]}`;
          if (!self.channels.has(id)) self.channels.set(id, { type: 'im', botMember: true, name: `dm-${users[0]}` });
          return { ok: true, channel: { id } };
        })()
      },
      files: {
        uploadV2: async args => call('files.uploadV2', args, () => {
          const c = needChannel(args.channel_id);
          // A file upload does not get chat:write.public's walk-in pass.
          if (!c.botMember) throw slackError('not_in_channel');
          self.files.push({ channel: args.channel_id, filename: args.filename, content: args.content, comment: args.initial_comment });
          return { ok: true };
        })()
      },
      views: {
        open: async args => call('views.open', args, () => {
          const t = useTrigger(args.trigger_id, 'views.open');
          lintView(args.view, 'views.open');
          return { ok: true, view: { id: register(t.user, args.view, 'open') } };
        })(),
        push: async args => call('views.push', args, () => {
          const t = useTrigger(args.trigger_id, 'views.push');
          lintView(args.view, 'views.push');
          if (self.stackOf(t.user).length === 0) throw slackError('not_found', 'nothing to push onto');
          if (self.stackOf(t.user).length >= MAX_VIEW_STACK) throw slackError('push_limit_reached');
          return { ok: true, view: { id: register(t.user, args.view, 'push') } };
        })(),
        update: async args => call('views.update', args, () => {
          const v = self.views.get(args.view_id);
          if (!v || !v.open) throw slackError('not_found', 'that view is no longer open');
          lintView(args.view, 'views.update');
          v.view = args.view; v.hash++;
          return { ok: true, view: { id: v.id } };
        })()
      }
    };
  }
}

module.exports = { FakeSlack, slackError, TRIGGER_LIFETIME_MS, MAX_VIEW_STACK };
