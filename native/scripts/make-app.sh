#!/usr/bin/env bash
# Build a self-contained Louie.app for personal use (ad-hoc signed).
# Usage: native/scripts/make-app.sh [output-dir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # native/
ROOT="$(cd "$HERE/.." && pwd)"                    # charles-clone/
OUT="${1:-$HERE/dist}"
APP="$OUT/Louie.app"

echo "==> building release binary"
swift build -c release --package-path "$HERE"

BIN="$HERE/.build/release/Louie"
[ -x "$BIN" ] || { echo "build output missing: $BIN" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"

cp "$BIN" "$APP/Contents/MacOS/Louie"

# App icon: from the provided artwork (Assets/AppIcon.jpeg). Center-crop to trim
# the paper margin, then build the .iconset and convert to .icns.
ICONSET="$HERE/.build/Louie.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
ICON_SRC="${LOUIE_ICON:-$HERE/Assets/AppIcon.jpeg}"
if [ -f "$ICON_SRC" ]; then
  BASE="$HERE/.build/icon-base.png"
  sips -s format png "$ICON_SRC" --out "$BASE" >/dev/null
  # 94% centered crop removes the outer margin so the rounded frame fills the tile
  W=$(sips -g pixelWidth "$BASE" | awk '/pixelWidth/{print $2}')
  CROP=$(( W * 94 / 100 ))
  sips -c "$CROP" "$CROP" "$BASE" >/dev/null
  for s in 16 32 64 128 256 512 1024; do
    case $s in
      16) n="icon_16x16.png";;      32) n="icon_16x16@2x.png";;
      64) n="icon_32x32@2x.png";;   128) n="icon_128x128.png";;
      256) n="icon_128x128@2x.png";; 512) n="icon_256x256@2x.png";;
      1024) n="icon_512x512@2x.png";;
    esac
    sips -z "$s" "$s" "$BASE" --out "$ICONSET/$n" >/dev/null
  done
  # remaining required names
  cp "$ICONSET/icon_32x32@2x.png" "$ICONSET/icon_32x32.png"
  cp "$ICONSET/icon_256x256@2x.png" "$ICONSET/icon_256x256.png"
  cp "$ICONSET/icon_512x512@2x.png" "$ICONSET/icon_512x512.png"
  echo "==> icon from $ICON_SRC"
else
  echo "==> icon artwork missing; drawing fallback"
  swift "$HERE/scripts/make-icon.swift" "$ICONSET" >/dev/null
fi
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Louie.icns"

# Bundle the Node engine (bin + lib). Node itself is expected on the host.
cp -R "$ROOT/bin" "$APP/Contents/Resources/engine/bin"
cp -R "$ROOT/lib" "$APP/Contents/Resources/engine/lib"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Louie</string>
  <key>CFBundleDisplayName</key><string>Louie</string>
  <key>CFBundleIdentifier</key><string>local.louie.app</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Louie</string>
  <key>CFBundleIconFile</key><string>Louie</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP"

echo "done: $APP"
echo "run:  open \"$APP\"   (or: CHARLES_CLONE_ENGINE=... to override the engine path)"
