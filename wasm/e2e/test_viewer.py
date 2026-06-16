#!/usr/bin/env python3
"""End-to-end test for the CAMotics three.js viewer.

Runs against synthetic fixtures (no C++ core dependency). Starts a static
server, drives the viewer in system headless Chromium, and asserts:
  - window.__viewer.ready becomes true
  - the WebGL canvas actually drew (non-clear pixels)
  - scrubbing the timeline moves the tool + updates the dashboard DOM
  - both the test hook (setTime) and the real slider DOM path work

Run:  uv run --active python test_viewer.py
Exit code 0 = PASS, nonzero = FAIL.
"""
import struct
import sys
import threading
import zlib
from pathlib import Path

from playwright.sync_api import sync_playwright

import serve  # local module

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE / "artifacts"
CHROMIUM = "/snap/bin/chromium"
CHROMIUM_ARGS = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
READY_TIMEOUT_MS = 20_000

failures = []


def check(cond, msg):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {msg}")
    if not cond:
        failures.append(msg)
    return cond


def start_server():
    httpd = serve.make_server("127.0.0.1", 0)
    host, port = httpd.server_address
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, f"http://{host}:{port}/"


def count_non_clear_pixels(page):
    """Use gl.readPixels on the live WebGL context to count drawn pixels.

    The clear color is 0x1a1d21 = (26, 29, 33). Count pixels that differ
    meaningfully from that background.
    """
    return page.evaluate(
        """() => {
            const c = document.getElementById('gl');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return { ok:false, reason:'no gl context', count:0, total:0 };
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const px = new Uint8Array(w*h*4);
            gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);
            const br=26, bg=29, bb=33;
            let count=0;
            for (let i=0;i<px.length;i+=4){
                const dr=Math.abs(px[i]-br), dg=Math.abs(px[i+1]-bg), db=Math.abs(px[i+2]-bb);
                if (dr+dg+db > 24) count++;
            }
            return { ok:true, count, total:(w*h), w, h };
        }"""
    )


def count_non_bg_screenshot_pixels(png_bytes):
    """Decode a PNG (stdlib zlib) and count pixels that differ from the dark
    background ~(26,29,33). This measures what was *actually drawn* into the
    canvas region, independent of WebGL backbuffer quirks.

    Returns (non_bg_count, total). Crops to the left ~75% (canvas, not the
    light dashboard/timeline) so the panel chrome doesn't dominate the count.
    """
    # --- minimal PNG decoder for truecolor/truecolor-alpha, 8-bit ---
    sig = png_bytes[:8]
    assert sig == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(png_bytes):
        (length,) = struct.unpack(">I", png_bytes[pos:pos + 4])
        ctype = png_bytes[pos + 4:pos + 8]
        data = png_bytes[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", data[:10])
        elif ctype == b"IDAT":
            idat += data
        elif ctype == b"IEND":
            break
        pos += 12 + length

    assert bit_depth == 8, f"unexpected bit depth {bit_depth}"
    channels = {2: 3, 6: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        if pa <= pb and pa <= pc:
            return a
        return b if pb <= pc else c

    out = bytearray(height * stride)
    prev = bytearray(stride)
    si = 0
    for y in range(height):
        ft = raw[si]; si += 1
        line = bytearray(raw[si:si + stride]); si += stride
        if ft == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ft == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:  # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                c = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + paeth(a, prev[i], c)) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line

    br, bg, bb = 26, 29, 33
    crop_w = int(width * 0.75)  # canvas region only
    non_bg = 0
    for y in range(height):
        rowbase = y * stride
        for x in range(crop_w):
            o = rowbase + x * channels
            if abs(out[o] - br) + abs(out[o + 1] - bg) + abs(out[o + 2] - bb) > 24:
                non_bg += 1
    return non_bg, crop_w * height


def dashboard_text(page):
    return page.eval_on_selector("#dashboard", "el => el.textContent")


def set_time_via_slider(page, t):
    """Drive the real <input type=range> the way a user drag would, firing
    the 'input' event the viewer listens to."""
    page.evaluate(
        """(t) => {
            const s = document.getElementById('timeline');
            s.value = String(t);
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        t,
    )


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    httpd, url = start_server()
    print(f"server: {url}")

    samples = []  # (label, state, non_clear_count)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM, args=CHROMIUM_ARGS)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))

            print("navigate + wait for ready...")
            # default page is now the interactive wasm loader; this deterministic
            # test uses the synthetic-fixtures mode.
            sep = "&" if "?" in url else "?"
            page.goto(url + sep + "fixtures=1", wait_until="load")
            page.wait_for_function("() => window.__viewer && window.__viewer.ready === true",
                                   timeout=READY_TIMEOUT_MS)
            check(True, "window.__viewer.ready === true")

            duration = page.evaluate("() => window.__viewer.getDuration()")
            move_count = page.evaluate("() => window.__viewer.getMoveCount()")
            print(f"  duration={duration:.3f}s  moves={move_count}")
            check(duration > 0, f"duration > 0 ({duration:.3f})")
            check(move_count >= 50, f"move_count >= 50 ({move_count})")

            # --- canvas actually drew something ---
            # (a) live WebGL context present + readPixels works
            px = count_non_clear_pixels(page)
            print(f"  webgl readPixels: {px}")
            check(px.get("ok"), "WebGL context present")
            check(px.get("count", 0) > 0, "WebGL readPixels returned pixels")

            # --- t = 0 ---
            s0 = page.evaluate("() => window.__viewer.getState()")
            d0 = dashboard_text(page)
            start_png = page.screenshot(path=str(ARTIFACTS / "start.png"))
            # (b) screenshot-based: count pixels in the canvas region that
            #     differ from the dark background -> proves geometry drew.
            non_bg, region_total = count_non_bg_screenshot_pixels(start_png)
            print(f"  screenshot non-bg pixels: {non_bg} / {region_total} "
                  f"({100*non_bg/region_total:.1f}% of canvas region)")
            threshold = max(int(region_total * 0.01), 1000)
            check(non_bg > threshold,
                  f"non-background canvas pixels {non_bg} > {threshold}")
            samples.append(("t=0", s0, non_bg))
            check(s0 is not None and "toolPos" in s0, "getState() at t=0 returns toolPos")

            # --- t = 50% via the REAL slider DOM path ---
            t_mid = duration * 0.5
            set_time_via_slider(page, t_mid)
            page.wait_for_function(
                "(t) => Math.abs(window.__viewer.getState().time - t) < 1e-3",
                arg=t_mid, timeout=5000)
            s_mid = page.evaluate("() => window.__viewer.getState()")
            d_mid = dashboard_text(page)
            mid_png = page.screenshot(path=str(ARTIFACTS / "mid.png"))
            pmid, _ = count_non_bg_screenshot_pixels(mid_png)
            samples.append(("t=mid (slider)", s_mid, pmid))
            check(abs(s_mid["time"] - t_mid) < 1e-2, f"slider set time to {t_mid:.3f}")

            # --- t = 100% via the test hook setTime ---
            set_via_hook = page.evaluate("(t) => window.__viewer.setTime(t)", duration)
            page.wait_for_function(
                "(t) => Math.abs(window.__viewer.getState().time - t) < 1e-3",
                arg=duration, timeout=5000)
            s_end = page.evaluate("() => window.__viewer.getState()")
            d_end = dashboard_text(page)
            end_png = page.screenshot(path=str(ARTIFACTS / "end.png"))
            pend, _ = count_non_bg_screenshot_pixels(end_png)
            samples.append(("t=end (hook)", s_end, pend))
            check(abs(s_end["time"] - duration) < 1e-2, f"hook set time to {duration:.3f}")
            # slider value should follow the hook (shared code path)
            slider_val = page.eval_on_selector("#timeline", "el => parseFloat(el.value)")
            check(abs(slider_val - duration) < 1e-2,
                  "slider value followed setTime (shared code path)")

            # --- tool actually moved ---
            def moved(a, b):
                return any(abs(a[i] - b[i]) > 1e-3 for i in range(3))
            check(moved(s0["toolPos"], s_mid["toolPos"]),
                  f"toolPos moved 0 -> mid ({s0['toolPos']} -> {s_mid['toolPos']})")
            check(moved(s_mid["toolPos"], s_end["toolPos"]),
                  f"toolPos moved mid -> end ({s_mid['toolPos']} -> {s_end['toolPos']})")

            # --- dashboard DOM updated ---
            check(d0 != d_mid, "dashboard text changed 0 -> mid")
            check(d_mid != d_end or d0 != d_end, "dashboard text changed across scrub")
            # dashboard reflects state: Time/Feed/Tool present and consistent
            check(f"{s_end['time']:.3f}" in d_end,
                  f"dashboard shows end time {s_end['time']:.3f}")
            check(str(s_mid["tool"]) in d_mid, f"dashboard shows tool {s_mid['tool']}")
            check(str(int(s_mid["feed"])) in d_mid.replace(",", ""),
                  f"dashboard shows feed {s_mid['feed']}")

            if errors:
                print("  page console/page errors captured:")
                for e in errors[:10]:
                    print("    !", e)
            check(not errors, "no page/console errors")

            browser.close()
    finally:
        httpd.shutdown()

    # --- summary table ---
    print("\n=== sampled states ===")
    print(f"{'label':<16} {'time':>9} {'idx':>4} {'tool':>5} {'feed':>8} "
          f"{'speed':>8} {'X':>8} {'Y':>8} {'Z':>8} {'pixels':>9}")
    for label, s, px in samples:
        tp = s["toolPos"]
        print(f"{label:<16} {s['time']:>9.3f} {s['activeMoveIndex']:>4} "
              f"{s['tool']:>5} {s['feed']:>8.0f} {s['speed']:>8.0f} "
              f"{tp[0]:>8.3f} {tp[1]:>8.3f} {tp[2]:>8.3f} {px:>9}")

    print("\n=== artifacts ===")
    for name in ("start.png", "mid.png", "end.png"):
        f = ARTIFACTS / name
        if f.exists():
            print(f"  {f}  ({f.stat().st_size} bytes)")
        else:
            print(f"  {f}  MISSING")
            failures.append(f"artifact {name} missing")

    print()
    if failures:
        print(f"RESULT: FAIL ({len(failures)} failed checks)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
