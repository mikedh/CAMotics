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

in vec3 vLocal;
in vec3 vCamLocal;
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

// three.js injects these into the vertex stage only; declare them here so the
// fragment shader can map the SDF hit point to depth (uniforms are program-wide).
uniform mat4  projectionMatrix;
uniform mat4  modelViewMatrix;

const int   HARD_STEPS = 768;
const int   MAX_PER_CELL = 4096;
const float SURF = 0.0;

vec4 fetch(sampler2D t, int i, int w) { return texelFetch(t, ivec2(i % w, i / w), 0); }

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
  vec2 d = ba.xy, e = a.xy - p.xy;
  float dd = dot(d, d);
  float txy = dd > 1e-12 ? clamp(-dot(e, d) / dd, 0.0, 1.0) : 0.0;
  float distXY = length(p.xy - (a.xy + txy * d));
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
    // (solving dd t^2 + 2(e.d)t + (e.e-r^2)=0) so the swept Z-extent is correct and
    // we don't over-remove the shaft below a ramp. C.z is linear in t.
    float txa, txb;
    if (dd > 1e-12) {
      float ed = dot(e, d), disc = ed * ed - dd * (dot(e, e) - r * r);
      if (disc > 0.0) {
        float s = sqrt(disc);
        txa = clamp((-ed - s) / dd, 0.0, 1.0);
        txb = clamp((-ed + s) / dd, 0.0, 1.0);
      } else { txa = txy; txb = txy; }          // never covered -> single point
    } else {                                     // pure plunge (no XY motion)
      bool cov = dot(e, e) <= r * r;
      txa = cov ? 0.0 : txy;
      txb = cov ? 1.0 : txy;
    }
    float za = a.z + txa * ba.z, zb = a.z + txb * ba.z;
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
  vec2 d = ba.xy, e = a.xy - p.xy;
  float dd = dot(d, d);
  float txy = dd > 1e-12 ? clamp(-dot(e, d) / dd, 0.0, 1.0) : 0.0;
  vec2 radial = p.xy - (a.xy + txy * d);
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

// Distance to the union of time-gated swept tools near p (negative inside the
// removed region). Only the moves binned into p's grid cell are tested.
float cutDist(vec3 p) {
  ivec3 c = clamp(ivec3(floor((p - u_gridOrigin) / u_gridCell)), ivec3(0), u_gridDims - 1);
  int lin   = (c.z * u_gridDims.y + c.y) * u_gridDims.x + c.x;
  int start = int(fetch(u_cellStart, lin,     u_startTexW).x + 0.5);
  int end   = int(fetch(u_cellStart, lin + 1, u_startTexW).x + 0.5);

  float d = 1e9;
  for (int k = 0; k < MAX_PER_CELL; k++) {
    int j = start + k;
    if (j >= end) break;
    int mi = int(fetch(u_cellMoves, j, u_cmTexW).x + 0.5);
    int base = mi * 3;
    vec4 m0 = fetch(u_moves, base,     u_moveTexW);   // x0,y0,z0,tStart
    vec4 m1 = fetch(u_moves, base + 1, u_moveTexW);   // x1,y1,z1,tEnd
    float tStart = m0.w, tEnd = m1.w;
    // cell moves are sorted by tStart -> once one hasn't started, none after it
    // have either, so stop scanning this cell (temporal pruning while scrubbing).
    if (tStart > u_scrubAbs) break;
    vec3 a = m0.xyz, b = m1.xyz;
    if (tEnd > u_scrubAbs) {                          // in progress -> clip to tool
      float f = clamp((u_scrubAbs - tStart) / max(tEnd - tStart, 1e-6), 0.0, 1.0);
      b = a + (b - a) * f;
    }
    int ti = int(fetch(u_moves, base + 2, u_moveTexW).x + 0.5);
    d = min(d, toolDist(p, a, b, u_tools[ti]));
  }
  return d;
}

// Analytic normal of the nearest cut surface at p: re-scan p's cell for the
// closest swept tool and return ITS analytic wall/floor normal. Only run at the
// hit (once/pixel), so the extra cell scan is cheap.
vec3 cutNormal(vec3 p) {
  ivec3 c = clamp(ivec3(floor((p - u_gridOrigin) / u_gridCell)), ivec3(0), u_gridDims - 1);
  int lin   = (c.z * u_gridDims.y + c.y) * u_gridDims.x + c.x;
  int start = int(fetch(u_cellStart, lin,     u_startTexW).x + 0.5);
  int end   = int(fetch(u_cellStart, lin + 1, u_startTexW).x + 0.5);
  float best = 1e9;
  vec3 n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < MAX_PER_CELL; k++) {
    int j = start + k;
    if (j >= end) break;
    int mi = int(fetch(u_cellMoves, j, u_cmTexW).x + 0.5);
    int base = mi * 3;
    vec4 m0 = fetch(u_moves, base,     u_moveTexW);
    vec4 m1 = fetch(u_moves, base + 1, u_moveTexW);
    float tStart = m0.w, tEnd = m1.w;
    if (tStart > u_scrubAbs) break;
    vec3 a = m0.xyz, b = m1.xyz;
    if (tEnd > u_scrubAbs) {
      float f = clamp((u_scrubAbs - tStart) / max(tEnd - tStart, 1e-6), 0.0, 1.0);
      b = a + (b - a) * f;
    }
    vec4 tool = u_tools[int(fetch(u_moves, base + 2, u_moveTexW).x + 0.5)];
    float td = toolDist(p, a, b, tool);
    if (td < best) { best = td; n = toolNormal(p, a, b, tool); }
  }
  return n;
}

float boxSDF(vec3 p) {
  vec3 q = max(u_stockMin - p, p - u_stockMax);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Cut workpiece SDF: inside stock AND outside every cut. <0 == solid.
float sceneSDF(vec3 p) { return max(boxSDF(p), -cutDist(p)); }

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
  return (boxSDF(p) > -cutDist(p) + u_featureScale * 0.03) ? boxNormal(p) : cutNormal(p);
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
  float dPrev = 1e9, tPrev = t;
  for (int i = 0; i < HARD_STEPS; i++) {
    if (i >= u_maxSteps || t > tf) break;
    vec3 p = ro + rd * t;
    float d = sceneSDF(p) + u_tolerance;
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
    dPrev = d; tPrev = t;
    // Near the stock BOTTOM (the breakthrough zone) step at the erosion scale so a
    // near-zero-thickness floor isn't stepped over by some rays and sampled by
    // others (the salt-and-pepper "haze" through almost-through cuts). Everywhere
    // else keep coarse steps so dense relief stays fast.
    float minStep = (p.z < u_stockMin.z + u_featureScale * 0.6)
      ? u_tolerance * 2.0 : u_featureScale * 0.25;
    t += clamp(d * 0.9, minStep, maxStep);
  }
  discard;
}
`;
