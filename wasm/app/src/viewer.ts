// ---------------------------------------------------------------------------
// Imperative three.js viewer controller. Ported from the vanilla app.js.
// The Preact UI drives this class; it owns the renderer/scene/camera/controls,
// builds toolpath lines + tool marker + surface mesh, recenters the world,
// fits the camera, and advances a scrub timeline.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ToolPath, Move, SimResult, CutData } from './camotics';
import { cutVertexShader, cutFragmentShader, bakeVertexShader, MAX_TOOLS } from './cutShader';
import { buildKeyframes, type KeyframeMeta } from './keyframes';

export interface DashState {
  time: number;
  tool: number;
  diameter: number | null;
  feed: number;
  speed: number;
  pos: [number, number, number];
  activeMoveIndex: number;
}

export interface SceneInfo {
  lineSegments: number;
  lineVertices: number;
  triangles: number;
  hasSurface: boolean;
  hasCut: boolean;
  hasToolMarker: boolean;
  children: number;
}

const CLEAR_COLOR = new THREE.Color(0x1a1d21);

// Toolpath line material: reveals each segment only once the timeline reaches it
// (per-vertex aTime vs a uTime uniform). Scrubbing draws the path up to the tool.
const LINE_VERT = `
  attribute float aTime;
  varying float vTime;
  void main() {
    vTime = aTime;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z -= 4e-4 * gl_Position.w;  // nudge toward camera so the path at the
                                            // groove floor cleanly wins the z-fight but
                                            // is still occluded where behind material
  }
`;
const LINE_FRAG = `
  precision mediump float;
  uniform float uTime;
  uniform vec3 uColor;
  varying float vTime;
  void main() { if (vTime > uTime) discard; gl_FragColor = vec4(uColor, 1.0); }
`;

export class Viewer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private world: THREE.Group;

  // state
  private toolpath: ToolPath | null = null;
  private moves: Move[] = [];
  private starts: number[] = [];
  private _duration = 0;
  private toolMarker: THREE.Mesh | null = null;
  private surfaceMesh: THREE.Mesh | null = null;
  private cutMesh: THREE.Mesh | null = null;
  private cutMat: THREE.ShaderMaterial | null = null;
  private cutTextures: THREE.Texture[] = [];
  // keyframe (checkpoint) fields for the keyframe+delta SDF
  private kf: KeyframeMeta | null = null;
  private kfRT: THREE.WebGLRenderTarget | null = null;
  private kfStartTex: THREE.DataTexture | null = null;
  private lineMaterials: THREE.ShaderMaterial[] = [];
  private pathObjects: THREE.Object3D[] = []; // toolpath lines only (marker is separate)
  private lastTris = 0;

  private showGeom = true;
  private showPath = true;
  private showTool = true;
  private geomColor = new THREE.Color(0x9aa0a6); // cut/mesh material color (recolorable)

  private playing = false;
  private playbackSpeed = 1; // timeline seconds advanced per real second
  private currentTime = 0;
  private lastFrameT = 0;
  private lastState: DashState | null = null;
  private rafId = 0;

  // click-vs-drag: a short, near-stationary press is a click (OrbitControls eats drags)
  private pressX = 0;
  private pressY = 0;
  private pressT = 0;
  private pressValid = false;

  // perf-aware rendering: render only when the scene changed (dirty); while interacting
  // (orbit/scrub/play) a closed-loop dynamic-resolution controller (DRS) measures the
  // actual frame period and trades internal resolution to hold the FPS target — then
  // settles to a crisp frame after a short idle. The raymarch is expensive per pixel.
  private dirty = true;
  private interacting = false;
  private lastInteractT = 0;
  private readonly IDLE_RESTORE_MS = 280;
  private renderCount = 0;

  // Resolution split: the canvas ALWAYS renders at settlePR, so the toolpath + tool
  // marker are full-res + crisp at all times. Only the expensive SDF is downscaled
  // while interacting — it's drawn into a SDF_SCALE-size target and composited under
  // the full-res path (with its depth, so occlusion is preserved). No control loop:
  // browser frame time isn't measurable without GPU timer queries (async render; no
  // Spectre-safe timers in Firefox), so a loop just limit-cycles. settlePR is a
  // per-scene quality ceiling; SDF_SCALE is a fixed, recognizable floor.
  private settlePR = 2;
  private sdfScale = 0.5; // interaction SDF downscale; raised when keyframes make it cheap
  private frameEMA = 16; // smoothed frame period — logging only, never a control input
  private lastRenderT = 0;
  // half-res SDF target + a fullscreen composite that re-emits its color AND depth
  private sdfRT: THREE.WebGLRenderTarget | null = null;
  private blitScene = new THREE.Scene();
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blitMat: THREE.ShaderMaterial | null = null;
  private readonly SDF_LAYER = 1;

  // periodic perf heartbeat (console, every 10s) + per-scene density stats
  private sceneMoves = 0;
  private sceneTools = 0;
  private cellMax = 0; // worst-case moves/cell (the SDF cost driver)
  private cellAvg = 0;
  private renderCountAtLog = 0;
  private perfTimer = 0;

  // authoritative GPU frame time via EXT_disjoint_timer_query_webgl2 (when available)
  private gl: WebGL2RenderingContext | null = null;
  private timerExt: any = null;
  private queryPool: WebGLQuery[] = [];
  private queryPending: WebGLQuery[] = [];
  private gpuMsEMA = 0;

  // Callbacks the UI subscribes to.
  onState: ((s: DashState) => void) | null = null;
  onDuration: ((d: number) => void) | null = null;
  onPlayingChange: ((playing: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,                  // AAs the lines + box edges in the 1x interaction
                                        // frame (the 2x settled frame supersamples anyway)
      powerPreference: 'high-performance', // ask for the discrete GPU on dual-GPU laptops
      stencil: false,                   // we never use stencil — skip the buffer
    });
    // Settled frames supersample at 2x: MSAA doesn't antialias the per-fragment
    // raymarch isosurface, so the crisp analytic edges alias without it. Render-on-
    // demand makes this a one-off cost; interaction still drops to half this.
    renderer.setPixelRatio(this.settlePR);
    renderer.setClearColor(CLEAR_COLOR, 1);
    this.renderer = renderer;

    // GPU introspection: identity + a TIME_ELAPSED timer query for true GPU frame ms
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rend = dbg ? gl.getParameter((dbg as any).UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vend = dbg ? gl.getParameter((dbg as any).UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    console.log(
      `[gpu] ${rend} | ${vend} | WebGL2 | timer-query ${this.timerExt ? 'yes' : 'no'} | ` +
        `maxTex ${gl.getParameter(gl.MAX_TEXTURE_SIZE)} | dpr ${window.devicePixelRatio}`
    );

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.layers.enable(this.SDF_LAYER); // see both the SDF (layer 1) and path (0)

    // fullscreen composite: blit the half-res SDF target's color + write its depth so
    // the full-res toolpath occludes against the (upscaled) cut surface correctly.
    this.blitMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: true,
      uniforms: { tColor: { value: null }, tDepth: { value: null } },
      vertexShader: `out vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; in vec2 vUv; out vec4 oCol;
        uniform sampler2D tColor; uniform sampler2D tDepth;
        void main(){ oCol = texture(tColor, vUv); gl_FragDepth = texture(tDepth, vUv).r; }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
    quad.frustumCulled = false;
    this.blitScene.add(quad);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25;
    this.controls.rotateSpeed = 1.0;
    // camera moved (user drag or damping inertia) -> needs a (low-res) redraw
    this.controls.addEventListener('change', () => this.markInteracting());

    // click detection lives alongside OrbitControls (no preventDefault, so it never
    // interferes): a left press that barely moves and releases quickly is a click.
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pressValid = e.button === 0;
      this.pressX = e.clientX;
      this.pressY = e.clientY;
      this.pressT = performance.now();
    });
    el.addEventListener('pointerup', (e) => {
      if (!this.pressValid || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY);
      if (moved > 5 || performance.now() - this.pressT > 400) return; // a drag
      this.togglePlay(); // a plain click anywhere = play/pause (color is the side swatch)
    });

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(1, 1, 2);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir2.position.set(-1, -0.5, 1);
    this.scene.add(dir2);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.resize();
    this.animate = this.animate.bind(this);
    this.rafId = requestAnimationFrame(this.animate);
    this.perfTimer = window.setInterval(() => this.logPerf(), 10000);
  }

  get duration() {
    return this._duration;
  }
  get moveCount() {
    return this.moves.length;
  }

  // --- lifecycle ------------------------------------------------------------
  resize() {
    const canvas = this.canvas;
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updatePixelWorld();
    this.markDirty();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    clearInterval(this.perfTimer);
    this.sdfRT?.dispose();
    this.clearWorld();
    this.controls.dispose();
    this.renderer.dispose();
  }

  // --- geometry helpers -----------------------------------------------------
  private boundsCenterSize(bounds: ToolPath['bounds']) {
    const mn = new THREE.Vector3().fromArray(bounds.min);
    const mx = new THREE.Vector3().fromArray(bounds.max);
    return { center: mn.clone().add(mx).multiplyScalar(0.5), size: mx.clone().sub(mn) };
  }

  private fitCamera(bounds: ToolPath['bounds']) {
    const { size } = this.boundsCenterSize(bounds);
    const radius = Math.max(size.length() * 0.5, 1);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 180 / 2);
    this.camera.position.set(dist * 0.8, -dist * 0.9, dist * 0.7);
    // tight near/far (~600:1, not 10000:1) so the depth buffer has the precision
    // the gl_FragDepth occlusion needs — wide ranges z-fight on thin walls. Still
    // roomy enough to dolly in/out with OrbitControls.
    this.camera.near = radius / 40;
    this.camera.far = radius * 16;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private findActiveMove(t: number): number {
    const moves = this.moves;
    if (moves.length === 0) return 0;
    if (t <= this.starts[0]) return 0;
    if (t >= moves[moves.length - 1].tEnd) return moves.length - 1;
    let lo = 0,
      hi = moves.length - 1,
      ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.starts[m] <= t) {
        ans = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return ans;
  }

  private lerpPos(move: Move, t: number): [number, number, number] {
    const span = move.tEnd - move.tStart;
    let f = span > 1e-9 ? (t - move.tStart) / span : 0;
    f = Math.max(0, Math.min(1, f));
    return [
      move.start[0] + (move.end[0] - move.start[0]) * f,
      move.start[1] + (move.end[1] - move.start[1]) * f,
      move.start[2] + (move.end[2] - move.start[2]) * f,
    ];
  }

  // --- scene builders -------------------------------------------------------
  private clearWorld() {
    for (let i = this.world.children.length - 1; i >= 0; i--) {
      const c = this.world.children[i] as THREE.Mesh;
      this.world.remove(c);
      if (c.geometry) c.geometry.dispose();
      const mat = c.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) Array.isArray(mat) ? mat.forEach((m) => m.dispose()) : mat.dispose();
    }
    // data textures aren't released by material.dispose() — do it explicitly
    for (const t of this.cutTextures) t.dispose();
    this.cutTextures = [];
    this.disposeKeyframes();
    this.toolMarker = null;
    this.surfaceMesh = null;
    this.cutMesh = null;
    this.cutMat = null;
    this.lineMaterials = [];
    this.pathObjects = [];
  }

  private buildSurfaceMesh(positions: Float32Array, normals: Float32Array) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals && normals.length === positions.length)
      g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    else g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: this.geomColor.clone(),
      metalness: 0.12,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    this.surfaceMesh = new THREE.Mesh(g, mat);
    this.world.add(this.surfaceMesh);
  }

  private buildToolpathLines() {
    const cutPts: number[] = [], cutT: number[] = [];
    const rapidPts: number[] = [], rapidT: number[] = [];
    for (const m of this.moves) {
      const pts = m.type === 'rapid' ? rapidPts : cutPts;
      const ts = m.type === 'rapid' ? rapidT : cutT;
      pts.push(m.start[0], m.start[1], m.start[2], m.end[0], m.end[1], m.end[2]);
      // per-vertex time so the fragment shader interpolates and ends the drawn
      // line exactly at the tool (not snapped to whole segments)
      ts.push(m.tStart, m.tEnd);
    }
    const makeLine = (pts: number[], times: number[], color: number) => {
      if (!pts.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.setAttribute('aTime', new THREE.Float32BufferAttribute(times, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: this._duration }, uColor: { value: new THREE.Color(color) } },
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        depthTest: true, // occluded by the cut surface (which now writes gl_FragDepth)
        depthWrite: false,
      });
      const seg = new THREE.LineSegments(g, mat);
      this.world.add(seg);
      this.pathObjects.push(seg);
      this.lineMaterials.push(mat);
    };
    makeLine(cutPts, cutT, 0x38d96b); // cuts green
    makeLine(rapidPts, rapidT, 0xff5c5c); // rapids solid red
  }

  private buildToolMarker() {
    const tp = this.toolpath!;
    // Use the first move that actually has a defined tool — many programs open with
    // a tool-less rapid (tool = -1), and falling back to the Ø3 default made the
    // marker render wider than the real cut (e.g. the heart example).
    const m0 = this.moves.find((m) => tp.tools[String(m.tool)]) || this.moves[0];
    const toolDef = tp.tools[String(m0.tool)] || { diameter: 3, length: 10 };
    const r = Math.max(toolDef.diameter / 2, 0.3);
    const len = Math.max(toolDef.length, r * 2);
    const geo = new THREE.CylinderGeometry(r, r, len, 24);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, len / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffc04d,
      metalness: 0.6,
      roughness: 0.3,
      emissive: 0x332200,
    });
    this.toolMarker = new THREE.Mesh(geo, mat);
    this.world.add(this.toolMarker);
    // NOT in pathObjects: the tool marker has its own visibility toggle (showTool)
  }

  private applyToggles() {
    if (this.surfaceMesh) this.surfaceMesh.visible = this.showGeom;
    if (this.cutMesh) this.cutMesh.visible = this.showGeom;
    for (const o of this.pathObjects) o.visible = this.showPath; // toolpath lines
    if (this.toolMarker) this.toolMarker.visible = this.showTool; // tool marker
    this.markDirty();
  }

  // --- analytic swept-volume SDF (squirm-free, crisp tool walls) -------------
  private floatTex(
    data: Float32Array,
    channels: 1 | 4,
    width: number
  ): THREE.DataTexture {
    const texels = data.length / channels;
    const height = Math.max(1, Math.ceil(texels / width));
    const padded = new Float32Array(width * height * channels);
    padded.set(data);
    const fmt = channels === 4 ? THREE.RGBAFormat : THREE.RedFormat;
    const tex = new THREE.DataTexture(padded, width, height, fmt, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.cutTextures.push(tex);
    return tex;
  }

  private buildCut(cut: CutData) {
    const MW = 1024; // move texture width (texels; 3 texels/move)
    const CW = 2048; // CSR texture width

    // moves -> 3 RGBA texels each: (x0,y0,z0,tStart)(x1,y1,z1,tEnd)(toolIdx,0,0,0)
    const nM = cut.nMoves;
    const packed = new Float32Array(nM * 12);
    const m = cut.moves;
    for (let i = 0; i < nM; i++) {
      const s = i * 9,
        d = i * 12;
      packed[d] = m[s];
      packed[d + 1] = m[s + 1];
      packed[d + 2] = m[s + 2];
      packed[d + 3] = m[s + 6]; // tStart
      packed[d + 4] = m[s + 3];
      packed[d + 5] = m[s + 4];
      packed[d + 6] = m[s + 5];
      // tEnd carries a free per-move flag in its sign: a move on the default tool
      // (dense index 0) stores +tEnd so the shader can skip the tool-index fetch;
      // others store -(tEnd+1) (the +1 keeps it strictly <= -1 even when tEnd==0).
      const tEnd = m[s + 7],
        toolIdx = m[s + 8];
      packed[d + 7] = toolIdx === 0 ? tEnd : -(tEnd + 1.0);
      packed[d + 8] = toolIdx; // read only for non-default moves
    }
    const moveTex = this.floatTex(packed, 4, MW);
    const startTex = this.floatTex(Float32Array.from(cut.cellStart), 1, CW);
    const movesTex = this.floatTex(Float32Array.from(cut.cellMoves), 1, CW);

    const tools: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_TOOLS; i++)
      tools.push(
        i < cut.nTools
          ? new THREE.Vector4(
              cut.tools[i * 4],
              cut.tools[i * 4 + 1],
              cut.tools[i * 4 + 2],
              cut.tools[i * 4 + 3]
            )
          : new THREE.Vector4()
      );

    const mn = new THREE.Vector3().fromArray(cut.stockMin);
    const mx = new THREE.Vector3().fromArray(cut.stockMax);
    const size = mx.clone().sub(mn);
    const center = mn.clone().add(mx).multiplyScalar(0.5);
    const diag = size.length();

    // Feature scale ~ the smallest tool radius: drives normal/AO/min-step detail
    // independently of the (part-sized) grid cell, so fine cuts on a big plate
    // get crisp walls. Floor it so it can't collapse to ~0.
    let minRadius = Infinity;
    for (let i = 0; i < cut.nTools; i++) minRadius = Math.min(minRadius, cut.tools[i * 4 + 1]);
    const featureScale = Math.max(
      isFinite(minRadius) && minRadius > 0 ? minRadius : cut.gridCell,
      diag * 1e-3
    );

    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        u_moves: { value: moveTex },
        u_cellStart: { value: startTex },
        u_cellMoves: { value: movesTex },
        u_moveTexW: { value: MW },
        u_startTexW: { value: CW },
        u_cmTexW: { value: CW },
        u_tools: { value: tools },
        u_stockCenter: { value: center },
        u_stockMin: { value: mn },
        u_stockMax: { value: mx },
        u_gridOrigin: { value: new THREE.Vector3().fromArray(cut.gridOrigin) },
        u_gridCell: { value: cut.gridCell },
        u_featureScale: { value: featureScale },
        u_gridDims: {
          value: new THREE.Vector3(cut.gridDims[0], cut.gridDims[1], cut.gridDims[2]),
        },
        u_scrubAbs: { value: cut.duration },
        // erode by ~half a thou (0.001") so a cut that goes almost-but-not-quite
        // through snaps to a clean breakthrough instead of shimmering
        u_tolerance: { value: 0.0127 },
        u_maxSteps: { value: Math.min(768, Math.ceil((diag / cut.gridCell) * 4) + 128) },
        u_baseColor: { value: this.geomColor.clone() },
        u_lightDir: { value: new THREE.Vector3(0.4, 0.6, 0.9).normalize() },
        u_pixelWorld: { value: 0 }, // set by updatePixelWorld() below (px footprint)
        u_clearColor: { value: CLEAR_COLOR.clone() },
        // keyframe (checkpoint) uniforms — default OFF; buildKeyframeFields turns them on
        u_keyframe: { value: null },
        u_cellKfStart: { value: null },
        u_ckTexW: { value: 1 },
        u_useKF: { value: false },
        u_kfIndex: { value: 0 },
        u_kfCount: { value: 1 },
        u_kfDepth: { value: 1 },
        u_kfW: { value: 1 },
        u_kfH: { value: 1 },
        u_kfCols: { value: 1 },
        u_kfRange: { value: 1 },
        u_kfVoxel: { value: featureScale },
      },
      vertexShader: cutVertexShader,
      fragmentShader: cutFragmentShader,
      side: THREE.BackSide,
    });

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    mesh.position.copy(center); // raw coords; world group applies -bounds-center
    mesh.layers.set(this.SDF_LAYER); // rendered alone into the half-res target while interacting
    this.cutMesh = mesh;
    this.cutMat = mat;
    this.world.add(mesh);
    this.buildKeyframeFields(cut, mn, mx, featureScale);
    this.updatePixelWorld();
  }

  // Keyframe + delta: bake periodic full-state SDF snapshots into a 3D texture (reusing
  // the exact cut shader via #define BAKE), so the raymarch samples the nearest snapshot
  // and only re-evaluates the moves since it. Heavy scenes only; light scenes stay off.
  private buildKeyframeFields(
    cut: CutData,
    mn: THREE.Vector3,
    mx: THREE.Vector3,
    featureScale: number
  ) {
    const mat = this.cutMat!;
    this.disposeKeyframes();
    this.sdfScale = 0.5; // analytic SDF is expensive -> aggressive interaction downscale
    const meta = buildKeyframes(cut);
    if (!meta) {
      mat.uniforms.u_useKF.value = false;
      this.kf = null;
      return;
    }
    const t0 = performance.now();
    const [W, H, D] = meta.dims;
    const K = meta.count;
    const range = Math.max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z);

    // atlas: lay the D*K slices left-to-right, top-down in one RGBA8 2D texture (the
    // most universally renderable target — works without float/3D render support).
    const maxTex = Math.min(8192, this.gl ? this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) : 8192);
    const cols = Math.max(1, Math.floor(maxTex / W));
    const rows = Math.ceil((D * K) / cols);
    const aw = cols * W,
      ah = rows * H;

    // cellKfStart -> R32F data texture (1D-indexed like the CSR streams)
    const CKW = 2048;
    const ckPad = new Float32Array(CKW * Math.max(1, Math.ceil(meta.cellKfStart.length / CKW)));
    ckPad.set(meta.cellKfStart);
    const ckTex = new THREE.DataTexture(ckPad, CKW, ckPad.length / CKW, THREE.RedFormat, THREE.FloatType);
    ckTex.minFilter = ckTex.magFilter = THREE.NearestFilter;
    ckTex.needsUpdate = true;

    const rt = new THREE.WebGLRenderTarget(aw, ah, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter; // manual trilinear decode
    rt.texture.generateMipmaps = false;

    // bake material: same fragment (#define BAKE), fullscreen quad, OWN scalar uniforms
    // but the SAME data textures + grid/stock/tool uniforms. kfEncode needs u_kfRange.
    const u = mat.uniforms;
    const bakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: { BAKE: '' },
      uniforms: {
        u_moves: u.u_moves, u_cellStart: u.u_cellStart, u_cellMoves: u.u_cellMoves,
        u_moveTexW: u.u_moveTexW, u_startTexW: u.u_startTexW, u_cmTexW: u.u_cmTexW,
        u_tools: u.u_tools, u_stockMin: u.u_stockMin, u_stockMax: u.u_stockMax,
        u_gridOrigin: u.u_gridOrigin, u_gridCell: u.u_gridCell, u_featureScale: u.u_featureScale,
        u_gridDims: u.u_gridDims,
        u_useKF: { value: false }, u_scrubAbs: { value: 0 },
        u_bakeLayer: { value: 0 }, u_bakeRes: { value: new THREE.Vector2(W, H) },
        u_tileOrigin: { value: new THREE.Vector2() },
        u_kfDepth: { value: D }, u_kfRange: { value: range },
        // declared-but-unused-in-BAKE uniforms still need a value:
        u_kfCount: { value: K }, u_kfIndex: { value: 0 }, u_ckTexW: { value: 1 },
        u_kfW: { value: W }, u_kfH: { value: H }, u_kfCols: { value: cols },
        u_keyframe: { value: null }, u_cellKfStart: { value: null }, u_kfVoxel: { value: 1 },
      },
      vertexShader: bakeVertexShader,
      fragmentShader: cutFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat);
    quad.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(quad);

    // clear the whole atlas once, then render each slice into its tile via the viewport
    // (which clips rasterization), accumulating with autoClear off.
    rt.viewport.set(0, 0, aw, ah);
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    for (let k = 0; k < K; k++) {
      bakeMat.uniforms.u_scrubAbs.value = meta.times[k];
      for (let z = 0; z < D; z++) {
        const slice = k * D + z;
        const tx = (slice % cols) * W,
          ty = ((slice / cols) | 0) * H;
        bakeMat.uniforms.u_bakeLayer.value = z;
        (bakeMat.uniforms.u_tileOrigin.value as THREE.Vector2).set(tx, ty);
        rt.viewport.set(tx, ty, W, H);
        this.renderer.setRenderTarget(rt);
        this.renderer.render(bakeScene, this.blitCam);
      }
    }
    this.renderer.autoClear = prevAutoClear;
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(CLEAR_COLOR, 1);
    bakeMat.dispose();
    quad.geometry.dispose();

    // Capability gate: even RGBA8 render-to-texture can be absent on ancient GPUs. Read
    // one baked tile back; if it never wrote (all zero), drop keyframes and fall back to
    // the exact analytic path so we never render an empty surface.
    let baked = false;
    try {
      const slice = (K - 1) * D + (D >> 1);
      const tx = (slice % cols) * W,
        ty = ((slice / cols) | 0) * H;
      const buf = new Uint8Array(W * H * 4);
      this.renderer.readRenderTargetPixels(rt, tx, ty, W, H, buf);
      for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) { baked = true; break; }
    } catch (e) {
      console.warn('[keyframes] readback failed', e);
    }
    if (!baked) {
      rt.dispose();
      ckTex.dispose();
      u.u_useKF.value = false;
      this.kf = null;
      console.log('[keyframes] render-to-texture unsupported here — using analytic path');
      return;
    }

    // bind into the live cut material
    u.u_keyframe.value = rt.texture;
    u.u_cellKfStart.value = ckTex;
    u.u_ckTexW.value = CKW;
    u.u_useKF.value = true;
    u.u_kfCount.value = K;
    u.u_kfDepth.value = D;
    u.u_kfW.value = W;
    u.u_kfH.value = H;
    u.u_kfCols.value = cols;
    u.u_kfRange.value = range;
    u.u_kfIndex.value = K - 1;
    u.u_kfVoxel.value = Math.max((mx.x - mn.x) / W, (mx.y - mn.y) / H, (mx.z - mn.z) / D);
    this.kf = meta;
    this.kfRT = rt;
    this.kfStartTex = ckTex;
    this.sdfScale = 0.85; // keyframes make the SDF cheap -> near-full interaction res (less shimmer)
    console.log(
      `[keyframes] K=${K} field ${W}×${H}×${D}, atlas ${aw}×${ah} (${(aw * ah * 4) / 1e6 | 0} MB) | ` +
        `baked in ${(performance.now() - t0) | 0}ms`
    );
  }

  private disposeKeyframes() {
    this.kfRT?.dispose();
    this.kfStartTex?.dispose();
    this.kfRT = null;
    this.kfStartTex = null;
    this.kf = null;
  }

  // World units per pixel per unit ray-distance: 2*tan(fovY/2) / renderedHeightPx.
  // Feeds the shader's analytic edge AA so the silhouette coverage band is ~1px wide.
  // heightPx overrides the rendered height (the half-res SDF pass passes its target height).
  private updatePixelWorld(heightPx?: number) {
    if (!this.cutMat) return;
    const h =
      heightPx ??
      (this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 0) *
        this.renderer.getPixelRatio();
    if (h <= 0) return;
    const fovRad = (this.camera.fov * Math.PI) / 180;
    this.cutMat.uniforms.u_pixelWorld.value = (2 * Math.tan(fovRad / 2)) / h;
  }

  // Shared render scaffolding: recenter the world, add toolpath + marker, fit the
  // camera, seek to finalTime, draw, and publish hooks. The mode-specific geometry
  // (cut mesh / surface mesh) must already be built into `world` by the caller.
  private setupScene(tp: ToolPath, finalTime: number) {
    this.toolpath = tp;
    this.moves = tp.moves;
    this.starts = tp.moves.map((m) => m.tStart);
    this._duration = tp.duration;
    const { center } = this.boundsCenterSize(tp.bounds);
    this.world.position.set(-center.x, -center.y, -center.z);

    this.buildToolpathLines();
    if (this.moves.length) this.buildToolMarker();
    this.applyToggles();

    this.playing = false;
    this.onPlayingChange?.(false);
    this.resize();
    this.fitCamera(tp.bounds);
    this.applyTime(finalTime);
    this.renderer.render(this.scene, this.camera);

    this.onDuration?.(this._duration);
    this.setViewerHook();
  }

  // Render the analytic cut: squirm-free, crisp tool-shaped walls. Scrubbing
  // drives u_scrubAbs (absolute seconds) — the GPU re-derives the surface.
  // solid=false (the "No Geometry" mode) skips the SDF solid: toolpath + marker only.
  renderCut(cut: CutData, solid = true) {
    this.clearWorld();
    if (solid) this.buildCut(cut);
    this.lastTris = 0;
    this.applyHeaviness(solid ? cut.nMoves : 0);
    this.setupScene(cut.toolpath, cut.duration);
  }

  // Per-scene cost caps the full-res pixel ratio: a dense part shouldn't attempt a
  // brutal 2x supersample even when settled. The interaction speedup comes from the
  // half-res SDF target, not from downscaling the whole canvas (which blurs the path).
  private applyHeaviness(nMoves: number) {
    this.settlePR = nMoves > 25000 ? 1.0 : nMoves > 8000 ? 1.5 : Math.min(Math.max(window.devicePixelRatio, 2), 2);
    this.applyPixelRatio(this.settlePR);
  }

  // (re)allocate the half-res SDF target + its depth texture to match the drawbuffer.
  private ensureRT(w: number, h: number) {
    if (this.sdfRT && this.sdfRT.width === w && this.sdfRT.height === h) return;
    this.sdfRT?.dispose();
    const rt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
    });
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter; // smooth color upscale
    this.sdfRT = rt;
  }

  // One frame. interacting + an SDF present -> two passes: the SDF into a half-res
  // target, composited (color+depth) under the FULL-res toolpath/marker. Otherwise a
  // single full-res pass (settle, mesh mode, or No-Geometry).
  private renderFrame(interacting: boolean) {
    const r = this.renderer;
    // The half-res SDF split was a workaround for an expensive analytic SDF. Keyframes
    // make it cheap, so KF scenes (and light scenes) render single-pass full-res — same
    // path as the settled frame, so occlusion is correct (no depth-composite seam) and
    // there's no half-res shimmer. Only the heavy KF-off fallback still splits.
    const wantSplit =
      interacting && this.cutMesh != null && this.cutMesh.visible && !this.kf && this.sceneMoves > 8000;
    if (!wantSplit) {
      this.camera.layers.enableAll();
      this.updatePixelWorld();
      r.render(this.scene, this.camera);
      return;
    }
    const fw = r.domElement.width,
      fh = r.domElement.height;
    const sw = Math.max(1, Math.round(fw * this.sdfScale)),
      sh = Math.max(1, Math.round(fh * this.sdfScale));
    this.ensureRT(sw, sh);
    // pass 1: SDF only (layer 1) into the half-res target
    this.updatePixelWorld(sh);
    this.camera.layers.set(this.SDF_LAYER);
    r.setRenderTarget(this.sdfRT);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    // composite the SDF color+depth to the canvas (clears it first)
    this.blitMat!.uniforms.tColor.value = this.sdfRT!.texture;
    this.blitMat!.uniforms.tDepth.value = this.sdfRT!.depthTexture;
    r.autoClear = true;
    r.render(this.blitScene, this.blitCam);
    // pass 2: everything except the SDF (layer 0) at FULL res, over the composite
    r.autoClear = false;
    this.camera.layers.set(0);
    this.updatePixelWorld();
    r.render(this.scene, this.camera);
    r.autoClear = true;
    this.camera.layers.enableAll();
  }

  setShowGeom(v: boolean) {
    this.showGeom = v;
    this.applyToggles();
  }
  setShowPath(v: boolean) {
    this.showPath = v;
    this.applyToggles();
  }
  setShowTool(v: boolean) {
    this.showTool = v;
    this.applyToggles();
  }

  // timeline seconds per real second (UI slider, 0.1x .. 100x)
  setSpeed(v: number) {
    this.playbackSpeed = Math.max(0.01, v);
  }

  // recolor the cut/mesh material (color wheel). Persisted so a re-bake keeps it.
  setGeomColor(hex: string) {
    this.geomColor.set(hex);
    if (this.cutMat) (this.cutMat.uniforms.u_baseColor.value as THREE.Color).copy(this.geomColor);
    if (this.surfaceMesh)
      (this.surfaceMesh.material as THREE.MeshStandardMaterial).color.copy(this.geomColor);
    this.markDirty();
  }
  get geomColorHex() {
    return '#' + this.geomColor.getHexString();
  }

  // --- apply time -> scene + dashboard --------------------------------------
  applyTime(t: number): DashState | null {
    if (!this.toolpath || this.moves.length === 0) return null;
    this.currentTime = Math.max(0, Math.min(this._duration, t));
    // analytic cut marches in absolute seconds (moves carry absolute tStart/tEnd)
    if (this.cutMat) {
      this.cutMat.uniforms.u_scrubAbs.value = this.currentTime;
      // pick the active keyframe = the latest checkpoint at or before the scrub time
      if (this.kf) {
        const t = this.kf.times;
        let k = 0;
        while (k + 1 < t.length && t[k + 1] <= this.currentTime) k++;
        this.cutMat.uniforms.u_kfIndex.value = k;
      }
    }
    // reveal the toolpath only up to the current time
    for (const m of this.lineMaterials) m.uniforms.uTime.value = this.currentTime;
    const idx = this.findActiveMove(this.currentTime);
    const move = this.moves[idx];
    const pos = this.lerpPos(move, this.currentTime);
    const toolDef = this.toolpath.tools[String(move.tool)] || ({} as any);
    // toolMarker is a child of `world` (already offset by -center), so use raw
    // path coords here — same frame as the toolpath lines and surface mesh. When
    // the active move has no tool engaged (an opening rapid, tool = -1), ghost the
    // marker (hazy + transparent) instead of showing a solid mismatched cylinder.
    if (this.toolMarker) {
      this.toolMarker.position.set(pos[0], pos[1], pos[2]);
      const mat = this.toolMarker.material as THREE.MeshStandardMaterial;
      const ghost = toolDef.diameter == null;
      if (mat.transparent !== ghost) {
        mat.transparent = ghost;
        mat.depthWrite = !ghost;       // solid marker occludes; ghost doesn't
        mat.opacity = ghost ? 0.22 : 1.0;
        mat.needsUpdate = true;
      }
    }
    this.lastState = {
      time: this.currentTime,
      tool: move.tool,
      diameter: toolDef.diameter != null ? toolDef.diameter : null,
      feed: move.feed,
      speed: move.speed,
      pos,
      activeMoveIndex: idx,
    };
    this.onState?.(this.lastState);
    this.markDirty();
    return this.lastState;
  }

  // --- render a result (toolpath + optional surface mesh) -------------------
  renderResult(tp: ToolPath, surface: SimResult | null) {
    this.clearWorld();
    if (surface && surface.positions.length)
      this.buildSurfaceMesh(surface.positions, surface.normals);
    this.lastTris = surface ? surface.triangleCount : 0;
    this.applyHeaviness(0); // mesh = plain triangles, cheap on the GPU -> crisp 2x settle
    this.setupScene(tp, 0);
  }

  // --- playback -------------------------------------------------------------
  scrub(t: number) {
    this.setPlaying(false);
    if (this.moves.length) this.applyTime(t);
    this.markInteracting(); // slider drag -> low-res while moving, crisp on release
  }

  togglePlay() {
    if (!this.moves.length) return;
    if (this.currentTime >= this._duration) this.applyTime(0);
    this.setPlaying(!this.playing);
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    this.onPlayingChange?.(p);
  }

  get isPlaying() {
    return this.playing;
  }
  get time() {
    return this.currentTime;
  }

  // --- perf-aware render helpers --------------------------------------------
  /** Mark the scene changed so the next animate frame renders it. */
  private markDirty() {
    this.dirty = true;
  }

  /** A change that also implies live interaction: render dirty, and switch the SDF to
   *  its half-res split until things settle (orbit/scrub/play). The canvas resolution
   *  is unchanged — only the SDF target shrinks — so the toolpath stays full-res. */
  private markInteracting() {
    this.dirty = true;
    this.lastInteractT = this.lastFrameT;
    if (!this.interacting) {
      this.interacting = true;
      this.lastRenderT = 0; // don't time the first frame
    }
  }

  private applyPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 0;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 0;
    if (w && h) this.renderer.setSize(w, h, false);
    this.updatePixelWorld(); // AA band auto-widens at the lower interaction res
  }

  // One-time scene log: moves, tools, grid, and the moves-per-cell distribution —
  // the metric that drives SDF cost (worst-case cell = slowest pixels). `bakeMs` is
  // passed from the caller (the wasm bake/sim time).
  logScene(label: string, mode: string, cut: CutData | null, bakeMs: number) {
    if (cut) {
      const cs = cut.cellStart;
      const n = cs.length - 1;
      let max = 0,
        sum = 0,
        nonEmpty = 0;
      for (let i = 0; i < n; i++) {
        const c = cs[i + 1] - cs[i];
        if (c > 0) {
          sum += c;
          nonEmpty++;
          if (c > max) max = c;
        }
      }
      this.sceneMoves = cut.nMoves;
      this.sceneTools = cut.nTools;
      this.cellMax = max;
      this.cellAvg = nonEmpty ? sum / nonEmpty : 0;
      const stk = `${(cut.stockMax[0] - cut.stockMin[0]).toFixed(0)}×${(cut.stockMax[1] - cut.stockMin[1]).toFixed(0)}×${(cut.stockMax[2] - cut.stockMin[2]).toFixed(0)}`;
      console.log(
        `[scene] ${label} | ${mode} | ${cut.nMoves.toLocaleString()} moves, ${cut.nTools} tools | ` +
          `grid ${cut.gridDims.join('×')} (${n.toLocaleString()} cells, ${nonEmpty.toLocaleString()} filled) | ` +
          `cellMoves ${cut.cellMoves.length.toLocaleString()} (avg ${this.cellAvg.toFixed(0)}, max ${max}/cell) | ` +
          `stock ${stk}mm | bake ${bakeMs | 0}ms`
      );
    } else {
      this.sceneMoves = 0;
      this.sceneTools = 0;
      this.cellMax = 0;
      console.log(`[scene] ${label} | ${mode} | ${this.lastTris.toLocaleString()} tris | bake ${bakeMs | 0}ms`);
    }
  }

  // Periodic heartbeat: full-res pixel ratio + interaction SDF resolution, perceived
  // frame period (rAF) and true GPU ms (timer query), render rate, and scene density.
  private logPerf() {
    if (!this.renderCount) return;
    const renders = this.renderCount - this.renderCountAtLog;
    this.renderCountAtLog = this.renderCount;
    const fw = this.renderer.domElement.width,
      fh = this.renderer.domElement.height;
    const sdf = `SDF ${Math.round(fw * this.sdfScale)}×${Math.round(fh * this.sdfScale)}`;
    const fps = this.frameEMA > 0 ? 1000 / this.frameEMA : 0;
    const gpu = this.gpuMsEMA ? `GPU ~${this.gpuMsEMA.toFixed(1)}ms` : 'GPU n/a';
    console.log(
      `[perf] full ${fw}×${fh}px @ ${this.settlePR}× | ${this.interacting ? sdf + 'px (interacting)' : 'full (idle)'} | ` +
        `frame ~${this.frameEMA.toFixed(1)}ms (~${fps.toFixed(0)} fps) | ${gpu} | ` +
        `${renders} renders/10s | ${this.sceneMoves.toLocaleString()} moves, max ${this.cellMax}/cell`
    );
  }

  private animate(now: number) {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = this.lastFrameT ? (now - this.lastFrameT) / 1000 : 0;
    this.lastFrameT = now;

    if (this.playing && this.moves.length) {
      let nt = this.currentTime + dt * this.playbackSpeed;
      if (nt >= this._duration) {
        nt = this._duration;
        this.setPlaying(false);
      }
      this.applyTime(nt); // sets dirty; keep playback at low res for smoothness
      this.markInteracting();
    }

    // controls.update() must run every frame for damping inertia; it fires the
    // 'change' event (-> markInteracting) only while the camera is actually moving.
    this.controls.update();

    // settled: no interaction for IDLE_RESTORE_MS and not playing -> one crisp full-res
    // frame (the render path switches from the half-res SDF split to a single pass).
    if (this.interacting && !this.playing && now - this.lastInteractT > this.IDLE_RESTORE_MS) {
      this.interacting = false;
      this.lastRenderT = 0;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.renderCount++;
      // frame-period EMA — logging only (never a control input; see the field comment)
      if (this.interacting && this.lastRenderT) {
        this.frameEMA = this.frameEMA * 0.7 + (now - this.lastRenderT) * 0.3;
      }
      this.lastRenderT = this.interacting ? now : 0;

      // wrap the draw in a GPU timer query (async readback, no stall) for true GPU ms
      const gl = this.gl,
        ext = this.timerExt;
      let q: WebGLQuery | null = null;
      if (gl && ext) {
        q = this.queryPool.pop() || gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      }
      this.renderFrame(this.interacting);
      if (gl && ext && q) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        this.queryPending.push(q);
        this.pollTimers();
      }
    }
  }

  // Drain completed GPU timer queries into a smoothed GPU-ms estimate (for the log).
  private pollTimers() {
    const gl = this.gl!,
      ext = this.timerExt;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      this.queryPool.push(...this.queryPending); // timings invalid this frame — recycle
      this.queryPending.length = 0;
      return;
    }
    while (this.queryPending.length) {
      const q = this.queryPending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.queryPending.shift();
      this.queryPool.push(q);
      this.gpuMsEMA = this.gpuMsEMA ? this.gpuMsEMA * 0.8 + ms * 0.2 : ms;
    }
  }

  // --- e2e hook (parity with vanilla window.__viewer) -----------------------
  getSceneInfo(): SceneInfo {
    let segs = 0,
      verts = 0;
    this.world.traverse((o) => {
      const ls = o as THREE.LineSegments;
      if ((ls as any).isLineSegments) {
        segs++;
        verts += ls.geometry.getAttribute('position').count;
      }
    });
    return {
      lineSegments: segs,
      lineVertices: verts,
      triangles: this.lastTris,
      hasSurface: !!this.surfaceMesh,
      hasCut: !!this.cutMesh,
      hasToolMarker: !!this.toolMarker,
      children: this.world.children.length,
    };
  }

  private setViewerHook() {
    (window as any).__viewer = {
      ready: true,
      getState: () => ({ ...this.lastState }),
      setTime: (t: number) => {
        this.setPlaying(false);
        return this.applyTime(t);
      },
      getDuration: () => this._duration,
      getMoveCount: () => this.moves.length,
      getSceneInfo: () => this.getSceneInfo(),
      setShowPath: (v: boolean) => this.setShowPath(v),
      setShowTool: (v: boolean) => this.setShowTool(v),
      setGeomColor: (hex: string) => this.setGeomColor(hex),
      renderNow: () => {
        // force a crisp full-res render now (bypasses the dirty gate, for perf timing)
        this.interacting = false;
        this.renderFrame(false);
      },
      getRenderCount: () => this.renderCount,
      isInteracting: () => this.interacting,
      // DRS introspection (level index, applied ratio, smoothed frame period ms)
      getPerf: () => ({ settlePR: this.settlePR, sdfScale: this.sdfScale, gpuMs: this.gpuMsEMA, frameEMA: this.frameEMA, interacting: this.interacting }),
      // render + force GPU completion (1px readback) so timing reflects real frame cost
      renderSync: () => {
        this.renderer.render(this.scene, this.camera);
        const gl = this.renderer.getContext();
        const px = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      },
    };
    window.dispatchEvent(new Event('viewer-ready'));
  }
}
