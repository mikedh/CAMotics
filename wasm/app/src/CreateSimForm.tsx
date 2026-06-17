// ---------------------------------------------------------------------------
// "Create new sim" sidebar form — shown when you click a loose G-code source.
// Tools are auto-detected from the program's T-words (default geometry, editable);
// you set the workpiece (auto-fit or explicit) + resolution, then create the sim.
// ---------------------------------------------------------------------------

import { useState } from 'preact/hooks';
import {
  type Sim,
  type SourceFile,
  type ResModeName,
  type ToolRow,
  createSimDraft,
  setSimTools,
  boundsFromMinSize,
  RES_NAMES,
} from './project';

const SHAPES = ['cylindrical', 'conical', 'ballnose', 'spheroid', 'snubnose'];

export function CreateSimForm({
  source,
  onCreate,
  onCancel,
}: {
  source: SourceFile;
  onCreate: (sim: Sim) => void;
  onCancel: () => void;
}) {
  const [draft] = useState(() => createSimDraft(source, source.name.replace(/\.[^.]+$/, '')));
  const [name, setName] = useState(draft.name);
  const [resMode, setResMode] = useState<ResModeName>(draft.doc['resolution-mode']);
  const [tools, setTools] = useState<ToolRow[]>(draft.tools);
  const [auto, setAuto] = useState(true);
  const [size, setSize] = useState<[number, number, number]>([100, 100, 25]);

  const updTool = (i: number, patch: Partial<ToolRow>) =>
    setTools((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setDim = (i: number, v: number) =>
    setSize((s) => {
      const n = [...s] as [number, number, number];
      n[i] = v;
      return n;
    });
  const num = (v: string) => (isFinite(parseFloat(v)) ? parseFloat(v) : 0);

  const create = () => {
    let sim: Sim = setSimTools(
      { ...draft, name: name.trim() || draft.name, doc: { ...draft.doc, 'resolution-mode': resMode } },
      tools
    );
    if (!auto)
      sim = {
        ...sim,
        doc: { ...sim.doc, workpiece: { ...sim.doc.workpiece, automatic: false, bounds: boundsFromMinSize([0, 0, 0], size) } },
      };
    onCreate(sim);
  };

  return (
    <section class="panel create-sim">
      <h2>New sim</h2>
      <div class="row">
        <span class="label">Name</span>
        <input class="mini grow-in" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="row">
        <span class="label">Source</span>
        <span class="value ellip">{source.name}</span>
      </div>
      <div class="row">
        <span class="label">Resolution</span>
        <select class="mini" value={resMode} onChange={(e) => setResMode((e.currentTarget as HTMLSelectElement).value as ResModeName)}>
          {RES_NAMES.map((m) => (
            <option value={m}>{m}</option>
          ))}
        </select>
      </div>
      <div class="row">
        <span class="label">Workpiece</span>
        <label class="chk">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto((e.currentTarget as HTMLInputElement).checked)} /> auto-fit
        </label>
      </div>
      {!auto && (
        <div class="wp-edit">
          {([0, 1, 2] as const).map((i) => (
            <input
              type="number"
              step="0.1"
              title={['X', 'Y', 'Z'][i]}
              value={String(size[i])}
              onInput={(e) => setDim(i, num((e.currentTarget as HTMLInputElement).value))}
            />
          ))}
        </div>
      )}

      <div class="sublabel">Tools (auto-detected — edit geometry)</div>
      {tools.length ? (
        <table class="tooltable edit">
          <thead>
            <tr>
              <th>#</th>
              <th>Shape</th>
              <th>Ø</th>
              <th>Len</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t, i) => (
              <tr>
                <td>{t.num}</td>
                <td>
                  <select value={t.shape} onChange={(e) => updTool(i, { shape: (e.currentTarget as HTMLSelectElement).value })}>
                    {SHAPES.map((s) => (
                      <option value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="number" step="0.1" value={String(t.diameter)} onInput={(e) => updTool(i, { diameter: num((e.currentTarget as HTMLInputElement).value) })} />
                </td>
                <td>
                  <input type="number" step="0.1" value={String(t.length)} onInput={(e) => updTool(i, { length: num((e.currentTarget as HTMLInputElement).value) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="muted">no tools detected</div>
      )}

      <div class="wp-actions">
        <button class="btn primary" onClick={create}>
          Create sim
        </button>
        <button class="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
