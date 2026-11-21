#!/usr/bin/env bash
set -euo pipefail
CWEB_PORTABLE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CWEB_FIRST_RESTORE=false
if [[ ! -f "$CWEB_PORTABLE_ROOT/.migration/ready.json" ]]; then CWEB_FIRST_RESTORE=true; fi
python3 "$CWEB_PORTABLE_ROOT/scripts/migration/restore.py" --root "$CWEB_PORTABLE_ROOT"
export PATH="$CWEB_PORTABLE_ROOT/.runtime/bin:$PATH"
export CODEX_HOME="$CWEB_PORTABLE_ROOT/.migration/codex"
export CWEB_DATA_DIR="$CWEB_PORTABLE_ROOT/bridge/.data"
unset CWEB_ISOLATED
if $CWEB_FIRST_RESTORE; then
  node "$CWEB_PORTABLE_ROOT/scripts/install-launcher.mjs" --install || printf '%s\n' '用户级命令安装未完成。仍可使用 bash cweb；请处理提示后运行 bash scripts/migration/run.sh --install-launcher。' >&2
fi
if [[ "${1:-}" == --cli ]]; then
  shift
  exec "${CWEB_CODEX:-codex}" "$@"
fi
if [[ "${1:-}" == --install-launcher ]]; then
  exec node "$CWEB_PORTABLE_ROOT/scripts/install-launcher.mjs" --install
fi
exec node "$CWEB_PORTABLE_ROOT/scripts/cweb.mjs" "$@"
