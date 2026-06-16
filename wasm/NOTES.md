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
- wasm/viewer/        three.js frontend (index.html, app.js, vendor/, fixtures/)
- wasm/e2e/           uv project, Playwright tests (test_viewer.py), serve via http
- wasm/*.log          background build/download logs

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

## Remaining (future)
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
fetch_deps.py is the orchestrator (fetch deps -> build wasm -> serve):
1. apt build deps (needs sudo):
   sudo apt-get install -y build-essential pkgconf libboost-dev \
     libboost-iostreams-dev libssl-dev libexpat1-dev zlib1g-dev libbz2-dev \
     liblz4-dev libsqlite3-dev libevent-dev libyaml-dev libre2-dev \
     libleveldb-dev libsnappy-dev
2. scons:  uv tool install scons
3. build+serve:  uv run wasm/fetch_deps.py --serve
   # pins cbang/libexpat/emsdk by commit, patches out cbang V8, installs emsdk
   # 6.0.0, gens cbang/include headers, builds wasm, serves on 0.0.0.0:8000
   flags: --clean (wipe build outputs + rebuild), --clean-all (also re-fetch deps,
          ~1.5G), --fetch-only, --serve, --port N
(cbang/, emsdk/, libexpat/, wobj/ gitignored — step 3 regenerates them. Idempotent.)

## Key commands
- env:   export PATH="$HOME/.local/bin:$PATH"; export CBANG_HOME=$PWD/wasm/cbang
- core:  scons with_gui=0 with_tpl=0 -j4
- sim:   ./camsim --resolution low examples/aztec_calendar/aztec_calendar.camotics out.stl
- path:  (cd examples/aztec_calendar && .../wasm/path2json aztec_calendar.camotics out.json)
- e2e:   cd wasm/e2e && uv run --active python test_viewer.py   (system chromium)
- emcc:  source wasm/emsdk/emsdk_env.sh   (emcc 6.0.0)
