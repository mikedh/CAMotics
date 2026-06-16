# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx>=0.27"]
# ///
"""
Build orchestrator for the CAMotics wasm viewer. Fetches + pins the third-party
deps, builds the wasm, and (optionally) serves it.

    uv run wasm/fetch_deps.py                 # fetch (idempotent) + build wasm
    uv run wasm/fetch_deps.py --serve         # ... then serve on 0.0.0.0:8000
    uv run wasm/fetch_deps.py --clean         # wipe build outputs, then rebuild
    uv run wasm/fetch_deps.py --clean-all     # also re-fetch deps (re-downloads ~1.5G)
    uv run wasm/fetch_deps.py --fetch-only     # just set up deps, no build

Deps fetched (pinned by commit) into wasm/:
  - cbang     (CauldronDevelopmentLLC/cbang) — the C! foundation library
  - libexpat  (libexpat/libexpat)            — XML parser (compiled into the wasm)
  - emsdk     (emscripten-core/emsdk)         — pinned toolchain installed/activated

Setup also: patches cbang to disable V8, and runs cbang's native scons build
(which GENERATES cbang/include/* headers the wasm build needs, e.g. re2/*.h, yaml.h).
Idempotent: re-running skips anything already in place.
"""
import httpx, tarfile, io, os, sys, stat, shutil, subprocess, argparse
from pathlib import Path

WASM = Path(__file__).resolve().parent

# Pinned third-party deps (GitHub commit SHAs). Bump deliberately.
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
    print(f"[fetch] {msg}", flush=True)


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


def verify():
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


def clean(deep=False):
    targets = [WASM / "wobj",
               WASM / "viewer" / "camotics.js",
               WASM / "viewer" / "camotics.wasm"]
    if deep:
        targets += [WASM / "cbang", WASM / "emsdk", WASM / "libexpat"]
    for t in targets:
        if t.is_dir():
            shutil.rmtree(t); log(f"removed {t.relative_to(WASM)}/")
        elif t.exists():
            t.unlink(); log(f"removed {t.relative_to(WASM)}")


def build_wasm():
    log("building wasm (wasm/build_wasm.sh)")
    rc = subprocess.run(["bash", str(WASM / "build_wasm.sh")], cwd=WASM).returncode
    if rc != 0:
        sys.exit("wasm build failed (see wasm/build_wasm.log)")
    wasm = WASM / "viewer" / "camotics.wasm"
    log(f"built {wasm.relative_to(WASM)} ({wasm.stat().st_size // 1024} KB)")


def serve(port):
    log(f"serving wasm/viewer on 0.0.0.0:{port} (Ctrl-C to stop)")
    subprocess.run([sys.executable, str(WASM / "serve_dev.py"), str(port), "0.0.0.0"], cwd=WASM)


def main():
    ap = argparse.ArgumentParser(description="Fetch deps, build, and serve the CAMotics wasm viewer.")
    ap.add_argument("--clean", action="store_true", help="remove build outputs (wobj/, camotics.{js,wasm}) before building")
    ap.add_argument("--clean-all", action="store_true", help="--clean plus re-fetch deps (re-downloads ~1.5G)")
    ap.add_argument("--fetch-only", action="store_true", help="set up deps only; skip the wasm build")
    ap.add_argument("--serve", action="store_true", help="serve the viewer after building")
    ap.add_argument("--port", type=int, default=8000, help="serve port (default 8000)")
    args = ap.parse_args()

    if args.clean or args.clean_all:
        clean(deep=args.clean_all)

    for dep in DEPS:
        download_extract(dep)
    patch_cbang_v8(WASM / "cbang")
    setup_emsdk(WASM / "emsdk")
    build_cbang_native(WASM / "cbang")
    if not verify():
        sys.exit("setup incomplete — see MISSING above")

    if args.fetch_only:
        log("deps ready (--fetch-only). Build with:  uv run wasm/fetch_deps.py")
        return

    build_wasm()
    if args.serve:
        serve(args.port)
    else:
        log("done. Serve with:  uv run wasm/fetch_deps.py --serve")


if __name__ == "__main__":
    main()
