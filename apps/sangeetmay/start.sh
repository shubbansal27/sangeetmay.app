#!/usr/bin/env bash

set -euo pipefail

PORT="${1:-9000}"
echo "sangeetmay → http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"
exec python3 -m http.server "${PORT}"
