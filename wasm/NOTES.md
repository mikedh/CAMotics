# CAMotics → WASM + three.js viewer — working notes

Goal: reuse CAMotics' headless C++ core (GUI-free, no TPL, no network) as the
simulation engine; build the interactive view (timeline scrub, toolpath lines,
moving tool marker, tool/feed/speed dashboard) in three.js. Validate end-to-end
with Playwright + headless Chromium.

## Decisions (from owner)
- TPL / embedded V8: REMOVED (build with `with_tpl=0`). ~half the example
  projects reference `.tpl` and will not load; that's accepted.
- Networking: not needed.
- GUI: rebuilt in three.js (NOT porting his Qt). The interaction he wants
  (drag timeline, see toolpaths, dashboard with current tool/speed/feed) is all
  backed by `gcode::ToolPath` / `gcode::Move` data — pure core, no Qt/GL.
- e2e via Playwright headless Chromium is the spec/contract.

## Data contract (the WASM/native core emits this; the viewer consumes it)
- ToolPath JSON: { moves:[{type, start:[x,y,z], end:[x,y,z], tool, feed,
  speed, tStart, tEnd}], tools:{id:{shape,diameter,length}}, duration, bounds }
  Backed by src/gcode/Move.h getters (getStartPt/getEndPt/getTool/getFeed/
  getSpeed/getStartTime/getEndTime/getPtAtTime) + ToolPath container.
- Workpiece surface: binary STL (camsim already writes STL via stl/Writer).
  three.js STLLoader consumes it.

## Environment facts (this box, Ubuntu 26.04)
- g++ 15.2, cmake, pkg-config, boost/openssl/expat/zlib already installed.
- SCons 4.10 installed via `uv tool install scons` (PATH: ~/.local/bin).
- uv available. NO pip, NO passwordless sudo.
- Playwright: no prebuilt Chromium for ubuntu26.04. Use system snap Chromium
  via executable_path="/snap/bin/chromium" + args
  ["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]. WebGL confirmed.

## NEEDS APT (owner running before bed) — validated by cbang build failure:
  sudo apt-get install -y libbz2-dev liblz4-dev libsqlite3-dev libevent-dev \
    libyaml-dev libre2-dev libleveldb-dev libsnappy-dev

## Build pipeline (once apt done)
1. cbang:  cd wasm/cbang && scons -j4         (CBANG_HOME=$PWD)
2. core:   (repo root) scons with_gui=0 with_tpl=0   -> camsim
3. emit:   run camsim on an examples/*.nc -> ToolPath.json + surface.stl
4. swap fixtures for real output; e2e must still pass
5. WASM:   install emsdk (userspace), attempt emcc build of trimmed cbang+libGCode

## Layout
- wasm/cbang/         cbang checkout + native build
- wasm/glue.cpp       embind entry (class Sim: run/bakeCut/toolpathJSON)
- wasm/app/           parcel2 + preact + ts frontend (src/, examples/, tests/)
- wasm/app/tests/     Playwright tests (test_cut.py, e2e_smoke.py, perf_cut.py)
- wasm/*.log          background build/download logs
(The early hand-vendored `wasm/viewer/` + `wasm/e2e/` + `wasm/path2json.cpp` were
 removed once `wasm/app` superseded them — see "Fork-diff shrink" below.)

## Status log
- [done] cloned cbang, installed scons via uv, proved Playwright+Chromium+WebGL
- [done] apt deps installed (owner ran the 8-pkg command)
- [done] cbang built NATIVELY **without V8** — patched config/cbang/__init__.py to
  drop `CBConfig('v8')` (system libnode V8 aborts on pointer-compression mismatch;
  TPL is yanked anyway). libcbang.a, HAVE_V8=0, zero js/v8 objects.
- [done] headless CAMotics core built: `scons with_gui=0 with_tpl=0` -> camsim,
  gcodetool, planner. `ldd camsim` = no v8/node. (binaries in repo root)
- [done] camsim PROVEN: examples/aztec_calendar/aztec_calendar.nc -> real surface
  STL, 107,420 triangles (wasm/real_surface.stl).
- [done] wrote wasm/path2json.cpp (companion emitter) -> ToolPath JSON in the
  viewer contract. aztec example: 224,586 moves, CONICAL Ø10 tool, 4711.9s
  (wasm/real_toolpath.json, 43MB).
- [done] three.js viewer (wasm/viewer) + Playwright e2e (wasm/e2e): PASSES against
  BOTH synthetic fixtures AND the real aztec data (18 checks; tool/feed/speed read
  live from dashboard, timeline scrub moves tool, screenshots in wasm/demo_real/).
- [done] **WASM compile feasibility PROVEN** (emsdk 6.0.0, em++ -c):
    * CAMotics core: 123/123 .cpp -> wasm objects, 0 failures
      (gcode/ast/parse/interp/machine/plan, stl, sim, contour, render, project,
       opt, probe)
    * cbang used-subsystems: 111/113 -> wasm. 2 failures are MISSING DEP HEADERS
      only (xml/ExpatAdapter.cpp -> expat.h; util/Random.cpp -> openssl/rand.h),
      NOT code portability. Both have emscripten ports / are avoidable for a
      JSON-only headless viewer.
  => The non-rewrite WASM path is real: the code compiles to wasm unmodified.

## [DONE] Actual in-browser .wasm — G-code -> render, e2e PASSES
- wasm/glue.cpp: embind entry `loadGCode(gcodeText) -> ToolPath JSON`. Loads via
  Project::addFile (avoids XML/expat at runtime), computeToolPath (synchronous,
  no threads), emits the viewer contract.
- wasm/build_wasm.sh: compiles core + cbang-subset + bundled re2 (-DNO_THREADS) +
  expat + boost(fs/iostreams) + glue with em++ -fexceptions, archives, links to
  wasm/viewer/camotics.{js,wasm} (~1.5MB wasm). Single-threaded (v1).
- Resolved blockers, in order: `function` ambiguity; dxflib glob; boost atomic
  (Win32 misdetect, excluded) + iostreams compression; expat (vendored libexpat
  + expat_config.h); cbang/comp pulled by SystemUtilities auto-compression
  (wasm/comp_stub.cpp returns COMPRESSION_NONE; bz2/lz4 left allowed-undefined
  via -sERROR_ON_UNDEFINED_SYMBOLS=0; zlib via -sUSE_ZLIB); TPLRunner.cpp
  excluded + cbang/js abstraction added (Javascript::interrupt); RE2 actually
  called -> compiled bundled re2; C++ exceptions -> -fexceptions everywhere.
- wasm/viewer/app.js: refactored to render from fixtures OR wasm. `?empty=1`
  starts blank; `window.__loadGCode(text)` calls the wasm module and renders.
- wasm/e2e/test_wasm.py: loads page empty -> feeds fixture.ngc -> wasm sim ->
  asserts toolpath geometry in scene, tool marker moves on scrub, dashboard
  tracks tool/feed. **PASS 9/9.** Real run: 9 moves, 23.1s, 66ms in-browser.
  Screenshots: wasm/e2e/artifacts/wasm_{start,mid,end}.png
- Run: `cd wasm/e2e && uv run --active python test_wasm.py`
- Rebuild wasm: `bash wasm/build_wasm.sh`

## [DONE v2] Final cut GEOMETRY + path, interactive, in-browser
- Surface meshing now runs in wasm: patched src/camotics/render/Renderer.cpp to run
  RenderJobs inline when threads<=1 (no cb::Thread spawn). Native (threads>1)
  unchanged. This is the one CAMotics source edit.
- wasm/glue.cpp: added embind `Sim` class — run(gcode,resMode) does
  computeToolPath + Simulation(threads=1) + computeSurface; exposes toolpathJSON(),
  positions()/normals() (typed_memory_view, JS .slice()s), triangleCount().
- wasm/viewer: drag-drop + file picker + example dropdown + resolution (low/med/high)
  + Geometry/Path toggles + status bar. Renders surface mesh (BufferGeometry
  pos+normal) AND toolpath, rotatable (OrbitControls), with scrub timeline+dashboard.
  Default page auto-loads scorpion.nc through wasm. URL modes: default=interactive,
  ?fixtures=1 (synthetic e2e), ?empty=1 (hook).
- wasm/viewer/examples/: bundled scorpion/slant_test/heart/genes-encoder/compass_text/vcarve.
- wasm/serve_dev.py: dev server on 127.0.0.1:8000 (run it yourself; the harness
  reaps long-lived background listeners, but it runs fine in a normal terminal).
- e2e: test_wasm.py asserts surface mesh (triangles>0) AND toolpath -> PASS 11/11
  (96,852 tris on fixture). test_viewer.py -> ?fixtures=1 -> PASS. Real default page:
  scorpion.nc -> 295,772 tris, 270 moves, 85.2s, ~1.7s in-browser.
- To view: `python3 wasm/serve_dev.py` then open http://localhost:8000

## [DONE v3] parcel2+preact+ts viewer + GPU time-scrub (two render modes)
- Frontend migrated to parcel2 + preact + typescript under `wasm/app/`. Build:
  `npm run build` in wasm/app -> dist/. Serve no-cache: `python serve_dist.py`.
- Three render modes (toolbar "Render"): **Cut (analytic)** [default], **Volume
  (field)**, **Mesh** (Volume since removed; now Cut / Mesh). C++ edits ->
  `uv run wasm/build_wasm.py` (links straight to `app/src/wasm/camotics.{js,wasm}`)
  then `npm run build`.

### Cut (analytic) — squirm-free, crisp tool walls  [the v3 payoff]
The voxel "removalTime" field (Volume mode) renders the level-set {g==scrubTime};
because g is interpolated, that surface SQUIRMS as you scrub. The analytic mode
removes the squirm entirely by evaluating the cut as a GPU SDF:

    solid(p, s) = stockBox(p)  MINUS  union of tool sweeps with tStart <= s

A point is removed exactly when the swept tool first reaches it -> the surface
only changes where/when the tool touches (no squirm), and walls are the true tool
envelope (capsule / swept-cone / sphere-swept) with analytic SDF-gradient normals
(crisp, tool-shaped). In-progress moves are clipped to the point the tool has
actually reached (continuous; no reliance on g-code segment granularity).

- C++ `Sim::bakeCut(gcode,resMode)` (wasm/glue.cpp) exports, via embind typed
  views: moves [x0,y0,z0,x1,y1,z1,tStart,tEnd,toolIdx], tool table
  [shape,radius,length,snubR], stock bounds, duration, and a UNIFORM-GRID CSR
  (cellStart/cellMoves) binning each move by its swept bbox (~64 cells on the
  longest axis). Tool-shape math from src/camotics/sim/{ConicSweep,SpheroidSweep}.
- `wasm/app/src/cutShader.ts`: GLSL3 raymarch. Data textures (RAW mm coords):
  u_moves RGBA32F 3 texels/move, u_cellStart/u_cellMoves R32F, u_tools vec4[].
  Per sample: grid cell -> iterate that cell's moves -> min swept-tool SDF, time
  gated + clipped; sphere-trace; SDF-gradient normal; cheap SDF ambient occlusion
  for groove depth. Scrub = one uniform write (u_scrubAbs, absolute seconds).
- `wasm/app/src/viewer.ts` `renderCut()` builds the textures + box + ShaderMaterial.
- Verified: `test_cut.py` (squirm metric: adjacent-frame change <6% and confined to
  a <30% bbox around the tool -> measured 0.3% / 10%), PASS 7/7. `test_volume.py`
  (the field-mode regression, selects Volume) PASS 8/8. `e2e_smoke.py` PASS.
- Perf (swiftshader CPU = ~10-15x slower than real GPU): scorpion 8ms, heart 20ms,
  compass 16ms; vcarve (3731 dense overlapping moves, ~199/cell) ~180ms — the
  pathological case; Volume mode (bakes once) is the fallback there.
- Dev harnesses: probe_cut.py (export stats), shot_cut.py (screenshots),
  perf_cut.py (frame timing), test_cut.py (the squirm contract).

### Cut v3.1 — correctness + sidewall + perf-aware pass
- **Plunge/steep-move bug ("solid material at the shaft"):** `toolDist` projected p
  onto the 3D segment, so on a vertical/steep move `axis.z≈p.z` -> `h≈0` -> the
  z-slab `max(-h,h-len)` collapsed to 0 and interior points read as *on the surface*
  (no removal). Fixed by treating the tool axis as world-Z and **decoupling XY from
  Z**: XY = signed capsule distance to the segment's XY projection; Z = the UNION
  tip-Z extent over the t-range whose moving disk covers p.xy (whole-segment range
  for shallow moves — cheap; exact quadratic-solved covered range for steep moves —
  so a ramp doesn't over-remove the shaft below it); combine as a 2D box SDF in
  (lateral, axial). Validated: plunge interior returns the correct negative depth,
  floor is continuous. (CAMotics `ConicSweep.cpp:65` special-cases the same vertical
  degeneracy.) Cone branch adapted best-effort (still untested).
- **Sidewall quality:** the normal/AO/min-step scales were tied to `u_gridCell`
  (part-size/64 ≈ 3mm on the scorpion plate, >> the ~2mm cut). Added `u_featureScale`
  (≈ min tool radius, computed in `buildCut`) and retied normal h, AO radii, and the
  sphere-trace min step to it; `u_gridCell` now only drives grid traversal + the
  open-space step cap. `shade()` got an ambient floor + a camera headlight so
  near-vertical cut walls are lit.
- **Perf-aware rendering (`viewer.ts animate`):** render-on-demand via a `dirty`
  flag (set by an OrbitControls `'change'` listener, applyTime/scrub, playback,
  resize, toggles) — idle drops from 60fps to **0 renders/s**; `controls.update()`
  still runs every frame for damping. Dynamic resolution: drop to 0.5× pixel ratio
  while interacting (orbit/scrub/play), restore full res + one crisp render ~280ms
  after settling. `__viewer` gained `renderNow`/`getRenderCount`/`isInteracting`.
- Tests: `test_cut.py` adds a slant_test plunge guard (within-part luma contrast >12
  — a solid-shaft regression is flat/low-contrast); `perf_cut.py` reports idle
  renders/s. All green: cut 8/8, volume 8/8, vanilla e2e 11/11, smoke PASS.

### Cut v3.2 — take-home: depth occlusion, code reduction, temporal pruning
- **SDF depth occlusion:** the cut fragment shader now writes `gl_FragDepth` at the
  ray hit (`clip = projectionMatrix*modelViewMatrix*vec4(p - u_stockCenter,1)` since
  the raymarch is in RAW coords; `gl_FragDepth=(clip.z/clip.w)*0.5+0.5`; `discard`
  writes none). So the toolpath lines + tool marker are correctly OCCLUDED by
  material in front — path reads as sitting in the grooves, marker hidden where it
  dips into stock. Line material: depthWrite:false + a tiny clip-z bias in LINE_VERT
  so the floor path doesn't z-fight. (projectionMatrix/modelViewMatrix are declared
  in the fragment shader — three.js only auto-injects them into the vertex stage.)
- **Deleted the Volume (voxel field) mode** — Cut strictly supersedes it. Removed
  volumeShader.ts, test_volume.py, buildVolume/renderVolume, bakeVolume/VolumeData,
  __bakeVolume, the C++ Sim::bake + field members + embind, the UI option. Dropdown
  is now Cut / Mesh. ~530 LOC gone; wasm shrank.
- **Unified render scaffolding** into `setupScene(tp, finalTime)` (renderCut /
  renderResult).
- **Temporal move pruning:** bakeCut `stable_sort`s moves by tStart before grid
  binning, so each cell's CSR list is tStart-ascending; the shader `break`s once a
  move hasn't started. ~2x faster median while scrubbing dense paths (vcarve median
  ~440ms->164ms under swiftshader; final frame unchanged).
- Verified: cut 8/8 (squirm + plunge + occlusion visual), e2e_smoke PASS, vanilla
  e2e 11/11, perf idle 0 renders.

### Cut v3.3 — polish: tool marker radius + thin-wall haze
- **Marker was wider than the cut:** `toolpathToJSON` ran BEFORE
  `Workpiece::update()`, which is what populates the tool table — so "tools"
  serialized empty and `buildToolMarker`/dashboard fell back to Ø3 (r=1.5) vs the
  real r=1. Fixed by reordering update() before toolpathToJSON in both bakeCut and
  run(); marker now matches the SDF and the dashboard shows the real diameter.
- **Hazy z-fight on thin walls:** camera near/far was `radius/100 .. radius*100`
  (10000:1) — terrible depth precision, which the new gl_FragDepth occlusion exposed
  as z-fighting between the path and the groove floor. Tightened to `radius/40 ..
  radius*16` (~600:1) and bumped the LINE_VERT bias 1e-4->4e-4 -> path reads clean.
- **Raymarch isosurface aliasing:** MSAA doesn't touch the per-fragment raymarch, so
  thin walls aliased on standard-DPI screens. Settled frames now supersample
  (pixelRatio floored to 1.5) — a one-off cost under render-on-demand; interaction
  still halves it. Cut 8/8, smoke, vanilla e2e 11/11 all green.

### Cut v3.4 — tolerance erosion + sharp stock corners
- **Near-breakthrough haze** (a cut that went almost-but-not-quite through leaves a
  sub-pixel sliver that shimmers): render the solid ERODED by `u_tolerance` (0.0127mm
  ~= half a thou) — sceneSDF(p)+u_tolerance — so solid features thinner than ~2x it
  snap to a clean breakthrough. Convex stock corners stay sharp (erosion only rounds
  concave). Paired with **linear hit-refinement** in the march (interpolate the
  surface crossing between the last two samples): the 0.25mm min step is far coarser
  than the tolerance shell, so without refinement we'd overshoot a thin wall — this
  also crisps thin features generally.
- **Filleted-looking corners (stock AND cuts):** the SDFs are geometrically sharp,
  but a finite-difference normal smears every CSG crease into a ~2h fillet. Replaced
  it with FULLY ANALYTIC normals (`hitNormal`): `boxNormal()` (axis-aligned stock
  face) where the box dominates (`boxSDF > -cutDist`), else `cutNormal()` — which
  re-scans p's grid cell for the active tool and returns its analytic wall (radial,
  cone-slanted) or floor (vertical) normal via `toolNormal()`. Crisp edges on the
  stock AND the cut result geometry (floor<->wall creases, cut rims, scallops), and
  it's slightly FASTER than the old 4-tap finite diff (1 cell scan vs 4). u_tolerance
  is a uniform (tunable). All suites green; perf scorpion 18ms / heart 42ms settled.

### Cut v3.5 — marker fixes, breakthrough haze, AA
- **Marker wider than the cut (heart):** the heart opens with a tool-less rapid
  (tool = -1), so `moves[0].tool` had no table entry and the marker fell back to Ø3
  (r=1.5) vs the real r=1. Now `buildToolMarker` uses the first move that actually
  has a tool for the cylinder SIZE; and during no-tool moments (active move's tool
  not in the table) the marker GHOSTS (transparent, depthWrite off) instead of
  showing a solid mismatched cylinder.
- **"Grazed the bottom exactly" haze (owner diagnosed it):** a near-zero-thickness
  floor on an almost-through cut got stepped OVER by some rays (min step 0.25mm >>
  the sliver) and sampled by others -> salt-and-pepper of floor vs background
  through the holes. Fix: near the stock bottom (within ~0.6*featureScale, the
  breakthrough zone) step at the erosion scale (u_tolerance*2) so the floor/hole
  boundary resolves as one clean contour; dense relief away from the bottom keeps
  coarse steps (vcarve unaffected). Also biased `hitNormal` toward the cut floor
  (`boxSDF > -cutDist + featureScale*0.03`) so a thin floor doesn't flicker between
  the opposite box-bottom and cut-floor normals.
- **AA:** settled supersample bumped 1.5x -> 2x (still render-on-demand one-off;
  interaction halves it). All suites green; perf settled scorpion 32 / heart 64 /
  vcarve 536ms (swiftshader floor; ~1/15 that on a real GPU).

### Cut v3.6 — analytic distance-field edge AA (silhouette coverage)
- Sharp ridges where two cuts meet (and stock edges) serrated when viewed from the
  side — single-sample raymarch of a sub-pixel silhouette. Since we have the exact
  SDF distance, antialias edges ANALYTICALLY (the SDF-text coverage trick): in
  `cutShader.ts main()` track the closest approach `minD = min(d)` + `tClose`; on a
  MISS, if `minD < pxSpan` (pixel's world width at that depth = `tClose*u_pixelWorld`)
  the ray grazed a silhouette -> shade the closest point and feather it over the
  known background: `mix(u_clearColor, shaded, 1-smoothstep(0,pxSpan,minD))`, opaque.
  Keep `gl_FragDepth = gl_FragCoord.z` (box backface) on that branch so the toolpath/
  marker still show through the band. ONE path crisps stock edges + cut rims + ridges
  (all silhouettes). `u_pixelWorld = 2*tan(fovY/2)/renderedHeightPx` via
  `updatePixelWorld()` (viewer) called in buildCut/resize/applyPixelRatio — so it
  auto-widens the band at the lower interaction res.
- Near-free (minD is a register compare; the extra shade only fires on the ~1px
  silhouette ring, with fixed ao=1). Verified the branch fires (A/B diff: 651 edge
  pixels change, localized to silhouettes). Limit: handles silhouettes against the
  BACKGROUND (the reported case); internal edges vs nearer geometry / non-silhouette
  creases rely on the 2x SSAA.
- **3-sample parabolic refine of minD** (added for residual shallow-angle serration):
  the coarse march step quantizes the sampled `minD`, so which sample "wins" jumps as
  the camera moves -> jitter/serration at grazing angles. At each local min (dPrev
  below both neighbours) fit a parabola through the 3 bracketing samples (Newton form,
  vertex clamped to the bracket so unequal spacing can't overshoot) and take its
  vertex as the TRUE closest distance -> smooth coverage. Only fires at turning
  points, near-free. Does NOT help internal knife-edges (ridge vs nearer hit-geometry
  is hit-vs-hit, no miss -> needs a separate hit-side coverage term). Cut 8/8, smoke,
  vanilla 11/11; perf ~unchanged.

### Cleanup pass
- **Git:** untracked the build-artifact binaries (`camotics.js`/`camotics.wasm` in
  app/src/wasm + viewer; ~3.5MB, regenerated by build_wasm.sh) and gitignored them
  (camotics.d.ts stays — it's a hand stub); removed throwaway debug scripts
  (probe_cut.py, shot_cut.py).
- **Layout:** moved the test/perf harnesses into `wasm/app/tests/`
  (test_cut.py, e2e_smoke.py, perf_cut.py; run as `uv run ... python tests/<x>.py`
  from app/); serve_dist.py stays at the app root.
- **Shader tidy (cutShader.ts):** dropped the dead `SURF` const; renamed the
  misleading XY-math vars (d/e/dd -> segXY/relXY/seg2) and the Newton-refine vars
  (slopeL/slopeR/curv/tVtx/dVtx); factored the duplicated grid-cell iteration into
  `cellMoveRange()` + a `SweptMove` struct + `loadMove()` so `cutDist`/`cutNormal`
  are short and parallel. Behaviour identical (cut 8/8).
- **bakeCut tidy (glue.cpp):** documented the `MV.d[9]` move-record layout (d[6]=tStart)
  + annotated the sort; renamed cl/range/r/cur -> clampIdx/cellSpan/span/cursor.

### Cut v3.7 — perf pass (~20%, quality-identical)
Audit: perf scales with moves-per-cell; the bottleneck is texture-fetch bandwidth in
the per-move cell loop (4 texelFetch/move), not ALU. Two quality-neutral wins:
- **Per-move default-tool flag** (general, not a single-tool special case): tEnd is
  always >=0, so its sign is a free per-move flag — `toolIdx===0 ? +tEnd : -(tEnd+1)`
  in the pack (viewer.ts), decoded in `loadMove`. A default-tool (index 0) move skips
  the 3rd-texel tool-index fetch. Single-tool programs (all examples) -> the fetch is
  uniformly elided (no warp divergence); multi-tool -> index-0 moves skip it. 1 fewer
  of 4 fetches per move everywhere.
- **Fuse the hit-normal selector**: `cutNormal` now returns `vec4(normal, minDist)`;
  `hitNormal` reuses `.w` for the box-vs-cut decision instead of a separate `cutDist`
  scan -> one fewer cell loop per cut-dominant hit pixel.
Both are shader+viewer only (no wasm rebuild) and mathematically identical (test_cut
8/8, same 22.3 contrast). Measured (swiftshader median, settled 2x): heart 80->62ms
(-21%), vcarve 540->~420ms (-22%), scorpion/compass ~-10-15%. Noted future: order the
dense tool table by move frequency (maximizes multi-tool skips); the per-move sign-bit
flag already generalizes the mechanism.

### Fork-diff shrink (keep the wasm-vs-master diff small + the C glue tight)
The maintainer won't merge this, so minimize the diff vs `master` and the touched
CORE files (easier to rebase the fork).
- **Deleted the abandoned vanilla prototype** `wasm/viewer/` — it hand-vendored
  `three.module.js` (53k lines) + OrbitControls + STLLoader + a duplicate examples
  copy, all superseded by `wasm/app` (parcel pulls three from npm). Took its
  viewer-only driver `wasm/e2e/`, the early native `wasm/path2json.cpp`, and
  `wasm/serve_dev.py` with it. ~56k lines gone; `wasm/app` had zero dependency on it.
- **Core `src/` footprint -> ONE file** (`render/Renderer.cpp`, the threads<=1 inline
  patch). Reverted `sim/ToolSweep.{cpp,h}` to master: its `getRemovalTime` was dead
  code left from the deleted Volume mode (no callers).
- **Build consolidated** into ONE script `wasm/build_wasm.py` (was the bash
  `build_wasm.sh` compile + the Python `fetch_deps.py` provisioning — now a single
  `uv run wasm/build_wasm.py` with `--clean`/`--clean-all`/`--fetch-only`/`--serve`).
  Provisions pinned deps + emsdk, compiles, and links straight to
  `app/src/wasm/camotics.{js,wasm}` (no viewer copy step). Clean build verified
  byte-identical to the bash build (309 objs, 0 FAILCOMPILE, cut 8/8 @ 22.3).
- **MESH-mode coverage** (lost with `wasm/e2e`) folded into `app/tests/e2e_smoke.py`:
  it now also drives `window.__simulate` and asserts a non-empty surface mesh.
- **glue.cpp tightened** (minimal/careful allocation): dropped dead includes
  (ToolSweep/CutWorkpiece/Grid) + the unused `loadGCode` entry; `run()` reserves
  verts/norms from triangleCount; `bakeCut` reserves `ms`, shrank the per-move
  `MV` bbox double->float (84->60 B), and sorts a uint32 INDEX array by tStart
  (not the structs) before building movesData + the CSR. Render byte-identical
  (cut 8/8, same 22.3 contrast).

## Remaining (future)
- Dense-path perf (vcarve ~199 moves/cell): inherent overlap, not grid resolution.
  The correct SDF is heavier per move, so swiftshader vcarve is ~400ms (one full-res
  settle frame; ~30ms on real GPU, and interaction runs at 0.5× res). Options:
  temporal pruning (sort cell moves by tStart, binary-search to scrub), or
  auto-fallback to Volume mode above a density threshold. Deferred by owner.
- Conical/ballnose swept-SDF paths are implemented but untested (all bundled
  examples use a cylindrical Ø2 tool); verify against a V-bit program.
- Validation cross-check: the analytic Cut is OUR geometry; an automated diff vs the
  true CAMotics mesh (Mesh mode) would keep them honest for the "validate other
  sims" use-case.
- Surface mesh in-browser: computeSurface uses threaded marching cubes
  (Renderer spawns cb::Thread RenderJobs). Needs em++ -pthread (workers +
  SharedArrayBuffer + COOP/COEP serving headers), or make Renderer run inline
  at threads=1. The toolpath path (shipped) needs none of this.
- Loading .camotics/.xml projects in-browser would exercise expat at runtime
  (currently only G-code via addFile is wired).

## (historical) Remaining for an actual .wasm (engineering, NOT rewrite)
1. Provide expat (emscripten port or build-from-src) and decide on openssl:
   Random.cpp only needs entropy; XML only needed if loading XML projects
   (.camotics is JSON, so expat may be skippable for the viewer use-case).
2. Archive the emcc objects (core + cbang subset, EXCLUDING event/net/http/ws/
   dns/db/openssl/acmev2/epoll) into .a's with emar.
3. Write an embind glue TU exposing: loadProject(json,gcode) / getToolPath() ->
   the JSON contract / getSurface() -> Float32 verts+normals (or STL bytes).
4. Link with em++ -pthread (renderer is multithreaded via cb::Thread -> pthreads
   -> web workers + SharedArrayBuffer; needs COOP/COEP headers) OR run threads=1.
5. File I/O: feed input via MEMFS / Module args instead of disk.
6. Swap viewer's fetch(fixtures) for calls into the wasm Module. Re-run the SAME
   e2e (it's the contract) against wasm-produced data.

## Reproducible setup from a fresh clone
build_wasm.py is the single orchestrator (provision deps -> compile+link -> serve):
1. apt build deps (needs sudo):
   sudo apt-get install -y build-essential pkgconf libboost-dev \
     libboost-iostreams-dev libssl-dev libexpat1-dev zlib1g-dev libbz2-dev \
     liblz4-dev libsqlite3-dev libevent-dev libyaml-dev libre2-dev \
     libleveldb-dev libsnappy-dev
2. scons:  uv tool install scons
3. build+serve:  uv run wasm/build_wasm.py --serve
   # pins cbang/libexpat/emsdk by commit, patches out cbang V8, installs emsdk
   # 6.0.0, gens cbang/include headers, builds wasm, serves on 0.0.0.0:8000
   flags: --clean (wipe build objects + outputs, rebuild), --clean-all (also re-fetch
          deps, ~1.5G), --fetch-only, --serve, --port N
(cbang/, emsdk/, libexpat/, wobj/ gitignored — step 3 regenerates them. Idempotent.)

## Key commands
- env:   export PATH="$HOME/.local/bin:$PATH"; export CBANG_HOME=$PWD/wasm/cbang
- core:  scons with_gui=0 with_tpl=0 -j4
- sim:   ./camsim --resolution low examples/aztec_calendar/aztec_calendar.camotics out.stl
- wasm:  uv run wasm/build_wasm.py      (-> wasm/app/src/wasm/camotics.{js,wasm})
- app:   (cd wasm/app && npm run build && python serve_dist.py)
- e2e:   (cd wasm/app && uv run --with playwright,pillow python tests/e2e_smoke.py)
- emcc:  source wasm/emsdk/emsdk_env.sh   (emcc 6.0.0)
