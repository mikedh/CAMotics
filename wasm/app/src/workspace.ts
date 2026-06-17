// ---------------------------------------------------------------------------
// Workspace — the in-app "file system": owns the source files (.nc/.gcode) and the
// sims (.camotics projects) and all the operations on them. The UI holds one
// instance and mirrors its arrays into render state after each mutation.
//
// Loose G-code is added as a SOURCE only — it does NOT auto-create a sim (you might
// be about to drop a matching .camotics, or you'll make a sim explicitly via the
// "create new sim" form). Only .camotics files become sims on ingest.
// ---------------------------------------------------------------------------

import {
  type SourceFile,
  type Sim,
  parseCamotics,
  createSimFromSource,
  fileKind,
  stem,
  serializeCamotics,
} from './project';

export interface NamedFile {
  name: string;
  text: string;
}

export class Workspace {
  sources: SourceFile[] = [];
  sims: Sim[] = [];
  // the file list starts as the bundled examples; the first user upload replaces them
  examplesActive = true;

  getSource(name: string): SourceFile | undefined {
    return this.sources.find((s) => s.name === name);
  }
  getSim(name: string): Sim | undefined {
    return this.sims.find((s) => s.name === name);
  }

  uniqueSimName(base: string): string {
    const names = new Set(this.sims.map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
  }

  private mergeSources(add: SourceFile[], replace: boolean) {
    const base = replace ? [] : this.sources;
    const map = new Map(base.map((s) => [s.name, s] as const));
    for (const s of add) map.set(s.name, s); // newer text wins on same name
    this.sources = [...map.values()];
  }

  // Ingest a batch: gcode -> sources only; .camotics -> sims (linked to their gcode).
  // Returns the sims added (from .camotics). `replace` wipes the current set first.
  ingest(named: NamedFile[], replace: boolean): Sim[] {
    const gsrc: SourceFile[] = named
      .filter((f) => fileKind(f.name) === 'gcode')
      .map((f) => ({ name: f.name, text: f.text, kind: 'gcode' as const }));
    if (replace) this.sims = [];
    this.mergeSources(gsrc, replace);

    const available = this.sources.map((s) => s.name);
    const added: Sim[] = [];
    for (const f of named)
      if (fileKind(f.name) === 'camotics')
        try {
          const sim = parseCamotics(f.name, f.text, available);
          if (sim.sourceName) {
            sim.name = this.uniqueSimName(sim.name);
            this.sims.push(sim);
            added.push(sim);
          }
        } catch (e) {
          console.warn('bad .camotics', f.name, e);
        }
    return added;
  }

  // Bootstrap helper: one curated sim per current source (so the bundled examples are
  // immediately browsable). Used ONLY for examples — user loose G-code stays sourceless.
  makeSimsForAllSources(): Sim[] {
    const added: Sim[] = [];
    for (const s of this.sources) {
      const sim = createSimFromSource(s, this.uniqueSimName(stem(s.name)));
      this.sims.push(sim);
      added.push(sim);
    }
    return added;
  }

  addSim(sim: Sim): Sim {
    sim.name = this.uniqueSimName(sim.name);
    this.sims.push(sim);
    return sim;
  }
  replaceSim(name: string, sim: Sim) {
    this.sims = this.sims.map((s) => (s.name === name ? sim : s));
  }
  setSourceText(name: string, text: string) {
    this.sources = this.sources.map((s) => (s.name === name ? { ...s, text } : s));
  }

  // sources (current text) + each sim serialized to a .camotics, for the zip export.
  zipEntries(): NamedFile[] {
    const out: NamedFile[] = [];
    for (const s of this.sources) if (s.text) out.push({ name: s.name, text: s.text });
    for (const sim of this.sims) out.push({ name: `${sim.name}.camotics`, text: serializeCamotics(sim) });
    return out;
  }
}
