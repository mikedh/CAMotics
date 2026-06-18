// ---------------------------------------------------------------------------
// Preact root. A small sim/project workspace over the imperative three.js Viewer:
//  - top toolbar: render mode (Incremental SDF / Final Mesh / No Geometry), path +
//    tool icon toggles, playback speed.
//  - right sidebar: live status, tool table, editable workpiece, files (sims +
//    sources), and a dropzone pinned to the bottom.
//  - bottom timeline with a play/pause toggle.
// Sims are CAMotics .camotics projects (source + workpiece + tools); sources are
// the raw .nc/.gcode programs they reference (see project.ts).
// ---------------------------------------------------------------------------

import { render } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { Viewer, type DashState } from './viewer';
import { simulate, bakeCut, type RenderOpts, type ToolPath } from './camotics';
import { EXAMPLES, DEFAULT_EXAMPLE, fetchExample } from './examples';
import { ColorWheel } from './ColorWheel';
import { Editor } from './Editor';
import { CreateSimForm } from './CreateSimForm';
import { downloadZip } from './zip';
import { Workspace } from './workspace';
import {
  type Sim,
  type SourceFile,
  type ToolRow,
  serializeCamotics,
  applyBake,
  simBounds,
  boundsSize,
  boundsFromMinSize,
  resModeToNum,
  baseName,
  RES_NAMES,
  type ResModeName,
} from './project';

type GeomMode = 'sdf' | 'mesh' | 'none';

function fmt(n: number | null | undefined, d = 2): string {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '--';
}

// ---- inline SVG icons (stroke = currentColor so CSS drives the color) -------
const Icon = ({ d, fill = false }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      d={d}
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
const IconPath = () => <Icon d="M4 17 L9 7 L15 17 L20 7" />;
const IconTool = () => <Icon d="M12 3 L17 3 L17 11 L13.5 20 A1.5 1.5 0 0 1 10.5 20 L7 11 L7 3 Z M7 7 L17 7" />;
const IconPlay = () => <Icon d="M8 5 L19 12 L8 19 Z" fill />;
const IconPause = () => <Icon d="M8 5 L8 19 M16 5 L16 19" />;
const IconDoc = () => <Icon d="M7 3 H14 L19 8 V21 H7 Z M14 3 V8 H19" />;
const IconSim = () => <Icon d="M5 4 L19 12 L5 20 Z" />;
const IconZip = () => <Icon d="M12 4 V14 M8 11 L12 15 L16 11 M5 19 H19" />;
const IconEdit = () => <Icon d="M4 20 L8 19 L19 8 L16 5 L5 16 Z M14 7 L17 10" />;

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const [status, setStatus] = useState('loading…');
  const [statusErr, setStatusErr] = useState(false);
  const [geomMode, setGeomMode] = useState<GeomMode>('sdf');
  const [showPath, setShowPath] = useState(true);
  const [showTool, setShowTool] = useState(true);
  const [speed, setSpeed] = useState(1);

  const [sources, setSources] = useState<SourceFile[]>([]);
  const [sims, setSims] = useState<Sim[]>([]);
  const [activeSimName, setActiveSimName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState<string | null>(null); // loose source -> new-sim form
  const [wheel, setWheel] = useState<{ x: number; y: number } | null>(null);

  const [dash, setDash] = useState<DashState | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [tris, setTris] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);

  // The Workspace owns the files + sims (the "file system"); React state mirrors it
  // for rendering. metaRef gives async (bake) callbacks the latest active sim + mode.
  const ws = useRef(new Workspace()).current;
  const sync = useCallback(() => {
    setSources([...ws.sources]);
    setSims([...ws.sims]);
  }, [ws]);
  const metaRef = useRef({ active: null as string | null, mode: 'sdf' as GeomMode });
  metaRef.current = { active: activeSimName, mode: geomMode };

  const activeSim = sims.find((s) => s.name === activeSimName) || null;

  const setStatusMsg = useCallback((msg: string, err = false) => {
    setStatus(msg);
    setStatusErr(err);
  }, []);

  // --- viewer lifecycle -----------------------------------------------------
  useEffect(() => {
    const viewer = new Viewer(canvasRef.current!);
    viewerRef.current = viewer;
    viewer.onState = (s) => {
      setDash(s);
      setTime(s.time);
    };
    viewer.onDuration = (d) => setDuration(d);
    viewer.onPlayingChange = (p) => setPlaying(p);
    const onResize = () => viewer.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      viewer.dispose();
    };
  }, []);

  // --- low-level: bake/sim arbitrary text in a mode, render, return toolpath -
  const renderText = useCallback(
    async (
      text: string,
      name: string,
      mode: GeomMode,
      resNum: number,
      opts: RenderOpts
    ): Promise<{ tp: ToolPath; min: [number, number, number]; max: [number, number, number] } | null> => {
      const viewer = viewerRef.current;
      if (!viewer) return null;
      setStatusMsg(`${mode === 'mesh' ? 'simulating' : 'baking'} ${name}…`);
      // let the status paint before the synchronous wasm call blocks the thread
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const t0 = performance.now();
        if (mode === 'mesh') {
          const result = await simulate(text, resNum, opts);
          const ms = performance.now() - t0;
          viewer.renderResult(result.toolpath, result);
          viewer.logScene(name, 'mesh', null, ms);
          setTris(result.triangleCount);
          setStatusMsg(
            `${name}: ${result.triangleCount.toLocaleString()} tris, ` +
              `${result.toolpath.moves.length.toLocaleString()} moves, ` +
              `${fmt(result.toolpath.duration, 1)} s, ${ms | 0} ms`
          );
          return { tp: result.toolpath, min: result.toolpath.bounds.min, max: result.toolpath.bounds.max };
        }
        const cut = await bakeCut(text, resNum, opts);
        const ms = performance.now() - t0;
        viewer.renderCut(cut, mode === 'sdf');
        viewer.logScene(name, mode, cut, ms);
        setTris(null);
        const geomTxt = mode === 'none' ? 'no geometry' : `${cut.gridDims.join('×')} grid`;
        setStatusMsg(
          `${name}: ${cut.nMoves.toLocaleString()} moves, ${cut.nTools} tool${
            cut.nTools === 1 ? '' : 's'
          }, ${geomTxt}, ${fmt(cut.duration, 1)} s, ${ms | 0} ms`
        );
        return { tp: cut.toolpath, min: cut.stockMin, max: cut.stockMax };
      } catch (e: any) {
        setStatusMsg(`error: ${e && e.message ? e.message : e}`, true);
        throw e;
      }
    },
    [setStatusMsg]
  );

  // A project-backed sim loads its full .camotics (real tools/bounds/resolution); a
  // raw-gcode sim just passes its (possibly edited) explicit stock box.
  const simOpts = (sim: Sim): RenderOpts =>
    sim.fromProject
      ? { project: { json: serializeCamotics(sim), gcodeName: baseName(sim.sourceName) } }
      : { bounds: simBounds(sim) };

  // --- render a sim (its workpiece, resolution, tools, color) ----------------
  const renderSim = useCallback(
    async (sim: Sim) => {
      const src = ws.getSource(sim.sourceName);
      if (!src || !src.text) {
        setStatusMsg(`source not loaded: ${sim.sourceName}`, true);
        return;
      }
      viewerRef.current?.setGeomColor(sim.geomColor);
      const out = await renderText(
        src.text,
        sim.name,
        metaRef.current.mode,
        resModeToNum(sim.doc['resolution-mode']),
        simOpts(sim)
      );
      if (out) {
        ws.replaceSim(sim.name, applyBake(sim, out.tp, out.min, out.max));
        sync();
      }
    },
    [ws, sync, renderText, setStatusMsg]
  );

  const selectSim = useCallback(
    (name: string) => {
      setCreatingName(null);
      setActiveSimName(name);
      const sim = ws.getSim(name);
      if (sim) renderSim(sim);
    },
    [ws, renderSim]
  );

  // commit a sim from the "create new sim" form: add, select, render
  const commitSim = useCallback(
    async (draft: Sim) => {
      ws.addSim(draft); // assigns a unique name
      setCreatingName(null);
      setActiveSimName(draft.name);
      sync();
      await renderSim(draft);
    },
    [ws, renderSim, sync]
  );

  // drop / browse: first user upload replaces the bundled examples, then accumulates.
  // Loose G-code becomes a SOURCE only (no auto-sim); .camotics becomes a sim.
  const addFiles = useCallback(
    async (fileList: FileList) => {
      const arr = Array.from(fileList);
      if (!arr.length) return;
      const named = await Promise.all(arr.map(async (f) => ({ name: f.name, text: await f.text() })));
      const replace = ws.examplesActive;
      ws.examplesActive = false;
      const added = ws.ingest(named, replace);
      sync();
      if (added.length) {
        const last = added[added.length - 1];
        setActiveSimName(last.name);
        await renderSim(last);
      } else {
        if (replace) setActiveSimName(null);
        setStatusMsg(`added ${named.length} source file(s) — click one to create a sim`);
      }
    },
    [ws, sync, renderSim, setStatusMsg]
  );

  // --- bootstrap ------------------------------------------------------------
  useEffect(() => {
    (window as any).__simulate = (text: string, name?: string) =>
      renderText(text, name || 'test', 'mesh', 2, {});
    (window as any).__bakeCut = (text: string, res: number) => bakeCut(text, res);
    (window as any).__loadExample = async (file: string) => {
      const sim = ws.sims.find((s) => s.sourceName === file);
      if (sim) {
        setActiveSimName(sim.name);
        await renderSim(sim);
      }
    };
    // Test hook: ingest a .camotics + its G-code (mirrors a real drop) and render it.
    (window as any).__loadProject = async (camName: string, camText: string, srcName: string, srcText: string) => {
      ws.examplesActive = false;
      const added = ws.ingest([{ name: srcName, text: srcText }, { name: camName, text: camText }], true);
      sync();
      if (added.length) {
        setActiveSimName(added[added.length - 1].name);
        await renderSim(added[added.length - 1]);
      }
    };

    const params = new URLSearchParams(location.search);
    (async () => {
      try {
        const named = await Promise.all(
          EXAMPLES.map(async (e) => ({ name: e.file, text: await fetchExample(e.file) }))
        );
        ws.ingest(named, false); // sources
        ws.makeSimsForAllSources(); // curated example sims (examples only)
        sync();
        if (params.has('empty')) {
          viewerRef.current?.resize();
          setStatusMsg('ready — drop a G-code or .camotics');
        } else {
          const def = ws.sims.find((s) => s.sourceName === DEFAULT_EXAMPLE) || ws.sims[0];
          if (def) {
            setActiveSimName(def.name);
            await renderSim(def);
          }
        }
      } catch (err: any) {
        setStatusMsg('init failed: ' + err, true);
      } finally {
        (window as any).__appReady = true;
        window.dispatchEvent(new Event('app-ready'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- toggles / mode / speed ----------------------------------------------
  useEffect(() => void viewerRef.current?.setShowPath(showPath), [showPath]);
  useEffect(() => void viewerRef.current?.setShowTool(showTool), [showTool]);
  useEffect(() => void viewerRef.current?.setSpeed(speed), [speed]);

  const changeMode = (m: GeomMode) => {
    setGeomMode(m);
    metaRef.current.mode = m;
    const sim = ws.getSim(metaRef.current.active || '');
    if (sim) renderSim(sim);
  };

  // --- workpiece / resolution / color edits (mutate the active sim) ---------
  const editActiveSim = useCallback(
    (mut: (sim: Sim) => Sim, rerender = true) => {
      const sim = ws.getSim(metaRef.current.active || '');
      if (!sim) return;
      const ns = mut(sim);
      ws.replaceSim(sim.name, ns);
      sync();
      if (rerender) renderSim(ns);
    },
    [ws, sync, renderSim]
  );
  const applyWorkpiece = useCallback(
    (size: [number, number, number]) =>
      editActiveSim((sim) => ({
        ...sim,
        doc: {
          ...sim.doc,
          workpiece: { ...sim.doc.workpiece, automatic: false, bounds: boundsFromMinSize(sim.doc.workpiece.bounds.min, size) },
        },
      })),
    [editActiveSim]
  );
  const autoWorkpiece = useCallback(
    () => editActiveSim((sim) => ({ ...sim, doc: { ...sim.doc, workpiece: { ...sim.doc.workpiece, automatic: true } } })),
    [editActiveSim]
  );
  const changeRes = useCallback(
    (m: ResModeName) => editActiveSim((sim) => ({ ...sim, doc: { ...sim.doc, 'resolution-mode': m } })),
    [editActiveSim]
  );

  // --- editor + color + zip -------------------------------------------------
  const saveSource = useCallback(
    (name: string, text: string) => {
      ws.setSourceText(name, text);
      sync();
      setEditingName(null);
      const sim = ws.getSim(metaRef.current.active || '');
      if (sim && sim.sourceName === name) renderSim(sim);
    },
    [ws, sync, renderSim]
  );
  const pickColor = useCallback(
    (hex: string) => {
      viewerRef.current?.setGeomColor(hex);
      editActiveSim((sim) => ({ ...sim, geomColor: hex }), false);
    },
    [editActiveSim]
  );
  const downloadAll = useCallback(() => {
    const entries = ws.zipEntries();
    if (entries.length) downloadZip('camotics-project.zip', entries);
  }, [ws]);

  // --- timeline -------------------------------------------------------------
  const onScrub = (e: Event) => {
    const v = parseFloat((e.currentTarget as HTMLInputElement).value);
    setTime(v);
    viewerRef.current?.scrub(v);
  };
  const step = Math.max(duration / 2000, 0.001);

  // speed slider: log scale 0.1x .. 100x over 0..100
  const speedToT = (s: number) => Math.round((Math.log(s / 0.1) / Math.log(1000)) * 100);
  const tToSpeed = (t: number) => 0.1 * Math.pow(1000, t / 100);
  const speedLabel = speed >= 10 ? speed.toFixed(0) : speed >= 1 ? speed.toFixed(1) : speed.toFixed(2);

  const editingSource = editingName ? sources.find((s) => s.name === editingName) : null;
  const creatingSource = creatingName ? sources.find((s) => s.name === creatingName) : null;

  return (
    <>
      <div id="toolbar">
        <span class="brand">
          <span class="dot" /> WAMotics
        </span>
        <span class="sep" />

        <div class="seg" role="tablist" aria-label="Render mode">
          {([
            ['sdf', 'Incremental SDF'],
            ['mesh', 'Final Mesh'],
            ['none', 'No Geometry'],
          ] as [GeomMode, string][]).map(([m, label]) => (
            <button class={geomMode === m ? 'on' : ''} onClick={() => changeMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <span class="sep" />

        <button
          class={`icon-toggle ${showPath ? 'on' : ''}`}
          title="Toolpath"
          onClick={() => setShowPath((v) => !v)}
        >
          <IconPath />
        </button>
        <button
          class={`icon-toggle ${showTool ? 'on' : ''}`}
          title="Tool marker"
          onClick={() => setShowTool((v) => !v)}
        >
          <IconTool />
        </button>
        <span class="sep" />

        <div class="speed" title="Playback speed">
          <input
            type="range"
            min="0"
            max="100"
            value={String(speedToT(speed))}
            onInput={(e) => setSpeed(tToSpeed(parseFloat((e.currentTarget as HTMLInputElement).value)))}
          />
          <span class="speed-read">{speedLabel}×</span>
        </div>

        <span id="status" class={statusErr ? 'err' : ''}>
          {status}
        </span>
      </div>

      <div id="main">
        <div
          id="canvas-wrap"
          class={dragging ? 'dragging' : ''}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
          }}
        >
          <canvas id="gl" ref={canvasRef} />
          <div id="drop-hint">Drop a G-code or .camotics</div>
        </div>

        <aside id="sidebar">
          {creatingSource ? (
            <CreateSimForm source={creatingSource} onCreate={commitSim} onCancel={() => setCreatingName(null)} />
          ) : (
          <>
          <section class="panel">
            <h2>Status</h2>
            <Row label="Tool" value={dash ? String(dash.tool) : '--'} />
            <Row label="Diameter" value={dash && dash.diameter != null ? fmt(dash.diameter) + ' mm' : '--'} />
            <Row label="Feed" value={dash ? fmt(dash.feed, 0) + ' mm/min' : '--'} />
            <Row label="Speed" value={dash ? fmt(dash.speed, 0) + ' rpm' : '--'} />
            <Row label="X / Y / Z" value={dash ? dash.pos.map((p) => fmt(p, 2)).join('  ') : '--'} />
            <Row label="Time" value={dash ? fmt(dash.time, 2) + ' s' : '--'} />
            <Row label="Triangles" value={tris != null ? tris.toLocaleString() : '--'} />
          </section>

          <section class="panel">
            <h2>Tools</h2>
            {activeSim && activeSim.tools.length ? (
              <table class="tooltable">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Shape</th>
                    <th>Ø</th>
                    <th>Len</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSim.tools.map((t: ToolRow) => (
                    <tr>
                      <td>{t.num}</td>
                      <td>{t.shape}</td>
                      <td>{fmt(t.diameter)}</td>
                      <td>{fmt(t.length)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="muted">no tools</div>
            )}
          </section>

          {activeSim && (
            <WorkpiecePanel
              key={activeSim.name + JSON.stringify(activeSim.doc.workpiece.bounds)}
              sim={activeSim}
              color={activeSim.geomColor}
              onApply={applyWorkpiece}
              onAuto={autoWorkpiece}
              onRes={changeRes}
              onSwatch={(x, y) => setWheel({ x, y })}
            />
          )}
          </>
          )}

          <section class="panel files">
            <h2>
              Files
              <button class="hbtn" title="Download all as .zip" onClick={downloadAll}>
                <IconZip />
              </button>
            </h2>
            <div class="sublabel">Sims</div>
            {sims.length ? (
              sims.map((s) => (
                <div
                  class={`frow ${s.name === activeSimName ? 'active' : ''}`}
                  onClick={() => selectSim(s.name)}
                  onDblClick={() => selectSim(s.name)}
                  title="Open sim"
                >
                  <span class="fic sim">
                    <IconSim />
                  </span>
                  <span class="fname">{s.name}</span>
                </div>
              ))
            ) : (
              <div class="muted">no sims</div>
            )}
            <div class="sublabel">Sources</div>
            {sources.length ? (
              sources.map((s) => (
                <div
                  class={`frow ${s.name === creatingName ? 'active' : ''}`}
                  onClick={() => setCreatingName(s.name)}
                  title="Click to create a sim from this file"
                >
                  <span class="fic">
                    <IconDoc />
                  </span>
                  <span class="fname">{s.name}</span>
                  <button
                    class="rowbtn"
                    title="Edit G-code"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingName(s.name);
                    }}
                  >
                    <IconEdit />
                  </button>
                </div>
              ))
            ) : (
              <div class="muted">no sources</div>
            )}
          </section>

          <div class="grow" />

          <label
            id="dropzone"
            class={dragging ? 'dragging' : ''}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
            }}
          >
            <input
              type="file"
              multiple
              accept=".nc,.ngc,.gcode,.tap,.txt,.camotics"
              onChange={(e) => {
                const f = (e.currentTarget as HTMLInputElement).files;
                if (f) addFiles(f);
                (e.currentTarget as HTMLInputElement).value = '';
              }}
            />
            <span>Drop or browse — G-code / .camotics</span>
          </label>
        </aside>
      </div>

      <div id="timeline-bar">
        <button id="play" class="icon-btn" onClick={() => viewerRef.current?.togglePlay()}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <input
          type="range"
          id="timeline"
          min="0"
          max={String(duration || 1)}
          step={String(step)}
          value={String(time)}
          onInput={onScrub}
        />
        <span id="time-readout">
          {fmt(time, 2)} / {fmt(duration, 2)} s
        </span>
      </div>

      {editingSource && (
        <Editor
          name={editingSource.name}
          text={editingSource.text}
          onSave={(t) => saveSource(editingSource.name, t)}
          onClose={() => setEditingName(null)}
        />
      )}
      {wheel && activeSim && (
        <ColorWheel
          x={wheel.x}
          y={wheel.y}
          color={activeSim.geomColor}
          onChange={pickColor}
          onClose={() => setWheel(null)}
        />
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="label">{label}</span>
      <span class="value">{value}</span>
    </div>
  );
}

// Editable workpiece: a compact "X × Y × Z mm" text line you click to edit, plus the
// resolution and the cut-color swatch in the header. Remounts (via key in the parent)
// whenever the sim's bounds change so the displayed numbers refresh after a bake.
function WorkpiecePanel({
  sim,
  color,
  onApply,
  onAuto,
  onRes,
  onSwatch,
}: {
  sim: Sim;
  color: string;
  onApply: (size: [number, number, number]) => void;
  onAuto: () => void;
  onRes: (m: ResModeName) => void;
  onSwatch: (x: number, y: number) => void;
}) {
  const wp = sim.doc.workpiece;
  const size0 = boundsSize(wp.bounds);
  const [editing, setEditing] = useState(false);
  const [sx, setSx] = useState(size0[0]);
  const [sy, setSy] = useState(size0[1]);
  const [sz, setSz] = useState(size0[2]);
  const num = (v: string, set: (n: number) => void) => {
    const n = parseFloat(v);
    if (isFinite(n)) set(n);
  };
  const d = (n: number) => String(Math.round(n * 100) / 100);
  const apply = () => {
    onApply([sx, sy, sz]);
    setEditing(false);
  };

  return (
    <section class="panel">
      <h2>
        Workpiece
        {wp.automatic ? <span class="badge">auto</span> : <span class="badge edit">custom</span>}
        <span class="hspace" />
        <button
          class="swatch"
          style={{ background: color }}
          title="Cut color"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onSwatch(r.left - 188, r.top);
          }}
        />
      </h2>

      {editing ? (
        <div class="wp-edit">
          <input type="number" step="0.1" value={d(sx)} onInput={(e) => num((e.currentTarget as HTMLInputElement).value, setSx)} />
          <span>×</span>
          <input type="number" step="0.1" value={d(sy)} onInput={(e) => num((e.currentTarget as HTMLInputElement).value, setSy)} />
          <span>×</span>
          <input type="number" step="0.1" value={d(sz)} onInput={(e) => num((e.currentTarget as HTMLInputElement).value, setSz)} />
          <button class="btn primary mini" title="Apply" onClick={apply}>
            ✓
          </button>
          <button class="btn mini" title="Cancel" onClick={() => setEditing(false)}>
            ✕
          </button>
        </div>
      ) : (
        <div class="wp-line" title="Click to edit stock size" onClick={() => setEditing(true)}>
          <span class="wp-dims">
            {d(sx)} × {d(sy)} × {d(sz)}
          </span>
          <span class="unit">mm</span>
          <span class="hspace" />
          {!wp.automatic && (
            <button
              class="link"
              onClick={(e) => {
                e.stopPropagation();
                onAuto();
              }}
            >
              auto-fit
            </button>
          )}
          <span class="pencil">✎</span>
        </div>
      )}

      <div class="row">
        <span class="label">Resolution</span>
        <select
          class="mini"
          value={sim.doc['resolution-mode']}
          onChange={(e) => onRes((e.currentTarget as HTMLSelectElement).value as ResModeName)}
        >
          {RES_NAMES.map((m) => (
            <option value={m}>{m}</option>
          ))}
        </select>
      </div>
    </section>
  );
}

render(<App />, document.getElementById('app')!);
