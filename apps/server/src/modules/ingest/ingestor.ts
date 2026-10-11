import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { rootStatus } from '../../library/roots.ts';
import { type Assignment, adoptSeries, assignMovie, assignSeries, matchSeries, placeEpisode } from './assign.ts';
import { type IngestContext, createLocalTitle, findSeasonsGroup, fixPersonNames, importSeasonsGroup, markOfficialSeasons, setSourceDir } from './metadata.ts';
import { type Parsed, parsePath } from './parser.ts';
import { type Probe, ffprobe } from './probe.ts';
import { type ConfirmBody, confirmPending } from './pending.ts';
import { type Placement, addPending, promoteDownload, registerDownloading, registerFile, relinkFiles } from './register.ts';
import { ROOTS, type VideoFile, listVideos, showDirKey } from './scanner.ts';
import { type TmdbClient, memoize } from './tmdb.ts';

const MIN_AGE_MS = 60_000;
const DEBOUNCE_MS = 5_000;

export interface ScanSummary {
  ingested: number;
  pending: number;
  /** Too recent or unreadable by ffprobe (still downloading): tried again on the next scan. */
  waiting: number;
  failed: number;
}

export interface IngestorOptions {
  db: DatabaseSync;
  tmdb: TmdbClient;
  dataDir: string;
  /** Fixed folder, or a live resolver so T22 can switch folders while the server runs. */
  contentDir: string | (() => string);
  probe?: Probe;
  /** T47d: false while the library disk is not mounted; scans are skipped and the watchers re-armed on return. */
  diskPresent?: () => boolean;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface Ingestor {
  confirm(id: number, body: ConfirmBody): Promise<{ titleId: number; placed: number }>;
  /** Concurrent callers share the scan in flight; a request made during a scan triggers one more pass. */
  scan(): Promise<ScanSummary>;
  start(intervalMin: number): void;
  stop(): void;
}

/** A video found on disk, tied to the root it was found in (T9b). */
type RootVideo = VideoFile & { rootId: number };

interface ScanRoot {
  id: number;
  path: string;
}

interface ScanState {
  ctx: IngestContext;
  /** Relative paths seen on disk per root: moves and supersedes never cross roots. */
  onDisk: Map<number, Set<string>>;
  offline: boolean;
  dirs: Map<string, Promise<Assignment>>;
}

export function createIngestor(opts: IngestorOptions): Ingestor {
  const { db, dataDir } = opts;
  const contentDir = () => (typeof opts.contentDir === 'function' ? opts.contentDir() : opts.contentDir);
  const probe = opts.probe ?? ffprobe;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  let running: Promise<ScanSummary> | null = null;
  let again = false;
  let timers: { interval?: NodeJS.Timeout; debounce?: NodeJS.Timeout; recent?: NodeJS.Timeout } = {};
  let watchers = new Map<string, { dir: string; watcher: FSWatcher }>();
  let armed = false;
  const diskPresent = opts.diskPresent ?? (() => true);
  // T9b: root 1 is the configured folder, guarded by the injected `diskPresent`; every other root by its marker.
  const rootPresent = (rootId: number) => (rootId === 1 ? diskPresent() : rootStatus(db, rootId).present);

  async function scanLoop(): Promise<ScanSummary> {
    let summary: ScanSummary;
    do {
      again = false;
      summary = await scanOnce();
    } while (again);
    return summary;
  }

  function scan(): Promise<ScanSummary> {
    if (running) {
      again = true;
      return running;
    }
    running = scanLoop().finally(() => {
      running = null;
    });
    return running;
  }

  async function scanOnce(): Promise<ScanSummary> {
    const state: ScanState = { ctx: { db, tmdb: memoize(opts.tmdb), dataDir }, onDisk: new Map(), offline: false, dirs: new Map() };
    const summary: ScanSummary = { ingested: 0, pending: 0, waiting: 0, failed: 0 };
    const present = scanRoots().filter((r) => rootPresent(r.id));
    if (armed) armWatchers(present); // picks up shows/ or films/ created after start; drops watchers of absent roots
    if (present.length === 0) return summary;
    await retryMetadata(state);
    relabelExtras();
    for (const root of present) await scanRoot(state, root, summary);
    if (summary.waiting > 0) schedule(MIN_AGE_MS + 1_000, 'recent');
    log('info', `scan done: ${JSON.stringify(summary)}`);
    return summary;
  }

  // Root 1 is the configured folder (its path may change at runtime); the rest use their last known path.
  function scanRoots(): ScanRoot[] {
    const rows = all<{ id: number; last_known_path: string | null }>(db, 'SELECT id, last_known_path FROM library_roots ORDER BY position, id');
    const out: ScanRoot[] = [];
    for (const r of rows) {
      const path = r.id === 1 ? contentDir() : r.last_known_path;
      if (path) out.push({ id: r.id, path });
    }
    return out;
  }

  // An absent root is skipped silently: no DB writes and, above all, no deletions of its rows.
  async function scanRoot(state: ScanState, root: ScanRoot, summary: ScanSummary): Promise<void> {
    const files: RootVideo[] = (await listVideos(root.path)).map((f) => ({ ...f, rootId: root.id }));
    const onDisk = new Set(files.map((f) => f.rel));
    state.onDisk.set(root.id, onDisk);
    const known = new Set([
      ...all<{ path: string }>(db, 'SELECT path FROM media_files WHERE root_id = ?', root.id).map((r) => r.path),
      ...all<{ path: string }>(db, 'SELECT path FROM pending_files WHERE root_id = ?', root.id).map((r) => r.path),
    ]);
    // Moves first, so a renamed folder never reaches the TMDB lookup.
    for (const rel of relocateMoved(root.id, files, known, onDisk)) known.add(rel);
    await promoteDownloads(root.id, files, summary);
    for (const file of files) {
      if (known.has(file.rel)) continue;
      try {
        summary[await ingestFile(state, file)]++;
      } catch (err) {
        summary.failed++;
        log('warn', `ingest failed for ${file.rel}: ${(err as Error).message}`);
      }
    }
  }

  // A file that is not on disk any more and reappears elsewhere with the same name and size is the same file:
  // torrent clients preallocate the final size, so this also holds while it downloads. Scoped to one root.
  function relocateMoved(rootId: number, files: RootVideo[], known: Set<string>, onDisk: Set<string>): string[] {
    const key = (name: string, size: number | null) => `${size}:${name}`;
    const fresh = new Map<string, RootVideo[]>();
    for (const f of files) if (!known.has(f.rel)) fresh.set(key(basename(f.rel), f.size), [...(fresh.get(key(basename(f.rel), f.size)) ?? []), f]);
    const missing = new Map<string, { id: number; path: string }[]>();
    for (const r of all<{ id: number; path: string; size: number | null }>(db, 'SELECT id, path, size FROM media_files WHERE size IS NOT NULL AND root_id = ?', rootId)) {
      if (onDisk.has(r.path)) continue;
      const k = key(basename(r.path), r.size);
      missing.set(k, [...(missing.get(k) ?? []), r]);
    }
    const moved: string[] = [];
    for (const [k, rows] of missing) {
      const candidates = fresh.get(k);
      if (rows.length !== 1 || candidates?.length !== 1) continue;
      const [old, to] = [rows[0]!, candidates[0]!];
      run(db, 'UPDATE media_files SET path = ? WHERE id = ?', to.rel, old.id);
      inheritSourceDir(rootId, old.path, to.rel);
      moved.push(to.rel);
    }
    return moved;
  }

  function inheritSourceDir(rootId: number, oldRel: string, newRel: string): void {
    const dirKey = (rel: string) => {
      const parsed = parsePath(rel);
      return parsed.kind === 'episode' || parsed.kind === 'extra' ? showDirKey(rel, parsed.show) : null;
    };
    const [from, to] = [dirKey(oldRel), dirKey(newRel)];
    if (!from || !to || from === to) return;
    const old = get<{ title_id: number; season_number: number | null }>(db, 'SELECT title_id, season_number FROM source_dirs WHERE root_id = ? AND path = ?', rootId, from);
    if (old && !get(db, 'SELECT 1 AS x FROM source_dirs WHERE root_id = ? AND path = ?', rootId, to)) setSourceDir(db, to, old.title_id, old.season_number, rootId);
  }

  // Downloads whose file is now old enough and readable join the queue.
  async function promoteDownloads(rootId: number, files: RootVideo[], summary: ScanSummary): Promise<void> {
    const byRel = new Map(files.map((f) => [f.rel, f]));
    for (const row of all<{ id: number; path: string }>(db, "SELECT id, path FROM media_files WHERE status = 'downloading' AND root_id = ?", rootId)) {
      const file = byRel.get(row.path);
      if (!file) continue;
      const info = now() - file.mtimeMs > MIN_AGE_MS ? await probe(file.abs).catch(() => null) : null;
      if (!info) summary.waiting++;
      else promoteDownload(db, row.id, file.size, info);
    }
  }

  async function ingestFile(state: ScanState, file: RootVideo): Promise<'ingested' | 'pending' | 'waiting'> {
    const info = now() - file.mtimeMs > MIN_AGE_MS ? await probe(file.abs).catch(() => null) : null;
    const parsed = parsePath(file.rel);
    const toPending = (reason: 'unparsed' | 'no_match' | 'unmapped_episode', candidates: Parameters<typeof addPending>[5] = []) => {
      if (!info) return 'waiting' as const; // unplaceable and unfinished: nothing is stored until it can be probed
      addPending(db, file.rel, file.size, parsed, reason, candidates, file.rootId);
      return 'pending' as const;
    };
    const store = (placement: Placement) => {
      if (!info) {
        registerDownloading(db, file.rel, file.size, placement, file.rootId);
        return 'waiting' as const;
      }
      registerFile(db, { rel: file.rel, size: file.size, probe: info }, placement, file.rootId);
      return 'ingested' as const;
    };

    if (parsed.kind === 'unparsed') return toPending('unparsed');

    if (parsed.kind === 'movie') {
      const out = await resolveMovie(state, parsed);
      if (out.status === 'no_match') return toPending('no_match', out.candidates);
      return store({ titleId: out.titleId, episodeId: null, extraLabel: null, parsedSeason: null, parsedNumber: null });
    }

    const dir = await resolveDir(state, file.rootId, showDirKey(file.rel, parsed.show), parsed.show);
    if (dir.status === 'no_match') return toPending('no_match', dir.candidates);
    if (parsed.kind === 'extra') {
      return store({ titleId: dir.titleId, episodeId: null, extraLabel: parsed.label, parsedSeason: null, parsedNumber: null });
    }
    const episodeId = await placeEpisode(state.ctx, dir.titleId, dir.seasonNumber, parsed);
    if (episodeId === null) return toPending('unmapped_episode');
    const outcome = store({ titleId: dir.titleId, episodeId, extraLabel: null, parsedSeason: parsed.season, parsedNumber: parsed.number });
    supersedeMissing(state, file, episodeId);
    return outcome;
  }

  // A new release (SubsPlease) of an episode whose old file (Cifer) is gone takes over its progress; the old row is
  // dropped. Scoped to the file's root: rows of another (possibly absent) root are never touched from here.
  function supersedeMissing(state: ScanState, file: RootVideo, episodeId: number): void {
    const added = get<{ id: number }>(db, 'SELECT id FROM media_files WHERE path = ? AND root_id = ?', file.rel, file.rootId);
    if (!added) return;
    const onDisk = state.onDisk.get(file.rootId) ?? new Set<string>();
    for (const old of all<{ id: number; path: string }>(db, 'SELECT id, path FROM media_files WHERE episode_id = ? AND id <> ? AND root_id = ?', episodeId, added.id, file.rootId)) {
      // Same file name elsewhere is a move, handled by relocateMoved (which refuses ambiguous ones on purpose).
      if (onDisk.has(old.path) || basename(old.path) === basename(file.rel)) continue;
      run(
        db,
        `INSERT OR IGNORE INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at)
         SELECT profile_id, ?, position_s, duration_s, completed, updated_at FROM watch_progress WHERE media_file_id = ? ORDER BY updated_at DESC`,
        added.id,
        old.id,
      );
      run(db, 'DELETE FROM media_files WHERE id = ?', old.id);
    }
  }

  // One TMDB lookup per folder per root per scan; without TMDB the folder becomes a placeholder title.
  function resolveDir(state: ScanState, rootId: number, dirRel: string, folder: string): Promise<Assignment> {
    const key = `${rootId}:${dirRel}`;
    let hit = state.dirs.get(key);
    if (!hit) {
      hit = (async () => {
        if (!state.offline) {
          try {
            return await assignSeries(state.ctx, dirRel, folder, rootId);
          } catch (err) {
            goOffline(state, err);
          }
        }
        const known = get<{ title_id: number; season_number: number | null }>(db, 'SELECT title_id, season_number FROM source_dirs WHERE root_id = ? AND path = ?', rootId, dirRel);
        if (known) return { status: 'matched', titleId: known.title_id, seasonNumber: known.season_number } as const;
        const titleId = createLocalTitle(db, 'series', folder);
        setSourceDir(db, dirRel, titleId, null, rootId);
        return { status: 'matched', titleId, seasonNumber: null } as const;
      })();
      state.dirs.set(key, hit);
    }
    return hit;
  }

  async function resolveMovie(state: ScanState, parsed: Extract<Parsed, { kind: 'movie' }>): Promise<Assignment> {
    if (!state.offline) {
      try {
        return await assignMovie(state.ctx, parsed.title, parsed.year);
      } catch (err) {
        goOffline(state, err);
      }
    }
    return { status: 'matched', titleId: createLocalTitle(db, 'movie', parsed.title, parsed.year), seasonNumber: null };
  }

  function goOffline(state: ScanState, err: unknown) {
    state.offline = true;
    log('warn', `TMDB unavailable, continuing offline: ${(err as Error).message}`);
  }

  // Placeholder titles get their metadata once TMDB answers; files left without an episode are placed again.
  async function retryMetadata(state: ScanState): Promise<void> {
    const pendingTitles = all<{ id: number; kind: string; title: string; year: number | null }>(
      db,
      "SELECT id, kind, title, year FROM titles WHERE metadata_status = 'pending'",
    );
    try {
      for (const t of pendingTitles) {
        if (t.kind === 'movie') {
          await assignMovie(state.ctx, t.title, t.year, t.id);
          continue;
        }
        const dirs = all<{ root_id: number; path: string }>(db, 'SELECT root_id, path FROM source_dirs WHERE title_id = ?', t.id);
        if (dirs.length === 0) continue;
        const found = await matchSeries(state.ctx, t.title);
        if ('candidates' in found) continue;
        run(db, 'DELETE FROM seasons WHERE title_id = ?', t.id);
        let titleId = t.id;
        for (const d of dirs) titleId = (await adoptSeries(state.ctx, d.path, found.tv, found.group, titleId, d.root_id)).titleId;
        await relinkFiles(state.ctx, titleId);
      }
      // Series imported with official seasons are checked once for a better "Seasons" group. Folder-matched
      // groups keep priority. Files are re-placed (same media_files rows) after the seasons are rebuilt.
      for (const t of all<{ id: number; tmdb_id: number; episode_group_id: string | null }>(
        db,
        "SELECT id, tmdb_id, episode_group_id FROM titles WHERE tmdb_type = 'tv' AND seasons_group_id IS NULL AND metadata_status = 'ready'",
      )) {
        const seasons = t.episode_group_id ? null : await findSeasonsGroup(state.ctx, await state.ctx.tmdb.tv(t.tmdb_id));
        if (!seasons) {
          markOfficialSeasons(db, t.id);
          continue;
        }
        run(db, 'DELETE FROM seasons WHERE title_id = ?', t.id);
        await importSeasonsGroup(state.ctx, t.id, seasons);
        await relinkFiles(state.ctx, t.id);
      }
      const orphans = all<{ title_id: number }>(
        db,
        `SELECT DISTINCT m.title_id FROM media_files m JOIN titles t ON t.id = m.title_id
         WHERE m.episode_id IS NULL AND m.extra_label IS NULL AND m.parsed_number IS NOT NULL AND t.metadata_status = 'ready'`,
      );
      for (const o of orphans) await relinkFiles(state.ctx, o.title_id);
      if (!state.offline) await fixPersonNames(state.ctx);
    } catch (err) {
      goOffline(state, err);
    }
  }

  // Extras stored by an older parser lost their number ("NCED" instead of "NCED 01").
  function relabelExtras(): void {
    for (const r of all<{ id: number; path: string; extra_label: string }>(db, 'SELECT id, path, extra_label FROM media_files WHERE extra_label IS NOT NULL')) {
      const parsed = parsePath(r.path);
      if (parsed.kind === 'extra' && parsed.label !== r.extra_label) run(db, 'UPDATE media_files SET extra_label = ? WHERE id = ?', parsed.label, r.id);
    }
  }

  function schedule(ms: number, slot: 'debounce' | 'recent') {
    clearTimeout(timers[slot]);
    timers[slot] = setTimeout(() => void scan(), ms);
    timers[slot].unref();
  }

  function start(intervalMin: number) {
    stop();
    armed = true;
    armWatchers(scanRoots().filter((r) => rootPresent(r.id)));
    void scan();
    timers.interval = setInterval(() => void scan(), intervalMin * 60_000);
    timers.interval.unref();
  }

  // Only the folders that hold media: package writes under `.sala/` must not trigger a scan per segment.
  // One watcher per root: an absent (or moved) root loses its watchers instead of keeping a dead handle.
  function armWatchers(roots: ScanRoot[]) {
    const wanted = new Map<string, string>();
    for (const root of roots) for (const rel of ROOTS) wanted.set(`${root.id}:${rel}`, join(root.path, rel));
    for (const [key, w] of watchers) {
      if (wanted.get(key) === w.dir) continue;
      w.watcher.close();
      watchers.delete(key);
    }
    for (const [key, dir] of wanted) {
      if (watchers.has(key)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, () => schedule(DEBOUNCE_MS, 'debounce'));
        watcher.on('error', (err) => log('warn', `watcher error: ${err.message}`));
        watchers.set(key, { dir, watcher });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `fs.watch unavailable for ${dir}, relying on periodic scans: ${(err as Error).message}`);
      }
    }
  }

  function closeWatchers() {
    watchers.forEach((w) => w.watcher.close());
    watchers.clear();
  }

  function stop() {
    clearInterval(timers.interval);
    clearTimeout(timers.debounce);
    clearTimeout(timers.recent);
    closeWatchers();
    armed = false;
    timers = {};
  }

  // Absolute folder of a root: the live configured folder for root 1, its last known path for the rest.
  function rootPath(rootId: number): string {
    if (rootId === 1) return contentDir();
    return get<{ last_known_path: string | null }>(db, 'SELECT last_known_path FROM library_roots WHERE id = ?', rootId)?.last_known_path ?? contentDir();
  }

  const confirm = (id: number, body: ConfirmBody) =>
    confirmPending({ ctx: { db, tmdb: memoize(opts.tmdb), dataDir }, probe, contentDir: (rootId) => rootPath(rootId) }, id, body);

  return { scan, start, stop, confirm };
}
