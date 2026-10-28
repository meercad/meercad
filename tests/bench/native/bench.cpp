// Native replay of the OCCT calls recorded by record.ts (same operands, same calls), plus meshing,
// volume and area of the final bodies. replay.ts does exactly the same in WASM.
// Build: ./build.sh   Run: ./bench <recordDir> [par]
#include <BOPAlgo_Options.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopoDS_Shape.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

static double now() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

static double median(std::function<void()> fn, int runs = 5) {
  std::vector<double> t;
  for (int i = 0; i < runs; i++) {
    double a = now();
    fn();
    t.push_back(now() - a);
  }
  std::sort(t.begin(), t.end());
  return t[t.size() / 2];
}

static TopoDS_Shape load(const std::string& path) {
  TopoDS_Shape s;
  BRep_Builder b;
  if (!BRepTools::Read(s, path.c_str(), b)) {
    fprintf(stderr, "cannot read %s\n", path.c_str());
    exit(1);
  }
  return s;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: bench <recordDir> [par]\n");
    return 1;
  }
  std::string dir = argv[1];
  bool par = argc > 2 && std::strcmp(argv[2], "par") == 0;
  BOPAlgo_Options::SetParallelMode(par);

  std::ifstream in(dir + "/index.json");
  std::stringstream ss;
  ss << in.rdbuf();
  std::string json = ss.str();

  // index.json is written by record.ts: pull out {"op": .., "files": [..], "wasmMs": ..} entries.
  std::regex rec(R"re("op":\s*"(\w+)",\s*"files":\s*\[\s*"([^"]+)"(?:,\s*"([^"]+)")?\s*\],\s*"wasmMs":\s*([\d.eE+-]+))re");
  std::map<std::string, double> nat, wasm;
  std::map<std::string, int> count;
  for (auto it = std::sregex_iterator(json.begin(), json.end(), rec); it != std::sregex_iterator(); ++it) {
    std::string op = (*it)[1], a = (*it)[2], b = (*it)[3];
    double w = std::stod((*it)[4]);
    TopoDS_Shape sa = load(dir + "/" + a);
    TopoDS_Shape sb = b.empty() ? TopoDS_Shape() : load(dir + "/" + b);
    double ms = median([&] {
      if (op == "BRepAlgoAPI_Cut") BRepAlgoAPI_Cut(sa, sb).Shape();
      else if (op == "BRepAlgoAPI_Fuse") BRepAlgoAPI_Fuse(sa, sb).Shape();
      else if (op == "BRepAlgoAPI_Common") BRepAlgoAPI_Common(sa, sb).Shape();
      else if (op == "UnifySameDomain") {
        ShapeUpgrade_UnifySameDomain u(sa, true, true, false);
        u.Build();
      }
    });
    nat[op] += ms;
    wasm[op] += w;
    count[op]++;
  }
  double tn = 0, tw = 0;
  for (auto& [op, ms] : nat) {
    printf("%-20s %3d calls  native %8.1f ms  (wasm in rebuild %8.1f ms)\n", op.c_str(), count[op], ms, wasm[op]);
    tn += ms;
    tw += wasm[op];
  }
  printf("%-20s            native %8.1f ms  (wasm in rebuild %8.1f ms)\n", "total", tn, tw);

  std::regex body(R"re("(body-[^"]+\.brep)")re");
  for (auto it = std::sregex_iterator(json.begin(), json.end(), body); it != std::sregex_iterator(); ++it) {
    TopoDS_Shape s = load(dir + "/" + std::string((*it)[1]));
    Bnd_Box box;
    BRepBndLib::Add(s, box, false);
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    double lin = std::max(0.01, std::hypot(x1 - x0, y1 - y0, z1 - z0) * 5e-4);
    double mesh = median([&] {
      BRepTools::Clean(s, true);
      BRepMesh_IncrementalMesh(s, lin, false, 0.06, par);
    });
    double props = median([&] {
      GProp_GProps v, a;
      BRepGProp::VolumeProperties(s, v, false, false, false);
      BRepGProp::SurfaceProperties(s, a, false, false);
    });
    printf("%s: mesh %.1f ms, volume+area %.1f ms\n", std::string((*it)[1]).c_str(), mesh, props);
  }
  return 0;
}
