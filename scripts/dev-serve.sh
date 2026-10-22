#!/usr/bin/env bash
# Local server. GESSO_PYTHON, BLENDER and FFMPEG may be paths or commands.
# This shortcut opts into Metal + denoising; the ordinary CLI defaults to CPU.
# The worker still enforces the pinned Blender/FFmpeg export versions.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

resolve_command() {
  if [[ "$1" == */* ]]; then
    [[ -x "$1" ]] && printf '%s\n' "$1"
  else
    command -v "$1" 2>/dev/null
  fi
}

python_command=''
if [[ -n "${GESSO_PYTHON:-}" ]]; then
  python_command="$(resolve_command "$GESSO_PYTHON" || true)"
  if [[ -z "$python_command" ]]; then
    printf 'GESSO_PYTHON is not executable: %s\n' "$GESSO_PYTHON" >&2
    exit 1
  fi
else
  for candidate in .venv/bin/python python3.12 python3; do
    resolved="$(resolve_command "$candidate" || true)"
    if [[ -n "$resolved" ]] && "$resolved" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))' 2>/dev/null; then
      python_command="$resolved"
      break
    fi
  done
fi
if [[ -z "$python_command" ]] || ! "$python_command" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))' 2>/dev/null; then
  printf 'Gesso requires Python 3.12. Set GESSO_PYTHON to a Python 3.12 environment with the project dependencies installed.\n' >&2
  exit 1
fi

# Prefer an installed pinned executable. A different installed version remains
# useful for import; the server reports which export formats are unavailable.
find_renderer() {
  local name="$1" expected="$2" override="$3" resolved first='' reported
  shift 3
  if [[ -n "$override" ]]; then
    resolve_command "$override" || { printf '%s override is not executable: %s\n' "$name" "$override" >&2; return 1; }
    return
  fi
  for candidate in "$@"; do
    resolved="$(resolve_command "$candidate" || true)"
    [[ -n "$resolved" ]] || continue
    [[ -n "$first" ]] || first="$resolved"
    if [[ "$name" == blender ]]; then
      reported="$("$resolved" --version 2>/dev/null || true)"
      [[ "$reported" == "Blender $expected"$'\n'* || "$reported" == "Blender $expected" ]] || continue
    else
      reported="$("$resolved" -version 2>/dev/null || true)"
      [[ "$reported" == "ffmpeg version $expected "* || "$reported" == "ffmpeg version $expected-"* ]] || continue
    fi
    printf '%s\n' "$resolved"
    return
  done
  printf '%s\n' "${first:-$name}"
}

blender_command="$(find_renderer blender 4.3.2 "${BLENDER:-}" \
  blender '/Applications/Blender 4.3.2.app/Contents/MacOS/Blender' \
  '/Applications/Blender.app/Contents/MacOS/Blender' \
  "$HOME/Applications/Blender 4.3.2.app/Contents/MacOS/Blender" \
  "$HOME/Applications/Blender.app/Contents/MacOS/Blender")"
ffmpeg_command="$(find_renderer ffmpeg 7.1.5 "${FFMPEG:-}" \
  ffmpeg /opt/homebrew/opt/ffmpeg@7/bin/ffmpeg /usr/local/opt/ffmpeg@7/bin/ffmpeg)"

# Help never accesses Keychain. Existing environment credentials take priority.
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  exec "$python_command" -m film serve --help
fi
if [[ -z "${WORLDLABS_API_KEY:-}" && "${GESSO_KEYCHAIN:-1}" == 1 && "$(uname -s)" == Darwin ]] && command -v security >/dev/null 2>&1; then
  keychain_key="$(security find-generic-password -s WORLDLABS_API_KEY -w 2>/dev/null || true)"
  if [[ -n "$keychain_key" ]]; then export WORLDLABS_API_KEY="$keychain_key"; fi
  unset keychain_key
fi
if [[ -z "${SSL_CERT_FILE:-}" ]]; then
  certificate_file="$("$python_command" -m certifi 2>/dev/null || true)"
  if [[ -n "$certificate_file" && -f "$certificate_file" ]]; then export SSL_CERT_FILE="$certificate_file"; fi
fi
export GESSO_CYCLES_DEVICE="${GESSO_CYCLES_DEVICE:-METAL}"
export GESSO_CYCLES_DENOISE="${GESSO_CYCLES_DENOISE:-1}"
export GESSO_ROOT="$PWD"
exec "$python_command" -m film serve --data-dir workspace-data \
  --blender "$blender_command" --ffmpeg "$ffmpeg_command" "$@"
