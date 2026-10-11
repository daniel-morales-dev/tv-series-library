# Sala para macOS 12+ — instalador

DMG con `Sala.app` y todo incluido: Node portable, ffmpeg/ffprobe, el servidor y la web. Se compila en GitHub Actions (`build-macos-installer`) y se descarga como artifact o desde la página del release; no hace falta compilar nada en la máquina del dueño.

## Qué hace el instalador

- `Instalar Sala.command` (doble clic desde el DMG): copia `Sala.app` a `/Applications` (si la cuenta no puede escribir ahí, a `~/Applications`), le quita la cuarentena y la abre. No usa sudo.
- `Sala.app/Contents/MacOS/sala` (lanzador bash): si el servidor ya responde, abre el navegador; si no, hace la copia verificada de SQLite (bloqueante), arranca el servidor en segundo plano con `nohup`, espera hasta 30 s a `/api/health` y abre `http://127.0.0.1:8080`. Los dos procesos Node cargan `--env-file-if-exists` de `Sala.app/Contents/Resources/sala/.env` y de `~/Library/Application Support/sala/.env` (ambos opcionales). Flags: `--no-open` (no abre el navegador) y `--no-agent` (no instala el autostart).
- Inicio de sesión: la primera vez que el servidor arranca desde `/Applications`, el lanzador crea `~/Library/LaunchAgents/com.sala.launcher.plist` (LaunchAgent `com.sala.launcher`, `RunAtLoad`) que arranca el servidor **en silencio** (`--no-open`); el doble clic normal sí abre el navegador.
- El estado (base, imágenes, HLS, copias) vive en `~/Library/Application Support/sala`; los logs en `~/Library/Logs/sala/server.log`.
- Sin notarización (no hay cuenta Apple Developer): la firma es ad-hoc y el primer arranque muestra el aviso de Gatekeeper → **clic derecho → Abrir**. La guía `LEEME.txt` del DMG lo explica paso a paso.
- Firma ad-hoc obligatoria en Apple Silicon (`codesign --force --deep --sign -`); el build falla si `codesign --verify --strict` no pasa.

## Cómo generar el instalador

1. GitHub → **Actions → build-macos-installer → Run workflow** (o subir un tag `vX.Y.Z`).
2. Descargar los artifacts `sala-macos-installer-arm64` / `sala-macos-installer-x64`: `sala-macos-<arch>.dmg`.

En un tag, ambos workflows publican en la misma release: Windows (`sala-setup.exe` + `SHA256SUMS.txt`) y macOS (`sala-macos-arm64.dmg`, `sala-macos-x64.dmg` + `SHA256SUMS-macos.txt`).

Versiones fijadas y verificadas por hash en el workflow: Node **24.14.0** (SHASUMS256.txt de nodejs.org, tarball `darwin-arm64`/`darwin-x64`), ffmpeg/ffprobe **9.0.2** (`ffmpeg.martin-riedl.de`, con el `.sha256` oficial junto a cada zip), runners `macos-latest` (arm64) y `macos-15-intel` (x64; `macos-13` retirado).

Las dependencias de producción del servidor se instalan en un workspace aislado (`npm install --omit=dev` solo con `apps/server`): ~15 MB, muy lejos del árbol de desarrollo. El workflow falla si el staging supera 40 MB o contiene symlinks. El workflow **no usa secretos** y no escribe ningún `.env` en el payload: el dueño configura el token después, sin reinstalar.

## Token TMDB (solo para importar contenido nuevo)

- El instalador no incluye `.env` ni ningún token; el build no usa secretos y el archivo no forma parte del payload.
- Sin token, la reproducción funciona completa y sin conexión: los títulos salen del nombre del archivo, sin pósters.
- El token se pide en el asistente del primer arranque (paso «Metadata de TMDB», con guía para conseguirlo) o después en **Ajustes**; se guarda en `~/Library/Application Support/sala/config.json`.
- Alternativa avanzada: `TMDB_READ_ACCESS_TOKEN=...` en `~/Library/Application Support/sala/.env` o en `Sala.app/Contents/Resources/sala/.env` (opcionales; la variable de entorno gana sobre `config.json`).

## Compilación local (referencia, requiere macOS)

```
# 1. Preparar packaging/macos/payload con el mismo contenido que genera el workflow.
# 2. Compilar:
APP_VERSION=1.0.0 bash packaging/macos/build.sh arm64
# Salida: packaging/macos/output/sala-macos-arm64.dmg (imprime también el sha256)
```

## Desinstalar y empezar de cero

1. Cerrar el servidor: Monitor de Actividad (el proceso `node` de Sala) o `pkill -f Sala.app`.
2. Quitar el arranque automático: `launchctl bootout gui/$(id -u)/com.sala.launcher` y borrar `~/Library/LaunchAgents/com.sala.launcher.plist`.
3. Arrastrar `Sala.app` a la Papelera (desde `/Applications` o `~/Applications`).
4. Opcional: borrar `~/Library/Application Support/sala` (catálogo, perfiles, progreso, ajustes, carátulas y videos procesados). Al reinstalar aparece el asistente de primer uso. Los videos originales (p. ej. `~/Movies/Sala`) nunca se borran.

Para empezar de cero por completo: desinstalar, borrar la carpeta de datos y volver a instalar el DMG.

## Verificado en CI vs solo verificable en macOS real

- **CI (real, en runner macOS):** firma ad-hoc (`codesign --verify --strict`), smoke test real (el lanzador arranca el servidor con un `HOME` temporal, la web responde en `/api/health` y luego se apaga), verificación por sha256 de Node y ffmpeg/ffprobe contra las fuentes oficiales y guardas de tamaño/symlinks del payload.
- **Solo en macOS real (pendiente del dueño):** avisos de Gatekeeper, permisos TCC al elegir carpetas (`~/Movies`, `~/Documents`, discos externos), arranque automático al iniciar sesión, diálogos de error del lanzador, apertura del navegador y procesado real con ffmpeg.
