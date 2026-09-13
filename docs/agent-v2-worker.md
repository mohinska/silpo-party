# Party agent v2 worker

Set `PARTY_AGENT_VERSION=v2` only after the reviewed v2 migrations have been
applied to the target environment. The Node route performs one durable slice:
`POST /api/internal/agent-runs` with `Authorization: Bearer $AGENT_WORKER_SECRET`.

For local development, run the application and then `npm run agent:poll`. It
uses the same authenticated route every five seconds; it does not start a
separate worker implementation.

Configure the Supabase `agent-dispatcher` Cron to POST every five seconds with
`Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY` (satisfies the platform's
default JWT verification on the function) and `x-dispatcher-secret:
$AGENT_DISPATCHER_SECRET` (the function's own check). The dispatcher returns
202, registers its Node forward in `EdgeRuntime.waitUntil`, and the durable
queue recovers an interrupted slice through its lease. Store `NEXT_APP_URL`,
`AGENT_WORKER_SECRET`, and `AGENT_DISPATCHER_SECRET` in deployment secrets;
never place values in this document or a client variable.

Cron setup (run once against the linked project): enable `pg_cron` and
`pg_net`, store the dispatcher secret and service-role key in Vault, then
`cron.schedule` a 5-second job that calls the deployed function via
`net.http_post` using the vaulted secrets — see
`supabase/migrations/*_agent_v2_dispatcher_cron.sql`.
