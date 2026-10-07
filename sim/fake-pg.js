// An in-memory stand-in for the one Postgres database the bot talks to.
//
// It is not a SQL engine. The bot sends about a dozen distinct statements, so
// each is recognised by shape and run against plain objects - and anything else
// throws, loudly, so a query added to the bot without teaching it to this file
// fails a test instead of quietly returning nothing.
//
// What it does copy from Postgres, because the bot's correctness leans on it:
//   - transactions: a BEGIN'd client writes to a private copy that COMMIT
//     publishes and ROLLBACK drops, so nobody reads a half-finished vote;
//   - row locks: SELECT ... FOR UPDATE holds a row until COMMIT/ROLLBACK, and
//     an UPDATE on a locked row waits, which is what stops a vote and a close
//     from both winning the same poll;
//   - the shape of rows: JSON columns are TEXT, close_at and created_at are
//     Dates, booleans are booleans.
//
// Faults can be injected (fail the next statement matching a pattern), someone
// else's action can be run in the gap before a statement (`before`), and time
// is a clock the test owns: `latencyMs` advances it per statement, which is how
// a slow cold database eats Slack's three-second window without a test waiting.

const COLUMNS = [
  'id', 'title', 'description', 'questions', 'votes', 'anonymous', 'allow_revote',
  'creator', 'channel_id', 'message_ts', 'status', 'close_at', 'vote_timestamps',
  'show_results', 'order_by_votes', 'message_refs', 'notify_on_close', 'co_creators', 'team_id'
];

const matches = (pattern, sql) => (pattern instanceof RegExp ? pattern.test(sql) : sql.includes(pattern));

class Lock {
  constructor(onWait = () => {}) { this.owner = null; this.queue = []; this.onWait = onWait; }
  async acquire(owner) {
    if (this.owner === owner) return;
    if (this.owner === null) { this.owner = owner; return; }
    this.onWait();
    await new Promise(resolve => this.queue.push(resolve));
    this.owner = owner;
  }
  release(owner) {
    if (this.owner !== owner) return;
    const next = this.queue.shift();
    // Handed straight to the next waiter, so nobody can slip in between.
    if (next) { this.owner = '__handoff__'; next(); } else this.owner = null;
  }
}

class FakeDb {
  constructor(clock) {
    this.clock = clock;              // { now(): ms, advance(ms) } - owned by the sim
    this.polls = new Map();
    this.installations = new Map();
    this.locks = new Map();
    this.latencyMs = 0;
    this.faults = [];
    this.hooks = [];
    this.blocked = null;             // set while a hook runs: called if it waits on a lock
    this.started = [];               // what hooks started, for settle()
    this.statements = [];            // every statement run, for assertions
    this.nextTxn = 1;
  }

  // ---- test controls ----
  failNext(pattern, error = new Error('fake-pg: injected failure'), { times = 1 } = {}) {
    this.faults.push({ pattern, error, times });
  }
  // Runs `fn` just before the next statement matching `pattern` (passing over
  // the first `skip` matches): how a test puts someone else's action into the
  // gap between two of the bot's own statements.
  before(pattern, fn, { skip = 0 } = {}) {
    this.hooks.push({ pattern, fn, skip });
  }
  rows() { return [...this.polls.values()]; }
  row(id) { return this.polls.get(id); }
  seed(row) {
    const full = { created_at: new Date(this.clock.now()), team_id: null, message_ts: null, close_at: null, ...row };
    this.polls.set(full.id, full);
    return full;
  }
  pool() { return new FakePool(this); }

  // ---- internals ----
  lockFor(id) {
    if (!this.locks.has(id)) this.locks.set(id, new Lock(() => this.blocked && this.blocked()));
    return this.locks.get(id);
  }
  tick() { if (this.latencyMs) this.clock.advance(this.latencyMs); }
  maybeFail(sql) {
    const i = this.faults.findIndex(f => matches(f.pattern, sql));
    if (i < 0) return;
    const f = this.faults[i];
    if (--f.times <= 0) this.faults.splice(i, 1);
    throw f.error;
  }
  async runHook(sql) {
    const i = this.hooks.findIndex(h => matches(h.pattern, sql));
    if (i < 0) return;
    const h = this.hooks[i];
    if (h.skip-- > 0) return;
    // Removed before it runs: what it does may send the same statement.
    this.hooks.splice(i, 1);
    // If it has to wait for a row the bot holds, the bot goes first and it
    // finishes afterwards - waiting for it here would be a deadlock.
    const waits = new Promise(resolve => { this.blocked = resolve; });
    const run = Promise.resolve().then(h.fn);
    this.started.push(run);
    try { await Promise.race([run, waits]); } finally { this.blocked = null; }
  }
  // Waits for everything `before` started, for a test to call before it looks.
  async settle() { await Promise.all(this.started); }
}

class FakePool {
  constructor(db) { this.db = db; this.handlers = {}; }
  on(event, fn) { this.handlers[event] = fn; return this; }
  async query(sql, params) { return new FakeClient(this.db, true).query(sql, params); }
  async connect() { return new FakeClient(this.db, false); }
  async end() {}
}

const clone = row => ({ ...row });

class FakeClient {
  constructor(db, autocommit) {
    this.db = db;
    this.autocommit = autocommit;
    this.id = `txn${db.nextTxn++}`;
    this.tx = null;          // Map id -> row, the transaction's private copy
    this.held = new Set();   // row locks this client owns
    this.released = false;
  }

  release() {
    for (const id of this.held) this.db.lockFor(id).release(this.id);
    this.held.clear();
    this.tx = null;
    this.released = true;
  }

  // What this client sees for a row: its own uncommitted copy first.
  read(id) {
    if (this.tx && this.tx.has(id)) return this.tx.get(id);
    return this.db.polls.get(id);
  }
  write(id, row) {
    if (this.tx) this.tx.set(id, row); else this.db.polls.set(id, row);
  }
  visibleRows() {
    const ids = new Set([...this.db.polls.keys(), ...(this.tx ? this.tx.keys() : [])]);
    return [...ids].map(id => this.read(id)).filter(Boolean);
  }

  async query(rawSql, params = []) {
    const db = this.db;
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    await db.runHook(sql);
    db.statements.push({ sql, params });
    db.maybeFail(sql);
    db.tick();
    const none = { rows: [], rowCount: 0 };
    const rowsOf = rows => ({ rows: rows.map(clone), rowCount: rows.length });

    if (/^(CREATE|ALTER|DROP) /i.test(sql)) return none;
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };

    if (sql === 'BEGIN') { this.tx = new Map(); return none; }
    if (sql === 'COMMIT') {
      for (const [id, row] of this.tx || []) db.polls.set(id, row);
      this.tx = null;
      for (const id of this.held) db.lockFor(id).release(this.id);
      this.held.clear();
      return none;
    }
    if (sql === 'ROLLBACK') {
      this.tx = null;
      for (const id of this.held) db.lockFor(id).release(this.id);
      this.held.clear();
      return none;
    }

    // SELECT * FROM polls WHERE id = $1 [FOR UPDATE]
    let m = sql.match(/^SELECT \* FROM polls WHERE id ?= ?\$1( FOR UPDATE)?$/);
    if (m) {
      const id = params[0];
      if (m[1]) {
        await db.lockFor(id).acquire(this.id);
        this.held.add(id);
        // The lock wait is what lets another transaction commit first, so the
        // row is read only after it is held.
      }
      const row = this.read(id);
      return rowsOf(row ? [row] : []);
    }

    if (sql.startsWith('INSERT INTO polls')) {
      const id = params[0];
      await db.lockFor(id).acquire(this.id);
      try {
        const existing = this.read(id);
        const incoming = {};
        COLUMNS.forEach((c, i) => { incoming[c] = params[i]; });
        incoming.close_at = incoming.close_at ? new Date(incoming.close_at) : null;
        const next = existing
          ? { ...existing, ...incoming, team_id: incoming.team_id ?? existing.team_id }
          : { created_at: new Date(db.clock.now()), ...incoming };
        this.write(id, next);
      } finally { if (!this.held.has(id)) db.lockFor(id).release(this.id); }
      return { rows: [], rowCount: 1 };
    }

    // The poll lists.
    if (sql.startsWith('SELECT * FROM polls WHERE status=$1 AND ( creator=$2')) {
      const [status, userId, channelId] = params;
      const hit = this.visibleRows().filter(r =>
        r.status === status && (
          r.creator === userId
          || JSON.parse(r.co_creators || '[]').includes(userId)
          || r.channel_id === channelId
          || JSON.parse(r.message_refs || '[]').some(ref => ref.channelId === channelId)
        ));
      hit.sort((a, b) => b.created_at - a.created_at);
      return rowsOf(hit);
    }

    if (sql === 'UPDATE polls SET votes=$1, vote_timestamps=$2 WHERE id=$3') {
      return this.update(params[2], row => ({ ...row, votes: params[0], vote_timestamps: params[1] }));
    }
    if (sql === 'UPDATE polls SET votes=$1, vote_timestamps=$2, notify_on_close=$3 WHERE id=$4') {
      return this.update(params[3], row => ({ ...row, votes: params[0], vote_timestamps: params[1], notify_on_close: params[2] }));
    }
    // Appending to the JSON list of copies, as Postgres' jsonb || does.
    const append = (refs, more) => JSON.stringify([...JSON.parse(refs || '[]'), ...JSON.parse(more)]);
    if (sql === 'UPDATE polls SET message_refs=(message_refs::jsonb || $1::jsonb)::text WHERE id=$2') {
      return this.update(params[1], row => ({ ...row, message_refs: append(row.message_refs, params[0]) }));
    }
    if (sql === 'UPDATE polls SET message_refs=(message_refs::jsonb || $1::jsonb)::text, channel_id=$2, message_ts=$3 WHERE id=$4 RETURNING *') {
      return this.update(params[3], row => ({ ...row, message_refs: append(row.message_refs, params[0]), channel_id: params[1], message_ts: params[2] }), { returning: true });
    }
    if (sql === "UPDATE polls SET title=$1, description=$2 WHERE id=$3 AND status='active' RETURNING *") {
      return this.update(params[2], row => ({ ...row, title: params[0], description: params[1] }), { onlyIf: row => row.status === 'active', returning: true });
    }
    if (sql === "UPDATE polls SET status='closed' WHERE id=$1") {
      return this.update(params[0], row => ({ ...row, status: 'closed' }));
    }
    if (sql === "UPDATE polls SET status='closed' WHERE id=$1 AND status='active' RETURNING *") {
      return this.update(params[0], row => ({ ...row, status: 'closed' }), { onlyIf: row => row.status === 'active', returning: true });
    }

    // The sweeper.
    if (sql === "UPDATE polls SET status='closed' WHERE status='active' AND close_at IS NOT NULL AND close_at <= NOW() RETURNING *") {
      const now = db.clock.now();
      const due = this.visibleRows().filter(r => r.status === 'active' && r.close_at && r.close_at.getTime() <= now);
      const out = [];
      for (const r of due) {
        const res = await this.update(r.id, row => ({ ...row, status: 'closed' }), { onlyIf: row => row.status === 'active', returning: true });
        out.push(...res.rows);
      }
      return rowsOf(out);
    }
    if (sql === "SELECT MIN(close_at) AS next FROM polls WHERE status='active' AND close_at IS NOT NULL") {
      const times = this.visibleRows().filter(r => r.status === 'active' && r.close_at).map(r => r.close_at.getTime());
      return { rows: [{ next: times.length ? new Date(Math.min(...times)) : null }], rowCount: 1 };
    }

    // Installations (multi-workspace only).
    if (sql === 'SELECT team_id FROM slack_installations LIMIT 2') {
      return { rows: [...db.installations.keys()].slice(0, 2).map(team_id => ({ team_id })), rowCount: db.installations.size };
    }
    if (sql === 'SELECT data FROM slack_installations WHERE team_id = $1') {
      return db.installations.has(params[0]) ? { rows: [{ data: db.installations.get(params[0]) }], rowCount: 1 } : none;
    }
    if (sql.startsWith('INSERT INTO slack_installations')) {
      db.installations.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`fake-pg: unsupported SQL, teach it to sim/fake-pg.js: ${sql}`);
  }

  // An UPDATE waits for any lock another transaction holds on the row, then
  // re-checks its condition against what that transaction committed - which is
  // exactly what makes "close only if still active" safe to race.
  async update(id, change, { onlyIf = () => true, returning = false } = {}) {
    const db = this.db;
    const owned = this.held.has(id);
    await db.lockFor(id).acquire(this.id);
    try {
      const row = this.read(id);
      if (!row || !onlyIf(row)) return { rows: [], rowCount: 0 };
      const next = change(row);
      this.write(id, next);
      return { rows: returning ? [clone(next)] : [], rowCount: 1 };
    } finally {
      if (!owned) db.lockFor(id).release(this.id);
    }
  }
}

module.exports = { FakeDb, FakePool, COLUMNS };
