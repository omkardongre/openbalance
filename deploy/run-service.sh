#!/bin/sh
set -eu
case "${OPENBALANCE_PROCESS:-server}" in
  server) exec node /app/dist/server.js ;;
  financial-worker) exec node /app/dist/financial-worker-server.js ;;
  migrate) exec node /app/dist/migrate.js ;;
  *) echo 'OPENBALANCE_PROCESS is not a supported runtime entrypoint.' >&2; exit 64 ;;
esac
