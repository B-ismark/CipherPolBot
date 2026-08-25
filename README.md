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

Go to **OAuth & Permissions → Bot Token Scopes** and add:
- `chat:write`
- `chat:write.public`
- `commands`
- `im:write` — required for polls created in DMs
- `im:history` — required to read DM channel info

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

```
/poll-results poll_1706234567_abc12345
```
→ Shows a breakdown with visual progress bars, visible only to you. Results the poll owner restricted ("only me", or "after the poll closes") stay hidden from everyone else until the poll closes; the owner and co-creators always see their own.

```
/polls-list
```
→ Lists all open polls.

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
→ Closes the poll (creator only).

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

If you want Render to restart an unhealthy instance by itself, set
`healthCheckPath: /health` in `render.yaml`. Weigh it first: a slow cold start on the
database would then look like a failure and cost you a restart, so it is left off by
default.

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
