# Security Fixes Applied

> Line numbers below are historical - the file has moved on since they were
> written. Search for the function name instead. Validation and rate limiting
> now live in `lib/validation.js`, results visibility in `lib/policy.js`, and
> both are covered by `npm test`.

## Completed Fixes

### 1. ✅ Rate Limiting on Poll Creation
- **Issue**: Any user could spam `/newpoll` to create unlimited polls
- **Fix**: Added `checkPollCreationRateLimit()` function that limits users to 10 polls per 24 hours
- **Location**: `slack-poll-bot.js` (lines 157-169)
- **Behavior**: Throws error if limit exceeded, error is caught and notified to user

### 2. ✅ Input Length Validation
- **Issue**: Poll titles, descriptions, questions, and options lacked max-length checks
- **Fix**: Added `validatePollInputs()` function with the following limits:
  - Poll title: 200 characters max
  - Poll description: 1000 characters max
  - Question text: 500 characters max
  - Option text: 200 characters max
  - Max 50 questions per poll
  - Max 10 options per question
- **Location**: `slack-poll-bot.js` (lines 159-187)
- **Behavior**: Validation happens in `createAndPostPoll()` before poll is saved
- **User Feedback**: Detailed error messages for each validation failure

### 3. ✅ Notification Spam Rate Limiting
- **Issue**: Users could opt-in to notifications and spam other users
- **Fix**: 
  - Added `checkNotificationRateLimit()` limiting each user to 5 notifications per hour
  - Limited poll subscribers to 20 per poll (enforced in `sendCloseNotifications()`)
- **Location**: `slack-poll-bot.js` (lines 171-186, 219-230)
- **Behavior**: 
  - Notifications are silently dropped if user hits hourly limit
  - Only first 20 subscribers are notified per poll closure

### 4. ✅ Privacy Default: Changed `showResults` from 'realtime' to 'creator_only'
- **Issue**: Poll results visible to everyone by default (privacy leak in sensitive surveys)
- **Fix**: Changed default from 'realtime' to 'creator_only' across all poll creation paths
- **Locations**:
  - `buildCreationModal()`: line 615 (form default)
  - `createAndPostPoll()`: line 1126 (creation parameter)
  - `readMainModalSettings()`: line 1198 (fallback)
  - `rowToPoll()`: line 79 (data retrieval fallback)
  - `savePoll()`: line 67 (data save fallback)
- **Behavior**: Users still have option to choose 'realtime' or 'on_close' in poll settings

### 5. ✅ Poll Edit Validation
- **Issue**: Poll edits weren't validating input lengths
- **Fix**: Added length validation in `poll_edit_submit` view handler
- **Location**: `slack-poll-bot.js` (lines 1608-1615)
- **Limits**: Same as creation (200 chars for title, 1000 for description)

### 6. ✅ Notification Subscriber Limits
- **Issue**: No limits on number of users who could subscribe to close notifications
- **Fix**: Limited to 20 subscribers per poll, excess are silently dropped
- **Location**: `sendCloseNotifications()` line 219
- **Behavior**: Only first 20 subscribers receive notifications

## Constants for Rate Limiting & Validation

Located at lines 150-163:

```javascript
const MAX_POLL_TITLE_LENGTH = 200;
const MAX_POLL_DESCRIPTION_LENGTH = 1000;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_QUESTIONS_PER_POLL = 50;
const MAX_OPTIONS_PER_QUESTION = 10;
const MAX_POLLS_PER_USER_PER_DAY = 10;
const MAX_NOTIFY_SUBSCRIBERS_PER_POLL = 20;
const MAX_NOTIFICATIONS_PER_USER_PER_HOUR = 5;
```

All constants are easily tunable if different limits are needed.

## What Was NOT Changed (Still Secure)

✓ SQL injection prevention (parameterized queries) — Already secure
✓ Vote race conditions (database transactions with FOR UPDATE) — Already secure
✓ Authorization checks (creator-only on poll close/edit) — Already secure
✓ Slack Block Kit sanitization — Already secure via Slack SDK
✓ OAuth token management — Already secure via Slack SDK
✓ Vote timestamps (server-side generated) — Already secure

## Behavior Changes

1. **Existing polls maintain their `showResults` setting** — Only new polls default to 'creator_only'
2. **Rate limits are per-user in-memory** — Resets if bot is restarted (use database for persistence if needed)
3. **Validation errors are user-friendly** — Specific error messages for each validation failure
4. **Notification rate limits are soft** — Notifications gracefully skip if user is at limit (no error)

## Testing Recommendations

1. Test that creating >10 polls in 24 hours shows rate limit error
2. Test that poll title >200 chars shows validation error
3. Test that editing poll with oversized title shows validation error
4. Verify new polls default to 'creator_only' (not 'realtime')
5. Test that adding >20 notifyOnClose subscribers limits to 20
6. Verify existing polls keep their original showResults setting

## Future Improvements

- Move rate limit tracking to database for persistence across restarts
- Add admin command to reset user rate limits if needed
- Consider webhook for audit logging of validation rejections
- Add configuration for rate limit constants via environment variables

---

## Round 2 - results disclosure, vote loss, operational hardening

### 6. Result visibility applied to every question type
- **Issue**: the `show_results` gate only ran on the fallthrough path of `buildQuestionResultBlock()`, so `open_ended`, `likert` and `ranking` questions rendered full results (including voter names) on `creator_only` and `on_close` polls while they were still open
- **Fix**: the gate runs once at the top of the function for every type, via `canViewResults()` in `lib/policy.js`
- **Also**: the function now takes a `viewerId`. The creator and co-creators always see their own live results, whatever `show_results` says - the setting governs who *else* sees them, and when. A null `viewerId` means a shared surface (the in-channel poll message, or a results digest posted to a channel), which only ever shows results the whole workspace may see

### 7. Authorization on the commands that read poll data
- **Issue**: `/poll-results`, `/poll-share` and `/poll-export` looked polls up by id with no permission check, and poll ids are listed to everyone by `/polls-list`. `/poll-results` and `/poll-share` used `chat.postMessage`, so any member could also broadcast another creator poll results into a channel
- **Fix**: `/poll-results` is gate-aware and ephemeral; `/poll-share` (public) and `/poll-export` (raw per-voter CSV) are limited to the creator and co-creators
- **Also**: `/poll-share` refuses to post restricted results while the poll is open, even for the creator. Voters were told the results were private; releasing them means closing the poll or changing the setting, not one command that contradicts it
- **Not gated**: the `📤 Post to Channel` button on the poll message, which any member may use. It posts the poll itself with a null viewer, so restricted results stay hidden, and re-posting a poll to gather votes is the point of the button. It was labelled "Share Results" on closed polls, which misdescribed it

### 8. Post-vote confirmation no longer overrides the setting
- **Issue**: `buildPostVoteModal()` passed `showResults: 'realtime'`, showing every voter the full results regardless of the poll setting
- **Fix**: it renders for the actual viewer

### 9. Votes are never dropped silently
- **Issue**: four paths in `vote_submit` acked with no `response_action`, so the modal closed with no feedback and the voter believed the vote counted: poll already closed, poll past `close_at`, revote with changes disabled, and transaction error
- **Fix**: each returns an explanatory view

### 10. Overdue polls close on schedule
- **Issue**: `close_at` was only honoured when someone tried to vote after it passed, so a quiet poll stayed "Active" for ever and never notified subscribers
- **Fix**: `sweepOverduePolls()` runs at boot and every 60s. The UPDATE is atomic so a concurrent vote cannot double-close

### 11. Auto-close works in every installed workspace
- **Issue**: the sweeper acts on its own, with no request to borrow a token from, so multi-workspace OAuth installs could only close overdue polls in the database - the channel message stayed "🟢 Active" and nobody was notified
- **Fix**: polls record a `team_id`, and `clientForPoll()` resolves that workspace token from `slack_installations` (or `SLACK_BOT_TOKEN` for single-workspace deployments). Polls predating the column resolve when exactly one workspace has installed the bot, and are otherwise closed in the database with a warning naming the poll
- **Note**: `savePoll` writes `team_id` with `COALESCE(EXCLUDED.team_id, polls.team_id)`, so a later write that does not carry the team cannot erase it

### 12. Database TLS is verified
- **Issue**: `ssl: { rejectUnauthorized: false }` disabled certificate verification, so a MITM on the Postgres connection could read the credentials and every vote
- **Fix**: removed; TLS comes from `sslmode` in `DATABASE_URL` (use `verify-full`). Connect timeout raised to 10s for cold starts, and a pool `error` listener keeps an idle-client error from killing the process

### 13. CSV export cannot inject formulas
- **Issue**: open-ended answers starting with `=`, `+`, `-` or `@` execute as formulas in Excel and Sheets
- **Fix**: such cells are prefixed with an apostrophe

### 14. Operational
- `/polls-list` capped at 20 like `/polls-archive`, both saying how many were hidden (an unbounded list exceeded Slack message limits)
- Boot binds the port first (Render kills a service that opens no port within ~60s, see bdeeb05), then retries the schema five times and exits if it never succeeds, instead of logging "will retry on next request" and never retrying
- SIGTERM/SIGINT close the server and pool before exit
- Modal-refresh failures warn instead of being swallowed by `catch (_) {}`
- `isCreatorOrAdmin` renamed `isCreatorOrCoCreator`: there is no workspace-admin override, and the old name implied one
