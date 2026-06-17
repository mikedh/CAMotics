// ---------------------------------------------------------------------------
// Preact root. The UI chrome (toolbar / dashboard / timeline + the canvas) that
// drives the imperative three.js Viewer controller. Two modes: the analytic GPU
// cut (default, squirm-free + depth-occluded) and the CAMotics mesh (validation).
// ---------------------------------------------------------------------------

import { render } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { Viewer, type DashState } from './viewer';
import { simulate, bakeCut } from './camotics';
import { EXAMPLES, DEFAULT_EXAMPLE, fetchExample } from './examples';

type RenderMode = 'cut' | 'mesh';

function fmt(n: number | null | undefined, d = 2): string {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '--';
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const [status, setStatus] = useState('loading…');
  const [statusErr, setStatusErr] = useState(false);
  const [resMode, setResMode] = useState(2);
  const [mode, setMode] = useState<RenderMode>('cut');
  const [showGeom, setShowGeom] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [selectedExample, setSelectedExample] = useState(DEFAULT_EXAMPLE);

  const [dash, setDash] = useState<DashState | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [tris, setTris] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);

  // re-simulate inputs (kept in refs so callbacks don't go stale)
  const lastGCode = useRef<string | null>(null);
  const lastName = useRef<string>('');
  const resModeRef = useRef(resMode);
  resModeRef.current = resMode;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const setStatusMsg = useCallback((msg: string, err = false) => {
    setStatus(msg);
    setStatusErr(err);
  }, []);

  // --- viewer lifecycle (init on mount / dispose on unmount) ---------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const viewer = new Viewer(canvas);
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

  // --- simulate G-code in wasm -> render ------------------------------------
  const runSim = useCallback(
    async (text: string, name: string, modeOverride?: RenderMode) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      lastGCode.current = text;
      lastName.current = name || lastName.current;
      const res = resModeRef.current;
      const rmode = modeOverride ?? modeRef.current;
      const verb = rmode === 'mesh' ? 'simulating' : 'baking';
      setStatusMsg(`${verb} ${lastName.current}…`);
      // let the status paint before the synchronous wasm call blocks the thread
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const t0 = performance.now();
        if (rmode === 'cut') {
          const cut = await bakeCut(text, res);
          const ms = performance.now() - t0;
          viewer.renderCut(cut);
          setTris(null);
          setStatusMsg(
            `${lastName.current}: ${cut.nMoves.toLocaleString()} moves, ` +
              `${cut.nTools} tool${cut.nTools === 1 ? '' : 's'}, ` +
              `${cut.gridDims.join('×')} grid, ${fmt(cut.duration, 1)} s, ${ms | 0} ms`
          );
        } else {
          const result = await simulate(text, res);
          const ms = performance.now() - t0;
          viewer.renderResult(result.toolpath, result);
          setTris(result.triangleCount);
          setStatusMsg(
            `${lastName.current}: ${result.triangleCount.toLocaleString()} tris, ` +
              `${result.toolpath.moves.length.toLocaleString()} moves, ` +
              `${fmt(result.toolpath.duration, 1)} s, ${ms | 0} ms`
          );
        }
      } catch (e: any) {
        setStatusMsg(`error: ${e && e.message ? e.message : e}`, true);
        throw e;
      }
    },
    [setStatusMsg]
  );

  const loadExample = useCallback(
    async (file: string) => {
      try {
        const text = await fetchExample(file);
        await runSim(text, file);
      } catch (e: any) {
        setStatusMsg(`could not load ${file}`, true);
      }
    },
    [runSim, setStatusMsg]
  );

  // --- bootstrap: auto-load default example through the wasm ----------------
  useEffect(() => {
    // expose e2e + debug hooks (parity with the vanilla app)
    // __simulate is the mesh-render hook (surface + triangles) used by e2e; force
    // mesh regardless of the UI's current mode (default is the analytic cut).
    (window as any).__simulate = (text: string, name?: string) => runSim(text, name || 'test', 'mesh');
    (window as any).__bakeCut = (text: string, res: number) => bakeCut(text, res);

    const params = new URLSearchParams(location.search);
    if (params.has('empty')) {
      viewerRef.current?.resize();
      setStatusMsg('ready — drop a G-code');
      (window as any).__appReady = true;
      window.dispatchEvent(new Event('app-ready'));
      return;
    }
    loadExample(DEFAULT_EXAMPLE).catch((err) => {
      console.error('viewer init failed', err);
      setStatusMsg('init failed: ' + err, true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- propagate toggle/res changes to the viewer ---------------------------
  useEffect(() => {
    viewerRef.current?.setShowGeom(showGeom);
  }, [showGeom]);
  useEffect(() => {
    viewerRef.current?.setShowPath(showPath);
  }, [showPath]);

  const onResChange = (v: number) => {
    setResMode(v);
    resModeRef.current = v;
    if (lastGCode.current) runSim(lastGCode.current, lastName.current);
  };

  const onModeChange = (m: RenderMode) => {
    setMode(m);
    modeRef.current = m;
    if (lastGCode.current) runSim(lastGCode.current, lastName.current);
  };

  const onExampleChange = (file: string) => {
    setSelectedExample(file);
    loadExample(file);
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files && input.files[0];
    if (!f) return;
    await runSim(await f.text(), f.name);
  };

  // --- drag and drop --------------------------------------------------------
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    await runSim(await f.text(), f.name);
  };

  // --- timeline -------------------------------------------------------------
  const onScrub = (e: Event) => {
    const v = parseFloat((e.currentTarget as HTMLInputElement).value);
    setTime(v);
    viewerRef.current?.scrub(v);
  };
  const onPlay = () => viewerRef.current?.togglePlay();

  const step = Math.max(duration / 2000, 0.001);

  return (
    <>
      <div id="toolbar">
        <label for="examples">Example</label>
        <select
          id="examples"
          value={selectedExample}
          onChange={(e) => onExampleChange((e.currentTarget as HTMLSelectElement).value)}
        >
          {EXAMPLES.map((ex) => (
            <option value={ex.file}>{ex.label}</option>
          ))}
        </select>
        <span class="sep" />
        <label for="file">Open</label>
        <input type="file" id="file" accept=".nc,.ngc,.gcode,.tap,.txt" onChange={onFile} />
        <span class="sep" />
        <label for="resolution">Resolution</label>
        <select
          id="resolution"
          value={String(resMode)}
          onChange={(e) => onResChange(parseInt((e.currentTarget as HTMLSelectElement).value, 10))}
        >
          <option value="1">Low</option>
          <option value="2">Medium</option>
          <option value="3">High</option>
        </select>
        <span class="sep" />
        <label for="mode">Render</label>
        <select
          id="mode"
          value={mode}
          onChange={(e) => onModeChange((e.currentTarget as HTMLSelectElement).value as RenderMode)}
        >
          <option value="cut">Cut (analytic)</option>
          <option value="mesh">Mesh</option>
        </select>
        <span class="sep" />
        <label class="toggle">
          <input
            type="checkbox"
            id="show-geom"
            checked={showGeom}
            onChange={(e) => setShowGeom((e.currentTarget as HTMLInputElement).checked)}
          />{' '}
          Geometry
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            id="show-path"
            checked={showPath}
            onChange={(e) => setShowPath((e.currentTarget as HTMLInputElement).checked)}
          />{' '}
          Path
        </label>
        <span id="status" class={statusErr ? 'err' : ''}>
          {status}
        </span>
      </div>

      <div id="main">
        <div
          id="canvas-wrap"
          ref={wrapRef}
          class={dragging ? 'dragging' : ''}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <canvas id="gl" ref={canvasRef} />
          <div id="drop-hint">Drop a G-code file to simulate</div>
        </div>
        <div id="dashboard">
          <h2>Simulation</h2>
          <Row label="Tool" value={dash ? String(dash.tool) : '--'} />
          <Row
            label="Diameter"
            value={dash && dash.diameter != null ? fmt(dash.diameter) + ' mm' : '--'}
          />
          <Row label="Feed" value={dash ? fmt(dash.feed, 0) + ' mm/min' : '--'} />
          <Row label="Speed" value={dash ? fmt(dash.speed, 0) + ' rpm' : '--'} />
          <Row label="Position X" value={dash ? fmt(dash.pos[0], 3) : '--'} />
          <Row label="Position Y" value={dash ? fmt(dash.pos[1], 3) : '--'} />
          <Row label="Position Z" value={dash ? fmt(dash.pos[2], 3) : '--'} />
          <Row label="Time" value={dash ? fmt(dash.time, 3) + ' s' : '--'} />
          <Row label="Triangles" value={tris != null ? tris.toLocaleString() : '--'} />
          <div class="legend">
            <div>
              <span class="chip geom" />
              Cut geometry
            </div>
            <div>
              <span class="chip cut" />
              Cut move
            </div>
            <div>
              <span class="chip rapid" />
              Rapid move
            </div>
          </div>
        </div>
      </div>

      <div id="timeline-bar">
        <button id="play" onClick={onPlay}>
          {playing ? 'Pause' : 'Play'}
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
          {fmt(time, 3)} / {fmt(duration, 3)} s
        </span>
      </div>
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

render(<App />, document.getElementById('app')!);
