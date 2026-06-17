#!/usr/bin/env python3
"""No-cache static server for the built app (wasm/app/dist). Binds 0.0.0.0:8080.
Sends Cache-Control: no-store so a soft refresh always gets the latest build
(parcel hashes the JS/wasm, but index.html is unhashed and would otherwise cache).
    python3 wasm/app/serve_dist.py [port]
"""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map = dict(Handler.extensions_map)
Handler.extensions_map.update({".wasm": "application/wasm", ".js": "text/javascript"})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"app/dist -> http://localhost:{PORT}/  (tailnet http://100.80.39.92:{PORT}/)", flush=True)
        httpd.serve_forever()
