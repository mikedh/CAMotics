#!/usr/bin/env python3
"""
Objective test for the analytic Cut render (default mode). Asserts the surface is
SQUIRM-FREE: between adjacent scrub frames the change is confined to a small
region around the tool, never a global shift. The old removalTime level-set
moved the whole surface as you scrubbed; the analytic SDF only changes a voxel
when the tool sweep reaches it, so adjacent-frame change is tightly localized.

Metrics (heart pocket, the worst case for squirm):
  - per-step change between adjacent scrub frames is a SMALL fraction of canvas
  - the changed pixels are LOCALIZED: their bbox is a small fraction of the part
  - cumulative early/total change is low (progressive, tool-local)

Run:  cd wasm/app && uv run --with playwright,pillow python test_cut.py
"""
import io, sys, threading, http.server, socketserver
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DIST = HERE.parent / "dist"   # app/dist (tests/ live one level under the app)
EXAMPLE = "heart.ngc"
CHROMIUM = "/snap/bin/chromium"
DIFF_LUMA = 24
STEP_CHANGE_MAX = 0.06     # adjacent-frame change < 6% of canvas
LOCAL_BBOX_MAX = 0.30      # changed-pixel bbox < 30% of the part bbox (tool-local)
EARLY_RATIO_MAX = 0.40


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(DIST), **k)
    def end_headers(self): self.send_header("Cache-Control", "no-store"); super().end_headers()
    def log_message(self, *a): pass


Handler.extensions_map = dict(Handler.extensions_map); Handler.extensions_map['.wasm'] = 'application/wasm'


def diff_mask(a, b):
    return ImageChops.difference(a.convert("L"), b.convert("L")).point(lambda v: 255 if v > DIFF_LUMA else 0)


def changed(a, b):
    return sum(diff_mask(a, b).histogram()[1:])


def non_bg(a, bg=(26, 29, 33), tol=10):
    d = ImageChops.difference(a.convert("RGB"), Image.new("RGB", a.size, bg)).convert("L")
    return sum(d.histogram()[tol + 1:])


def main():
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    checks = []
    def check(name, ok):
        checks.append((name, bool(ok))); print(("[PASS] " if ok else "[FAIL] ") + name)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM, args=[
            "--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 1000, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda mm: errs.append("console:" + mm.text) if mm.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{port}/index.html")
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        pg.evaluate("(ex)=>window.__loadExample(ex)", EXAMPLE)
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        pg.wait_for_timeout(400)

        info = pg.evaluate("window.__viewer.getSceneInfo()")
        dur = pg.evaluate("window.__viewer.getDuration()")
        check("analytic cut present in scene", info.get("hasCut"))
        check("duration > 0", dur and dur > 0)

        # hide the toolpath/marker so the diff measures the SURFACE only
        pg.evaluate("()=>{window.__viewer.setShowPath(false);window.__viewer.setShowTool(false);}")
        pg.wait_for_timeout(150)

        fracs = [i / 20 for i in range(21)]  # 0.00 .. 1.00 in 0.05 steps
        frames = {}
        for f in fracs:
            pg.evaluate("(f)=>window.__viewer.setTime(window.__viewer.getDuration()*f)", f)
            pg.wait_for_timeout(140)
            frames[f] = Image.open(io.BytesIO(pg.locator("#gl").screenshot())).copy()

        W, H = frames[1.0].size
        total_px = W * H
        # part bbox = non-bg pixels of the final frame
        part_bbox = frames[1.0].convert("RGB").point(lambda v: v).getbbox()
        # crude: use luminance-diff vs bg for a tight part bbox
        bgimg = Image.new("RGB", (W, H), (26, 29, 33))
        partmask = ImageChops.difference(frames[1.0].convert("RGB"), bgimg).convert("L").point(
            lambda v: 255 if v > 10 else 0)
        pb = partmask.getbbox()
        part_area = (pb[2] - pb[0]) * (pb[3] - pb[1]) if pb else total_px

        # per-step (adjacent) change + localization of the change bbox
        max_step = 0.0
        max_local = 0.0
        for i in range(1, len(fracs)):
            a, c = frames[fracs[i - 1]], frames[fracs[i]]
            stepchg = changed(a, c) / total_px
            mask = diff_mask(a, c)
            bb = mask.getbbox()
            local = ((bb[2] - bb[0]) * (bb[3] - bb[1]) / part_area) if bb else 0.0
            max_step = max(max_step, stepchg)
            if stepchg > 0.003:  # only score steps that actually changed something
                max_local = max(max_local, local)

        cum_total = changed(frames[0.0], frames[1.0])
        early = changed(frames[0.0], frames[0.2])
        ratio = early / cum_total if cum_total else 1.0

        print(f"\n  part bbox area frac: {part_area/total_px*100:.1f}% of canvas")
        print(f"  max adjacent-frame change: {max_step*100:.2f}% of canvas (want < {STEP_CHANGE_MAX*100:.0f}%)")
        print(f"  max change-bbox / part:    {max_local*100:.1f}% (want < {LOCAL_BBOX_MAX*100:.0f}%) <- squirm metric")
        print(f"  early/total cumulative:    {ratio:.3f} (want < {EARLY_RATIO_MAX})")

        check("renders something at final", non_bg(frames[1.0]) / total_px > 0.05)
        check(f"adjacent-frame change small ({max_step*100:.1f}% < {STEP_CHANGE_MAX*100:.0f}%)",
              max_step < STEP_CHANGE_MAX)
        check(f"change is tool-local / squirm-free (bbox {max_local*100:.0f}% < {LOCAL_BBOX_MAX*100:.0f}%)",
              max_local < LOCAL_BBOX_MAX)
        check(f"progressive (early/total {ratio:.2f} < {EARLY_RATIO_MAX})", ratio < EARLY_RATIO_MAX)
        check("no page/console errors", not errs)
        if errs: print("  errors:", errs[:5])

        frames[0.5].save(HERE / "tc_mid.png")
        frames[1.0].save(HERE / "tc_final.png")

        # --- plunge/steep-move correctness (the "solid shaft" bug) -------------
        # slant_test plunges in and exits sideways. The bug made vertical motion
        # NOT remove material -> the shaft rendered as a solid block (flat, low
        # contrast). Correct removal carves recessed channels -> high within-part
        # luma contrast. Assert the steep cuts actually carved material.
        pg.evaluate("(ex)=>window.__loadExample(ex)", "slant_test.nc")
        pg.wait_for_function("window.__viewer && window.__viewer.ready===true", timeout=60000)
        pg.evaluate("()=>window.__viewer.setTime(window.__viewer.getDuration())")
        pg.wait_for_timeout(500)
        slant = Image.open(io.BytesIO(pg.locator("#gl").screenshot())).copy()
        sg = slant.convert("L")
        bb = ImageChops.difference(slant.convert("RGB"), Image.new("RGB", slant.size, (26, 29, 33))
                                   ).convert("L").point(lambda v: 255 if v > 10 else 0).getbbox()
        import statistics
        px = [sg.getpixel((x, y)) for y in range(bb[1], bb[3], 3) for x in range(bb[0], bb[2], 3)]
        contrast = statistics.pstdev(px) if len(px) > 1 else 0.0
        slant.save(HERE / "tc_slant.png")
        print(f"\n  slant_test within-part luma contrast: {contrast:.1f} (want > 12; a solid"
              f" shaft from the plunge bug is flat/low-contrast)")
        check(f"plunge/steep moves carve material (contrast {contrast:.1f} > 12)", contrast > 12)

        b.close()
    httpd.shutdown()
    ok = all(c for _, c in checks)
    print("\nRESULT:", "PASS" if ok else "FAIL", f"({sum(c for _,c in checks)}/{len(checks)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
