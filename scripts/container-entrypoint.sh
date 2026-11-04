#!/bin/sh
set -eu

data_dir="${GESSO_DATA_DIR:-/data/workspace}"

# Hosts mount a persistent disk over /data. Set its ownership once
# before starting the server as an unprivileged user. Existing contents stay put.
if [ "$(id -u)" -eq 0 ]; then
    mkdir -p "$data_dir"
    chown gesso:gesso /data "$data_dir"
    exec gosu gesso "$0" "$@"
fi

# AWS mounts its Secrets Manager value as a read-only file. Load it only after
# dropping root, keep it out of process arguments, and never echo the contents.
if [ -n "${GESSO_ACCESS_KEY_FILE:-}" ]; then
    if [ "${GESSO_ACCESS_KEY+x}" = x ]; then
        echo 'Set only GESSO_ACCESS_KEY or GESSO_ACCESS_KEY_FILE, not both.' >&2
        exit 1
    fi
    if [ ! -f "$GESSO_ACCESS_KEY_FILE" ] || [ ! -r "$GESSO_ACCESS_KEY_FILE" ]; then
        echo 'The workspace access-key file must be a readable regular file.' >&2
        exit 1
    fi
    GESSO_ACCESS_KEY="$(cat "$GESSO_ACCESS_KEY_FILE")"
    if [ "${#GESSO_ACCESS_KEY}" -lt 32 ]; then
        echo 'The workspace access-key file must contain at least 32 characters.' >&2
        exit 1
    fi
    export GESSO_ACCESS_KEY
    unset GESSO_ACCESS_KEY_FILE
fi

if [ "$#" -eq 0 ]; then
    set -- python -m film serve \
        --host 0.0.0.0 --port "${PORT:-8787}" --data-dir "$data_dir"
fi

exec "$@"
