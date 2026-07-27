#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec node "$ROOT/tests/terminal-e2e/demo.mjs" "$@"
