#!/bin/bash
# Sala - lanzador para macOS.
# Se ejecuta con el doble clic de Sala.app (o con el LaunchAgent del inicio de sesión): copia
# verificada de SQLite, servidor en segundo plano y apertura del navegador. Si el servidor ya
# responde, solo abre el navegador.
set -u

# El ejecutable vive en Contents/MacOS/sala: todo se resuelve desde ahí para funcionar con
# cualquier carpeta de trabajo (el Finder lanza la app con cwd=/).
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RES="$APP/Contents/Resources/sala"
NODE="$RES/node/bin/node"
SERVER="$RES/apps/server"
FF="$RES/ffmpeg/bin"
URL="http://127.0.0.1:8080"
LOG_DIR="$HOME/Library/Logs/sala"
LOG="$LOG_DIR/server.log"
# .env opcionales: dentro del bundle (si el usuario lo crea) y por usuario en Application Support.
ENV_FILE="$RES/.env"
USER_ENV_FILE="$HOME/Library/Application Support/sala/.env"

NO_OPEN=0
NO_AGENT=0
for arg in "$@"; do
  case "$arg" in
    --no-open) NO_OPEN=1 ;;
    --no-agent) NO_AGENT=1 ;;
  esac
done

# ffmpeg/ffprobe se lanzan por nombre; FFMPEG_BIN/FFPROBE_BIN los fijan de forma explícita.
export WEB_DIR="$RES/apps/web/dist"
export PORT=8080
export FFMPEG_BIN="$FF/ffmpeg"
export FFPROBE_BIN="$FF/ffprobe"
export PATH="$FF:$PATH"

health_ok() {
  /usr/bin/curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1
}

open_browser() {
  [ "$NO_OPEN" -eq 1 ] && return 0
  /usr/bin/open "$URL"
}

# Aviso nativo con el texto como argumento: comillas y espacios viajan seguros.
alert() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display alert "Sala" message (item 1 of argv) as critical buttons {"Cerrar"} default button "Cerrar"
end run
APPLESCRIPT
}

# Inicio de sesión: LaunchAgent que arranca el servidor en silencio (--no-open). Solo si la app
# quedó en /Applications; nunca se reescribe si ya existe.
install_agent() {
  [ "$NO_AGENT" -eq 1 ] && return 0
  case "$APP" in
    /Applications/*) ;;
    *) return 0 ;;
  esac
  PLIST="$HOME/Library/LaunchAgents/com.sala.launcher.plist"
  [ -e "$PLIST" ] && return 0
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sala.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP}/Contents/MacOS/sala</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
}

if health_ok; then
  open_browser
  exit 0
fi

mkdir -p "$LOG_DIR"

# Copia verificada de SQLite antes de abrir la base; también detecta el puerto 8080 ocupado.
if ! cd "$SERVER"; then
  alert "No se encontró la instalación de Sala. Vuelve a copiar la aplicación desde el DMG."
  exit 1
fi
"$NODE" --env-file-if-exists="$ENV_FILE" --env-file-if-exists="$USER_ENV_FILE" src/cli/backup.ts >>"$LOG" 2>&1
BACKUP_CODE=$?
if [ "$BACKUP_CODE" -ne 0 ]; then
  # Carrera al abrir dos veces (inicio de sesión + doble clic): el servidor puede estar arrancando.
  if health_ok; then
    open_browser
    exit 0
  fi
  alert "No se pudo preparar Sala: el puerto 8080 está ocupado o falló la copia de seguridad. Cierra el programa que use el puerto 8080 y vuelve a intentarlo."
  exit 1
fi

# Servidor en segundo plano: nohup lo desliga del lanzador, que termina enseguida.
nohup "$NODE" --env-file-if-exists="$ENV_FILE" --env-file-if-exists="$USER_ENV_FILE" src/index.ts </dev/null >>"$LOG" 2>&1 &

WAITED=0
while [ "$WAITED" -lt 30 ]; do
  sleep 1
  WAITED=$((WAITED + 1))
  if health_ok; then
    install_agent
    open_browser
    exit 0
  fi
done

alert "Sala no respondió en 30 segundos. Puede que macOS haya bloqueado la aplicación; vuelve a intentarlo."
exit 1
