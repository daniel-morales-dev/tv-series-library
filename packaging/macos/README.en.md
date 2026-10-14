# Sala for macOS 12+ — installer

[Español](README.md) · **English** · [Português](README.pt.md)

A DMG with `Sala.app` and everything bundled: portable Node, ffmpeg/ffprobe, the server and the web. It is built in GitHub Actions (`build-macos-installer`) and downloaded as an artifact or from the release page; nothing has to be compiled on the owner's machine.

## What the installer does

- `Instalar Sala.command` (double click from the DMG): copies `Sala.app` to `/Applications` (or to `~/Applications` if the account cannot write there), removes the quarantine flag and opens it. No sudo.
- `Sala.app/Contents/MacOS/sala` (bash launcher): if the server already answers, it opens the browser; if not, it makes the verified SQLite copy (blocking), starts the server in the background with `nohup`, waits up to 30 s for `/api/health` and opens `http://127.0.0.1:8080`. Both Node processes load `--env-file-if-exists` from `Sala.app/Contents/Resources/sala/.env` and from `~/Library/Application Support/sala/.env` (both optional). Flags: `--no-open` (does not open the browser) and `--no-agent` (does not install autostart).
- Login: the first time the server starts from `/Applications`, the launcher creates `~/Library/LaunchAgents/com.sala.launcher.plist` (LaunchAgent `com.sala.launcher`, `RunAtLoad`) which starts the server **silently** (`--no-open`); a normal double click does open the browser.
- State (database, images, HLS, copies) lives in `~/Library/Application Support/sala`; logs in `~/Library/Logs/sala/server.log`.
- No notarization (there is no Apple Developer account): the signature is ad-hoc and the first launch shows the Gatekeeper warning → **right-click → Open**. The DMG's `LEEME.txt` guide explains it step by step (in Spanish, English and Portuguese).
- Ad-hoc signature mandatory on Apple Silicon (`codesign --force --deep --sign -`); the build fails if `codesign --verify --strict` does not pass.

## How to build the installer

1. GitHub → **Actions → build-macos-installer → Run workflow** (or push a `vX.Y.Z` tag).
2. Download the `sala-macos-installer-arm64` / `sala-macos-installer-x64` artifacts: `sala-macos-<arch>.dmg`.

On a tag, both workflows publish to the same release: Windows (`sala-setup.exe` + `SHA256SUMS.txt`) and macOS (`sala-macos-arm64.dmg`, `sala-macos-x64.dmg` + `SHA256SUMS-macos.txt`).

Versions pinned and hash-verified in the workflow: Node **24.14.0** (SHASUMS256.txt from nodejs.org, `darwin-arm64`/`darwin-x64` tarball), ffmpeg/ffprobe **9.0.2** (`ffmpeg.martin-riedl.de`, with the official `.sha256` next to each zip), runners `macos-latest` (arm64) and `macos-15-intel` (x64; `macos-13` retired).

The server's production dependencies are installed in an isolated workspace (`npm install --omit=dev` with `apps/server` only): ~15 MB, far from the development tree. The workflow fails if the staging area exceeds 40 MB or contains symlinks. The workflow **uses no secrets** and writes no `.env` into the payload: the owner configures the token later, without reinstalling.

## TMDB token (only to import new content)

- The installer ships no `.env` and no token; the build uses no secrets and the file is not part of the payload.
- Without a token, playback works fully and offline: titles come from the file name, without posters.
- The token is requested in the first-run wizard (the "Metadata de TMDB" step, with a guide to obtain one) or later in **Ajustes** (Settings); it is stored in `~/Library/Application Support/sala/config.json`.
- Advanced alternative: `TMDB_READ_ACCESS_TOKEN=...` in `~/Library/Application Support/sala/.env` or in `Sala.app/Contents/Resources/sala/.env` (optional; the environment variable wins over `config.json`).

## Local build (reference, requires macOS)

```
# 1. Prepare packaging/macos/payload with the same content the workflow generates.
# 2. Build:
APP_VERSION=1.0.0 bash packaging/macos/build.sh arm64
# Output: packaging/macos/output/sala-macos-arm64.dmg (also prints the sha256)
```

## Uninstall and start over

1. Close the server: Activity Monitor (Sala's `node` process) or `pkill -f Sala.app`.
2. Remove autostart: `launchctl bootout gui/$(id -u)/com.sala.launcher` and delete `~/Library/LaunchAgents/com.sala.launcher.plist`.
3. Drag `Sala.app` to the Trash (from `/Applications` or `~/Applications`).
4. Optional: delete `~/Library/Application Support/sala` (catalog, profiles, progress, settings, posters and processed videos). Reinstalling shows the first-run wizard. Your original videos (e.g. `~/Movies/Sala`) are never deleted.

To start completely from scratch: uninstall, delete the data folder and install the DMG again.

## Verified in CI vs only verifiable on real macOS

- **CI (real, on a macOS runner):** ad-hoc signature (`codesign --verify --strict`), a real smoke test (the launcher starts the server with a temporary `HOME`, the web answers at `/api/health` and then shuts down), sha256 verification of Node and ffmpeg/ffprobe against the official sources, and payload size/symlink guards.
- **Only on real macOS (pending for the owner):** Gatekeeper warnings, TCC permissions when picking folders (`~/Movies`, `~/Documents`, external disks), autostart at login, launcher error dialogs, browser opening and real ffmpeg processing.
