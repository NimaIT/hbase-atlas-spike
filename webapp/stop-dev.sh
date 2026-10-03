#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../env.sh"
exec python3 "$HBASE_SPIKE_ROOT/scripts/runtime.py" web-stop "$@"
