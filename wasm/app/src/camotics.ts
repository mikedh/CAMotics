// ---------------------------------------------------------------------------
// CAMotics wasm core loader + simulate() wrapper.
//
// Emscripten ES6 module (MODULARIZE + EXPORT_ES6 + EXPORT_NAME=createCAMotics).
// Under Parcel 2 we import the factory and feed it a `locateFile` that points
// at the .wasm asset URL Parcel resolves from `new URL(..., import.meta.url)`.
// ---------------------------------------------------------------------------

import createCAMotics from './wasm/camotics.js';

// Parcel rewrites this to the hashed/served asset URL for the .wasm file.
const wasmUrl = new URL('./wasm/camotics.wasm', import.meta.url).href;

// --- ToolPath JSON shape (from toolpathJSON / loadGCode) --------------------
export interface Move {
  type: 'rapid' | 'cut';
  start: [number, number, number];
  end: [number, number, number];
  tool: number;
  feed: number;
  speed: number;
  tStart: number;
  tEnd: number;
}
export interface Tool {
  shape: string;
  diameter: number;
  length: number;
}
export interface ToolPath {
  moves: Move[];
  tools: Record<string, Tool>;
  duration: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

// Result of a simulation: final surface mesh + toolpath.
export interface SimResult {
  toolpath: ToolPath;
  positions: Float32Array; // copied out of wasm heap
  normals: Float32Array; // copied out of wasm heap
  triangleCount: number;
}

// Analytic cut data for the GPU swept-volume SDF renderer. Moves + tool table +
// a uniform-grid CSR (cellStart/cellMoves) binning moves by swept bbox. The GPU
// evaluates solid = max(stockSDF, -min over time-gated moves of sweptToolDist).
export interface CutData {
  toolpath: ToolPath;
  duration: number;
  nMoves: number;
  nTools: number;
  moves: Float32Array; // nMoves*9: x0,y0,z0, x1,y1,z1, tStart, tEnd, toolIdx
  tools: Float32Array; // nTools*4: shape, radius, length, snubRadius
  stockMin: [number, number, number];
  stockMax: [number, number, number];
  gridDims: [number, number, number];
  gridOrigin: [number, number, number];
  gridCell: number;
  cellStart: Uint32Array; // CSR offsets, length gnx*gny*gnz + 1
  cellMoves: Uint32Array; // CSR move indices
}

// embind types are `any` for this phase.
type CamModule = any;

let modulePromise: Promise<CamModule> | null = null;

// Singleton: load + instantiate the wasm module once.
export function getModule(): Promise<CamModule> {
  if (!modulePromise) {
    modulePromise = createCAMotics({
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    });
  }
  return modulePromise;
}

// Toolpath-only (no surface mesh). Kept for parity with the vanilla __loadGCode.
export async function loadGCode(text: string): Promise<ToolPath> {
  const mod = await getModule();
  return JSON.parse(mod.loadGCode(text)) as ToolPath;
}

// Simulate G-code in wasm -> final surface mesh + toolpath. resMode 1/2/3.
export async function simulate(text: string, resMode: number): Promise<SimResult> {
  const mod = await getModule();
  const sim = new mod.Sim();
  try {
    sim.run(text, resMode); // <-- CAMotics core (wasm): toolpath + surface
    const toolpath = JSON.parse(sim.toolpathJSON()) as ToolPath;
    // positions()/normals() are VIEWS into the wasm heap — copy before delete().
    const positions = sim.positions().slice() as Float32Array;
    const normals = sim.normals().slice() as Float32Array;
    const triangleCount = sim.triangleCount() as number;
    return { toolpath, positions, normals, triangleCount };
  } finally {
    sim.delete();
  }
}

// Bake the analytic cut data (moves + tools + grid CSR) for the GPU swept-volume
// SDF renderer. Typed-array members are heap VIEWS — copy out before delete().
export async function bakeCut(text: string, resMode: number): Promise<CutData> {
  const mod = await getModule();
  const sim = new mod.Sim();
  try {
    const r = sim.bakeCut(text, resMode);
    return {
      toolpath: JSON.parse(r.toolpath) as ToolPath,
      duration: r.duration as number,
      nMoves: r.nMoves as number,
      nTools: r.nTools as number,
      moves: (r.moves as Float32Array).slice(),
      tools: (r.tools as Float32Array).slice(),
      stockMin: r.stockMin as [number, number, number],
      stockMax: r.stockMax as [number, number, number],
      gridDims: r.gridDims as [number, number, number],
      gridOrigin: r.gridOrigin as [number, number, number],
      gridCell: r.gridCell as number,
      cellStart: (r.cellStart as Uint32Array).slice(),
      cellMoves: (r.cellMoves as Uint32Array).slice(),
    };
  } finally {
    sim.delete();
  }
}
