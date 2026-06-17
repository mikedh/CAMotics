#!/usr/bin/env python3
"""Measure analytic-cut render frame time (interactivity) across examples."""
import threading, http.server, socketserver, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DIST = HERE.parent / "dist"   # app/dist (tests/ live one level under the app)
CHROMIUM = "/snap/bin/chromium"
EXAMPLES = sys.argv[1:] or ["scorpion.nc", "heart.ngc", "compass_text.ngc", "vcarve.ngc"]


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
        # NOTE: swiftshader is CPU rendering -> absolute times are a floor; real GPU
        # is far faster. Use relative comparison across examples.
        b = p.chromium.launch(executable_path=CHROMIUM, args=[
            "--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 900, "height": 700})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{port}/index.html")
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        for ex in EXAMPLES:
            pg.evaluate("""(ex)=>{const s=document.getElementById('examples');s.value=ex;
                s.dispatchEvent(new Event('change',{bubbles:true}));}""", ex)
            pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
            pg.wait_for_timeout(500)  # let dynamic-res settle back to full
            # render-on-demand: idle should produce ~0 renders over ~1s
            c0 = pg.evaluate("window.__viewer.getRenderCount()")
            pg.wait_for_timeout(1000)
            idle = pg.evaluate("window.__viewer.getRenderCount()") - c0
            r = pg.evaluate("""async ()=>{
              const v = window.__viewer; const dur = v.getDuration();
              // force a fresh render each scrub and time it
              const gl = document.getElementById('gl').getContext('webgl2');
              const W = gl.drawingBufferWidth, Hh = gl.drawingBufferHeight;
              const px = new Uint8Array(W*Hh*4);
              const N = 24; const ts = [];
              for (let i=0;i<N;i++){
                const f = (i+0.5)/N;
                v.setTime(dur*f);
                const t0 = performance.now();
                v.renderNow();
                gl.readPixels(0,0,W,Hh,gl.RGBA,gl.UNSIGNED_BYTE,px); // forces GPU finish
                ts.push(performance.now()-t0);
              }
              ts.sort((a,b)=>a-b);
              return {median: ts[N>>1], p90: ts[Math.floor(N*0.9)], max: ts[N-1]};
            }""")
            print(f"  {ex:18s} median={r['median']:6.1f}ms  p90={r['p90']:6.1f}ms  "
                  f"max={r['max']:6.1f}ms  idle-renders/s={idle}")
        if errs: print("ERRORS:", errs[:5])
        b.close()
    httpd.shutdown()
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
