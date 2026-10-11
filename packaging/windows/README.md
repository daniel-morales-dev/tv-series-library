# Sala para Windows 11 — instalador

Instalador `.exe` (Inno Setup 6) con todo incluido: Node portable, ffmpeg/ffprobe, el servidor y la web. Se compila en GitHub Actions (`build-windows-installer`) y se descarga como artifact; no hace falta compilar nada en la máquina del dueño.

## Qué hace el instalador

- Copia el payload en `C:\Program Files\Sala`: `node\node.exe`, `ffmpeg\bin\`, `apps\server` (código + dependencias de producción), `apps\web\dist`, `scripts\dev.mjs`, `package.json` y `sala-launcher.vbs`. **Sin `.env` ni credenciales**: el instalador no incluye ningún token.
- Crea la regla de firewall `Sala 8080` (solo `LocalSubnet`) y la elimina al desinstalar.
- Añade un acceso directo al menú Inicio y otro en **Inicio de sesión** (`wscript.exe sala-launcher.vbs`, sin ventana).
- `sala-launcher.vbs`: si el servidor ya responde, abre el navegador; si no, hace la copia verificada de SQLite (bloqueante), arranca el servidor en segundo plano, espera hasta 30 s a `/api/health` y abre `http://127.0.0.1:8080`. Los dos procesos Node cargan `--env-file-if-exists` de `<install>\.env` y de `%LOCALAPPDATA%\sala\.env` (ambos opcionales).
- El estado (base, imágenes, HLS, copias) vive en `%LOCALAPPDATA%\sala`. Al desinstalar se pregunta si borrarlo; en modo silencioso se conserva.
- Sin firma digital: SmartScreen muestra "Windows protegió su PC" → **Más información → Ejecutar de todas formas**.

## Cómo generar el instalador

1. GitHub → **Actions → build-windows-installer → Run workflow** (o subir un tag `vX.Y.Z`).
2. Descargar el artifact `sala-windows-installer`: `sala-setup-<version>.exe` + `SHA256SUMS.txt`.

Versiones fijadas y verificadas por hash en el workflow: Node **24.14.0** (SHASUMS256.txt de nodejs.org), ffmpeg **9.0.2 essentials** (gyan.dev, incluye libx264) e Inno Setup **6.7.1**.

Las dependencias de producción del servidor se instalan en un workspace aislado (`npm install --omit=dev` solo con `apps/server`): ~15 MB, muy lejos del árbol de desarrollo (~166 MB). El workflow falla si el staging supera 40 MB o contiene symlinks. El workflow **no usa secretos** y no escribe ningún `.env` en el payload: el instalador se publica sin token y el dueño lo configura después en su máquina (ver abajo), sin reinstalar.

## Token TMDB (solo para importar contenido nuevo)

- El instalador no incluye `.env` ni ningún token; el build no usa secretos y el archivo no forma parte del payload.
- Sin token, la reproducción funciona completa y sin conexión: los títulos salen del nombre del archivo, sin pósters.
- El token se pide en el asistente del primer arranque (paso «Metadata de TMDB», con guía para conseguirlo) o después en **Ajustes**; se guarda en `%LOCALAPPDATA%\sala\config.json`.
- Alternativa avanzada: `TMDB_READ_ACCESS_TOKEN=...` en `%LOCALAPPDATA%\sala\.env` o `<install>\.env` (opcionales; la variable de entorno gana sobre `config.json`).

## Compilación local (referencia, requiere Windows)

```
# 1. Preparar packaging\windows\payload con el mismo contenido que genera el workflow.
# 2. Compilar:
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=1.0.0 packaging\windows\sala.iss
# Salida: packaging\windows\output\sala-setup-1.0.0.exe
```

## Desinstalar y empezar de cero

Desde la v0.1.4 el desinstalador cierra el `node.exe`/`ffmpeg.exe` de Sala (por ruta, sin tocar otros Node) y pregunta **«¿Borrar también tus datos de Sala?»**:

- **Sí**: borra `%LOCALAPPDATA%\sala` (catálogo, perfiles, progreso, ajustes, carátulas y videos procesados). Al reinstalar aparece el asistente de primer uso.
- **No**: conserva todo; al reinstalar o actualizar sigue el mismo catálogo.

Los videos originales (p. ej. `%USERPROFILE%\Videos\Sala`) nunca se borran.

Limpieza manual (v0.1.3 o anteriores), en PowerShell como administrador y con la sesión del usuario que usa Sala:

```powershell
Get-Process node,ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\Program Files\Sala\*' } | Stop-Process -Force
Start-Sleep 2
Remove-Item "$env:LOCALAPPDATA\sala" -Recurse -Force
Remove-Item "$([Environment]::GetFolderPath('Startup'))\Sala.lnk" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Videos\Sala\.sala-library.json" -ErrorAction SilentlyContinue
```

Luego desinstalar desde Configuración → Aplicaciones y borrar `C:\Program Files\Sala` si quedó. Si `http://127.0.0.1:8080` todavía carga, sigue vivo un servidor viejo.

## Solo verificable en Windows real

Ejecución del `.exe` con UAC, SmartScreen, regla de firewall, autostart al iniciar sesión, apertura del navegador desde el `.vbs`, procesado real con ffmpeg (libx264) y desinstalación limpia. En Linux solo se validan tests, typecheck, sintaxis del workflow y el tamaño del payload.
