#!/usr/bin/env bash

set -euo pipefail

PORT="${1:-9000}"
echo "sa·re·ga·ma → http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")/src"
exec python3 -m http.server "${PORT}"
