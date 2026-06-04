#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"

APP_DISPLAY_NAME="Sketch Local"
EXECUTABLE_NAME="SketchLocal"
BUNDLE_IDENTIFIER="ai.getsketch.local"
VERSION="${VERSION:-0.0.0}"
DIST_DIR="${DIST_DIR:-$MACOS_DIR/.dist}"
APP_DIR="$DIST_DIR/$APP_DISPLAY_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_CONTENTS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ZIP_PATH="$DIST_DIR/Sketch-Local-macOS.zip"

rm -rf "$DIST_DIR"
mkdir -p "$MACOS_CONTENTS_DIR" "$RESOURCES_DIR"

swift build --package-path "$MACOS_DIR" -c release
BUILD_DIR="$(swift build --package-path "$MACOS_DIR" -c release --show-bin-path)"

cp "$BUILD_DIR/$EXECUTABLE_NAME" "$MACOS_CONTENTS_DIR/$EXECUTABLE_NAME"
chmod +x "$MACOS_CONTENTS_DIR/$EXECUTABLE_NAME"

cp -R "$MACOS_DIR/Sources/SketchLocal/Resources/"* "$RESOURCES_DIR/"

ICON_SOURCE="$REPO_ROOT/packages/web/public/logos/sketch-icon-light.png"
ICONSET_DIR="$(mktemp -d)/SketchLocal.iconset"
mkdir -p "$ICONSET_DIR"
sips -z 16 16 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/SketchLocal.icns"

cat >"$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIconFile</key>
  <string>SketchLocal</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_IDENTIFIER</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

plutil -lint "$CONTENTS_DIR/Info.plist"
codesign --force --deep --sign - "$APP_DIR"

COPYFILE_DISABLE=1 ditto -c -k --norsrc --keepParent "$APP_DIR" "$ZIP_PATH"
echo "$ZIP_PATH"
