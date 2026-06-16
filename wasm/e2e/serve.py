#!/usr/bin/env python3
"""Static HTTP server for the CAMotics viewer (ES modules + fetch need http).

Serves wasm/viewer/ on 127.0.0.1. Used by test_viewer.py and for manual dev:

    python3 serve.py            # serves on 127.0.0.1:8000
    python3 serve.py 8123       # custom port
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VIEWER_DIR = (Path(__file__).resolve().parent.parent / "viewer").resolve()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep test output clean


def make_server(host="127.0.0.1", port=0):
    """Return a server bound to host:port. port=0 picks a free port."""
    handler = partial(QuietHandler, directory=str(VIEWER_DIR))
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = make_server("127.0.0.1", port)
    host, port = httpd.server_address
    print(f"Serving {VIEWER_DIR} at http://{host}:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
