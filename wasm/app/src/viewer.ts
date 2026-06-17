// ---------------------------------------------------------------------------
// Imperative three.js viewer controller. Ported from the vanilla app.js.
// The Preact UI drives this class; it owns the renderer/scene/camera/controls,
// builds toolpath lines + tool marker + surface mesh, recenters the world,
// fits the camera, and advances a scrub timeline.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ToolPath, Move, SimResult, CutData } from './camotics';
import { cutVertexShader, cutFragmentShader, MAX_TOOLS } from './cutShader';

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
  private lineMaterials: THREE.ShaderMaterial[] = [];
  private pathObjects: THREE.Object3D[] = [];
  private lastTris = 0;

  private showGeom = true;
  private showPath = true;

  private playing = false;
  private currentTime = 0;
  private lastFrameT = 0;
  private lastState: DashState | null = null;
  private rafId = 0;

  // perf-aware rendering: render only when the scene changed (dirty), and drop to
  // a lower internal resolution while interacting (orbit/scrub/play), snapping back
  // to full res after a short idle. The raymarch modes are expensive per pixel.
  private dirty = true;
  private interacting = false;
  private lastInteractT = 0;
  private fullPixelRatio = 1;
  private readonly LOW_RES_SCALE = 0.5;
  private readonly IDLE_RESTORE_MS = 280;
  private renderCount = 0;

  // Callbacks the UI subscribes to.
  onState: ((s: DashState) => void) | null = null;
  onDuration: ((d: number) => void) | null = null;
  onPlayingChange: ((playing: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // Settled frames supersample at 2x: MSAA doesn't antialias the per-fragment
    // raymarch isosurface, so the crisp analytic edges alias without it. Render-on-
    // demand makes this a one-off cost; interaction still drops to half this.
    this.fullPixelRatio = Math.min(Math.max(window.devicePixelRatio, 2), 2);
    renderer.setPixelRatio(this.fullPixelRatio);
    renderer.setClearColor(CLEAR_COLOR, 1);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25;
    this.controls.rotateSpeed = 1.0;
    // camera moved (user drag or damping inertia) -> needs a (low-res) redraw
    this.controls.addEventListener('change', () => this.markInteracting());

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
    this.markDirty();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
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
      color: 0x9aa0a6,
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
    this.pathObjects.push(this.toolMarker);
  }

  private applyToggles() {
    if (this.surfaceMesh) this.surfaceMesh.visible = this.showGeom;
    if (this.cutMesh) this.cutMesh.visible = this.showGeom;
    for (const o of this.pathObjects) o.visible = this.showPath;
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
      packed[d + 7] = m[s + 7]; // tEnd
      packed[d + 8] = m[s + 8]; // toolIdx
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
        u_baseColor: { value: new THREE.Color(0x9aa0a6) },
        u_lightDir: { value: new THREE.Vector3(0.4, 0.6, 0.9).normalize() },
      },
      vertexShader: cutVertexShader,
      fragmentShader: cutFragmentShader,
      side: THREE.BackSide,
    });

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    mesh.position.copy(center); // raw coords; world group applies -bounds-center
    this.cutMesh = mesh;
    this.cutMat = mat;
    this.world.add(mesh);
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
  renderCut(cut: CutData) {
    this.clearWorld();
    this.buildCut(cut);
    this.lastTris = 0;
    this.setupScene(cut.toolpath, cut.duration);
  }

  setShowGeom(v: boolean) {
    this.showGeom = v;
    this.applyToggles();
  }
  setShowPath(v: boolean) {
    this.showPath = v;
    this.applyToggles();
  }

  // --- apply time -> scene + dashboard --------------------------------------
  applyTime(t: number): DashState | null {
    if (!this.toolpath || this.moves.length === 0) return null;
    this.currentTime = Math.max(0, Math.min(this._duration, t));
    // analytic cut marches in absolute seconds (moves carry absolute tStart/tEnd)
    if (this.cutMat) this.cutMat.uniforms.u_scrubAbs.value = this.currentTime;
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

  /** A change that also implies live interaction: render dirty AND drop to low
   *  resolution until things settle (orbit/scrub/play). */
  private markInteracting() {
    this.dirty = true;
    this.lastInteractT = this.lastFrameT;
    if (!this.interacting) {
      this.interacting = true;
      this.applyPixelRatio(this.fullPixelRatio * this.LOW_RES_SCALE);
    }
  }

  private applyPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 0;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 0;
    if (w && h) this.renderer.setSize(w, h, false);
  }

  private animate(now: number) {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = this.lastFrameT ? (now - this.lastFrameT) / 1000 : 0;
    this.lastFrameT = now;

    if (this.playing && this.moves.length) {
      let nt = this.currentTime + dt;
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

    // settled: no interaction for IDLE_RESTORE_MS and not playing -> one crisp frame
    if (this.interacting && !this.playing && now - this.lastInteractT > this.IDLE_RESTORE_MS) {
      this.interacting = false;
      this.applyPixelRatio(this.fullPixelRatio);
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.renderCount++;
      this.renderer.render(this.scene, this.camera);
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
      renderNow: () => {
        // force a full-res render now (bypasses the dirty gate, for perf timing)
        if (this.interacting) {
          this.interacting = false;
          this.applyPixelRatio(this.fullPixelRatio);
        }
        this.renderer.render(this.scene, this.camera);
      },
      getRenderCount: () => this.renderCount,
      isInteracting: () => this.interacting,
    };
    window.dispatchEvent(new Event('viewer-ready'));
  }
}
