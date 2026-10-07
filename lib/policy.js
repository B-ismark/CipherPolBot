// Who may manage a poll, and who may see its results.

function isCreator(poll, userId) {
  return poll.creator === userId;
}

// Whether viewerId may see live results.
//
// viewerId is null on shared surfaces (the in-channel poll message, or a
// results digest posted to a channel), which everyone can read - those only
// ever show results the whole workspace is allowed to see.
function canViewResults(poll, viewerId) {
  if (poll.status === 'closed') return true;
  // The creator always sees their own results, whatever the setting:
  // show_results controls who else sees them, and when.
  if (isCreator(poll, viewerId)) return true;
  if (poll.showResults === 'on_close' || poll.showResults === 'creator_only') return false;
  return true;
}

function resultsHiddenReason(poll) {
  return poll.showResults === 'on_close'
    ? 'Results visible after poll closes'
    : 'Results visible only to the poll creator until it closes';
}

module.exports = { isCreator, canViewResults, resultsHiddenReason };
