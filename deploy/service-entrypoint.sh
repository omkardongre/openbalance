#!/bin/sh
set -eu
case "${OPENBALANCE_PROCESS:-}" in
  api|indexer|integrations|relayer|venue-relay)
    exec node "/app/services/$OPENBALANCE_PROCESS/dist/server.js" ;;
  financial-worker)
    exec node /app/services/relayer/dist/financial-worker-server.js ;;
  venue-relay-settlement)
    exec node /app/services/venue-relay/dist/settlement-worker-server.js ;;
  migrate-api|migrate-indexer|migrate-relayer|migrate-integrations)
    service="${OPENBALANCE_PROCESS#migrate-}"
    exec node "/app/services/$service/dist/migrate.js" ;;
  *)
    echo 'OPENBALANCE_PROCESS must identify a supported service or migration.' >&2
    exit 64 ;;
esac
