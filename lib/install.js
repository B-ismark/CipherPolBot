const crypto = require('crypto');

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

// ==================== OAuth state ====================
//
// Without a state check, anyone can hand a victim a link to our redirect with
// a code of their own, and the victim's browser completes an install nobody
// asked for. The fix is the standard one: the install starts on our own page,
// which sets a short-lived cookie holding a random nonce and sends Slack a
// state carrying that nonce, its age, and an HMAC of both keyed by
// SLACK_STATE_SECRET. The redirect accepts only a state that is ours (the MAC),
// fresh (the age) and started in this same browser (the cookie).

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_COOKIE = 'slack_install_nonce';

// The five scopes README lists, and the only ones the bot's calls need.
const BOT_SCOPES = ['commands', 'chat:write', 'chat:write.public', 'im:write', 'files:write'];

function stateMac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createInstallState(secret, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${now}.${nonce}`;
  return { nonce, state: `${payload}.${stateMac(secret, payload)}` };
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyInstallState(secret, state, cookieNonce, now = Date.now()) {
  if (!secret || typeof state !== 'string' || !cookieNonce) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [issuedAt, nonce, mac] = parts;
  if (!sameText(mac, stateMac(secret, `${issuedAt}.${nonce}`))) return false;
  const age = now - Number(issuedAt);
  // A minute of clock skew either way; nothing older than the cookie lives.
  if (!Number.isFinite(age) || age < -60 * 1000 || age > STATE_TTL_MS) return false;
  return sameText(nonce, cookieNonce);
}

function installUrl(clientId, state) {
  const query = new URLSearchParams({ client_id: clientId, scope: BOT_SCOPES.join(','), state });
  return `https://slack.com/oauth/v2/authorize?${query}`;
}

// Scoped to /slack, where both install routes live; Lax so it survives the
// top-level redirect back from slack.com; Secure because the host is https.
function stateCookie(nonce) {
  return `${STATE_COOKIE}=${nonce}; Max-Age=${STATE_TTL_MS / 1000}; Path=/slack; HttpOnly; Secure; SameSite=Lax`;
}

function clearedStateCookie() {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/slack; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header, name = STATE_COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

module.exports = {
  installationKey, installationKeyFromOAuth,
  BOT_SCOPES, STATE_TTL_MS, STATE_COOKIE,
  createInstallState, verifyInstallState, installUrl, stateCookie, clearedStateCookie, readCookie
};
