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
→ Shows a breakdown with visual progress bars, visible only to you. Results the poll owner restricted ("only me", or "after the poll closes") stay hidden until they are released.

```
/polls-list
```
→ Lists all open polls.

```
/poll-share poll_1706234567_abc12345
```
→ Posts current results into the channel. Creator and co-creators only, since everyone there can read them.

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

> ⚠️ Render's free tier spins down after 15 minutes of inactivity.
> Use https://cron-job.org (free) to ping your URL every 10 minutes to keep it awake.

### Railway
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Add environment variables
3. Copy the public URL and update Slack app Request URLs

---

## Database

Polls live in PostgreSQL. Set `DATABASE_URL` to a Postgres connection string — the free [Neon](https://neon.tech) tier is enough — and the schema is created and migrated on boot.

```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=verify-full
```

Use `sslmode=verify-full` for any hosted database, so the certificate is verified and nobody on the network path can read the credentials or the votes. The bot retries the connection five times at boot and then exits, rather than serving requests against a missing schema.

### Multi-workspace (OAuth)

A single workspace only needs `SLACK_BOT_TOKEN`. To let other workspaces install the bot, set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` and point the Slack app redirect URL at `/slack/oauth_redirect`; installations are stored in the `slack_installations` table. Note that overdue polls in OAuth installs close in the database without updating their Slack message, because polls do not record which workspace they belong to.

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Bot not responding | Check `.env` tokens are correct |
| Commands not found | Verify Slash Commands have the right Request URL |
| Votes not working | Confirm Interactivity is enabled with the correct URL |
| ngrok URL changed | Update Request URLs in Slack app settings |
| Bot exits at boot with a DB error | Check `DATABASE_URL`; the bot retries five times, then exits so the host restarts it |
| `self signed certificate` on connect | The database is not presenting a trusted certificate. Use managed Postgres, or `sslmode=no-verify` for local dev only |
| Can't create polls in DMs | Add `im:write` and `im:history` scopes, then reinstall the app |
