#!/usr/bin/env bash
set -euo pipefail
CWEB_PORTABLE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 "$CWEB_PORTABLE_ROOT/scripts/migration/restore.py" --root "$CWEB_PORTABLE_ROOT"
export PATH="$CWEB_PORTABLE_ROOT/.runtime/bin:$PATH"
export CODEX_HOME="$CWEB_PORTABLE_ROOT/.migration/codex"
export CWEB_DATA_DIR="$CWEB_PORTABLE_ROOT/bridge/.data"
unset CWEB_ISOLATED
if [[ "${1:-}" == --cli ]]; then
  shift
  exec "${CWEB_CODEX:-codex}" "$@"
fi
if [[ "${1:-}" == --install-launcher ]]; then
  exec node "$CWEB_PORTABLE_ROOT/scripts/install-launcher.mjs" --install
fi
exec node "$CWEB_PORTABLE_ROOT/scripts/cweb.mjs" "$@"
