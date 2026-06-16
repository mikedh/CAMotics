#!/usr/bin/env python3
"""
End-to-end: load G-code -> simulate in the CAMotics wasm core -> render in-browser.
Serves wasm/viewer, drives system headless Chromium via Playwright, feeds raw
G-code to window.__loadGCode (which calls the wasm module's loadGCode), and
asserts the toolpath actually rendered and the dashboard reflects the program.
Exit 0 = PASS.
"""
import os, sys, threading, http.server, functools, socketserver, struct, zlib, io
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
VIEWER = HERE.parent / "viewer"
GCODE = (HERE / "fixture.ngc").read_text()
ART = HERE / "artifacts"; ART.mkdir(exist_ok=True)
CHROMIUM = "/snap/bin/chromium"

def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(VIEWER))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]

def png_nonbg(buf, bg=(26, 29, 33), tol=10):
    # minimal stdlib PNG decode -> count pixels differing from clear color
    sig = buf[:8]; assert sig == b"\x89PNG\r\n\x1a\n"
    i = 8; w = h = 0; idat = b""
    while i < len(buf):
        ln = struct.unpack(">I", buf[i:i+4])[0]; typ = buf[i+4:i+8]
        data = buf[i+8:i+8+ln]; i += 12 + ln
        if typ == b"IHDR": w, h, *_ = struct.unpack(">IIBBBBB", data)
        elif typ == b"IDAT": idat += data
        elif typ == b"IEND": break
    raw = zlib.decompress(idat); stride = w * 4; out = bytearray(); prev = bytearray(stride)
    p = 0
    def pa(a,b,c):
        pp=a+b-c; pa_=abs(pp-a); pb_=abs(pp-b); pc_=abs(pp-c)
        return a if pa_<=pb_ and pa_<=pc_ else (b if pb_<=pc_ else c)
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p+1:p+1+stride]); p += 1+stride
        for x in range(stride):
            a = line[x-4] if x>=4 else 0; b = prev[x]; c = prev[x-4] if x>=4 else 0
            if f==1: line[x]=(line[x]+a)&255
            elif f==2: line[x]=(line[x]+b)&255
            elif f==3: line[x]=(line[x]+((a+b)>>1))&255
            elif f==4: line[x]=(line[x]+pa(a,b,c))&255
        out += line; prev = line
    cnt = 0; total = w*h
    for px in range(0, len(out), 4):
        r,g,bl = out[px],out[px+1],out[px+2]
        if abs(r-bg[0])>tol or abs(g-bg[1])>tol or abs(bl-bg[2])>tol: cnt += 1
    return cnt, total

def main():
    httpd, port = serve()
    url = f"http://127.0.0.1:{port}/index.html?empty=1"
    checks = []
    def check(name, cond):
        checks.append((name, bool(cond)))
        print(("[PASS] " if cond else "[FAIL] ") + name)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM,
                              args=["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"])
        pg = b.new_page(viewport={"width":1280,"height":800})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type=="error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url)
        pg.wait_for_function("window.__appReady === true", timeout=20000)
        check("page loaded empty, app ready", True)

        # ---- feed G-code to the wasm core (toolpath + SURFACE), render in-browser ----
        res = pg.evaluate("(g) => window.__simulate(g, 'fixture')", GCODE)
        print("  simulate ->", res)
        check("wasm simulate returned moves", res and res["moveCount"] > 0)
        check("wasm simulate produced surface triangles", res and res["triangles"] > 0)
        pg.wait_for_function("window.__viewer && window.__viewer.ready === true", timeout=20000)
        check("viewer ready after G-code", True)

        st0 = pg.evaluate("window.__viewer.getState()")
        pg.locator("#gl").screenshot(path=str(ART/"wasm_start.png"))
        info = pg.evaluate("window.__viewer.getSceneInfo()")
        print("  scene info:", info)
        check("final geometry (surface mesh) in scene", info["hasSurface"] and info["triangles"] > 0)
        check("toolpath lines in scene", info["lineVertices"] > 0)
        check("tool marker present", info["hasToolMarker"])

        # ---- scrub: tool must move, dashboard must update ----
        dur = pg.evaluate("window.__viewer.getDuration()")
        mid = pg.evaluate("(d)=>{ window.__viewer.setTime(d*0.5); return null;}", dur)
        st_mid = pg.evaluate("window.__viewer.getState()")
        pg.locator("#gl").screenshot(path=str(ART/"wasm_mid.png"))
        pg.evaluate("(d)=>window.__viewer.setTime(d)", dur)
        st_end = pg.evaluate("window.__viewer.getState()")
        pg.locator("#gl").screenshot(path=str(ART/"wasm_end.png"))

        moved = st0["toolPos"] != st_mid["toolPos"] or st_mid["toolPos"] != st_end["toolPos"]
        check("tool marker moved across timeline", moved)
        dash_tool = pg.evaluate("document.getElementById('dash-tool').textContent")
        dash_feed = pg.evaluate("document.getElementById('dash-feed').textContent")
        check("dashboard shows a tool", dash_tool not in ("", "--"))
        check("dashboard shows a feed", "mm/min" in dash_feed)
        check("no page/console errors", not errors)
        if errors: print("  errors:", errors[:5])

        print("\n=== sampled states ===")
        for lbl, s in [("t=0",st0),("t=mid",st_mid),("t=end",st_end)]:
            print(f"  {lbl:8} idx={s['activeMoveIndex']:4} tool={s['tool']} "
                  f"feed={s['feed']} pos={[round(x,3) for x in s['toolPos']]}")
        b.close()
    httpd.shutdown()
    ok = all(c for _, c in checks)
    print("\nRESULT:", "PASS" if ok else "FAIL", f"({sum(c for _,c in checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
