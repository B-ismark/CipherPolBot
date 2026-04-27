# Security Fixes Applied

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
