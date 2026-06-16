# CAMotics three.js Viewer

An interactive CNC-simulation viewer built with [three.js](https://threejs.org/)
(vendored locally, r160). It renders a workpiece surface + toolpath and lets you
scrub a timeline to watch a tool marker move, with a live dashboard of
tool / feed / speed / position / time.

Right now it runs entirely against **synthetic fixtures** so the data contract is
locked and tested before the C++ core is wired in. See
[TO SWAP IN REAL CORE OUTPUT](#to-swap-in-real-core-output).

```
viewer/
  index.html            # layout + importmap (three -> ./vendor/)
  app.js                # ES-module viewer logic + window.__viewer test hook
  vendor/               # three.module.js, OrbitControls.js, STLLoader.js (r160)
  fixtures/
    gen_fixtures.py     # generates toolpath.json + workpiece.stl
    toolpath.json       # ToolPath JSON (the data contract)
    workpiece.stl       # binary STL stock surface
  README.md
```

---

## Data contract

The native/WASM core (CAMotics `camsim`) emits exactly these two files; the
viewer consumes them. Both are reproduced by `fixtures/gen_fixtures.py`.

### 1. `fixtures/toolpath.json`

```jsonc
{
  "moves": [
    {
      "type": "rapid" | "cut",     // rapid = positioning, cut = cutting
      "start": [x, y, z],          // mm
      "end":   [x, y, z],          // mm
      "tool":  1,                  // tool id, key into "tools"
      "feed":  600.0,              // mm/min
      "speed": 12000.0,            // spindle rpm
      "tStart": 0.0,               // seconds, == previous move's tEnd (contiguous)
      "tEnd":   1.2                // seconds
    }
    // ... ~50-300 moves, monotonically increasing & contiguous in time
  ],
  "tools": {
    "1": { "shape": "cylindrical", "diameter": 3.0, "length": 10.0 }
  },
  "duration": 205.0817,            // float seconds, == last move's tEnd
  "bounds": { "min": [x,y,z], "max": [x,y,z] }   // computed from all points
}
```

Backed by `src/gcode/Move.h` getters in CAMotics (`getStartPt` / `getEndPt` /
`getTool` / `getFeed` / `getSpeed` / `getStartTime` / `getEndTime` /
`getPtAtTime`) plus the `ToolPath` container.

The current fixture is a **raster/zigzag pocket** over a 50x50 mm square (5 rapids
+ 73 cut moves, 3 distinct feed rates), followed by a finishing contour pass.

### 2. `fixtures/workpiece.stl`

A **binary STL** of the stock solid (a box sized to the toolpath bounds, top at
z=0). Consumed by three.js `STLLoader`. CAMotics already writes binary STL via
its `stl/Writer`.

### Regenerating the fixtures

```bash
cd viewer/fixtures
python3 gen_fixtures.py
```

This prints the move count / duration / bounds and rewrites both fixture files.
The generator guarantees contiguous, monotonic timing and computes `bounds` from
the actual points.

---

## Rendering details

- **Workpiece**: matte grey `MeshStandardMaterial` (flat shading), lit by an
  ambient + two directional lights.
- **Toolpath**: `THREE.LineSegments` built from each move's start/end. Cut moves
  are **green**; rapid moves are **red, dashed**.
- **Tool marker**: a cylinder sized to the active tool's diameter, with its tip
  at the interpolated tool position.
- The whole scene is recentered so the bounds center sits at the origin; the
  camera is fitted to the bounds on load. **OrbitControls** gives mouse
  rotate/zoom.

### Timeline

Dragging the slider (or `window.__viewer.setTime(t)`) sets the current time `t`.
The active move is found by **binary search** on `tStart <= t < tEnd`, and the
tool position is **LERPed** `start -> end` by `(t - tStart)/(tEnd - tStart)`.
The dashboard is updated from that move (tool, diameter looked up from `tools`,
feed, speed, interpolated XYZ, and `t`). Play/Pause advances time in real wall
seconds.

---

## Running the viewer

ES modules + `fetch` require HTTP (not `file://`). A stdlib static server lives
in the e2e project:

```bash
# from wasm/e2e/
python3 serve.py            # serves ../viewer at http://127.0.0.1:8000/
python3 serve.py 8123       # custom port
```

Then open <http://127.0.0.1:8000/> in any modern browser. Or use any static
server rooted at `wasm/viewer/`, e.g. `python3 -m http.server` from this dir.

### Test hook

For e2e, the viewer exposes:

```js
window.__viewer = {
  ready: true,                          // after STL + JSON loaded and first render
  getState: () => ({ time, toolPos:[x,y,z], tool, feed, speed, activeMoveIndex }),
  setTime: (t) => { /* same code path as the slider */ },
  getDuration: () => <seconds>,
  getMoveCount: () => <int>,
}
```

and dispatches a `viewer-ready` event on `window` when ready.

---

## Running the e2e test

The test lives in the sibling `wasm/e2e/` `uv` project (Playwright preinstalled).
It uses the **system** Chromium (`/snap/bin/chromium`) since there's no prebuilt
Playwright Chromium on this box.

```bash
cd wasm/e2e
uv run --active python test_viewer.py
```

Exit code `0` = PASS, nonzero = FAIL (clear `PASS`/`FAIL` lines + a summary
table are printed). The test:

1. starts `serve.py` on a free `127.0.0.1` port,
2. launches system headless Chromium (`--no-sandbox --disable-gpu
   --disable-dev-shm-usage`) at 1280x800,
3. waits for `window.__viewer.ready === true`,
4. asserts the canvas drew geometry (screenshot non-background pixel count +
   live `gl.readPixels`),
5. scrubs to 0% / 50% / 100% — exercising **both** the real slider DOM `input`
   event and `window.__viewer.setTime` — and asserts the tool moved and the
   dashboard DOM text updated,
6. writes `artifacts/start.png`, `artifacts/mid.png`, `artifacts/end.png`.

> `uv run --active` prints a `VIRTUAL_ENV` warning to stderr; ignore it.

---

## TO SWAP IN REAL CORE OUTPUT

The viewer and e2e test are intentionally decoupled from the C++ build. To run
against real simulation output instead of fixtures:

1. Build the headless core (`camsim`, `with_gui=0 with_tpl=0`) per
   `wasm/NOTES.md`.
2. Run it on a G-code program (e.g. `examples/*.nc`) to emit:
   - a **ToolPath JSON** matching the contract above, and
   - a **binary STL** of the cut/stock surface.
3. Replace the two fixture files:

   ```bash
   cp <camsim-output>/toolpath.json  wasm/viewer/fixtures/toolpath.json
   cp <camsim-output>/surface.stl    wasm/viewer/fixtures/workpiece.stl
   ```

   (Keep the same filenames, or update the two `fetch`/`load` paths in `app.js`.)
4. Re-run the e2e test — **it must still pass** with no viewer changes. That is
   the whole point: the contract is fixed and verified, so dropping in real core
   output is a file swap, not a code change.

No CDN is used at any point (three.js is vendored under `vendor/`), so the
viewer and test are fully offline/deterministic.
