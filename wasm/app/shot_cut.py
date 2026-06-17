#!/usr/bin/env python3
"""Screenshot the analytic Cut render at a few scrub times; report GL/console errors."""
import threading, http.server, socketserver, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
CHROMIUM = "/snap/bin/chromium"
EX = sys.argv[1] if len(sys.argv) > 1 else "scorpion.nc"
FRACS = [1.0, 0.5, 0.25]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(DIST), **k)
    def end_headers(self): self.send_header("Cache-Control", "no-store"); super().end_headers()
    def log_message(self, *a): pass


Handler.extensions_map = dict(Handler.extensions_map); Handler.extensions_map['.wasm'] = 'application/wasm'


def main():
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM, args=[
            "--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 1000, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda mm: errs.append("console:" + mm.text) if mm.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{port}/index.html")
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        pg.evaluate("""(ex)=>{const s=document.getElementById('examples');s.value=ex;
            s.dispatchEvent(new Event('change',{bubbles:true}));}""", EX)
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        pg.wait_for_timeout(500)
        info = pg.evaluate("window.__viewer.getSceneInfo()")
        dur = pg.evaluate("window.__viewer.getDuration()")
        print(f"{EX}: dur={dur:.1f}s  scene={info}")
        for f in FRACS:
            pg.evaluate("(f)=>window.__viewer.setTime(window.__viewer.getDuration()*f)", f)
            pg.wait_for_timeout(300)
            out = HERE / f"cut_{EX.split('.')[0]}_{int(f*100):03d}.png"
            pg.locator("#gl").screenshot(path=str(out))
            print("  wrote", out.name)
        if errs:
            print("ERRORS:", errs[:8])
        b.close()
    httpd.shutdown()
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
