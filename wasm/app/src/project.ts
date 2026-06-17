// ---------------------------------------------------------------------------
// Sim/project model. A "sim" is a CAMotics-style project (the .camotics JSON):
// a source G-code file + a workpiece (stock box) + resolution + a tool table.
// "Source files" (.nc/.ngc/.gcode/.tap) are the raw programs that sims reference.
// .camotics is plain JSON, so we parse/serialize it natively here.
// ---------------------------------------------------------------------------

import type { Bounds, ToolPath } from './camotics';

export type FileKind = 'gcode' | 'camotics';

export interface SourceFile {
  name: string;
  text: string;
  kind: FileKind;
}

export type ResModeName = 'low' | 'medium' | 'high' | 'very-high';

// Mirrors the .camotics project JSON.
export interface CamoticsDoc {
  units: 'metric' | 'imperial';
  'resolution-mode': ResModeName;
  resolution?: number; // mm (informational; the core derives it from bounds+mode)
  tools: Record<string, any>;
  workpiece: {
    automatic: boolean;
    margin: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  files: string[];
}

export interface ToolRow {
  num: number;
  shape: string;
  diameter: number;
  length: number;
}

export interface Sim {
  name: string; // display name (source stem)
  sourceName: string; // the SourceFile.name it renders
  doc: CamoticsDoc;
  tools: ToolRow[]; // derived from the last bake's toolpath
  geomColor: string; // hex; cut/mesh material color
  fromProject: boolean; // true if parsed from a .camotics (rich tools/bounds/res)
}

const DEFAULT_COLOR = '#9aa0a6'; // matches the shader u_baseColor default
export const RES_NAMES: ResModeName[] = ['low', 'medium', 'high', 'very-high'];

export function resModeToNum(m: ResModeName): number {
  const i = RES_NAMES.indexOf(m);
  return i < 0 ? 2 : i + 1; // low=1 medium=2 high=3 very-high=4
}
export function numToResMode(n: number): ResModeName {
  return RES_NAMES[Math.min(Math.max(n | 0, 1), 4) - 1];
}

export function baseName(name: string): string {
  return name.replace(/^.*[\\/]/, '');
}
export function stem(name: string): string {
  return baseName(name).replace(/\.[^.]+$/, '');
}
export function fileKind(name: string): FileKind {
  return /\.camotics$/i.test(name) ? 'camotics' : 'gcode';
}

// --- workpiece box helpers (we present "size" = the XYZ extents) -------------
export function boundsSize(b: CamoticsDoc['workpiece']['bounds']): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}
// Grow/shrink from the fixed min corner: max = min + size.
export function boundsFromMinSize(
  min: [number, number, number],
  size: [number, number, number]
): CamoticsDoc['workpiece']['bounds'] {
  return { min: [...min], max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] };
}

// Tool numbers the program selects (T-words), comments stripped. Used to pre-fill
// the "create new sim" tool table so you only edit geometry, not which tools exist.
export function detectToolNumbers(gcode: string): number[] {
  const nums = new Set<number>();
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, ''); // strip () and ; comments
    const m = /(?:^|\s)T(\d+)/i.exec(line);
    if (m) nums.add(parseInt(m[1], 10));
  }
  return [...nums].filter((n) => n > 0).sort((a, b) => a - b);
}

// A draft sim for the create-sim form: auto-detected tools (default geometry, editable)
// + automatic workpiece + medium resolution. fromProject=true so the wasm applies the
// edited tool table (raw G-code has no tool geometry of its own).
export function createSimDraft(src: SourceFile, name: string): Sim {
  const nums = detectToolNumbers(src.text);
  const list = nums.length ? nums : [1];
  const tools: ToolRow[] = list.map((n) => ({ num: n, shape: 'cylindrical', diameter: 3.175, length: 25 }));
  const docTools: Record<string, any> = {};
  for (const t of tools)
    docTools[t.num] = { units: 'metric', shape: t.shape, diameter: t.diameter, length: t.length, description: '' };
  return {
    name,
    sourceName: src.name,
    doc: {
      units: 'metric',
      'resolution-mode': 'medium',
      tools: docTools,
      workpiece: { automatic: true, margin: 5, bounds: { min: [0, 0, 0], max: [0, 0, 0] } },
      files: [baseName(src.name)],
    },
    tools,
    geomColor: DEFAULT_COLOR,
    fromProject: true,
  };
}

// Write an edited tool table back into a sim's doc (so it re-bakes + serializes with it).
export function setSimTools(sim: Sim, tools: ToolRow[]): Sim {
  const docTools: Record<string, any> = {};
  for (const t of tools)
    docTools[t.num] = { units: 'metric', shape: t.shape, diameter: t.diameter, length: t.length, description: '' };
  return { ...sim, tools, doc: { ...sim.doc, tools: docTools } };
}

// --- create / parse / serialize ---------------------------------------------
export function createSimFromSource(src: SourceFile, name?: string): Sim {
  return {
    name: name || stem(src.name),
    sourceName: src.name,
    doc: {
      units: 'metric',
      'resolution-mode': 'medium',
      tools: {},
      workpiece: { automatic: true, margin: 5, bounds: { min: [0, 0, 0], max: [0, 0, 0] } },
      files: [baseName(src.name)],
    },
    tools: [],
    geomColor: DEFAULT_COLOR,
    fromProject: false,
  };
}

// Parse a dropped .camotics project. Links to a gcode source by its files[]
// basenames against the available source names (so dropping both wires them up).
export function parseCamotics(
  name: string,
  json: string,
  availableNames: string[]
): Sim {
  const doc = JSON.parse(json) as CamoticsDoc;
  doc.units = doc.units || 'metric';
  doc['resolution-mode'] = doc['resolution-mode'] || 'medium';
  doc.workpiece = doc.workpiece || {
    automatic: true,
    margin: 5,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };
  doc.files = doc.files || [];

  let sourceName = '';
  for (const f of doc.files) {
    const hit = availableNames.find((a) => baseName(a) === baseName(f));
    if (hit && fileKind(hit) === 'gcode') {
      sourceName = hit;
      break;
    }
  }
  const tools: ToolRow[] = Object.entries(doc.tools || {}).map(([k, t]: [string, any]) => ({
    num: parseInt(k, 10),
    shape: t.shape || 'cylindrical',
    diameter: t.diameter ?? 0,
    length: t.length ?? 0,
  }));
  return { name: stem(name), sourceName, doc, tools, geomColor: DEFAULT_COLOR, fromProject: true };
}

// Serialize back to .camotics JSON (so the project re-opens in desktop CAMotics).
export function serializeCamotics(sim: Sim): string {
  const d = sim.doc;
  return JSON.stringify(
    {
      units: d.units,
      'resolution-mode': d['resolution-mode'],
      ...(d.resolution ? { resolution: d.resolution } : {}),
      tools: d.tools,
      workpiece: d.workpiece,
      files: [baseName(sim.sourceName)],
    },
    null,
    2
  );
}

// The wasm Bounds for a sim (undefined = automatic auto-fit).
export function simBounds(sim: Sim): Bounds | undefined {
  const wp = sim.doc.workpiece;
  if (wp.automatic) return undefined;
  return { min: [...wp.bounds.min], max: [...wp.bounds.max] };
}

// After a bake: capture the tool table + (when automatic) the real stock box, and
// mirror the tools into doc.tools so a serialized .camotics carries them. Returns a
// NEW sim (immutable update for preact state).
export function applyBake(
  sim: Sim,
  tp: ToolPath,
  stockMin: [number, number, number],
  stockMax: [number, number, number]
): Sim {
  const tools: ToolRow[] = Object.entries(tp.tools).map(([k, t]) => ({
    num: parseInt(k, 10),
    shape: t.shape,
    diameter: t.diameter,
    length: t.length,
  }));
  const wp = sim.doc.workpiece;
  const bounds = wp.automatic ? { min: [...stockMin], max: [...stockMax] } : wp.bounds;
  // For a project-backed sim keep its original rich tool table (descriptions, all
  // tools); only synthesize doc.tools for raw-gcode sims so their exported .camotics
  // carries something. The displayed `tools` always reflects the actual bake.
  let docTools = sim.doc.tools;
  if (!sim.fromProject) {
    docTools = {};
    for (const [k, t] of Object.entries(tp.tools))
      docTools[k] = { units: 'metric', shape: t.shape, length: t.length, diameter: t.diameter, description: '' };
  }
  return {
    ...sim,
    tools,
    doc: { ...sim.doc, tools: docTools, workpiece: { ...wp, bounds } },
  };
}
