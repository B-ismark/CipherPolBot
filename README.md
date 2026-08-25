# 🗳️ Slack Poll Bot
> 100% free — no paid services required

Create and manage polls in Slack with real-time vote tracking. Polls are stored in PostgreSQL, so they survive restarts and redeploys.

---

## Tech Stack (all free)

| Component        | Tool                      | Cost  |
|-----------------|---------------------------|-------|
| Bot framework   | Slack Bolt (Node.js)      | Free  |
| Database        | PostgreSQL via `pg` (Neon) | Free tier |
| Local tunnel    | ngrok (free tier)         | Free  |
| Hosting         | Render / Railway          | Free  |

---

## Quick Start

### 1. Create a Slack App

1. Go to https://api.slack.com/apps → **Create New App → From scratch**
2. Name your app, select your workspace

### 2. Add Bot Token Scopes

Go to **OAuth & Permissions → Bot Token Scopes** and add exactly these five:

| Scope | Needed for |
|-------|-----------|
| `commands` | The slash commands themselves |
| `chat:write` | Posting polls, results and every ephemeral reply |
| `chat:write.public` | Posting to a public channel without being invited to it first |
| `im:write` | Opening a DM — polls created in DMs, close notifications, error reports |
| `files:write` | The CSV from `/poll-export` |

That is the complete set: those are the only Slack methods the bot calls
(`chat.postMessage`, `chat.postEphemeral`, `chat.update`, `conversations.open`,
`files.uploadV2`, and the `views.*` methods, which need no scope at all).

Nothing else is required. In particular `im:history`, `channels:join`, `groups:write`,
`mpim:write` and `conversations.connect:read` are **not** used — the bot never reads
message history, never joins a channel by itself, and never opens a group DM. If your
app already has them, they are harmless, but a fresh install does not need them.

**Private channels are the one gap.** `chat:write.public` covers public channels only,
so to post a poll into a private channel the bot must be invited to it
(`/invite @Cipher Pol`). `groups:write` does not substitute for membership. The same
applies to `/poll-export`: file uploads do not honour `chat:write.public`, so run it
in a DM or in a channel the bot belongs to.

Click **Install to Workspace** and copy your **Bot Token** (`xoxb-...`)

### 3. Copy your Signing Secret

Go to **Basic Information → App Credentials** and copy the **Signing Secret**

### 4. Install & Run

```bash
npm install

cp .env.example .env
# Edit .env and paste your tokens

npm start
```

### 5. Expose to the Internet (for local dev)

Install ngrok (free): https://ngrok.com/download

```bash
ngrok http 3000
# Copy the https URL, e.g. https://abc123.ngrok-free.app
```

### 6. Add Slash Commands

In your Slack app, go to **Slash Commands** and create each one with this Request URL:
`https://abc123.ngrok-free.app/slack/events`

| Command          | Description             | Hint                          |
|-----------------|-------------------------|-------------------------------|
| `/newpoll`       | Create a new poll       | Opens interactive modal       |
| `/poll`          | Alias for `/newpoll`    | Opens interactive modal       |
| `/poll-results`  | View results privately  | `POLL_ID`                     |
| `/poll-share`    | Post results to channel (creator only) | `POLL_ID`      |
| `/polls-list`    | List all active polls   |                               |
| `/polls-archive` | List closed polls       |                               |
| `/poll-close`    | Close a poll            | `POLL_ID`                     |
| `/poll-edit`     | Edit poll title/desc    | `POLL_ID`                     |
| `/poll-export`   | Export results as CSV (creator only) | `POLL_ID`        |

### 7. Enable Interactivity

Go to **Interactivity & Shortcuts**, toggle it **ON**, and set:
Request URL: `https://abc123.ngrok-free.app/slack/events`

---

## Usage

```
/newpoll
```
→ Opens an interactive modal. Add a title, questions (multiple choice, yes/no, rating scales, open-ended, and more), set options like anonymous voting or auto-close time, then post.

**Where to post.** The last screen, *Preview & Confirm*, shows the poll as it
will look and then asks where it goes - two pickers, right above **🚀 Post
Poll**:

| Picker | What it reaches |
|--------|-----------------|
| **Channels** | Public channels (the bot does not need to be a member), and private channels it has been invited to. Up to 10. |
| **People** | Each person gets the poll in their own DM with the bot. Up to 10. |

Fill in both if you like: unlike most poll apps this is not a choice between a
channel and people, and there is no radio button to flip. Leave both empty and
the poll goes to the conversation you ran the command from; the channel you ran
it in is prefilled, so posting where you are stays one click.

Going **← Back** from this screen to edit a question resets the pickers to that
default - Slack discards the state of a view it pops, and the picks are only sent
when the poll is posted.

Votes cast anywhere the poll appears count toward the same poll, and every copy
of the message updates on every vote.

**You always get a ballot.** Pick only people and you get your own copy of the
poll too, so you can vote in it and watch the results come in - a poll its
creator cannot vote in is broken, not a preference. Pick a channel and you do
not, because you can read it there. Pick yourself under **People** and you get
one copy, not two. If the only channel you picked turns the bot away, that
counts as no copy and you get a DM copy instead, with a note to invite the bot.

**Running `/newpoll` in a DM with another person.** Slack does not let an app
post into a DM between two people - it has no membership there and cannot be
given one, and it is never told who the other person is. So pick them under
**People** and they get the poll directly. If you pick nothing, the poll lands
in your own DM with the bot with a **Send it on** button.

**Closing a poll.** Active polls carry a **🔒 Close** button next to Vote and
Share. The button is visible to everyone - Slack cannot show one person a
different version of a message - but only the creator and co-creators can use
it; anyone else is told so privately. A poll that already has votes asks for
confirmation first. `/poll-close POLL_ID` still works, and an auto-close time
set when the poll was created still closes it on its own.

```
/poll-results poll_1706234567_abc12345
```
→ Shows a breakdown with visual progress bars, visible only to you. Results the poll owner restricted ("only me", or "after the poll closes") stay hidden from everyone else until the poll closes; the owner and co-creators always see their own.

```
/polls-list
```
→ Lists all open polls, each with a **📤 Send** button. That button is the way
back to a poll you cannot see - one sent only to somebody else, say: send it to
yourself and you can vote in it and follow the results.

```
/poll-share poll_1706234567_abc12345
```
→ Posts current results into the channel. Creator and co-creators only, since everyone there can read them - and refused while the poll still restricts its results, because the voters were told they were private. Close the poll or change the setting first.

```
/poll-export poll_1706234567_abc12345
```
→ Exports results as a CSV file, with per-voter rows for non-anonymous polls. Creator and co-creators only.

```
/poll-close poll_1706234567_abc12345
```
→ Closes the poll (creator only). Usually unnecessary: use the **🔒 Close**
button on the poll itself.

---

## Free Hosting (Production)

### Render (recommended free option)
1. Push code to GitHub
2. Go to https://render.com → New Web Service
3. Connect your repo
4. Set environment variables (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL`)
5. Copy the public URL and update all Slack app Request URLs

> ⚠️ Render's free tier spins down after 15 minutes of inactivity. See
> **Staying awake** below — without it, the first command after a nap fails.

### Railway
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Add environment variables
3. Copy the public URL and update Slack app Request URLs

---

## Staying awake

A sleeping instance cannot answer in time. Slack gives a slash command **3 seconds**
to respond, and invalidates its `trigger_id` after **3 seconds** — while waking a
cold container takes tens of seconds. You get `operation_timeout` from Slackbot,
then `expired_trigger_id` from the app, and the command has to be run again.

Two layers, and you want both:

**1. An external monitor — this is the one that matters.** Only an outside request
can wake a sleeping instance. Point [cron-job.org](https://cron-job.org) or
[UptimeRobot](https://uptimerobot.com) at `https://<your-service>.onrender.com/health`
every **10 minutes** — under the 15-minute limit, with room for one missed run.

Use `/health`, not `/`. The two answer different questions:

| Path | Answers | Fails when |
|------|---------|-----------|
| `/` | Is the process alive? | Only if the container is down |
| `/health` | Can it actually serve a poll? | Also if the database is unreachable or the schema is still being created |

`/health` returns `200` with `{"status":"ok","schema":"ready","database":"ok","databaseLatencyMs":…}`,
or `503` with `"status":"degraded"` and which part is wrong. So a monitor on `/health`
alerts on an instance that is up but useless, where `/` would report it as fine. The
database probe is cached for 15 seconds, so a short monitor interval cannot turn the
endpoint into load, and the response deliberately never echoes the driver error —
those can name the database host and user, and this endpoint is public.

### Automatic restart

`render.yaml` sets `healthCheckPath: /health`, so Render recycles an instance that
fails the check instead of leaving it up and broken.

That makes the endpoint a trigger, not just a report, so it is deliberately slow to
fail. The database gets a **90-second grace window** (`lib/health.js`): a Neon cold
start or a brief hiccup rides through, a real outage crosses it and the instance is
recycled. The body stays honest the whole time — `status` reads `degraded` from the
first failed probe, even while the HTTP code is still `200`.

So the two consumers want different things:

| Watching | Reacts to | Because |
|----------|-----------|---------|
| Render (HTTP code) | `503` only | A restart should cost more than one bad probe |
| Your monitor (body) | `"status":"degraded"` | You want to know about the blip Render is ignoring |

Point cron-job.org or UptimeRobot at the response body containing `"status":"ok"`
rather than only the status code, and you see both.

Expect a `503` for the first ~10 seconds of every boot: the schema is created before
the endpoint reports ready, and a cold database connection takes a few seconds. Render
retries during a deploy, so this costs nothing — but it is why `/` and `/health`
disagree right after a restart.

### What happens to a poll created during those 10 seconds

Nothing bad, and nothing is lost. The port is bound before the migrations run, so the
bot really is answering Slack while its schema work finishes. Existing tables are
already there, so reads and votes are unaffected — but the first boot after a deploy
that adds a column would hit that column before the `ALTER` had run.

So work that writes polls waits for the migrations instead of failing on them. Poll
creation is already acked by then, so it can wait up to 20 seconds — the poll appears a
moment later than usual and that is the whole of it. A vote gets a 2-second wait,
because its results view has to be part of the ack, and is told to retry if the bot is
still coming up. Once the bot is up, both waits cost nothing measurable.

**2. `KEEPALIVE_URL` — belt and braces.** Set it to that same `/health` URL and the
bot pings itself every 10 minutes, no third-party account needed. Leave it unset
locally. It stops a *running* instance from falling asleep, but it cannot wake one
that already has — which is why layer 1 is not optional.

> On the free plan, staying awake all month uses roughly 730 of the 750 free
> instance-hours. Fine for one service; if you keep several free services warm in
> the same account, the allowance runs out.

---

## Database

Polls live in PostgreSQL. Set `DATABASE_URL` to a Postgres connection string — the free [Neon](https://neon.tech) tier is enough — and the schema is created and migrated on boot.

```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=verify-full
```

Use `sslmode=verify-full` for any hosted database, so the certificate is verified and nobody on the network path can read the credentials or the votes. The bot retries the connection five times at boot and then exits, rather than serving requests against a missing schema.

### Multi-workspace (OAuth)

A single workspace only needs `SLACK_BOT_TOKEN`. To let other workspaces install the bot, set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` and point the Slack app redirect URL at `/slack/oauth_redirect`; installations are stored in the `slack_installations` table. Each poll records the installation it belongs to, so scheduled auto-closes update the right channel and notify the right people in every installed workspace.

Org-wide (Enterprise Grid) installs work too: one installation covers the org, keyed by enterprise id rather than workspace id (`lib/install.js` decides, and the same rule is used when storing the installation, when authorizing a request, and when recording a poll).

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Bot not responding | Check `.env` tokens are correct |
| First command fails, retry works | The host had gone to sleep — see **Staying awake** |
| Monitor says up, bot still broken | Point the monitor at `/health`, not `/` — see **Staying awake** |
| `/health` returns 503 | Read `database` and `schema` in the body; the instance is running but cannot serve polls |
| Commands not found | Verify Slash Commands have the right Request URL |
| Votes not working | Confirm Interactivity is enabled with the correct URL |
| ngrok URL changed | Update Request URLs in Slack app settings |
| Bot exits at boot with a DB error | Check `DATABASE_URL`; the bot retries five times, then exits so the host restarts it |
| `self signed certificate` on connect | The database is not presenting a trusted certificate. Use managed Postgres, or `sslmode=no-verify` for local dev only |
| Can't create polls in DMs | Add `im:write` and `im:history` scopes, then reinstall the app |
