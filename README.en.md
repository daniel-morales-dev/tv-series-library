# Sala

[Español](README.md) · **English** · [Português](README.pt.md)

A local platform to watch your movies, series and anime from any device on your WiFi (TV, phone, tablet or PC). No ads, no accounts, with profiles, My List and Continue watching.

> **Local start:** `npm run dev` from the root starts the backend (8080) and the frontend (5174), with a verified SQLite copy and a joint stop on `Ctrl+C`. Guide and copy/migration warning: [docs/local-development.md](docs/local-development.md). If you already have a library, read that warning **before starting the backend**.
>
> Status: working and in daily use. What is still missing is in the plan: [`odd/tasks/tv-series-library.md`](odd/tasks/tv-series-library.md).
>
> Note: the app interface is currently in Spanish.

## Screenshots

**Desktop**

| Home | Title page |
| :---: | :---: |
| ![Home: hero with Continue watching](docs/screenshots/01-browse.webp) | ![Title page with seasons and episodes](docs/screenshots/08-title-frieren.webp) |

| Player | Activity |
| :---: | :---: |
| ![Player with controls and subtitles](docs/screenshots/13-player.webp) | ![Activity panel with processing in progress](docs/screenshots/14-activity.webp) |

**Phone and TV**

| Home | Title page | Player |
| :---: | :---: | :---: |
| ![Home on a phone](docs/screenshots/16-browse-mobile.webp) | ![Title page on a phone](docs/screenshots/17-title-mobile.webp) | ![Player on a phone](docs/screenshots/19-player-mobile.webp) |

More screenshots (Series, Movies, Anime, My List, Search, Settings, Pending and profiles) in [`docs/screenshots/`](docs/screenshots).

## Adding content

Put your videos inside the content folder (`content/` by default, or whichever you pick on first run):

```
content/
├── films/      movies (one file or one folder per movie)
└── shows/      series and anime (one folder per title)
    └── bakemonogatari/
        └── any/subfolder/episode_01.mkv
```

- **No renaming needed.** The app searches subfolders and works out the title, season and episode from the file names.
- **If you are seeding a torrent, do not rename or move the files**: the torrent client would lose track of them.
- Download the torrent straight into `content/shows/` or `content/films/`.
- Files still downloading that can be identified show up as **Coming soon**; the rest wait until they can be imported.
- Openings, endings and commentaries are stored as **extras**, not episodes.
- Anything the app cannot identify with confidence lands in **Pending** for you to confirm.

## Configuration

The app stores your content folder in its own config (`~/.config/sala/config.json` on Linux, `%LOCALAPPDATA%\sala` on Windows); you can change it in **Ajustes** (Settings). Do not edit that file by hand. The first-run wizard (or Settings) picks the folder; the default suggestion is `content/`.

1. Only on a fresh install and **only for development**, create `.env` from `.env.example` **without overwriting an existing one**. `CONTENT_DIR` there is optional: your choice in the app wins.
2. Set your TMDB *Read Access Token* in `TMDB_READ_ACCESS_TOKEN`. This install already has one; never print it or commit it.

## Installation

Everything is downloaded from **[Releases → latest version](https://github.com/daniel-morales-dev/tv-series-library/releases/latest)**, under **Assets**.

### Windows 11 — next, next, done

1. Download `sala-setup-<version>.exe`.
2. Double click and **Next → Next → Install**.
3. If Windows warns *"Windows protected your PC"*: **More info → Run anyway**. The installer has no paid code-signing certificate; it is not a virus.
4. Leave the **Start Sala and open the browser** box checked and click **Finish**.

That is it: http://127.0.0.1:8080 opens and Sala starts again on its own every time you log in. Everything is bundled (Node, ffmpeg, server and web) and the installer opens port 8080 for your local network only.

Uninstall and details: [packaging/windows/README.md](packaging/windows/README.md).

### macOS 12 or newer

**1. Find out which Mac you have.** Apple menu → **About This Mac**:

- **Chip** says `Apple M1`, `M2`, `M3`, `M4`… → download `sala-macos-arm64.dmg`.
- **Processor** says `Intel` → download `sala-macos-x64.dmg`.

**2. Install.** Double click the downloaded `.dmg` and double click **Instalar Sala**. A Terminal window opens, copies the app to Applications and opens it for you.

**3. If macOS blocks it the first time.** You get an *"unidentified developer"* warning: **right-click on `Instalar Sala` → Open → Open**. If the warning comes back, go to **System Settings → Privacy & Security**, scroll down to the message about Sala and click **Open Anyway**. You only need this once: the app is not notarized by Apple.

Done: http://127.0.0.1:8080 opens and Sala starts on its own at login. Your data lives in `~/Library/Application Support/sala` and the log in `~/Library/Logs/sala/server.log`.

> If your account is not an administrator, the app installs to `~/Applications` and does **not** start at login. You can still use it.

Uninstall and details: [packaging/macos/README.md](packaging/macos/README.md).

### Linux (Ubuntu and friends)

Linux has no double-click installer: it is six steps you copy and paste into the terminal (about 5 minutes). Works on Ubuntu, Debian, Linux Mint and Pop!_OS.

**1. Open the terminal.** Press `Ctrl` + `Alt` + `T`.

**2. Check whether you already have Node 24.** Paste this and press Enter:

```sh
node --version
```

- It answers `v24.…` or higher → skip to **step 4**.
- It answers a lower number, or `command not found` → go to step 3.

**3. Install Node 24 and ffmpeg.** Paste both lines (it will ask for your password; nothing shows while you type, that is normal):

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg
```

Close the terminal, open it again and repeat step 2 to confirm it now says `v24.…`. Node 24 is mandatory: the one Ubuntu ships by default is too old.

**4. Download Sala:**

```sh
git clone https://github.com/daniel-morales-dev/tv-series-library.git
cd tv-series-library
```

If it says `command not found: git`, install it with `sudo apt install -y git` and try again.

**5. Install and enable the service** (the first command takes a couple of minutes):

```sh
npm ci
bash scripts/linux-install.sh
systemctl --user daemon-reload
systemctl --user enable --now sala
```

**6. Open it** in the laptop browser: http://localhost:8080

The first-run wizard asks for the folder holding your videos and, if you want posters and synopses, a free TMDB token. You can leave that for later: without a token it still plays, just without posters.

**Start on boot, without logging in** (the only `sudo` step):

```sh
sudo loginctl enable-linger "$USER"
```

To watch it from your phone and TV, plus the firewall and the day-to-day commands: [Run it on Linux (laptop) and watch it from your phone and TV](#run-it-on-linux-laptop-and-watch-it-from-your-phone-and-tv).

## Run it on Linux (laptop) and watch it from your phone and TV

If you have not installed it yet, start with [Linux (Ubuntu and friends)](#linux-ubuntu-and-friends). No internet needed, but your phone and TV must be on the **same WiFi** as the laptop.

1. **Firewall, only if ufw is active.** First check the status:
   ```sh
   sudo ufw status
   ```
   If it says `inactive`, skip this step. If it says `active`, find your LAN subnet:
   ```sh
   ip -4 -o addr show scope global
   ```
   With your subnet (for example `192.168.1.0/24`), open the port for it only:
   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'
   sudo ufw status numbered      # verify the rule landed
   ```
   Never open it to `any`: the app has no authentication.

2. **Connect your phone and TV.** On the laptop open http://localhost:8080, go to **Ajustes** (Settings) from the profile menu, and under **Ver desde el celular o la TV** (Watch from your phone or TV) scan the QR with your phone, or type the URL on the TV. If several URLs show up (Ethernet and WiFi), use the WiFi one.

3. **Reserve the laptop IP in your router** (once): find the DHCP reservation or a static IP by MAC and assign the IP Settings shows. That way the URL and the QR never change.

4. **Day to day:**
   - Status: `systemctl --user status sala`
   - Logs: `journalctl --user -u sala -f`
   - Stop: `systemctl --user stop sala`
   - Restart: `systemctl --user restart sala`
   - Update: `git pull`, then `npm ci`, `bash scripts/linux-install.sh` and `systemctl --user restart sala`

> **Heads-up:** the `sala` service and `npm run dev` share port 8080.
> - With the service running, `npm run dev` refuses to start. Before developing: `systemctl --user stop sala`.
> - Stopping the service makes the app unreachable (phone and TV) until you run `systemctl --user start sala`.
> - Stopping `npm run dev` does **not** start the service: do it yourself with `systemctl --user start sala`.
> - To check whether it is running: `systemctl --user status sala` (`inactive (dead)` = stopped).

### Using sala

Installing with `scripts/linux-install.sh` leaves the `sala` command behind (in `~/.local/bin`; if your terminal cannot find it, open a new one or add that folder to PATH). With it you do not need `systemctl`:

- `sala status`: says whether it is running and whether any videos are processing, queued or failing.
- `sala start` / `sala stop` / `sala restart`: start, stop and restart.
- `sala pause` / `sala resume`: pause and resume video processing.
- `sala url`: the address for your phone and TV. `sala open`: opens the library on this machine.
- `sala logs`: the live log (Ctrl+C to exit). `sala --help`: the help.
- `sala migrate-state [--dry-run] [--yes]`: copies the database, images and recovery copies from `data/` to `~/.local/share/sala/` (T47a). It verifies the copy, does **not** delete the source (it tells you how) and refuses if Sala is running or the destination is not empty. Until you run it, everything keeps using `data/` as before. The video (HLS) does not move yet.

If `npm run dev` is holding port 8080, `sala start` warns you instead of failing silently. `npm run dev` and `npm start` keep working as before.

### Development vs production

- `npm run dev`: **development only**. Backend with `--watch` (8080) + Vite (5174); the UI is at http://localhost:5174.
- `npm start`: **production**. Builds `apps/web/dist` if it is missing or older than the web code, and runs the server alone (no watch, no Vite) at http://localhost:8080, with the same port, data folder and SQLite copy guards as `dev`. The `sala` service runs the same server and the same `apps/web/dist` folder (the web is built by `scripts/linux-install.sh`).

## Documentation

- [Glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)

## License

[MIT](LICENSE). You may use, copy, modify and distribute Sala, including commercially, as long as you keep the copyright notice.
