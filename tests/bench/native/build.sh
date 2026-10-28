#!/bin/sh
# Builds the native benchmark against Homebrew's OCCT (brew install opencascade).
set -e
cd "$(dirname "$0")"
OCCT="${OCCT:-$(brew --prefix opencascade)}"
OUT="${OUT:-${TMPDIR:-/tmp}/meercad-native-bench}"
clang++ -std=c++17 -O2 -I"$OCCT/include/opencascade" bench.cpp -o "$OUT" \
  -L"$OCCT/lib" -Wl,-rpath,"$OCCT/lib" -lTKernel -lTKMath -lTKG2d -lTKG3d -lTKGeomBase -lTKBRep -lTKGeomAlgo -lTKTopAlgo -lTKPrim -lTKBO -lTKShHealing -lTKMesh -lTKBool
echo "$OUT"
