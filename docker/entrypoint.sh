#!/bin/sh
set -eu

DATA_DIR="/app/data"
LEGACY_DIR="/legacy-data"

# Keep the database and all Uptime Kuma data across image rebuilds/redeploys.
# On the first deployment using the persistent volume, migrate the old bind-mounted
# ./data directory if it contains an existing installation.
if [ -d "$LEGACY_DIR" ] && [ -z "$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    if [ -n "$(find "$LEGACY_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
        echo "[ENTRYPOINT] Migrating existing Uptime Kuma data to persistent volume..."
        cp -a "$LEGACY_DIR"/. "$DATA_DIR"/
        chown -R node:node "$DATA_DIR"
        echo "[ENTRYPOINT] Data migration completed."
    fi
fi

exec "$@"
