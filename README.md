# 🗳️ Slack Poll Bot
> 100% free — no paid services required

Create and manage polls in Slack with real-time vote tracking. Polls persist across restarts using a local SQLite database.

---

## Tech Stack (all free)

| Component        | Tool                      | Cost  |
|-----------------|---------------------------|-------|
| Bot framework   | Slack Bolt (Node.js)      | Free  |
| Database        | SQLite via better-sqlite3 | Free  |
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
| `/poll`          | Create a new poll       | `Question \| Option 1 \| Option 2` |
| `/poll-results`  | View results            | `POLL_ID`                     |
| `/polls-list`    | List all active polls   |                               |
| `/poll-close`    | Close a poll            | `POLL_ID`                     |

### 7. Enable Interactivity

Go to **Interactivity & Shortcuts**, toggle it **ON**, and set:
Request URL: `https://abc123.ngrok-free.app/slack/events`

---

## Usage

```
/poll Best language? | Python | JavaScript | Go
```
→ A poll appears with Vote buttons. Votes update in real time.

```
/poll-results poll_1706234567_abc12345
```
→ Shows a breakdown with visual progress bars.

```
/polls-list
```
→ Lists all open polls.

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
4. Set environment variables (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`)
5. Copy the public URL and update all Slack app Request URLs

> ⚠️ Render's free tier spins down after 15 minutes of inactivity.
> Use https://cron-job.org (free) to ping your URL every 10 minutes to keep it awake.

### Railway
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Add environment variables
3. Copy the public URL and update Slack app Request URLs

---

## Database

Polls are stored in `polls.db` (SQLite file in the project directory). No setup required — it's created automatically on first run.

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Bot not responding | Check `.env` tokens are correct |
| Commands not found | Verify Slash Commands have the right Request URL |
| Votes not working | Confirm Interactivity is enabled with the correct URL |
| ngrok URL changed | Update Request URLs in Slack app settings |
| Polls lost after restart | Make sure `polls.db` file is persisted on your host |
