import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Compile the migration and exercise real RLS/RPC behavior without leaving any
// schema, fixtures or migration-history changes in the local database.
const migration = readFileSync(new URL('../supabase/migrations/202609100002_agent_first_debug_party.sql', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../supabase/tests/debug_party_smoke.sql', import.meta.url), 'utf8');
// The CLI prepares one statement. A PL/pgSQL exception block supplies a real
// subtransaction: this private sentinel rolls back every successful test too.
const sql = `do $validation$
begin
  perform set_config('statement_timeout', '30s', true);
  perform set_config('lock_timeout', '3s', true);
  begin
    execute $migration$${migration}$migration$;
    execute $smoke$${smoke}$smoke$;
    raise exception using errcode = 'ZX001', message = 'debug-party rollback sentinel';
  exception when sqlstate 'ZX001' then
    raise notice 'debug-party migration and RLS/lifecycle smoke checks passed; rolled back';
  end;
end $validation$;`;
const result = spawnSync('supabase', ['db', 'query', '--local', sql], { encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status === 0) process.stdout.write('PASS: migration and real RLS/lifecycle checks; all changes rolled back.\n');
process.exitCode = result.status ?? 1;
