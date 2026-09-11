#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

port="${1:-9000}"
echo "Serving domark at http://localhost:${port}"
python3 -m http.server "$port"
