#!/bin/sh
set -eu

DATA_DIR="/app/data"
LEGACY_DIR="/legacy-data"
USE_EXISTING_DB="${UPTIME_KUMA_USE_EXISTING_DB:-true}"

case "$USE_EXISTING_DB" in
    true|TRUE|1|yes|YES)
        USE_EXISTING_DB=true
        ;;
    false|FALSE|0|no|NO)
        USE_EXISTING_DB=false
        ;;
    *)
        echo "[ENTRYPOINT] Invalid UPTIME_KUMA_USE_EXISTING_DB='$UPTIME_KUMA_USE_EXISTING_DB'. Use true or false."
        exit 1
        ;;
esac

if [ "$USE_EXISTING_DB" = "false" ]; then
    echo "[ENTRYPOINT] UPTIME_KUMA_USE_EXISTING_DB=false"
    echo "[ENTRYPOINT] Removing all existing Uptime Kuma data and starting with a new database..."

    # The volume itself is intentionally kept. Only its contents are reset.
    # This guarantees that the next deploy can reuse the same named volume.
    find "$DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

    echo "[ENTRYPOINT] Existing data removed. A new database will be created."
else
    echo "[ENTRYPOINT] UPTIME_KUMA_USE_EXISTING_DB=true"

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
fi

exec "$@"
