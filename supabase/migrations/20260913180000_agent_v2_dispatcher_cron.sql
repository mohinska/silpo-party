-- 5-second Cron dispatch for the agent-v2 worker. No secret values live here;
-- the cron job reads them from Vault by name at call time (see
-- docs/agent-v2-worker.md for the one-off statements that create those
-- Vault entries -- never run from a committed migration).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'agent-v2-dispatcher',
  '5 seconds',
  $$
  select net.http_post(
    url := 'https://dnspnlmukuvcprjhedvx.supabase.co/functions/v1/agent-dispatcher',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'agent_v2_anon_key'),
      'x-dispatcher-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_v2_dispatcher_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
