# Sala para Windows 11 — instalador

Instalador `.exe` (Inno Setup 6) con todo incluido: Node portable, ffmpeg/ffprobe, el servidor y la web. Se compila en GitHub Actions (`build-windows-installer`) y se descarga como artifact; no hace falta compilar nada en la máquina del dueño.

## Qué hace el instalador

- Copia el payload en `C:\Program Files\Sala`: `node\node.exe`, `ffmpeg\bin\`, `apps\server` (código + dependencias de producción), `apps\web\dist`, `scripts\dev.mjs`, `package.json` y `sala-launcher.vbs`. **Sin `.env` ni credenciales**: el instalador no incluye ningún token.
- Crea la regla de firewall `Sala 8080` (solo `LocalSubnet`) y la elimina al desinstalar.
- Añade un acceso directo al menú Inicio y otro en **Inicio de sesión** (`wscript.exe sala-launcher.vbs`, sin ventana).
- `sala-launcher.vbs`: si el servidor ya responde, abre el navegador; si no, hace la copia verificada de SQLite (bloqueante), arranca el servidor en segundo plano, espera hasta 30 s a `/api/health` y abre `http://127.0.0.1:8080`. Los dos procesos Node cargan `--env-file-if-exists` de `<install>\.env` y de `%LOCALAPPDATA%\sala\.env` (ambos opcionales).
- El estado (base, imágenes, HLS, copias) vive en `%LOCALAPPDATA%\sala`: desinstalar no borra datos.
- Sin firma digital: SmartScreen muestra "Windows protegió su PC" → **Más información → Ejecutar de todas formas**.

## Cómo generar el instalador

1. GitHub → **Actions → build-windows-installer → Run workflow** (o subir un tag `vX.Y.Z`).
2. Descargar el artifact `sala-windows-installer`: `sala-setup-<version>.exe` + `SHA256SUMS.txt`.

Versiones fijadas y verificadas por hash en el workflow: Node **24.14.0** (SHASUMS256.txt de nodejs.org), ffmpeg **9.0.2 essentials** (gyan.dev, incluye libx264) e Inno Setup **6.7.1**.

Las dependencias de producción del servidor se instalan en un workspace aislado (`npm install --omit=dev` solo con `apps/server`): ~15 MB, muy lejos del árbol de desarrollo (~166 MB). El workflow falla si el staging supera 40 MB o contiene symlinks. El workflow **no usa secretos** y no escribe ningún `.env` en el payload: el instalador se publica sin token y el dueño lo configura después en su máquina (ver abajo), sin reinstalar.

## Token TMDB (solo para importar contenido nuevo)

- El instalador no incluye `.env` ni ningún token; el build no usa secretos y el archivo no forma parte del payload.
- Sin token, la reproducción funciona completa y sin conexión: la biblioteca ya importada no lo necesita.
- Para importar contenido nuevo con metadata de TMDB, crear `%LOCALAPPDATA%\sala\.env` con la línea `TMDB_READ_ACCESS_TOKEN=...` (el dueño copia el valor de su `.env` de Linux; nunca se sube a git ni se imprime).
- El lanzador también carga `<install>\.env` si el usuario lo crea; ambos archivos son opcionales y solo se leen si existen.

## Compilación local (referencia, requiere Windows)

```
# 1. Preparar packaging\windows\payload con el mismo contenido que genera el workflow.
# 2. Compilar:
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=1.0.0 packaging\windows\sala.iss
# Salida: packaging\windows\output\sala-setup-1.0.0.exe
```

## Antes de desinstalar

Cerrar Sala (o reiniciar sesión) para que `node.exe` no esté en uso; si no, Inno pedirá reiniciar para borrar los archivos.

## Solo verificable en Windows real

Ejecución del `.exe` con UAC, SmartScreen, regla de firewall, autostart al iniciar sesión, apertura del navegador desde el `.vbs`, procesado real con ffmpeg (libx264) y desinstalación limpia. En Linux solo se validan tests, typecheck, sintaxis del workflow y el tamaño del payload.
