#!/usr/bin/env bash
# Raise local Realtime tenant limits. The container re-seeds `_realtime.tenants` (defaults: 100 events/s)
# on every start, and Realtime caches the tenant row at first use (health ping). So: restart, then keep
# re-applying the update until the server has started serving, which guarantees the cached row is ours.
set -uo pipefail
DB=postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres
DIR="$(cd "$(dirname "$0")" && pwd)"
C=supabase_realtime_agar
docker restart "$C" >/dev/null
since=$(date +%s)
applied=0
for _ in $(seq 1 600); do
  if psql "$DB" -v ON_ERROR_STOP=1 -f "$DIR/dev-realtime-limits.sql" 2>/dev/null | grep -q "UPDATE 1"; then applied=1; fi
  # Stop once the server has handled its first request (tenant is now cached) and we have applied at least once.
  if [ "$applied" = 1 ] && docker logs "$C" --since "$since" 2>&1 | grep -q "Realtime.RateCounter"; then
    psql "$DB" -v ON_ERROR_STOP=1 -f "$DIR/dev-realtime-limits.sql" >/dev/null
    echo "realtime limits applied"; exit 0
  fi
  sleep 0.1
done
echo "failed to apply realtime limits (server did not start serving?)" >&2; exit 1
