# Sala for Windows 11 — installer

[Español](README.md) · **English** · [Português](README.pt.md)

An `.exe` installer (Inno Setup 6) with everything bundled: portable Node, ffmpeg/ffprobe, the server and the web. It is built in GitHub Actions (`build-windows-installer`) and downloaded as an artifact; nothing has to be compiled on the owner's machine.

## What the installer does

- Copies the payload into `C:\Program Files\Sala`: `node\node.exe`, `ffmpeg\bin\`, `apps\server` (code + production dependencies), `apps\web\dist`, `scripts\dev.mjs`, `package.json` and `sala-launcher.vbs`. **No `.env` and no credentials**: the installer ships no token.
- Creates the firewall rule `Sala 8080` (`LocalSubnet` only) and removes it on uninstall.
- Adds a Start-menu shortcut and another one under **Startup** (`wscript.exe sala-launcher.vbs`, no window).
- `sala-launcher.vbs`: if the server already answers, it opens the browser; if not, it makes the verified SQLite copy (blocking), starts the server in the background, waits up to 30 s for `/api/health` and opens `http://127.0.0.1:8080`. Both Node processes load `--env-file-if-exists` from `<install>\.env` and from `%LOCALAPPDATA%\sala\.env` (both optional).
- State (database, images, HLS, copies) lives in `%LOCALAPPDATA%\sala`. On uninstall it asks whether to delete it; in silent mode it is kept.
- No digital signature: SmartScreen shows "Windows protected your PC" → **More info → Run anyway**.

## How to build the installer

1. GitHub → **Actions → build-windows-installer → Run workflow** (or push a `vX.Y.Z` tag).
2. Download the `sala-windows-installer` artifact: `sala-setup-<version>.exe` + `SHA256SUMS.txt`.

Versions pinned and hash-verified in the workflow: Node **24.14.0** (SHASUMS256.txt from nodejs.org), ffmpeg **9.0.2 essentials** (gyan.dev, includes libx264) and Inno Setup **6.7.1**.

The server's production dependencies are installed in an isolated workspace (`npm install --omit=dev` with `apps/server` only): ~15 MB, far from the development tree (~166 MB). The workflow fails if the staging area exceeds 40 MB or contains symlinks. The workflow **uses no secrets** and writes no `.env` into the payload: the installer is published without a token and the owner configures it later on their own machine (see below), without reinstalling.

## TMDB token (only to import new content)

- The installer ships no `.env` and no token; the build uses no secrets and the file is not part of the payload.
- Without a token, playback works fully and offline: titles come from the file name, without posters.
- The token is requested in the first-run wizard (the "Metadata de TMDB" step, with a guide to obtain one) or later in **Ajustes** (Settings); it is stored in `%LOCALAPPDATA%\sala\config.json`.
- Advanced alternative: `TMDB_READ_ACCESS_TOKEN=...` in `%LOCALAPPDATA%\sala\.env` or `<install>\.env` (optional; the environment variable wins over `config.json`).

## Local build (reference, requires Windows)

```
# 1. Prepare packaging\windows\payload with the same content the workflow generates.
# 2. Build:
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=1.0.0 packaging\windows\sala.iss
# Output: packaging\windows\output\sala-setup-1.0.0.exe
```

## Uninstall and start over

Since v0.1.4 the uninstaller closes Sala's `node.exe`/`ffmpeg.exe` (by path, without touching other Node installs) and asks **"Delete your Sala data too?"**:

- **Yes**: deletes `%LOCALAPPDATA%\sala` (catalog, profiles, progress, settings, posters and processed videos). Reinstalling shows the first-run wizard.
- **No**: keeps everything; reinstalling or updating keeps the same catalog.

Your original videos (e.g. `%USERPROFILE%\Videos\Sala`) are never deleted.

Manual cleanup (v0.1.3 or earlier), in PowerShell as administrator and with the session of the user who runs Sala:

```powershell
Get-Process node,ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\Program Files\Sala\*' } | Stop-Process -Force
Start-Sleep 2
Remove-Item "$env:LOCALAPPDATA\sala" -Recurse -Force
Remove-Item "$([Environment]::GetFolderPath('Startup'))\Sala.lnk" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Videos\Sala\.sala-library.json" -ErrorAction SilentlyContinue
```

Then uninstall from Settings → Apps and delete `C:\Program Files\Sala` if it is still there. If `http://127.0.0.1:8080` still loads, an old server is still alive.

## Only verifiable on real Windows

Running the `.exe` with UAC, SmartScreen, the firewall rule, autostart at login, the browser opening from the `.vbs`, real ffmpeg processing (libx264) and a clean uninstall. On Linux only tests, typecheck, workflow syntax and payload size are validated.
