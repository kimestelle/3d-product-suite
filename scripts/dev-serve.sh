#!/bin/zsh
# Local Gesso server with pinned tools, keychain secrets and opt-in Metal/OIDN acceleration.
cd "$(dirname "$0")/.." || exit 1
export WORLDLABS_API_KEY="$(security find-generic-password -s WORLDLABS_API_KEY -w 2>/dev/null)"
export SSL_CERT_FILE="$(.venv/bin/python -m certifi)"
export GESSO_CYCLES_DEVICE="${GESSO_CYCLES_DEVICE:-METAL}"
export GESSO_CYCLES_DENOISE="${GESSO_CYCLES_DENOISE:-1}"
exec .venv/bin/python -m film serve --data-dir workspace-data \
  --blender "/Applications/Blender 4.3.2.app/Contents/MacOS/Blender" \
  --ffmpeg /opt/homebrew/opt/ffmpeg@7/bin/ffmpeg "$@"
