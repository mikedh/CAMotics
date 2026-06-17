#!/usr/bin/env python3
"""Probe Sim::bakeCut export: move/tool/grid stats + CSR sanity. Headless."""
import threading, http.server, socketserver, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
CHROMIUM = "/snap/bin/chromium"
EXAMPLES = ["scorpion.nc", "heart.ngc", "vcarve.ngc"]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(DIST), **k)
    def end_headers(self): self.send_header("Cache-Control", "no-store"); super().end_headers()
    def log_message(self, *a): pass


Handler.extensions_map = dict(Handler.extensions_map); Handler.extensions_map['.wasm'] = 'application/wasm'


def main():
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    exroot = HERE.parents[1] / "examples"
    paths = {"scorpion.nc": exroot/"scorpion/scorpion.nc", "heart.ngc": exroot/"heart/heart.ngc",
             "vcarve.ngc": exroot/"vcarve/vcarve.ngc"}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM, args=[
            "--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{port}/index.html?empty=1")
        pg.wait_for_function("window.__bakeCut!==undefined", timeout=60000)
        for ex in EXAMPLES:
            g = paths[ex].read_text()
            r = pg.evaluate("""async (g)=>{
              const c = await window.__bakeCut(g, 2);
              // CSR stats
              const cs = c.cellStart; let maxBin=0, nonEmpty=0, totalBin=0;
              for (let i=0;i<cs.length-1;i++){const n=cs[i+1]-cs[i]; if(n>0)nonEmpty++; if(n>maxBin)maxBin=n; totalBin+=n;}
              // tool table readback
              const tools=[]; for(let i=0;i<c.nTools;i++){tools.push([c.tools[i*4],c.tools[i*4+1],c.tools[i*4+2],c.tools[i*4+3]]);}
              // move time range
              let tmin=1e30,tmax=-1e30; for(let i=0;i<c.nMoves;i++){const a=c.moves[i*9+6],b=c.moves[i*9+7]; if(a<tmin)tmin=a; if(b>tmax)tmax=b;}
              const nCells=c.gridDims[0]*c.gridDims[1]*c.gridDims[2];
              return {nMoves:c.nMoves,nTools:c.nTools,dur:c.duration,grid:c.gridDims,cell:c.gridCell,
                nCells, csrLen:c.cellMoves.length, maxBin, nonEmpty, avgBin:totalBin/Math.max(1,nonEmpty),
                tools, tmin, tmax, stockMin:c.stockMin, stockMax:c.stockMax,
                m0:[c.moves[0],c.moves[1],c.moves[2],c.moves[3],c.moves[4],c.moves[5],c.moves[6],c.moves[7],c.moves[8]]};
            }""", g)
            print(f"\n=== {ex} ===")
            print(f"  moves={r['nMoves']}  tools={r['nTools']}  dur={r['dur']:.2f}s")
            print(f"  grid={r['grid']} ({r['nCells']} cells) cell={r['cell']:.3f}")
            print(f"  CSR entries={r['csrLen']}  nonEmptyCells={r['nonEmpty']}  maxBin={r['maxBin']}  avgBin={r['avgBin']:.1f}")
            print(f"  move time range=[{r['tmin']:.3f},{r['tmax']:.3f}]  (dur={r['dur']:.3f})")
            print(f"  stock=[{[round(x,2) for x in r['stockMin']]} .. {[round(x,2) for x in r['stockMax']]}]")
            print(f"  tools (shape,r,len,snub): {[[round(v,3) for v in t] for t in r['tools']]}")
            print(f"  move[0]={[round(v,3) for v in r['m0']]}")
        if errs: print("\nERRORS:", errs[:5])
        b.close()
    httpd.shutdown()
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
