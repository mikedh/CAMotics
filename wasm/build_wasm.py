# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx>=0.27"]
# ///
"""
One-stop build for the in-browser CAMotics core (wasm) + parcel app.

    uv run wasm/build_wasm.py                # fetch deps if missing, compile, link
    uv run wasm/build_wasm.py --clean        # wipe build objects + outputs, rebuild
    uv run wasm/build_wasm.py --clean-all    # also re-fetch pinned deps (~1.5G)
    uv run wasm/build_wasm.py --fetch-only   # provision deps/toolchain only, no build
    uv run wasm/build_wasm.py --serve        # build the app too + serve dist on :8000
    uv run wasm/build_wasm.py --serve --port 8101

Provisions (pinned by SHA, idempotent): cbang, libexpat, and the emsdk toolchain.
Patches cbang to drop V8 and runs its native scons build (which GENERATES the
cbang/include/* headers the wasm build includes). Then compiles the CAMotics core +
cbang subset + bundled re2 + boost(fs/iostreams) + expat + the embind glue with
emscripten, archives to libcamcore.a, and links to wasm/app/src/wasm/camotics.{js,wasm}.
"""
import argparse, io, os, shutil, stat, subprocess, sys, tarfile
from pathlib import Path

import httpx

WASM = Path(__file__).resolve().parent
ROOT = WASM.parent

# ---------------------------------------------------------------------------
# Provisioning (pinned third-party deps + emsdk toolchain + native cbang headers)
# ---------------------------------------------------------------------------
DEPS = [
    dict(name="cbang",    owner="CauldronDevelopmentLLC", repo="cbang",
         sha="cbb4043a1e5214a26bf444c398d53e3b22a6d39f"),
    dict(name="libexpat", owner="libexpat",               repo="libexpat",
         sha="059910e278223e36f45337cf6e44cf25750d7803"),
    dict(name="emsdk",    owner="emscripten-core",        repo="emsdk",
         sha="d223ae73c6998296e3ab27cf81dc2c2c9fd383de"),
]
EMSDK_VERSION = "6.0.0"

APT_HINT = ("sudo apt-get install -y build-essential pkgconf "
            "libboost-dev libboost-iostreams-dev libssl-dev libexpat1-dev "
            "zlib1g-dev libbz2-dev liblz4-dev libsqlite3-dev libevent-dev "
            "libyaml-dev libre2-dev libleveldb-dev libsnappy-dev")


def log(msg):
    print(f"[build] {msg}", flush=True)


def download_extract(dep):
    target = WASM / dep["name"]
    if target.exists():
        log(f"{dep['name']}: present, skipping download")
        return target
    url = f"https://github.com/{dep['owner']}/{dep['repo']}/archive/{dep['sha']}.tar.gz"
    log(f"{dep['name']}: downloading @ {dep['sha'][:10]}")
    buf = io.BytesIO()
    with httpx.stream("GET", url, follow_redirects=True, timeout=180) as r:
        r.raise_for_status()
        for chunk in r.iter_bytes(1 << 20):
            buf.write(chunk)
    buf.seek(0)
    log(f"{dep['name']}: extracting")
    with tarfile.open(fileobj=buf, mode="r:gz") as t:
        t.extractall(WASM, filter="data")
    (WASM / f"{dep['repo']}-{dep['sha']}").rename(target)
    return target


def patch_cbang_v8(cbang):
    f = cbang / "config" / "cbang" / "__init__.py"
    s = f.read_text()
    if "CAMotics" in s or "# conf.CBConfig('v8'" in s:
        log("cbang: V8 patch already applied")
        return
    needle = "    conf.CBConfig('v8', False)\n"
    if needle not in s:
        log("cbang: V8 config line not found (upstream changed?) — review manually")
        return
    s = s.replace(needle,
                  "    # CAMotics-wasm: V8/TPL disabled (system libnode V8 ABI "
                  "mismatch; no JS engine wanted).\n"
                  "    # conf.CBConfig('v8', False)\n")
    f.write_text(s)
    log("cbang: patched out CBConfig('v8')")


def setup_emsdk(emsdk):
    if (emsdk / "upstream" / "emscripten" / "emcc").exists():
        log(f"emsdk: toolchain {EMSDK_VERSION} already active")
        return
    emsdk_bin = emsdk / "emsdk"
    emsdk_bin.chmod(emsdk_bin.stat().st_mode | stat.S_IEXEC)
    log(f"emsdk: install {EMSDK_VERSION} (downloads ~1.5G toolchain)")
    subprocess.run([str(emsdk_bin), "install", EMSDK_VERSION], cwd=emsdk, check=True)
    subprocess.run([str(emsdk_bin), "activate", EMSDK_VERSION], cwd=emsdk, check=True)


def build_cbang_native(cbang):
    # The wasm build includes cbang/include/* (re2/*.h, yaml.h, ...), which are
    # produced by cbang's native build — so build it once here.
    if (cbang / "include" / "re2" / "re2.h").exists() and (cbang / "include" / "yaml.h").exists():
        log("cbang: include/ headers already generated")
        return
    scons = shutil.which("scons")
    if not scons:
        sys.exit("scons not found. Install it with:  uv tool install scons")
    log("cbang: building natively to generate include/ headers")
    env = dict(os.environ, CBANG_HOME=str(cbang))
    rc = subprocess.run([scons, f"-j{os.cpu_count() or 4}"], cwd=cbang, env=env).returncode
    if rc != 0:
        sys.exit("cbang native build failed. Likely missing apt build deps:\n  " + APT_HINT)


def verify_deps():
    checks = {
        "emcc":          WASM / "emsdk" / "upstream" / "emscripten" / "emcc",
        "expat source":  WASM / "libexpat" / "expat" / "lib" / "xmlparse.c",
        "cbang re2 hdr":  WASM / "cbang" / "include" / "re2" / "re2.h",
        "cbang yaml hdr": WASM / "cbang" / "include" / "yaml.h",
    }
    ok = True
    for label, path in checks.items():
        present = path.exists()
        ok = ok and present
        log(("ok    " if present else "MISSING ") + f"{label}: {path.relative_to(WASM)}")
    return ok


def provision(deep_clean=False):
    for dep in DEPS:
        download_extract(dep)
    patch_cbang_v8(WASM / "cbang")
    setup_emsdk(WASM / "emsdk")
    build_cbang_native(WASM / "cbang")
    if not verify_deps():
        sys.exit("setup incomplete — see MISSING above")


# ---------------------------------------------------------------------------
# Compile + link (emscripten). Mirrors the old build_wasm.sh exactly.
# ---------------------------------------------------------------------------
OBJ = WASM / "wobj"
EXPAT = WASM / "libexpat" / "expat" / "lib"
INC = ["-Iwasm/cbang/src", "-Iwasm/cbang/include", "-Iwasm/cbang/src/boost",
       f"-I{EXPAT}", "-Isrc", "-Ibuild"]
DEF = ["-std=c++17", "-O2", "-fexceptions",
       "-DHAVE_CBANG", "-DUSING_CBANG", "-DCAMOTICS_NO_TPL"]
PTHREAD = os.environ.get("PTHREAD", "").split()  # empty (v1 is single-threaded)
LOG = WASM / "build_wasm.log"

# core CAMotics source globs (relative to ROOT), and the one excluded TPL file.
CORE_GLOBS = [
    "src/gcode/*.cpp", "src/gcode/ast/*.cpp", "src/gcode/parse/*.cpp",
    "src/gcode/interp/*.cpp", "src/gcode/machine/*.cpp", "src/gcode/plan/*.cpp",
    "src/gcode/plan/bbctrl/*.cpp", "src/stl/*.cpp", "src/dxf/*.cpp", "src/dxflib/*.cpp",
    "src/camotics/*.cpp", "src/camotics/sim/*.cpp", "src/camotics/probe/*.cpp",
    "src/camotics/opt/*.cpp", "src/camotics/project/*.cpp",
    "src/camotics/contour/*.cpp", "src/camotics/render/*.cpp",
]
# cbang subset (relative to wasm/cbang); skip Random.cpp (needs openssl).
CBANG_GLOBS = [
    "src/cbang/*.cpp", "src/cbang/geom/*.cpp", "src/cbang/json/*.cpp",
    "src/cbang/json/schema/*.cpp", "src/cbang/xml/*.cpp", "src/cbang/util/*.cpp",
    "src/cbang/os/*.cpp", "src/cbang/os/lin/*.cpp", "src/cbang/thread/*.cpp",
    "src/cbang/time/*.cpp", "src/cbang/log/*.cpp", "src/cbang/parse/*.cpp",
    "src/cbang/io/*.cpp", "src/cbang/config/*.cpp",
    "src/cbang/debug/*.cpp", "src/cbang/enum/*.cpp", "src/cbang/js/*.cpp",
    "src/cbang/net/Base64.cpp", "src/cbang/net/URI.cpp",
]

_failed = []


def _globs(base, patterns):
    out = []
    for pat in patterns:
        out += sorted(base.glob(pat))
    return out


def compile_one(prefix, src, cwd, flags, compiler="em++", log_fh=None):
    """Compile src->obj if the obj is stale. Returns the obj path (always, so it
    gets archived even when skipped). Records failures in _failed."""
    rel = src.relative_to(cwd)
    obj = OBJ / f"{prefix}__{str(rel).replace('/', '_')}.o"
    if obj.exists() and obj.stat().st_mtime >= src.stat().st_mtime:
        return obj
    rc = subprocess.run([compiler, *flags, "-c", str(rel), "-o", str(obj)],
                        cwd=cwd, stderr=log_fh).returncode
    if rc != 0:
        _failed.append(str(rel))
        print(f"FAILCOMPILE {rel}", flush=True)
    return obj


def emsdk_env():
    """Source emsdk_env.sh and capture the resulting environment (PATH etc.)."""
    script = WASM / "emsdk" / "emsdk_env.sh"
    out = subprocess.run(
        ["bash", "-c", f"source '{script}' >/dev/null 2>&1 && env -0"],
        capture_output=True, text=True, check=True).stdout
    env = {}
    for entry in out.split("\0"):
        if "=" in entry:
            k, v = entry.split("=", 1)
            env[k] = v
    return env or dict(os.environ)


def build_wasm():
    OBJ.mkdir(parents=True, exist_ok=True)
    os.environ.update(emsdk_env())  # put em++/emcc/emar on PATH for all subprocesses
    LOG.write_text("")
    _failed.clear()
    cbang = WASM / "cbang"

    with open(LOG, "a") as fh:
        print("=== CAMotics core ===", flush=True)
        core_objs = []
        for f in _globs(ROOT, CORE_GLOBS):
            if f.name == "TPLRunner.cpp":   # TPL-only, excluded
                continue
            core_objs.append(compile_one("core", f, ROOT, DEF + PTHREAD + INC, log_fh=fh))
        print(f"  core: {len(core_objs)} files", flush=True)

        print("=== cbang subset ===", flush=True)
        cbinc = ["-Isrc", "-Iinclude", "-Isrc/boost", f"-I{EXPAT}"]
        cbang_objs = []
        for f in _globs(cbang, CBANG_GLOBS):
            if f.name == "Random.cpp":      # needs openssl
                continue
            cbang_objs.append(compile_one("cbang", f, cbang, DEF + PTHREAD + cbinc, log_fh=fh))

        print("=== re2 (bundled in cbang; NO_THREADS) ===", flush=True)
        re2_flags = ["-std=c++17", "-O2", "-fexceptions", "-DNO_THREADS",
                     *PTHREAD, "-Isrc/re2/src", "-Iinclude"]
        re2_objs = []
        for f in _globs(cbang, ["src/re2/src/re2/*.cc", "src/re2/src/util/*.cc"]):
            re2_objs.append(compile_one("re2", f, cbang, re2_flags, log_fh=fh))

        print("=== boost subset (filesystem + iostreams core; NO atomic/compression) ===", flush=True)
        boost_objs = []
        for f in _globs(cbang, ["src/boost/libs/filesystem/src/*.cpp",
                                "src/boost/libs/iostreams/src/*.cpp"]):
            if f.name in ("bzip2.cpp", "lzma.cpp", "zstd.cpp"):
                continue
            boost_objs.append(compile_one(
                "boost", f, cbang,
                DEF + PTHREAD + ["-Isrc", "-Isrc/boost", "-fexceptions", "-sUSE_ZLIB=1"],
                log_fh=fh))

        print("=== expat (xmlparse/xmlrole/xmltok) ===", flush=True)
        expat_objs = []
        for name in ("xmlparse.c", "xmlrole.c", "xmltok.c"):
            src = EXPAT / name
            obj = OBJ / f"expat__{name}.o"
            if not (obj.exists() and obj.stat().st_mtime >= src.stat().st_mtime):
                rc = subprocess.run(
                    ["emcc", "-O2", *PTHREAD, "-DXML_GE=1", "-DXML_POOR_ENTROPY",
                     "-DXML_STATIC", f"-I{EXPAT}", "-c", str(src), "-o", str(obj)],
                    stderr=fh).returncode
                if rc != 0:
                    _failed.append(name)
                    print(f"FAILCOMPILE {name}", flush=True)
            expat_objs.append(obj)

        print("=== embind glue + comp stub ===", flush=True)
        glue_o = compile_one("glue", WASM / "glue.cpp", ROOT, DEF + PTHREAD + INC, log_fh=fh)
        comp_o = compile_one("glue", WASM / "comp_stub.cpp", ROOT, DEF + PTHREAD + INC, log_fh=fh)

        print("=== archive ===", flush=True)
        ar = OBJ / "libcamcore.a"
        ar.unlink(missing_ok=True)
        lib_objs = core_objs + cbang_objs + re2_objs + boost_objs + expat_objs
        subprocess.run(["emar", "rcs", str(ar), *map(str, lib_objs)], stderr=fh, check=False)
        print(f"  archive: {ar.stat().st_size if ar.exists() else 0} bytes, {len(lib_objs)} objs",
              flush=True)

        print("=== link ===", flush=True)
        out_js = WASM / "app" / "src" / "wasm" / "camotics.js"
        out_js.parent.mkdir(parents=True, exist_ok=True)
        link = subprocess.run(
            ["em++", "-O2", "-fexceptions", *PTHREAD, "--bind",
             "-sMODULARIZE=1", "-sEXPORT_NAME=createCAMotics", "-sEXPORT_ES6=1",
             "-sALLOW_MEMORY_GROWTH=1", "-sENVIRONMENT=web", "-sASSERTIONS=1",
             "-sEXPORTED_RUNTIME_METHODS=FS",
             "-sERROR_ON_UNDEFINED_SYMBOLS=0", "-sUSE_ZLIB=1",
             str(glue_o), str(comp_o), str(ar), "-o", str(out_js)],
            stderr=fh).returncode

    fails = len(_failed)
    print(f"link exit={link}", flush=True)
    print(f"=== FAILCOMPILE count: {fails} ===", flush=True)
    if link != 0:
        text = LOG.read_text(errors="replace")
        undef = sorted({l.split("undefined symbol: ", 1)[1].split()[0]
                        for l in text.splitlines() if "undefined symbol: " in l})
        if undef:
            print("=== undefined symbols (unique) ===", flush=True)
            print("\n".join(undef[:50]), flush=True)
        sys.exit("wasm link failed (see wasm/build_wasm.log)")
    if fails:
        sys.exit(f"{fails} translation unit(s) failed to compile (see wasm/build_wasm.log)")
    wasm_out = WASM / "app" / "src" / "wasm" / "camotics.wasm"
    log(f"built {wasm_out.relative_to(WASM)} ({wasm_out.stat().st_size // 1024} KB)")


# ---------------------------------------------------------------------------
# clean + serve
# ---------------------------------------------------------------------------
def clean(deep=False):
    targets = [OBJ,
               WASM / "app" / "src" / "wasm" / "camotics.js",
               WASM / "app" / "src" / "wasm" / "camotics.wasm"]
    if deep:
        targets += [WASM / "cbang", WASM / "emsdk", WASM / "libexpat"]
    for t in targets:
        if t.is_dir():
            shutil.rmtree(t); log(f"removed {t.relative_to(WASM)}/")
        elif t.exists():
            t.unlink(); log(f"removed {t.relative_to(WASM)}")


def serve(port):
    app = WASM / "app"
    log("building parcel app (npm run build)")
    subprocess.run(["npm", "run", "build"], cwd=app, check=False)
    log(f"serving wasm/app/dist on 0.0.0.0:{port} (Ctrl-C to stop)")
    subprocess.run([sys.executable, str(app / "serve_dist.py"), str(port)], cwd=app)


def main():
    ap = argparse.ArgumentParser(description="Provision, build, and serve the CAMotics wasm app.")
    ap.add_argument("--clean", action="store_true",
                    help="remove build objects + outputs before building")
    ap.add_argument("--clean-all", action="store_true",
                    help="--clean plus re-fetch deps (re-downloads ~1.5G)")
    ap.add_argument("--fetch-only", action="store_true",
                    help="provision deps/toolchain only; skip the wasm build")
    ap.add_argument("--serve", action="store_true", help="build the app + serve dist after building")
    ap.add_argument("--port", type=int, default=8000, help="serve port (default 8000)")
    args = ap.parse_args()

    if args.clean or args.clean_all:
        clean(deep=args.clean_all)

    provision()

    if args.fetch_only:
        log("deps ready (--fetch-only). Build with:  uv run wasm/build_wasm.py")
        return

    build_wasm()
    if args.serve:
        serve(args.port)
    else:
        log("done. Serve with:  uv run wasm/build_wasm.py --serve")


if __name__ == "__main__":
    main()
