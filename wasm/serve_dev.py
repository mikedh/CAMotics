#!/usr/bin/env python3
"""Dev server for the CAMotics wasm viewer. Binds 0.0.0.0 (reachable over the
tailnet/LAN) on port 8000. Single-threaded wasm -> no COOP/COEP needed.
Usage: python3 wasm/serve_dev.py [port] [host]
"""
import http.server, socketserver, os, sys, socket, subprocess

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HOST = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "viewer")


def reachable_urls(port):
    urls = [f"http://localhost:{port}/"]
    try:  # tailnet IP
        ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
        for ip in ts.stdout.split():
            if ip.strip():
                urls.append(f"http://{ip.strip()}:{port}/   (tailnet)")
    except Exception:
        pass
    try:  # LAN IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80))
        urls.append(f"http://{s.getsockname()[0]}:{port}/   (LAN)"); s.close()
    except Exception:
        pass
    return urls


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always serve fresh builds
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


Handler.extensions_map = dict(Handler.extensions_map)
Handler.extensions_map.update({".wasm": "application/wasm",
                               ".js": "text/javascript", ".mjs": "text/javascript"})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server((HOST, PORT), Handler) as httpd:
        print(f"CAMotics wasm viewer serving {DIR}")
        print(f"bound {HOST}:{PORT} — open any of:")
        for u in reachable_urls(PORT):
            print("   " + u)
        print("(Ctrl-C to stop)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
