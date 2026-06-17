// ---------------------------------------------------------------------------
// Analytic swept-volume SDF raymarch — the squirm-free, crisp-wall cut render.
//
// Instead of a baked removalTime field (whose level-set squirms as you scrub),
// the GPU evaluates the cut ANALYTICALLY:
//
//   solid(p, s) = stockBox(p)  MINUS  union of tool sweeps with tStart <= s
//
// A point is removed exactly when the swept tool first reaches it, so the
// surface only changes where/when the tool touches — no temporal squirm — and
// the walls are the true tool envelope (capsule / cone / sphere-swept), so they
// are crisp and tool-shaped, with analytic SDF-gradient normals.
//
// Acceleration: moves are binned into a uniform grid (CSR: cellStart/cellMoves);
// each raymarch sample only tests the moves in its cell. Continuous motion: a
// move still in progress at scrub time s is clipped to the point the tool has
// actually reached (no reliance on g-code segment granularity).
//
// Data textures (all in RAW stock/toolpath coordinates, mm):
//   u_moves     RGBA32F, 3 texels/move: (x0,y0,z0,tStart)(x1,y1,z1,tEnd)(tool,0,0,0)
//   u_cellStart R32F: CSR offsets, gnx*gny*gnz + 1 entries
//   u_cellMoves R32F: CSR move indices
//   u_tools     vec4[]: (shape, radius, length, snubRadius) per dense tool index
// ---------------------------------------------------------------------------

export const cutVertexShader = /* glsl */ `
out vec3 vLocal;       // box object-space position (== raw - stockCenter)
out vec3 vCamLocal;    // camera in box object space
void main() {
  vLocal = position;
  vCamLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const MAX_TOOLS = 64;

export const cutFragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

#ifdef BAKE
uniform int  u_bakeLayer;   // local Z layer (0..D-1) of the keyframe being baked
uniform vec2 u_bakeRes;     // field W,H (one slice, in texels)
uniform vec2 u_tileOrigin;  // this slice's origin in the atlas (texels)
#else
in vec3 vLocal;             // box object-space pos (from the vertex stage)
in vec3 vCamLocal;
#endif
out vec4 fragColor;

uniform sampler2D u_moves;
uniform sampler2D u_cellStart;
uniform sampler2D u_cellMoves;
uniform int u_moveTexW;
uniform int u_startTexW;
uniform int u_cmTexW;
uniform vec4 u_tools[${MAX_TOOLS}];

uniform vec3  u_stockCenter;   // raw center; raw = vLocal + center
uniform vec3  u_stockMin;      // raw stock AABB
uniform vec3  u_stockMax;
uniform vec3  u_gridOrigin;
uniform float u_gridCell;      // grid-cell traversal scale (part-size / 64)
uniform float u_featureScale;  // cut-feature scale (~min tool radius) for normals/AO/step
uniform ivec3 u_gridDims;

uniform float u_scrubAbs;      // absolute scrub time (seconds)
uniform int   u_maxSteps;
uniform vec3  u_baseColor;
uniform vec3  u_lightDir;
uniform float u_tolerance;     // erode the solid by this (mm): solid features thinner
                               // than ~2x it snap away (clean near-breakthroughs)
uniform float u_pixelWorld;    // world units / pixel / unit ray-distance = 2*tan(fovY/2)/Hpx
uniform vec3  u_clearColor;    // background color, for analytic silhouette coverage AA

// --- keyframe (checkpoint) fields: bake periodic full-state SDF snapshots, render the
// nearest one + only the moves since it. u_useKF gates the whole feature (off = exact
// original analytic path). The K fields are stacked in Z (texture depth = D*K).
uniform sampler2D u_keyframe;    // RGBA8 atlas of K*D field slices (RG = 16-bit packed SDF)
uniform sampler2D u_cellKfStart; // per-cell, per-checkpoint CSR start index (nCells*K)
uniform int   u_ckTexW;
uniform bool  u_useKF;
uniform int   u_kfIndex;         // active keyframe = largest k with t_k <= scrub
uniform int   u_kfCount;         // K
uniform int   u_kfDepth;         // D field slices (Z) per keyframe
uniform int   u_kfW;             // field slice width / height (texels)
uniform int   u_kfH;
uniform int   u_kfCols;          // atlas columns (slices laid out left-to-right, top-down)
uniform float u_kfRange;         // SDF encode half-range (mm); values clamp to [-range,range]
uniform float u_kfVoxel;         // world size of a field voxel (gradient step)

// three.js injects these into the vertex stage only; declare them here so the
// fragment shader can map the SDF hit point to depth (uniforms are program-wide).
uniform mat4  projectionMatrix;
uniform mat4  modelViewMatrix;

const int HARD_STEPS = 768;      // GLSL needs a constant loop bound; u_maxSteps caps it
const int MAX_PER_CELL = 4096;   // safety bound on moves scanned per grid cell

// Fetch texel i from a 1D-indexed 2D data texture of width w (CSR / move streams).
vec4 fetch(sampler2D tex, int i, int w) { return texelFetch(tex, ivec2(i % w, i / w), 0); }

// Signed distance to one vertical tool (axis = world +Z) swept linearly along
// segment a->b. shape: 0 cylindrical, 1 conical, 2 ballnose, 3 spheroid, 4 snub.
//
// The tool axis is vertical, so we DECOUPLE the XY problem from the Z problem
// (projecting onto the 3D segment collapses the z-slab on plunge moves -> the
// old "solid shaft" bug). XY: distance to the moving disk (a capsule) + the
// t-range whose disk actually covers p.xy. Z: the UNION tip-Z extent over that
// covered range (a point is inside if SOME instance along the move covers its
// height, not just the XY-closest one). Combine as a 2D box SDF in (lateral, z).
float toolDist(vec3 p, vec3 a, vec3 b, vec4 tool) {
  float r = tool.y, len = max(tool.z, 1e-4), snub = tool.w;
  int shape = int(tool.x + 0.5);
  vec3 ba = b - a;

  if (shape == 2 || shape == 3) {
    // ballnose / spheroid: sphere swept = 3D capsule (the bottom is the cut;
    // the shaft above is approximated away). The 3D projection is fine here.
    float den = dot(ba, ba);
    float tt = den > 1e-12 ? clamp(dot(p - a, ba) / den, 0.0, 1.0) : 0.0;
    vec3 c = a + tt * ba; c.z += r;
    return length(p - c) - r;
  }

  // --- XY: signed capsule distance to the segment's XY projection ---
  vec2  segXY = ba.xy, relXY = a.xy - p.xy;      // XY segment direction; a->p offset
  float seg2  = dot(segXY, segXY);               // |segXY|^2
  float txy   = seg2 > 1e-12 ? clamp(-dot(relXY, segXY) / seg2, 0.0, 1.0) : 0.0;
  float distXY = length(p.xy - (a.xy + txy * segXY));
  float dxy = distXY - r;

  // --- Z: union tip-Z extent of the tool over this move at p's XY ---
  float zTipLo, zTop;
  if (abs(ba.z) <= u_featureScale * 0.5) {
    // shallow/horizontal move: tip Z barely varies along it, so the whole-segment
    // range is exact-to-within-the-z-span (cheap; the common cutting-pass case).
    zTipLo = min(a.z, b.z);
    zTop   = max(a.z, b.z) + len;
  } else {
    // steep/plunge: use only the t-range whose moving disk actually covers p.xy
    // (solving seg2 t^2 + 2(relXY.segXY)t + (|relXY|^2 - r^2) = 0) so the swept
    // Z-extent is correct and we don't over-remove the shaft below a ramp.
    float txa, txb;
    if (seg2 > 1e-12) {
      float relDot = dot(relXY, segXY);
      float disc   = relDot * relDot - seg2 * (dot(relXY, relXY) - r * r);
      if (disc > 0.0) {
        float root = sqrt(disc);
        txa = clamp((-relDot - root) / seg2, 0.0, 1.0);
        txb = clamp((-relDot + root) / seg2, 0.0, 1.0);
      } else { txa = txy; txb = txy; }          // never covered -> single point
    } else {                                     // pure plunge (no XY motion)
      bool covered = dot(relXY, relXY) <= r * r;
      txa = covered ? 0.0 : txy;
      txb = covered ? 1.0 : txy;
    }
    float za = a.z + txa * ba.z, zb = a.z + txb * ba.z;  // tip Z at the covered ends
    zTipLo = min(za, zb);
    zTop   = max(za, zb) + len;
  }
  float zg = max(zTipLo - p.z, p.z - zTop);      // <0 inside the swept z-extent

  // cone family: widen the lateral term by the slant near p's height (cylinder:
  // rb==r so Tm==0 -> unchanged). Approximate for ramped cones (untested).
  if (shape == 1 || shape == 4) {
    float rb = (shape == 1) ? 0.0 : snub;
    float Tm = (r - rb) / len;
    float coneR = rb + clamp(p.z - zTipLo, 0.0, len) * Tm;
    dxy = (distXY - coneR) * inversesqrt(1.0 + Tm * Tm);
  }

  vec2 q = vec2(dxy, zg);                          // (lateral, axial) box SDF
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0)));
}

// Analytic outward normal of one swept tool's surface at p: the tool WALL is
// radial (slanted for a cone), the FLOOR/cap is vertical. Selecting by which
// constraint binds gives crisp cut creases (floor<->wall, cut rim) the same way
// boxNormal does for the stock. (Direction up to sign; shade() faces it.)
vec3 toolNormal(vec3 p, vec3 a, vec3 b, vec4 tool) {
  float r = tool.y, len = max(tool.z, 1e-4), snub = tool.w;
  int shape = int(tool.x + 0.5);
  vec3 ba = b - a;
  if (shape == 2 || shape == 3) {                  // ballnose/spheroid: sphere radial
    float den = dot(ba, ba);
    float tt = den > 1e-12 ? clamp(dot(p - a, ba) / den, 0.0, 1.0) : 0.0;
    vec3 c = a + tt * ba; c.z += r;
    return normalize(p - c);
  }
  vec2  segXY = ba.xy, relXY = a.xy - p.xy;
  float seg2  = dot(segXY, segXY);
  float txy   = seg2 > 1e-12 ? clamp(-dot(relXY, segXY) / seg2, 0.0, 1.0) : 0.0;
  vec2  radial = p.xy - (a.xy + txy * segXY);
  float distXY = length(radial);
  float zTipLo = min(a.z, b.z), zTop = max(a.z, b.z) + len;
  float rb = (shape == 1) ? 0.0 : (shape == 4 ? snub : r);
  float Tm = (r - rb) / len;
  float dxy = (distXY - (rb + clamp(p.z - zTipLo, 0.0, len) * Tm)) * inversesqrt(1.0 + Tm * Tm);
  float zg  = max(zTipLo - p.z, p.z - zTop);
  if (dxy >= zg) {                                 // on the (possibly slanted) wall
    vec2 rdir = distXY > 1e-6 ? radial / distXY : vec2(1.0, 0.0);
    return normalize(vec3(rdir, -Tm));
  }
  return vec3(0.0, 0.0, 1.0);                       // on the floor/cap
}

// CSR [start, end) range of move indices for p's grid cell. With keyframes active the
// start jumps PAST the moves already folded into the active keyframe (the per-cell
// checkpoint offset) so we only scan the delta moves; otherwise it's the full cell list.
ivec2 cellRange(vec3 p) {
  ivec3 c = clamp(ivec3(floor((p - u_gridOrigin) / u_gridCell)), ivec3(0), u_gridDims - 1);
  int lin = (c.z * u_gridDims.y + c.y) * u_gridDims.x + c.x;
  int end = int(fetch(u_cellStart, lin + 1, u_startTexW).x + 0.5);
  int start = u_useKF
    ? int(fetch(u_cellKfStart, lin * u_kfCount + u_kfIndex, u_ckTexW).x + 0.5)
    : int(fetch(u_cellStart, lin, u_startTexW).x + 0.5);
  return ivec2(start, end);
}

// One move resolved at the current scrub time: segment endpoints (the end clipped
// to where the tool has actually reached if the move is still in progress), its
// tool params, and whether it has started yet.
struct SweptMove { vec3 a; vec3 b; vec4 tool; bool started; };

SweptMove loadMove(int csrIndex) {
  int base = int(fetch(u_cellMoves, csrIndex, u_cmTexW).x + 0.5) * 3;
  vec4 t0 = fetch(u_moves, base,     u_moveTexW);   // x0,y0,z0,tStart
  vec4 t1 = fetch(u_moves, base + 1, u_moveTexW);   // x1,y1,z1, ±tEnd
  // tEnd is always >= 0, so its sign is a free per-move flag: >= 0 means this move
  // uses the DEFAULT tool (dense index 0), so we skip the 3rd-texel tool-index fetch
  // (the biggest per-move cost). Non-default moves stored -(tEnd+1) -> fetch the index.
  bool defaultTool = t1.w >= 0.0;
  float tEnd = defaultTool ? t1.w : (-t1.w - 1.0);
  SweptMove m;
  m.started = t0.w <= u_scrubAbs;
  m.a = t0.xyz;
  m.b = t1.xyz;
  if (tEnd > u_scrubAbs)                              // in progress -> clip end to the tool
    m.b = mix(m.a, m.b, clamp((u_scrubAbs - t0.w) / max(tEnd - t0.w, 1e-6), 0.0, 1.0));
  m.tool = defaultTool ? u_tools[0]
                       : u_tools[int(fetch(u_moves, base + 2, u_moveTexW).x + 0.5)];
  return m;
}

// Distance to the union of time-gated swept tools near p (negative inside the
// removed region). Only the moves in p's grid cell are tested; the cell list is
// sorted by start time, so we stop at the first move not yet started.
float cutDist(vec3 p) {
  ivec2 range = cellRange(p);
  float d = 1e9;
  for (int k = 0; k < MAX_PER_CELL; k++) {
    int j = range.x + k;
    if (j >= range.y) break;
    SweptMove m = loadMove(j);
    if (!m.started) break;                           // temporal pruning while scrubbing
    d = min(d, toolDist(p, m.a, m.b, m.tool));
  }
  return d;
}

// Nearest cut surface at p: re-scan p's cell for the closest swept tool and return
// ITS analytic wall/floor normal in .xyz AND the min cut distance in .w. Returning
// the distance lets hitNormal reuse it for the box-vs-cut decision instead of a
// separate cutDist() scan. Only run at the hit (once/pixel).
vec4 cutNormal(vec3 p) {
  ivec2 range = cellRange(p);
  float best = 1e9;
  vec3 n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < MAX_PER_CELL; k++) {
    int j = range.x + k;
    if (j >= range.y) break;
    SweptMove m = loadMove(j);
    if (!m.started) break;
    float td = toolDist(p, m.a, m.b, m.tool);
    if (td < best) { best = td; n = toolNormal(p, m.a, m.b, m.tool); }
  }
  return vec4(n, best);
}

float boxSDF(vec3 p) {
  vec3 q = max(u_stockMin - p, p - u_stockMax);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// SDF <-> RGBA8 packing: 16-bit fixed point (R = high byte, G = low byte) over the
// clamped range [-u_kfRange, u_kfRange]. Lets the bulk field live in a universally
// renderable RGBA8 atlas (no float render targets needed).
vec4 kfEncode(float sdf) {
  float s = clamp(sdf / (2.0 * u_kfRange) + 0.5, 0.0, 1.0) * 65535.0;
  float hi = floor(s / 256.0);
  return vec4(hi / 255.0, (s - hi * 256.0) / 255.0, 0.0, 1.0);
}
float kfDecode(vec4 t) {
  float hi = floor(t.r * 255.0 + 0.5), lo = floor(t.g * 255.0 + 0.5);
  return ((hi * 256.0 + lo) / 65535.0 - 0.5) * 2.0 * u_kfRange;
}
// Bilinear-decode one atlas slice at field coords fxy (texels), clamped inside its tile.
float kfSlice(int slice, vec2 fxy) {
  ivec2 org = ivec2((slice % u_kfCols) * u_kfW, (slice / u_kfCols) * u_kfH);
  vec2 q = clamp(fxy, vec2(0.5), vec2(float(u_kfW) - 0.5, float(u_kfH) - 0.5)) - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 fr = q - vec2(i0);
  float d00 = kfDecode(texelFetch(u_keyframe, org + i0, 0));
  float d10 = kfDecode(texelFetch(u_keyframe, org + i0 + ivec2(1, 0), 0));
  float d01 = kfDecode(texelFetch(u_keyframe, org + i0 + ivec2(0, 1), 0));
  float d11 = kfDecode(texelFetch(u_keyframe, org + i0 + ivec2(1, 1), 0));
  return mix(mix(d00, d10, fr.x), mix(d01, d11, fr.x), fr.y);
}
// Trilinear sample of the active keyframe's solid SDF at raw point p (manual: NearestFilter
// atlas + bilinear-in-slice + lerp across the two bracketing Z slices, all within keyframe).
float sampleKF(vec3 p) {
  vec3 f = clamp((p - u_stockMin) / max(u_stockMax - u_stockMin, vec3(1e-6)), 0.0, 1.0);
  vec2 fxy = f.xy * vec2(float(u_kfW), float(u_kfH));
  float fz = f.z * (float(u_kfDepth) - 1.0);
  int z0 = int(floor(fz)), z1 = min(z0 + 1, u_kfDepth - 1);
  int base = u_kfIndex * u_kfDepth;
  return mix(kfSlice(base + z0, fxy), kfSlice(base + z1, fxy), fz - float(z0));
}
// Octahedral unit-normal packing into 2 bytes (atlas B,A) so keyframe surfaces carry the
// real ANALYTIC normal baked in — crisp creases — instead of a smeared field gradient.
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}
vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
// Bilinear-decode the baked normal (B,A channels) of one atlas slice at field coords fxy.
vec3 kfSliceN(int slice, vec2 fxy) {
  ivec2 org = ivec2((slice % u_kfCols) * u_kfW, (slice / u_kfCols) * u_kfH);
  vec2 q = clamp(fxy, vec2(0.5), vec2(float(u_kfW) - 0.5, float(u_kfH) - 0.5)) - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 fr = q - vec2(i0);
  vec3 n00 = octDecode(texelFetch(u_keyframe, org + i0, 0).ba);
  vec3 n10 = octDecode(texelFetch(u_keyframe, org + i0 + ivec2(1, 0), 0).ba);
  vec3 n01 = octDecode(texelFetch(u_keyframe, org + i0 + ivec2(0, 1), 0).ba);
  vec3 n11 = octDecode(texelFetch(u_keyframe, org + i0 + ivec2(1, 1), 0).ba);
  return mix(mix(n00, n10, fr.x), mix(n01, n11, fr.x), fr.y);
}
// Keyframe-surface normal = the baked analytic normal (crisp), sampled like sampleKF.
vec3 kfNormal(vec3 p) {
  vec3 f = clamp((p - u_stockMin) / max(u_stockMax - u_stockMin, vec3(1e-6)), 0.0, 1.0);
  vec2 fxy = f.xy * vec2(float(u_kfW), float(u_kfH));
  float fz = f.z * (float(u_kfDepth) - 1.0);
  int z0 = int(floor(fz)), z1 = min(z0 + 1, u_kfDepth - 1);
  int base = u_kfIndex * u_kfDepth;
  return normalize(mix(kfSliceN(base + z0, fxy), kfSliceN(base + z1, fxy), fz - float(z0)));
}

// Cut workpiece SDF: inside stock AND outside every cut. <0 == solid. With keyframes
// active, the stock + all cuts up to the active checkpoint come from the field sample
// and cutDist scans only the delta moves since then (see cellRange).
float sceneSDF(vec3 p) {
  return u_useKF ? max(sampleKF(p), -cutDist(p)) : max(boxSDF(p), -cutDist(p));
}

// Analytic outward normal of the stock box face nearest p (exact, sharp corners).
vec3 boxNormal(vec3 p) {
  vec3 c = (u_stockMin + u_stockMax) * 0.5;
  vec3 d = (p - c) / max((u_stockMax - u_stockMin) * 0.5, vec3(1e-6));
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) return vec3(sign(d.x), 0.0, 0.0);
  if (a.y >= a.z)               return vec3(0.0, sign(d.y), 0.0);
  return vec3(0.0, 0.0, sign(d.z));
}

// Normal at a hit: fully ANALYTIC (no finite differences, so no rounded-fillet
// creases). Stock face where the box CLEARLY dominates, else the active tool's
// wall/floor normal -> crisp edges on both the stock AND the cut geometry. The
// small bias breaks the tie on a thin remaining floor (a cut that grazed the
// bottom): there boxSDF ~= -cutDist and the two normals are OPPOSITE (bottom-down
// vs floor-up), so an unbiased pick flickers per-pixel -> haze. Bias toward the
// cut floor (what you actually see from above) so it renders consistently.
vec3 hitNormal(vec3 p) {
  vec4 cn = cutNormal(p);   // .xyz = cut normal, .w = nearest (delta) cut distance
  // base = the box (analytic) or the keyframe field, whichever this mode uses. If it
  // binds over the delta cut, use its normal (box face / field gradient); else the
  // active tool's analytic wall/floor normal.
  float base = u_useKF ? sampleKF(p) : boxSDF(p);
  if (base > -cn.w + u_featureScale * 0.03) return u_useKF ? kfNormal(p) : boxNormal(p);
  return cn.xyz;
}

vec2 hitBox(vec3 ro, vec3 rd, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (lo - ro) * inv;
  vec3 t1 = (hi - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// Cheap SDF ambient occlusion: march a few steps along the normal; where the
// field stays below the marched distance the point is in a pocket/groove ->
// darken. Gives the cut channels real depth (the "solid" look).
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float hd = u_featureScale * (0.3 + 0.9 * float(i));  // probe at the cut scale
    float d = sceneSDF(p + n * hd);
    occ += (hd - d) * sca;
    sca *= 0.8;
  }
  // softer than a full darkening, floored so cut bottoms never go black
  return clamp(1.0 - 0.8 * occ / max(u_featureScale, 1e-4), 0.35, 1.0);
}

vec3 shade(vec3 n, vec3 rd, float ao) {
  if (dot(n, rd) > 0.0) n = -n;
  vec3 V = -rd;
  vec3 L1 = normalize(u_lightDir);
  vec3 L2 = normalize(vec3(-0.5, -0.3, 0.5));
  float d1 = max(dot(n, L1), 0.0);
  float d2 = max(dot(n, L2), 0.0);
  float head = max(dot(n, V), 0.0);             // camera headlight: lights whatever
                                                // you look INTO -> cut floors & corners

  // diffuse: ambient (AO-modulated) + key/fill (gently AO-gated) + a headlight that
  // is NOT killed by AO, so deep cut bottoms/corners you face still read.
  float amb  = 0.26 + 0.14 * ao;
  float diff = amb + (d1 * 0.5 + d2 * 0.22) * (0.45 + 0.55 * ao) + head * 0.32;

  // specular sheen so walls + bottom corners look like shiny metal: a key-light
  // Blinn highlight (some AO) PLUS a view-aligned sheen that reaches into the cuts.
  vec3 H = normalize(L1 + V);
  float spec = pow(max(dot(n, H), 0.0), 38.0) * 0.6 * (0.4 + 0.6 * ao)
             + pow(head, 22.0) * 0.30;
  return u_baseColor * diff + vec3(spec);
}

#ifdef BAKE
// Bake pass: evaluate the analytic solid SDF at this voxel's center (XY from the
// fragment, Z from the layer) and store it into the keyframe field. The bake material
// sets u_useKF=false + u_scrubAbs=t_k, so cutDist scans ALL moves up to the checkpoint.
void main() {
  vec2 f = (gl_FragCoord.xy - u_tileOrigin) / u_bakeRes;  // [0,1] within this slice's tile
  float z = (float(u_bakeLayer) + 0.5) / float(u_kfDepth);
  vec3 p = mix(u_stockMin, u_stockMax, vec3(f, z));
  // ONE cell scan: cutNormal returns the nearest cut's analytic normal (.xyz) AND its
  // distance (.w), so we get both the SDF and a crisp baked normal without a 2nd scan.
  vec4 cn = cutNormal(p);
  float bx = boxSDF(p);
  vec3 nrm = (bx > -cn.w + u_featureScale * 0.03) ? boxNormal(p) : cn.xyz;  // = hitNormal logic
  vec4 d = kfEncode(max(bx, -cn.w));    // R,G = 16-bit distance
  fragColor = vec4(d.r, d.g, octEncode(nrm));  // B,A = baked analytic normal
}
#else
void main() {
  vec3 ro = vCamLocal + u_stockCenter;             // camera, raw coords
  vec3 rd = normalize(vLocal - vCamLocal);         // ray dir (translation free)

  vec2 nf = hitBox(ro, rd, u_stockMin, u_stockMax);
  float tn = max(nf.x, 0.0), tf = nf.y;
  if (tn > tf) discard;

  // Sphere-trace the solid ERODED by u_tolerance (render the sceneSDF == -tolerance
  // isosurface) so sub-tolerance slivers — e.g. a cut that went almost-but-not-quite
  // through — snap to a clean breakthrough instead of shimmering. Big steps through
  // open air / cut voids; a generous cap bounds the worst case. When a step crosses
  // the surface we LINEAR-REFINE the hit (the min step is far coarser than the
  // tolerance shell, so we'd otherwise overshoot a thin wall).
  float maxStep = u_gridCell * 6.0;
  float t = tn + 1e-4;
  float dPrev = 1e9, tPrev = t, dPrev2 = 1e9, tPrev2 = t;
  float minD = 1e9, tClose = t;          // closest approach -> analytic edge coverage
  for (int i = 0; i < HARD_STEPS; i++) {
    if (i >= u_maxSteps || t > tf) break;
    vec3 p = ro + rd * t;
    float d = sceneSDF(p) + u_tolerance;
    if (d < minD) { minD = d; tClose = t; }
    if (d < 1e-4) {
      float th = (dPrev < 1e9) ? mix(tPrev, t, clamp(dPrev / max(dPrev - d, 1e-6), 0.0, 1.0)) : t;
      p = ro + rd * th;
      vec3 n = hitNormal(p);
      float ao = calcAO(p, n);
      fragColor = vec4(shade(n, rd, ao), 1.0);
      // Write the true surface depth so the toolpath + tool marker get occluded by
      // material in front. The raymarch is in RAW coords, so object space (what
      // modelViewMatrix expects) is p - u_stockCenter.
      vec4 clip = projectionMatrix * modelViewMatrix * vec4(p - u_stockCenter, 1.0);
      gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
      return;
    }
    // Parabolic refine of the closest approach: at a local min (dPrev below both
    // neighbours) the TRUE closest distance is the parabola vertex, not the coarse
    // sample -> smooth coverage instead of sampled-min jitter (the residual
    // shallow-angle serration). Newton form; vertex clamped to the bracket so
    // unequal step spacing can't overshoot.
    if (dPrev < d && dPrev < dPrev2 && dPrev2 < 1e8) {
      float slopeL = (dPrev - dPrev2) / max(tPrev - tPrev2, 1e-9);   // d slope, left pair
      float slopeR = (d - dPrev) / max(t - tPrev, 1e-9);             // d slope, right pair
      float curv   = (slopeR - slopeL) / max(t - tPrev2, 1e-9);      // 2nd difference
      if (curv > 1e-9) {                                             // convex -> real min
        float tVtx = clamp((tPrev2 + tPrev) * 0.5 - slopeL / (2.0 * curv), tPrev2, t);
        float dVtx = dPrev2 + slopeL * (tVtx - tPrev2) + curv * (tVtx - tPrev2) * (tVtx - tPrev);
        if (dVtx < minD) { minD = max(dVtx, 0.0); tClose = tVtx; }
      }
    }
    dPrev2 = dPrev; tPrev2 = tPrev; dPrev = d; tPrev = t;
    // Near the stock BOTTOM (the breakthrough zone) step at the erosion scale so a
    // near-zero-thickness floor isn't stepped over by some rays and sampled by
    // others (the salt-and-pepper "haze" through almost-through cuts). Everywhere
    // else keep coarse steps so dense relief stays fast.
    float minStep = (p.z < u_stockMin.z + u_featureScale * 0.6)
      ? u_tolerance * 2.0 : u_featureScale * 0.25;
    t += clamp(d * 0.9, minStep, maxStep);
  }

  // MISS. Analytic silhouette anti-aliasing: if the ray grazed a surface within ~one
  // pixel (minD < the pixel's world width at that depth), this is a silhouette EDGE.
  // Shade the closest-approach point and feather it over the known background by a
  // distance-derived coverage -> a clean ~1px ramp instead of a jagged hard miss.
  // One code path crisps EVERY silhouette: stock edges, cut rims, knife-edge ridges.
  float pxSpan = tClose * u_pixelWorld;
  if (minD < pxSpan) {
    vec3 pc = ro + rd * tClose;
    vec3 shaded = shade(hitNormal(pc), rd, 1.0);   // fixed AO: blended into bg anyway
    float coverage = 1.0 - smoothstep(0.0, pxSpan, minD);
    fragColor = vec4(mix(u_clearColor, shaded, coverage), 1.0);
    // keep the box-backface depth (NOT the surface) so the toolpath/marker still show
    // through the mostly-transparent silhouette band instead of being hard-occluded
    gl_FragDepth = gl_FragCoord.z;
    return;
  }
  discard;
}
#endif
`;

// Fullscreen-triangle vertex shader for the keyframe bake pass (clip-space quad).
export const bakeVertexShader = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
