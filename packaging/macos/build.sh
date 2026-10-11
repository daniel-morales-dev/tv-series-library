#!/bin/bash
# Sala para macOS: ensambla Sala.app y el DMG.
# El payload lo prepara .github/workflows/build-macos-installer.yml en packaging/macos/payload
# (mismo layout que packaging/windows/payload).
# Uso: APP_VERSION=1.0.0 bash packaging/macos/build.sh <arm64|x64>
# Salida: packaging/macos/output/sala-macos-<arch>.dmg
set -euo pipefail

ARCH="${1:-}"
case "$ARCH" in
  arm64 | x64) ;;
  *)
    echo "uso: bash packaging/macos/build.sh <arm64|x64>" >&2
    exit 2
    ;;
esac

APP_VERSION="${APP_VERSION:-0.0.0-dev}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload"
APP="$HERE/Sala.app"
STAGE="$HERE/stage"
OUTPUT="$HERE/output"
DMG="$OUTPUT/sala-macos-$ARCH.dmg"

for item in node/bin/node ffmpeg/bin/ffmpeg ffmpeg/bin/ffprobe apps/server/src apps/server/node_modules apps/web/dist scripts/dev.mjs package.json; do
  if [ ! -e "$PAYLOAD/$item" ]; then
    echo "falta $PAYLOAD/$item: prepara packaging/macos/payload con el workflow build-macos-installer (mismo layout que packaging/windows/payload)." >&2
    exit 1
  fi
done

echo "Sala $APP_VERSION ($ARCH): ensamblando Sala.app"
rm -rf "$APP" "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Nombre final del ejecutable: Contents/MacOS/sala (CFBundleExecutable).
cp "$HERE/sala-launcher.sh" "$APP/Contents/MacOS/sala"
chmod 755 "$APP/Contents/MacOS/sala"
sed "s|@VERSION@|$APP_VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
cp -R "$PAYLOAD" "$APP/Contents/Resources/sala"

# Firma ad-hoc (obligatoria en Apple Silicon): sin cuenta Apple Developer no hay notarización.
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --strict "$APP"

# DMG: la app, el acceso a /Applications, el instalador de doble clic y la guía.
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Sala.app"
ln -s /Applications "$STAGE/Aplicaciones"
cp "$HERE/Instalar Sala.command" "$STAGE/Instalar Sala.command"
chmod 755 "$STAGE/Instalar Sala.command"
cp "$HERE/LEEME.txt" "$STAGE/LEEME.txt"

mkdir -p "$OUTPUT"
hdiutil create -volname "Sala" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
shasum -a 256 "$DMG"
