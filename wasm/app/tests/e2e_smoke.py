#!/usr/bin/env python3
"""Headless smoke test for the new Parcel/Preact CAMotics app.

Serves app/dist over http (with .wasm -> application/wasm), launches system
chromium headless, waits for the default example to auto-load through the wasm
core, and asserts: wasm module loaded with no page/console errors, a surface
mesh + toolpath lines rendered (window.__viewer.getSceneInfo()), and a
non-trivial screenshot is saved. Also forces a mesh-mode render (Sim::run
marching-cubes surface) and asserts a non-empty surface mesh.

Run from wasm/app:
    uv run --with playwright,pillow python tests/e2e_smoke.py
"""
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent.parent  # app/ (this file is app/tests/)
DIST_DIR = (APP_DIR / "dist").resolve()
SCREENSHOT = APP_DIR / "smoke.png"
CHROMIUM = "/snap/bin/chromium"

# Tiny program (examples/slant_test.nc) for the mesh-mode assertion — inlined so
# the test doesn't depend on parcel's hashed example asset URLs.
SLANT_NC = (
    "G21 T3 F5\n"
    "G0 X0 Y0 Z0\n"
    "G1 X5 Y5 Z-5\n"
    "G1 X10 Y10 Z0\n"
    "G0 Z1\nG0 X0\nG0 Z0\n"
    "G1 X5 Y5 Z-5\n"
    "G1 X10 Y0 Z0\n"
    "G0 Z1\nG0 X5\nG0 Z0\n"
    "G1 Y5 Z-5\n"
    "G1 Y10 Z0\n"
    "G0 Z1\nG0 X0 Y5\nG0 Z0\n"
    "G1 X5 Z-5\n"
    "G1 X10 Z0\n"
    "G0 Z0\n"
)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # parcel emits .wasm without an extension-correct mime on some stdlibs
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)


def main():
    if not DIST_DIR.exists():
        print(f"FAIL: {DIST_DIR} missing — run `npm run build` first")
        return 1

    handler = partial(Handler, directory=str(DIST_DIR))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    host, port = httpd.server_address
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://{host}:{port}/"
    print(f"serving {DIST_DIR} at {base}")

    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=CHROMIUM,
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    "--use-gl=swiftshader",
                ],
            )
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.on("console", lambda m: (
                errors.append(f"console.{m.type}: {m.text}")
                if m.type in ("error",) else None
            ))
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

            page.goto(base, wait_until="load")

            # wait for the viewer hook (set after the default example simulates)
            page.wait_for_function("window.__viewer && window.__viewer.ready === true",
                                   timeout=60000)
            # give a couple frames to render
            page.wait_for_timeout(800)

            info = page.evaluate("window.__viewer.getSceneInfo()")
            duration = page.evaluate("window.__viewer.getDuration()")
            moves = page.evaluate("window.__viewer.getMoveCount()")
            status = page.text_content("#status")
            print("sceneInfo:", info)
            print("duration:", duration, "moves:", moves)
            print("status:", status)

            # MESH-mode coverage (Sim::run marching-cubes surface) — retained from
            # the deleted wasm/e2e. Force mesh render of a tiny program, assert a
            # non-empty surface mesh comes back.
            mesh = page.evaluate(
                """async (g) => {
                     await window.__simulate(g, 'mesh-smoke');
                     return window.__viewer.getSceneInfo();
                   }""",
                SLANT_NC,
            )
            print("mesh sceneInfo:", mesh)

            page.screenshot(path=str(SCREENSHOT))
            browser.close()
    finally:
        httpd.shutdown()

    # --- assertions ---------------------------------------------------------
    ok = True
    if errors:
        print("FAIL: page/console errors:")
        for e in errors:
            print("  ", e)
        ok = False

    # default render mode is the analytic GPU cut (squirm-free, crisp walls)
    if not info or not info.get("hasCut"):
        print(f"FAIL: no analytic cut in scene: {info}")
        ok = False
    if not info or info.get("lineSegments", 0) <= 0:
        print(f"FAIL: no toolpath line segments: {info}")
        ok = False
    if not info or not info.get("hasToolMarker"):
        print("FAIL: no tool marker")
        ok = False

    # mesh-mode (Sim::run surface) must produce a non-empty marching-cubes mesh
    if not mesh or not mesh.get("hasSurface"):
        print(f"FAIL: mesh mode produced no surface: {mesh}")
        ok = False
    if not mesh or mesh.get("triangles", 0) <= 0:
        print(f"FAIL: mesh mode produced no triangles: {mesh}")
        ok = False

    size = SCREENSHOT.stat().st_size if SCREENSHOT.exists() else 0
    print(f"screenshot: {SCREENSHOT} ({size} bytes)")
    if size < 10000:
        print("FAIL: screenshot trivially small")
        ok = False

    print("RESULT:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
