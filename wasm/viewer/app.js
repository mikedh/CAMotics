import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { STLLoader } from 'three/addons/STLLoader.js';

// ---------------------------------------------------------------------------
// CAMotics wasm viewer. Drag in G-code -> the wasm core simulates the cut and
// returns BOTH the final surface mesh and the toolpath, rendered (rotatable)
// in three.js with a scrub timeline + dashboard.
// ---------------------------------------------------------------------------

const EXAMPLES = [
  ['scorpion.nc',        'Scorpion'],
  ['slant_test.nc',      'Slant test (tiny)'],
  ['heart.ngc',          'Heart'],
  ['genes-encoder.ngc',  'Genes encoder'],
  ['compass_text.ngc',   'Compass text'],
  ['vcarve.ngc',         'V-carve (large)'],
];
const DEFAULT_EXAMPLE = 'scorpion.nc';

const canvas = document.getElementById('gl');
const canvasWrap = document.getElementById('canvas-wrap');
const dash = {
  tool: document.getElementById('dash-tool'),
  diameter: document.getElementById('dash-diameter'),
  feed: document.getElementById('dash-feed'),
  speed: document.getElementById('dash-speed'),
  x: document.getElementById('dash-x'), y: document.getElementById('dash-y'), z: document.getElementById('dash-z'),
  time: document.getElementById('dash-time'), tris: document.getElementById('dash-tris'),
};
const timeline = document.getElementById('timeline');
const playBtn = document.getElementById('play');
const timeReadout = document.getElementById('time-readout');
const statusEl = document.getElementById('status');
const examplesSel = document.getElementById('examples');
const fileInput = document.getElementById('file');
const resSel = document.getElementById('resolution');
const showGeom = document.getElementById('show-geom');
const showPath = document.getElementById('show-path');

function setStatus(msg, err = false) { statusEl.textContent = msg; statusEl.classList.toggle('err', err); }

// --- renderer / scene / camera ---------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const CLEAR_COLOR = new THREE.Color(0x1a1d21);
renderer.setClearColor(CLEAR_COLOR, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.25; controls.rotateSpeed = 1.0;
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.85); dir.position.set(1, 1, 2); scene.add(dir);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.4); dir2.position.set(-1, -0.5, 1); scene.add(dir2);

// --- state ------------------------------------------------------------------
let toolpath = null, moves = [], starts = [], duration = 0;
let toolMarker = null, surfaceMesh = null, pathObjects = [];
let playing = false, lastFrameT = 0, currentTime = 0, lastState = null, lastTris = 0;
let lastGCode = null, lastName = '';   // for re-simulate on resolution change

const world = new THREE.Group(); scene.add(world);
let centerOffset = new THREE.Vector3();

// --- helpers ----------------------------------------------------------------
function resize() {
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function boundsCenterSize(bounds) {
  const mn = new THREE.Vector3().fromArray(bounds.min);
  const mx = new THREE.Vector3().fromArray(bounds.max);
  return { center: mn.clone().add(mx).multiplyScalar(0.5), size: mx.clone().sub(mn) };
}
function fitCamera(bounds) {
  const { size } = boundsCenterSize(bounds);
  const radius = Math.max(size.length() * 0.5, 1);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
  camera.position.set(dist * 0.8, -dist * 0.9, dist * 0.7);
  camera.near = radius / 100; camera.far = radius * 100; camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0); controls.update();
}
function findActiveMove(t) {
  if (moves.length === 0) return 0;
  if (t <= starts[0]) return 0;
  if (t >= moves[moves.length - 1].tEnd) return moves.length - 1;
  let lo = 0, hi = moves.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function lerpPos(move, t) {
  const span = move.tEnd - move.tStart;
  let f = span > 1e-9 ? (t - move.tStart) / span : 0; f = Math.max(0, Math.min(1, f));
  return [move.start[0] + (move.end[0] - move.start[0]) * f,
          move.start[1] + (move.end[1] - move.start[1]) * f,
          move.start[2] + (move.end[2] - move.start[2]) * f];
}
function fmt(n, d = 2) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : '--'; }

// --- scene builders ---------------------------------------------------------
function clearWorld() {
  for (let i = world.children.length - 1; i >= 0; i--) {
    const c = world.children[i]; world.remove(c);
    if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
  }
  toolMarker = null; surfaceMesh = null; pathObjects = [];
}

function buildSurfaceMesh(positions, normals) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals && normals.length === positions.length)
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9aa0a6, metalness: 0.12, roughness: 0.8, side: THREE.DoubleSide,
  });
  surfaceMesh = new THREE.Mesh(g, mat);
  world.add(surfaceMesh);
}

function buildToolpathLines() {
  const cutPts = [], rapidPts = [];
  for (const m of moves) {
    const arr = m.type === 'rapid' ? rapidPts : cutPts;
    arr.push(m.start[0], m.start[1], m.start[2], m.end[0], m.end[1], m.end[2]);
  }
  if (cutPts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cutPts, 3));
    const seg = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x38d96b }));
    world.add(seg); pathObjects.push(seg);
  }
  if (rapidPts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(rapidPts, 3));
    const seg = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: 0xff5c5c, dashSize: 1.2, gapSize: 0.8 }));
    seg.computeLineDistances(); world.add(seg); pathObjects.push(seg);
  }
}

function buildToolMarker() {
  const toolDef = toolpath.tools[String(moves[0].tool)] || { diameter: 3, length: 10 };
  const r = Math.max(toolDef.diameter / 2, 0.3), len = Math.max(toolDef.length, r * 2);
  const geo = new THREE.CylinderGeometry(r, r, len, 24);
  geo.rotateX(Math.PI / 2); geo.translate(0, 0, len / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffc04d, metalness: 0.6, roughness: 0.3, emissive: 0x332200 });
  toolMarker = new THREE.Mesh(geo, mat); world.add(toolMarker); pathObjects.push(toolMarker);
}

function applyToggles() {
  if (surfaceMesh) surfaceMesh.visible = showGeom.checked;
  for (const o of pathObjects) o.visible = showPath.checked;
}

// --- apply time -> scene + dashboard ----------------------------------------
function applyTime(t) {
  currentTime = Math.max(0, Math.min(duration, t));
  const idx = findActiveMove(currentTime), move = moves[idx], pos = lerpPos(move, currentTime);
  // toolMarker is a child of `world` (which is already offset by -center), so use
  // raw path coords here — same frame as the toolpath lines and surface mesh.
  if (toolMarker) toolMarker.position.set(pos[0], pos[1], pos[2]);
  const toolDef = toolpath.tools[String(move.tool)] || {};
  dash.tool.textContent = String(move.tool);
  dash.diameter.textContent = toolDef.diameter != null ? fmt(toolDef.diameter) + ' mm' : '--';
  dash.feed.textContent = fmt(move.feed, 0) + ' mm/min';
  dash.speed.textContent = fmt(move.speed, 0) + ' rpm';
  dash.x.textContent = fmt(pos[0], 3); dash.y.textContent = fmt(pos[1], 3); dash.z.textContent = fmt(pos[2], 3);
  dash.time.textContent = fmt(currentTime, 3) + ' s';
  if (Math.abs(parseFloat(timeline.value) - currentTime) > 1e-6) timeline.value = String(currentTime);
  timeReadout.textContent = `${fmt(currentTime, 3)} / ${fmt(duration, 3)} s`;
  lastState = { time: currentTime, toolPos: pos, tool: move.tool, feed: move.feed, speed: move.speed, activeMoveIndex: idx };
  return lastState;
}

// --- render a result (toolpath + optional surface mesh) ---------------------
function renderResult(tp, surface) {
  clearWorld();
  toolpath = tp; moves = tp.moves; starts = moves.map((m) => m.tStart); duration = tp.duration;
  const { center } = boundsCenterSize(tp.bounds); centerOffset = center.clone();
  world.position.set(-center.x, -center.y, -center.z);

  if (surface && surface.positions.length) buildSurfaceMesh(surface.positions, surface.normals);
  buildToolpathLines();
  if (moves.length) buildToolMarker();
  applyToggles();

  timeline.min = '0'; timeline.max = String(duration);
  timeline.step = String(Math.max(duration / 2000, 0.001)); timeline.value = '0';
  resize(); fitCamera(tp.bounds); applyTime(0); renderer.render(scene, camera);

  lastTris = surface ? surface.tris : 0;
  dash.tris.textContent = surface ? surface.tris.toLocaleString() : '--';
  setViewerHook();
}

function setViewerHook() {
  window.__viewer = {
    ready: true,
    getState: () => ({ ...lastState }),
    setTime: (t) => { playing = false; playBtn.textContent = 'Play'; return applyTime(t); },
    getDuration: () => duration,
    getMoveCount: () => moves.length,
    getSceneInfo: () => {
      let segs = 0, verts = 0;
      world.traverse((o) => { if (o.isLineSegments) { segs++; verts += o.geometry.getAttribute('position').count; } });
      return { lineSegments: segs, lineVertices: verts, triangles: lastTris,
               hasSurface: !!surfaceMesh, hasToolMarker: !!toolMarker, children: world.children.length };
    },
  };
  window.dispatchEvent(new Event('viewer-ready'));
}

// --- the wasm core ----------------------------------------------------------
let camModulePromise = null;
function getCamModule() {
  if (!camModulePromise) camModulePromise = import('./camotics.js').then((m) => m.default());
  return camModulePromise;
}

// Simulate G-code in wasm -> render surface mesh + toolpath. resMode 1/2/3.
async function simulate(text, name) {
  lastGCode = text; lastName = name || lastName;
  const resMode = parseInt(resSel.value, 10) || 2;
  setStatus(`simulating ${lastName}…`);
  // let the status paint before the synchronous wasm call blocks the main thread
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const mod = await getCamModule();
    const sim = new mod.Sim();
    const t0 = performance.now();
    sim.run(text, resMode);                       // <-- CAMotics core (wasm): toolpath + surface
    const tp = JSON.parse(sim.toolpathJSON());
    const positions = sim.positions().slice();    // copy out of wasm heap
    const normals = sim.normals().slice();
    const tris = sim.triangleCount();
    sim.delete();
    const ms = performance.now() - t0;
    renderResult(tp, { positions, normals, tris });
    setStatus(`${lastName}: ${tris.toLocaleString()} tris, ${tp.moves.length.toLocaleString()} moves, ${fmt(tp.duration, 1)} s, ${ms | 0} ms`);
    return { moveCount: tp.moves.length, triangles: tris, duration: tp.duration, ms };
  } catch (e) {
    setStatus(`error: ${e && e.message ? e.message : e}`, true);
    throw e;
  }
}

async function loadExample(file) {
  const resp = await fetch('./examples/' + file);
  if (!resp.ok) { setStatus(`could not load ${file}`, true); return; }
  await simulate(await resp.text(), file);
}

// --- main loop --------------------------------------------------------------
function animate(now) {
  requestAnimationFrame(animate);
  const dt = lastFrameT ? (now - lastFrameT) / 1000 : 0; lastFrameT = now;
  if (playing && moves.length) {
    let nt = currentTime + dt;
    if (nt >= duration) { nt = duration; playing = false; playBtn.textContent = 'Play'; }
    applyTime(nt);
  }
  controls.update(); renderer.render(scene, camera);
}

// --- UI wiring --------------------------------------------------------------
timeline.addEventListener('input', () => { playing = false; playBtn.textContent = 'Play'; if (moves.length) applyTime(parseFloat(timeline.value)); });
playBtn.addEventListener('click', () => { if (!moves.length) return; if (currentTime >= duration) applyTime(0); playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play'; });
showGeom.addEventListener('change', applyToggles);
showPath.addEventListener('change', applyToggles);
resSel.addEventListener('change', () => { if (lastGCode) simulate(lastGCode, lastName); });
examplesSel.addEventListener('change', () => loadExample(examplesSel.value));
fileInput.addEventListener('change', async () => {
  const f = fileInput.files && fileInput.files[0]; if (!f) return;
  await simulate(await f.text(), f.name);
});
// drag and drop
['dragenter', 'dragover'].forEach((ev) => canvasWrap.addEventListener(ev, (e) => { e.preventDefault(); canvasWrap.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((ev) => canvasWrap.addEventListener(ev, (e) => { e.preventDefault(); canvasWrap.classList.remove('dragging'); }));
canvasWrap.addEventListener('drop', async (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
  await simulate(await f.text(), f.name);
});

// expose for e2e
window.__simulate = (text, name) => simulate(text, name || 'test');
window.__loadGCode = async (text) => {           // path-only (kept for older test)
  const mod = await getCamModule();
  renderResult(JSON.parse(mod.loadGCode(text)), null);
  return { moveCount: moves.length, duration };
};

// --- fixtures mode (deterministic e2e: ?fixtures=1) -------------------------
async function initFixtures() {
  const tp = await (await fetch('./fixtures/toolpath.json')).json();
  renderResult(tp, null);
  await new Promise((resolve) => new STLLoader().load('./fixtures/workpiece.stl', (geo) => {
    geo.computeVertexNormals();
    surfaceMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.1, roughness: 0.85, flatShading: true, side: THREE.DoubleSide }));
    world.add(surfaceMesh); applyToggles(); resolve();
  }, undefined, () => resolve()));
  setStatus('fixtures');
}

// --- bootstrap --------------------------------------------------------------
async function init() {
  const params = new URLSearchParams(location.search);
  for (const [file, label] of EXAMPLES) {
    const o = document.createElement('option'); o.value = file; o.textContent = label;
    if (file === DEFAULT_EXAMPLE) o.selected = true; examplesSel.appendChild(o);
  }
  if (params.has('empty')) { resize(); setStatus('ready — drop a G-code'); window.__appReady = true; window.dispatchEvent(new Event('app-ready')); return; }
  if (params.has('fixtures')) { await initFixtures(); return; }
  // default: interactive — auto-load the default example through the wasm core
  resize();
  await loadExample(DEFAULT_EXAMPLE);
}

requestAnimationFrame(animate);
init().catch((err) => { console.error('viewer init failed', err); setStatus('init failed: ' + err, true); window.__viewer = window.__viewer || { ready: false, error: String(err) }; });
