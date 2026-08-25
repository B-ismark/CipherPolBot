// Turning Render's automatic restart on makes the health endpoint a trigger,
// not just a report, so a single blip must not cost a restart. The database is
// allowed to be unreachable for a grace window before the endpoint starts
// failing: a Neon cold start or a brief network hiccup rides through, while a
// real outage crosses it and the instance gets recycled.
//
// The body stays truthful throughout - status is 'degraded' from the first
// failed probe, even while the HTTP code is still 200 - so a monitor watching
// the body sees the blip that the restart logic deliberately ignores.

const DB_UNHEALTHY_GRACE_MS = 90 * 1000;

function healthStatus({ schemaReady, dbOk, dbFailingForMs = 0, graceMs = DB_UNHEALTHY_GRACE_MS }) {
  const withinGrace = dbOk || dbFailingForMs < graceMs;
  return {
    httpStatus: schemaReady && withinGrace ? 200 : 503,
    status: schemaReady && dbOk ? 'ok' : 'degraded'
  };
}

module.exports = { healthStatus, DB_UNHEALTHY_GRACE_MS };
