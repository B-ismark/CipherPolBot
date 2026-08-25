// One key identifies one installation of the bot, and the same key must be used
// everywhere: the row in slack_installations, the lookup in authorize(), and the
// team_id recorded on each poll so the auto-close sweeper can find the token.
//
// For an org-wide (Enterprise Grid) install there is one installation for the
// whole org and no single workspace behind it, so the enterprise id is the key.
// Everything else - including a workspace-level install inside a Grid org - is
// keyed by the workspace id.

function installationKey({ isEnterpriseInstall, enterpriseId, teamId } = {}) {
  if (isEnterpriseInstall) return enterpriseId || teamId || null;
  return teamId || enterpriseId || null;
}

// The same rule applied to an oauth.v2.access response, where team is null for
// an org-wide install.
function installationKeyFromOAuth(result = {}) {
  return installationKey({
    isEnterpriseInstall: !!result.is_enterprise_install,
    enterpriseId: result.enterprise?.id,
    teamId: result.team?.id
  });
}

module.exports = { installationKey, installationKeyFromOAuth };
