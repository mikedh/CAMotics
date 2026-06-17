/*
  glue.cpp — Emscripten/embind entry point for the in-browser CAMotics core.
  No GUI, no TPL/V8, no networking. Loads raw G-code via Project::addFile (avoids
  XML/expat at runtime). Two entry points:
    - loadGCode(text)            : ToolPath JSON only (fast, path-only viewer).
    - class Sim                  : ToolPath JSON + the simulated cut SURFACE mesh
                                   (marching cubes). Runs single-threaded
                                   (threads=1) so it works without -pthread;
                                   Renderer was patched to run jobs inline then.
*/
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <camotics/project/Project.h>
#include <camotics/project/ResolutionMode.h>
#include <camotics/sim/CutSim.h>
#include <camotics/sim/Simulation.h>
#include <camotics/sim/ToolSweep.h>
#include <camotics/sim/CutWorkpiece.h>
#include <camotics/sim/Workpiece.h>
#include <camotics/render/RenderMode.h>
#include <camotics/contour/Surface.h>
#include <camotics/Grid.h>

#include <gcode/ToolPath.h>
#include <gcode/Move.h>
#include <gcode/Tool.h>

#include <cbang/SmartPointer.h>
#include <cbang/Exception.h>

#include <gcode/ToolShape.h>

#include <sstream>
#include <fstream>
#include <iomanip>
#include <vector>
#include <map>
#include <algorithm>
#include <cfloat>

using namespace cb;
using namespace std;
using namespace GCode;
using namespace CAMotics;
using namespace emscripten;

static void vec(ostream &o, const Vector3D &v) {
  o << '[' << v[0] << ',' << v[1] << ',' << v[2] << ']';
}

// Serialize a ToolPath to the three.js viewer's JSON contract.
static string toolpathToJSON(const GCode::ToolPath &path) {
  ostringstream out;
  out << setprecision(6) << fixed;
  out << "{\n  \"moves\": [\n";
  for (unsigned i = 0; i < path.size(); i++) {
    const Move &m = path[i];
    const char *type = (m.getType() == MoveType::MOVE_RAPID) ? "rapid" : "cut";
    out << "    {\"type\":\"" << type << "\",\"start\":";
    vec(out, m.getStartPt());
    out << ",\"end\":";
    vec(out, m.getEndPt());
    out << ",\"tool\":" << m.getTool()
        << ",\"feed\":" << m.getFeed()
        << ",\"speed\":" << m.getSpeed()
        << ",\"tStart\":" << m.getStartTime()
        << ",\"tEnd\":" << m.getEndTime() << "}";
    out << (i + 1 < path.size() ? ",\n" : "\n");
  }
  out << "  ],\n  \"tools\": {\n";
  const ToolTable &tools = path.getTools();
  size_t n = 0;
  for (auto it = tools.begin(); it != tools.end(); ++it, ++n) {
    const Tool &t = it->second;
    out << "    \"" << it->first << "\": {\"shape\":\"" << t.getShape().toString()
        << "\",\"diameter\":" << t.getDiameter()
        << ",\"length\":" << t.getLength() << "}"
        << (n + 1 < tools.size() ? ",\n" : "\n");
  }
  const Rectangle3D &b = path.getBounds();
  out << "  },\n  \"duration\": " << path.getTime() << ",\n";
  out << "  \"bounds\": {\"min\":";
  vec(out, b.getMin());
  out << ",\"max\":";
  vec(out, b.getMax());
  out << "}\n}\n";
  return out.str();
}

static void writeGCode(const string &gcode) {
  ofstream f("/input.ngc");
  f << gcode;
}

// Path-only entry: G-code text -> ToolPath JSON. Throws -> JS exception.
static string loadGCode(string gcode) {
  writeGCode(gcode);
  Project::Project project;
  project.addFile("/input.ngc");
  CutSim cutSim;
  SmartPointer<GCode::ToolPath> path = cutSim.computeToolPath(project);
  return toolpathToJSON(*path);
}

static ResolutionMode resModeFromInt(int m) {
  switch (m) {
  case 1:  return ResolutionMode::RESOLUTION_LOW;
  case 3:  return ResolutionMode::RESOLUTION_HIGH;
  case 4:  return ResolutionMode::RESOLUTION_VERY_HIGH;
  default: return ResolutionMode::RESOLUTION_MEDIUM;
  }
}

// Full sim: G-code -> ToolPath JSON + cut surface mesh (vertices+normals).
// JS owns an instance; reads typed-memory views then .delete()s it.
class Sim {
  string tpJson;
  vector<float> verts;   // flat xyz triples, non-indexed (9 floats / triangle)
  vector<float> norms;   // parallel per-vertex normals
  unsigned tris = 0;
  double durationS = 0;

  // Baked voxel field for GPU time-scrubbing: interleaved RG per voxel,
  // R = final signed depth (>0 inside material), G = removalTime in (0,1] with
  // sentinels 0 = outside stock (air), >1 = in-stock-never-cut (permanent).
  // Analytic cut export: moves (9 floats each), tool table (4 floats each), and a
  // uniform-grid CSR binning moves by their swept bbox -> the GPU evaluates the
  // cut as max(stockSDF, -min over time-gated moves of sweptToolDistance).
  vector<float> movesData;        // x0,y0,z0, x1,y1,z1, tStart, tEnd, toolIdx
  vector<float> toolsData;        // shape, radius, length, snubRadius
  vector<uint32_t> cellStartData; // CSR offsets, length gnx*gny*gnz + 1
  vector<uint32_t> cellMovesData; // CSR move indices
  int nMovesV = 0, nToolsV = 0;
  int gnx = 0, gny = 0, gnz = 0;
  double gOrigin[3] = {0, 0, 0};
  double gCell = 0;

public:
  // resMode: 1=low 2=medium 3=high 4=very-high. Throws on bad G-code.
  void run(string gcode, int resMode) {
    tpJson.clear(); verts.clear(); norms.clear(); tris = 0; durationS = 0;

    writeGCode(gcode);
    Project::Project project;
    project.addFile("/input.ngc");
    project.setResolutionMode(resModeFromInt(resMode));

    CutSim cutSim;
    SmartPointer<GCode::ToolPath> path = cutSim.computeToolPath(project);
    durationS = path->getTime();

    // Auto-compute the workpiece bounds from the path BEFORE reading bounds/
    // resolution (raw .nc has an automatic workpiece that is empty until update).
    // This also populates the tool table, so toolpathToJSON must run AFTER it
    // (else "tools" serializes empty -> marker Ø fallback + dashboard "--").
    project.getWorkpiece().update(*path);
    tpJson = toolpathToJSON(*path);
    Rectangle3D bounds = project.getWorkpiece().getBounds();
    double resolution = project.getResolution();

    Simulation sim(path, 0, 0, bounds, resolution,
                   DBL_MAX, RenderMode::MCUBES_MODE, /*threads=*/1);

    SmartPointer<Surface> surface = cutSim.computeSurface(sim);
    tris = (unsigned)surface->getTriangleCount();
    surface->getVertices([this](const vector<float> &v, const vector<float> &n) {
      verts.insert(verts.end(), v.begin(), v.end());
      norms.insert(norms.end(), n.begin(), n.end());
    });
  }

  // Export analytic cut data: moves + tool table + uniform-grid CSR. The GPU
  // evaluates solid = max(stockSDF, -min over time-gated moves of swept-tool dist).
  val bakeCut(string gcode, int resMode) {
    movesData.clear(); toolsData.clear();
    cellStartData.clear(); cellMovesData.clear();

    writeGCode(gcode);
    Project::Project project;
    project.addFile("/input.ngc");
    project.setResolutionMode(resModeFromInt(resMode));

    CutSim cutSim;
    SmartPointer<GCode::ToolPath> path = cutSim.computeToolPath(project);
    // update() before toolpathToJSON: the tool table isn't populated until the
    // workpiece update, so serializing earlier emits an empty "tools" map (which
    // made the marker fall back to Ø3 and the dashboard show "--").
    project.getWorkpiece().update(*path);
    tpJson = toolpathToJSON(*path);
    double duration = path->getTime();
    durationS = duration;

    Rectangle3D wb = project.getWorkpiece().getBounds();

    // Tool table: dense index per tool number; emit [shape, radius, length, snubR].
    const ToolTable &tools = path->getTools();
    std::map<int, int> toolIdx;
    double maxRadius = 0;
    for (auto it = tools.begin(); it != tools.end(); ++it) {
      int dense = (int)toolIdx.size();
      toolIdx[(int)it->first] = dense;
      const Tool &t = it->second;
      ToolShape s = t.getShape();
      int shape = 0;
      if (s == ToolShape::TS_CONICAL) shape = 1;
      else if (s == ToolShape::TS_BALLNOSE) shape = 2;
      else if (s == ToolShape::TS_SPHEROID) shape = 3;
      else if (s == ToolShape::TS_SNUBNOSE) shape = 4;
      toolsData.push_back((float)shape);
      toolsData.push_back((float)t.getRadius());
      toolsData.push_back((float)t.getLength());
      toolsData.push_back((float)(t.getSnubDiameter() * 0.5));
      if (t.getRadius() > maxRadius) maxRadius = t.getRadius();
    }
    nToolsV = (int)toolIdx.size();

    // Moves (+ per-move swept bbox for grid binning).
    struct MV { float d[9]; double bmin[3], bmax[3]; };
    std::vector<MV> ms;
    for (unsigned i = 0; i < path->size(); i++) {
      const Move &mv = (*path)[i];
      int tnum = mv.getTool();
      auto f = toolIdx.find(tnum);
      if (tnum < 0 || f == toolIdx.end()) continue;
      int dense = f->second;
      int shape = (int)toolsData[dense * 4 + 0];
      double radius = toolsData[dense * 4 + 1];
      double length = toolsData[dense * 4 + 2];
      double zoff = (shape == 2 || shape == 3) ? -radius : 0; // ballnose/spheroid dip below tip
      const Vector3D &a = mv.getStartPt();
      const Vector3D &b = mv.getEndPt();
      MV m;
      m.d[0] = a.x(); m.d[1] = a.y(); m.d[2] = a.z();
      m.d[3] = b.x(); m.d[4] = b.y(); m.d[5] = b.z();
      m.d[6] = (float)mv.getStartTime();
      m.d[7] = (float)mv.getEndTime();
      m.d[8] = (float)dense;
      m.bmin[0] = std::min(a.x(), b.x()) - radius;
      m.bmin[1] = std::min(a.y(), b.y()) - radius;
      m.bmin[2] = std::min(a.z(), b.z()) + zoff;
      m.bmax[0] = std::max(a.x(), b.x()) + radius;
      m.bmax[1] = std::max(a.y(), b.y()) + radius;
      m.bmax[2] = std::max(a.z(), b.z()) + length;
      ms.push_back(m);
    }
    nMovesV = (int)ms.size();
    // Sort by tStart so each grid cell's CSR move list ends up tStart-ascending;
    // the shader can then STOP scanning a cell once a move hasn't started yet
    // (temporal pruning while scrubbing). The SDF is a min over moves, so order
    // is otherwise irrelevant; the dashboard/path use the separate toolpath order.
    std::stable_sort(ms.begin(), ms.end(),
                     [](const MV &a, const MV &b){ return a.d[6] < b.d[6]; });
    movesData.reserve((size_t)nMovesV * 9);
    for (auto &m : ms) for (int k = 0; k < 9; k++) movesData.push_back(m.d[k]);

    // Uniform grid over the stock bounds (padded by max tool radius).
    Vector3D mn = wb.getMin(), mx = wb.getMax();
    double pad = maxRadius + 1e-3;
    double ox = mn.x() - pad, oy = mn.y() - pad, oz = mn.z() - pad;
    double ex = (mx.x() + pad) - ox, ey = (mx.y() + pad) - oy, ez = (mx.z() + pad) - oz;
    double longest = std::max(ex, std::max(ey, ez));
    double cell = longest / 64.0; if (cell <= 0) cell = 1;
    gnx = std::max(1, (int)std::ceil(ex / cell));
    gny = std::max(1, (int)std::ceil(ey / cell));
    gnz = std::max(1, (int)std::ceil(ez / cell));
    gCell = cell; gOrigin[0] = ox; gOrigin[1] = oy; gOrigin[2] = oz;
    size_t nCells = (size_t)gnx * gny * gnz;

    auto cl = [](int v, int hi){ return v < 0 ? 0 : (v > hi ? hi : v); };
    auto range = [&](const MV &m, int *r) {
      r[0]=cl((int)std::floor((m.bmin[0]-ox)/cell),gnx-1); r[1]=cl((int)std::floor((m.bmax[0]-ox)/cell),gnx-1);
      r[2]=cl((int)std::floor((m.bmin[1]-oy)/cell),gny-1); r[3]=cl((int)std::floor((m.bmax[1]-oy)/cell),gny-1);
      r[4]=cl((int)std::floor((m.bmin[2]-oz)/cell),gnz-1); r[5]=cl((int)std::floor((m.bmax[2]-oz)/cell),gnz-1);
    };
    std::vector<uint32_t> counts(nCells, 0);
    for (auto &m : ms) { int r[6]; range(m,r);
      for (int z=r[4];z<=r[5];z++) for (int y=r[2];y<=r[3];y++) for (int x=r[0];x<=r[1];x++)
        counts[((size_t)z*gny+y)*gnx+x]++; }
    cellStartData.resize(nCells + 1); cellStartData[0] = 0;
    for (size_t c = 0; c < nCells; c++) cellStartData[c+1] = cellStartData[c] + counts[c];
    cellMovesData.resize(cellStartData[nCells]);
    std::vector<uint32_t> cur(cellStartData.begin(), cellStartData.end()-1);
    for (int mi = 0; mi < nMovesV; mi++) { int r[6]; range(ms[mi],r);
      for (int z=r[4];z<=r[5];z++) for (int y=r[2];y<=r[3];y++) for (int x=r[0];x<=r[1];x++)
        cellMovesData[cur[((size_t)z*gny+y)*gnx+x]++] = (uint32_t)mi; }

    val o = val::object();
    o.set("toolpath", tpJson);
    o.set("duration", duration);
    o.set("nMoves", nMovesV);
    o.set("nTools", nToolsV);
    o.set("moves", val(typed_memory_view(movesData.size(), movesData.data())));
    o.set("tools", val(typed_memory_view(toolsData.size(), toolsData.data())));
    val a3 = val::array(); a3.call<void>("push", mn.x()); a3.call<void>("push", mn.y()); a3.call<void>("push", mn.z());
    val a4 = val::array(); a4.call<void>("push", mx.x()); a4.call<void>("push", mx.y()); a4.call<void>("push", mx.z());
    o.set("stockMin", a3); o.set("stockMax", a4);
    val gd = val::array(); gd.call<void>("push", gnx); gd.call<void>("push", gny); gd.call<void>("push", gnz);
    val gO = val::array(); gO.call<void>("push", gOrigin[0]); gO.call<void>("push", gOrigin[1]); gO.call<void>("push", gOrigin[2]);
    o.set("gridDims", gd); o.set("gridOrigin", gO); o.set("gridCell", gCell);
    o.set("cellStart", val(typed_memory_view(cellStartData.size(), cellStartData.data())));
    o.set("cellMoves", val(typed_memory_view(cellMovesData.size(), cellMovesData.data())));
    return o;
  }

  string toolpathJSON() const { return tpJson; }
  unsigned triangleCount() const { return tris; }
  double duration() const { return durationS; }
  // typed-memory views alias C++ memory; JS must .slice() before delete().
  val positions() { return val(typed_memory_view(verts.size(), verts.data())); }
  val normals()   { return val(typed_memory_view(norms.size(), norms.data())); }
};

EMSCRIPTEN_BINDINGS(camotics) {
  emscripten::function("loadGCode", &loadGCode);

  class_<Sim>("Sim")
    .constructor<>()
    .function("run",           &Sim::run)
    .function("bakeCut",       &Sim::bakeCut)
    .function("toolpathJSON",  &Sim::toolpathJSON)
    .function("triangleCount", &Sim::triangleCount)
    .function("duration",      &Sim::duration)
    .function("positions",     &Sim::positions)
    .function("normals",       &Sim::normals);
}
