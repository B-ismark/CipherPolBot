// pg only turns TLS on if the connection string asks for it. If DATABASE_URL
// omits sslmode, a hosted database is contacted in the clear and refuses the
// connection - which, since the bot now exits when the schema cannot be
// created, would be a restart loop rather than a warning. So default a remote
// host to verified TLS, and leave the URL in charge whenever it says anything.
//
// Returns the ssl option for new Pool(), or undefined to defer to the URL.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', ''];

function sslOptionFor(connectionString) {
  if (!connectionString) return undefined;
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined; // not parseable - let pg report it
  }
  if (url.searchParams.has('sslmode') || url.searchParams.has('ssl')) return undefined;
  if (LOCAL_HOSTS.includes(url.hostname.replace(/^\[|\]$/g, ''))) return undefined;
  return { rejectUnauthorized: true };
}

module.exports = { sslOptionFor };
