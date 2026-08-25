// Who may manage a poll, and who may see its results.

function isCreatorOrCoCreator(poll, userId) {
  return poll.creator === userId || (poll.coCreators || []).includes(userId);
}

// Whether viewerId may see live results. viewerId is null on shared surfaces
// (the in-channel poll message), which everyone sees - those never get
// creator-only results.
function canViewResults(poll, viewerId) {
  if (poll.status === 'closed') return true;
  if (poll.showResults === 'on_close') return false;
  if (poll.showResults === 'creator_only') return !!viewerId && isCreatorOrCoCreator(poll, viewerId);
  return true;
}

function resultsHiddenReason(poll) {
  return poll.showResults === 'on_close'
    ? 'Results visible after poll closes'
    : 'Results visible only to the poll creator';
}

module.exports = { isCreatorOrCoCreator, canViewResults, resultsHiddenReason };
