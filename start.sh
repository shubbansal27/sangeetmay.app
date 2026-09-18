#!/usr/bin/env bash

set -euo pipefail

PORT="${1:-9000}"
echo "apps  → http://localhost:${PORT}/"
echo "  sangeetmay → http://localhost:${PORT}/apps/sangeetmay/"
echo "  domark     → http://localhost:${PORT}/apps/domark/"
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"

# Serve with directory listing disabled so the folder structure is never exposed.
exec python3 - "$PORT" <<'PY'
import http.server, socketserver, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    # Return 404 instead of an auto-generated directory listing.
    def list_directory(self, path):
        self.send_error(404, "Not Found")
        return None

class Server(socketserver.TCPServer):
    allow_reuse_address = True

with Server(("", int(sys.argv[1])), Handler) as httpd:
    httpd.serve_forever()
PY
