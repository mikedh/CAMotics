/*
  path2json — minimal companion to camsim. Loads a CAMotics project / GCode file,
  computes the GCode::ToolPath, and emits the move list (with per-move tool, feed,
  speed and timing) as JSON matching the three.js viewer's data contract.
  Pure headless reuse of libCAMotics/libGCode; no GUI, no TPL, no V8.
*/
#include <camotics/project/Project.h>
#include <camotics/sim/CutSim.h>

#include <gcode/ToolPath.h>
#include <gcode/Move.h>
#include <gcode/Tool.h>

#include <cbang/SmartPointer.h>
#include <cbang/os/SystemUtilities.h>
#include <cbang/Exception.h>

#include <iostream>
#include <fstream>
#include <iomanip>

using namespace cb;
using namespace std;
using namespace GCode;

static void vec(ostream &o, const Vector3D &v) {
  o << '[' << v[0] << ',' << v[1] << ',' << v[2] << ']';
}

int main(int argc, char *argv[]) {
  try {
    if (argc < 3) {
      cerr << "usage: path2json <project.camotics|input.gcode> <output.json>\n";
      return 1;
    }
    string input = argv[1];

    CAMotics::Project::Project project;
    string ext = SystemUtilities::extension(input);
    if (ext == "xml" || ext == "camotics") project.load(input);
    else project.addFile(input);

    CAMotics::CutSim cutSim;
    SmartPointer<ToolPath> path = cutSim.computeToolPath(project);

    ofstream out(argv[2]);
    out << setprecision(6) << fixed;
    out << "{\n  \"moves\": [\n";
    for (unsigned i = 0; i < path->size(); i++) {
      const Move &m = (*path)[i];
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
      out << (i + 1 < path->size() ? ",\n" : "\n");
    }
    out << "  ],\n  \"tools\": {\n";
    const ToolTable &tools = path->getTools();
    size_t n = 0;
    for (auto it = tools.begin(); it != tools.end(); ++it, ++n) {
      const Tool &t = it->second;
      out << "    \"" << it->first << "\": {\"shape\":\"" << t.getShape().toString()
          << "\",\"diameter\":" << t.getDiameter()
          << ",\"length\":" << t.getLength() << "}"
          << (n + 1 < tools.size() ? ",\n" : "\n");
    }
    const Rectangle3D &b = path->getBounds();
    out << "  },\n  \"duration\": " << path->getTime() << ",\n";
    out << "  \"bounds\": {\"min\":";
    vec(out, b.getMin());
    out << ",\"max\":";
    vec(out, b.getMax());
    out << "}\n}\n";
    out.close();

    cerr << "path2json: " << path->size() << " moves, " << tools.size()
         << " tools, duration " << path->getTime() << "s -> " << argv[2] << "\n";
    return 0;
  } catch (const Exception &e) {
    cerr << "path2json error: " << e << "\n";
    return 2;
  } catch (const std::exception &e) {
    cerr << "path2json error: " << e.what() << "\n";
    return 2;
  }
}
