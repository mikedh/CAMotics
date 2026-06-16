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
#include <camotics/render/RenderMode.h>
#include <camotics/contour/Surface.h>

#include <gcode/ToolPath.h>
#include <gcode/Move.h>
#include <gcode/Tool.h>

#include <cbang/SmartPointer.h>
#include <cbang/Exception.h>

#include <sstream>
#include <fstream>
#include <iomanip>
#include <vector>
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
static string toolpathToJSON(const ToolPath &path) {
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
  SmartPointer<ToolPath> path = cutSim.computeToolPath(project);
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

public:
  // resMode: 1=low 2=medium 3=high 4=very-high. Throws on bad G-code.
  void run(string gcode, int resMode) {
    tpJson.clear(); verts.clear(); norms.clear(); tris = 0; durationS = 0;

    writeGCode(gcode);
    Project::Project project;
    project.addFile("/input.ngc");
    project.setResolutionMode(resModeFromInt(resMode));

    CutSim cutSim;
    SmartPointer<ToolPath> path = cutSim.computeToolPath(project);
    tpJson = toolpathToJSON(*path);
    durationS = path->getTime();

    // Auto-compute the workpiece bounds from the path BEFORE reading bounds/
    // resolution (raw .nc has an automatic workpiece that is empty until update).
    // Pass the Rectangle3D bounds (implicitly -> Simulation's Workpiece), exactly
    // as camsim.cpp does.
    project.getWorkpiece().update(*path);
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
    .function("toolpathJSON",  &Sim::toolpathJSON)
    .function("triangleCount", &Sim::triangleCount)
    .function("duration",      &Sim::duration)
    .function("positions",     &Sim::positions)
    .function("normals",       &Sim::normals);
}
