#!/bin/sh
set -eu

data_dir="${GESSO_DATA_DIR:-/data/workspace}"

# Render mounts a fresh persistent disk over /data. Set its ownership once
# before starting the server as an unprivileged user. Existing contents stay put.
if [ "$(id -u)" -eq 0 ]; then
    mkdir -p "$data_dir"
    chown gesso:gesso /data "$data_dir"
    exec gosu gesso "$0" "$@"
fi

if [ "$#" -eq 0 ]; then
    set -- python -m film serve \
        --host 0.0.0.0 --port "${PORT:-8787}" --data-dir "$data_dir"
fi

exec "$@"
