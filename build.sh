#!/usr/bin/env bash
# Build a Chrome Web Store ZIP from the extension source files.
# Run from the repo root: ./build.sh
set -euo pipefail

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="already-own-v${VERSION}.zip"

# Files and folders that go into the extension package
INCLUDE=(
  manifest.json
  background.js
  content_epic.js
  content_steam.js
  popup.html
  popup.js
  importer.html
  importer.js
  icons/
)

rm -f "$OUT"
zip -r "$OUT" "${INCLUDE[@]}" --exclude "*.DS_Store"
echo "Built: $OUT  ($(du -h "$OUT" | cut -f1))"
