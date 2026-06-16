#!/usr/bin/env bash
# Build the in-browser CAMotics core to wasm (v1: G-code -> ToolPath JSON).
set -u
shopt -s nullglob
ROOT="/home/mikedh/dev/CAMotics"; WASM="$ROOT/wasm"
source "$WASM/emsdk/emsdk_env.sh" 2>/dev/null
cd "$ROOT"
OBJ="$WASM/wobj"; mkdir -p "$OBJ"
EXPAT="$WASM/libexpat/expat/lib"
INC="-Iwasm/cbang/src -Iwasm/cbang/include -Iwasm/cbang/src/boost -I$EXPAT -Isrc -Ibuild"
DEF="-std=c++17 -O2 -fexceptions -DHAVE_CBANG -DUSING_CBANG -DCAMOTICS_NO_TPL"
PTHREAD="${PTHREAD:-}"
LOG="$WASM/build_wasm.log"; : > "$LOG"

cc1() { # compile one file: $1=src $2=obj  $3..=extra flags
  local f="$1" o="$2"; shift 2
  [ "$o" -nt "$f" ] && return 0
  em++ $DEF $PTHREAD "$@" -c "$f" -o "$o" 2>>"$LOG" || echo "FAILCOMPILE $f"
}

echo "=== CAMotics core ==="
n=0
for f in src/gcode/*.cpp src/gcode/ast/*.cpp src/gcode/parse/*.cpp \
  src/gcode/interp/*.cpp src/gcode/machine/*.cpp src/gcode/plan/*.cpp \
  src/gcode/plan/bbctrl/*.cpp src/stl/*.cpp src/dxf/*.cpp src/dxflib/*.cpp \
  src/camotics/*.cpp src/camotics/sim/*.cpp src/camotics/probe/*.cpp \
  src/camotics/opt/*.cpp src/camotics/project/*.cpp \
  src/camotics/contour/*.cpp src/camotics/render/*.cpp; do
  case "$f" in */plan/TPLRunner.cpp) continue;; esac   # TPL-only, excluded
  cc1 "$f" "$OBJ/core__$(echo "$f"|tr '/' '_').o" $INC; n=$((n+1))
done
echo "  core: $n files"

echo "=== cbang subset ==="
pushd "$WASM/cbang" >/dev/null
CBINC="-Isrc -Iinclude -Isrc/boost -I$EXPAT"
for f in src/cbang/*.cpp src/cbang/geom/*.cpp src/cbang/json/*.cpp \
  src/cbang/json/schema/*.cpp src/cbang/xml/*.cpp src/cbang/util/*.cpp \
  src/cbang/os/*.cpp src/cbang/os/lin/*.cpp src/cbang/thread/*.cpp \
  src/cbang/time/*.cpp src/cbang/log/*.cpp src/cbang/parse/*.cpp \
  src/cbang/io/*.cpp src/cbang/config/*.cpp \
  src/cbang/debug/*.cpp src/cbang/enum/*.cpp src/cbang/js/*.cpp \
  src/cbang/net/Base64.cpp src/cbang/net/URI.cpp; do
  # skip ones needing openssl (Random) or external compression libs (comp)
  case "$f" in */util/Random.cpp) continue;; esac
  cc1 "$f" "$OBJ/cbang__$(echo "$f"|tr '/' '_').o" $CBINC
done
popd >/dev/null

echo "=== re2 (bundled in cbang; NO_THREADS) ==="
pushd "$WASM/cbang" >/dev/null
for f in src/re2/src/re2/*.cc src/re2/src/util/*.cc; do
  o="$OBJ/re2__$(echo "$f"|tr '/' '_').o"
  [ "$o" -nt "$f" ] && continue
  em++ -std=c++17 -O2 -fexceptions -DNO_THREADS $PTHREAD -Isrc/re2/src -Iinclude \
    -c "$f" -o "$o" 2>>"$LOG" || echo "FAILCOMPILE $f"
done
popd >/dev/null

echo "=== boost subset (filesystem + iostreams core; NO atomic/compression) ==="
pushd "$WASM/cbang" >/dev/null
for f in src/boost/libs/filesystem/src/*.cpp src/boost/libs/iostreams/src/*.cpp; do
  # keep zlib.cpp (provides boost::iostreams::zlib const data symbols via zlib port);
  # bz2/lz4 backends stay allowed-undefined functions.
  case "$f" in *bzip2.cpp|*lzma.cpp|*zstd.cpp) continue;; esac
  cc1 "$f" "$OBJ/boost__$(echo "$f"|tr '/' '_').o" -Isrc -Isrc/boost -fexceptions -sUSE_ZLIB=1
done
popd >/dev/null

echo "=== expat (xmlparse/xmlrole/xmltok) ==="
for f in "$EXPAT/xmlparse.c" "$EXPAT/xmlrole.c" "$EXPAT/xmltok.c"; do
  o="$OBJ/expat__$(basename "$f").o"
  [ "$o" -nt "$f" ] && continue
  emcc -O2 $PTHREAD -DXML_GE=1 -DXML_POOR_ENTROPY -DXML_STATIC -I"$EXPAT" \
    -c "$f" -o "$o" 2>>"$LOG" || echo "FAILCOMPILE $f"
done

echo "=== embind glue + comp stub ==="
cc1 "$WASM/glue.cpp" "$OBJ/glue.o" $INC
cc1 "$WASM/comp_stub.cpp" "$OBJ/comp_stub.o" $INC

echo "=== archive ==="
objs=( "$OBJ"/core__*.o "$OBJ"/cbang__*.o "$OBJ"/re2__*.o "$OBJ"/boost__*.o "$OBJ"/expat__*.o )
rm -f "$OBJ/libcamcore.a"
emar rcs "$OBJ/libcamcore.a" "${objs[@]}" 2>>"$LOG"
echo "  archive: $(ls -la "$OBJ/libcamcore.a" 2>/dev/null|awk '{print $5}') bytes, ${#objs[@]} objs"

echo "=== link ==="
em++ -O2 -fexceptions $PTHREAD --bind \
  -sMODULARIZE=1 -sEXPORT_NAME=createCAMotics -sEXPORT_ES6=1 \
  -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web -sASSERTIONS=1 \
  -sEXPORTED_RUNTIME_METHODS=FS \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 -sUSE_ZLIB=1 \
  "$OBJ/glue.o" "$OBJ/comp_stub.o" "$OBJ/libcamcore.a" \
  -o "$WASM/viewer/camotics.js" 2>>"$LOG"
LINKRC=$?
echo "link exit=$LINKRC"
echo "=== FAILCOMPILE count: $(grep -c FAILCOMPILE "$LOG" 2>/dev/null||echo 0) ==="
grep FAILCOMPILE "$LOG" | head
if [ $LINKRC -ne 0 ]; then
  echo "=== undefined symbols (unique) ==="
  grep -oE "undefined symbol: [^ ]+" "$LOG" | sort -u | head -50
  echo "=== other link errors ==="
  grep -E "error:" "$LOG" | grep -v "undefined symbol" | sort -u | head -20
else
  ls -la "$WASM/viewer/camotics.js" "$WASM/viewer/camotics.wasm"
fi
