import { watch, type FSWatcher } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { type Assignment, adoptSeries, assignMovie, assignSeries, matchSeries, placeEpisode } from './assign.ts';
import { type IngestContext, createLocalTitle, setSourceDir } from './metadata.ts';
import { type Parsed, parsePath } from './parser.ts';
import { type Probe, ffprobe } from './probe.ts';
import { type ConfirmBody, confirmPending } from './pending.ts';
import { addPending, registerFile, relinkFiles } from './register.ts';
import { type VideoFile, listVideos, showDirKey } from './scanner.ts';
import { type TmdbClient, memoize } from './tmdb.ts';

const MIN_AGE_MS = 60_000;
const DEBOUNCE_MS = 5_000;

export interface ScanSummary {
  ingested: number;
  pending: number;
  /** Too recent or unreadable by ffprobe: tried again on the next scan. */
  waiting: number;
  failed: number;
}

export interface IngestorOptions {
  db: DatabaseSync;
  tmdb: TmdbClient;
  dataDir: string;
  contentDir: string;
  probe?: Probe;
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

interface ScanState {
  ctx: IngestContext;
  offline: boolean;
  dirs: Map<string, Promise<Assignment>>;
}

export function createIngestor(opts: IngestorOptions): Ingestor {
  const { db, dataDir, contentDir } = opts;
  const probe = opts.probe ?? ffprobe;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  let running: Promise<ScanSummary> | null = null;
  let again = false;
  let timers: { interval?: NodeJS.Timeout; debounce?: NodeJS.Timeout; recent?: NodeJS.Timeout; watcher?: FSWatcher } = {};

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
    const state: ScanState = { ctx: { db, tmdb: memoize(opts.tmdb), dataDir }, offline: false, dirs: new Map() };
    const summary: ScanSummary = { ingested: 0, pending: 0, waiting: 0, failed: 0 };
    await retryMetadata(state);

    const known = new Set([
      ...all<{ path: string }>(db, 'SELECT path FROM media_files').map((r) => r.path),
      ...all<{ path: string }>(db, 'SELECT path FROM pending_files').map((r) => r.path),
    ]);
    for (const file of await listVideos(contentDir)) {
      if (known.has(file.rel)) continue;
      try {
        summary[await ingestFile(state, file)]++;
      } catch (err) {
        summary.failed++;
        log('warn', `ingest failed for ${file.rel}: ${(err as Error).message}`);
      }
    }
    if (summary.waiting > 0) schedule(MIN_AGE_MS + 1_000, 'recent');
    log('info', `scan done: ${JSON.stringify(summary)}`);
    return summary;
  }

  async function ingestFile(state: ScanState, file: VideoFile): Promise<'ingested' | 'pending' | 'waiting'> {
    if (now() - file.mtimeMs <= MIN_AGE_MS) return 'waiting';
    const info = await probe(file.abs).catch(() => null);
    if (!info) return 'waiting';

    const facts = { rel: file.rel, size: file.size, probe: info };
    const parsed = parsePath(file.rel);
    const toPending = (reason: 'unparsed' | 'no_match' | 'unmapped_episode', candidates: Parameters<typeof addPending>[5] = []) => {
      addPending(db, file.rel, file.size, parsed, reason, candidates);
      return 'pending' as const;
    };

    if (parsed.kind === 'unparsed') return toPending('unparsed');

    if (parsed.kind === 'movie') {
      const out = await resolveMovie(state, parsed);
      if (out.status === 'no_match') return toPending('no_match', out.candidates);
      registerFile(db, facts, { titleId: out.titleId, episodeId: null, extraLabel: null, parsedSeason: null, parsedNumber: null });
      return 'ingested';
    }

    const dir = await resolveDir(state, showDirKey(file.rel, parsed.show), parsed.show);
    if (dir.status === 'no_match') return toPending('no_match', dir.candidates);
    if (parsed.kind === 'extra') {
      registerFile(db, facts, { titleId: dir.titleId, episodeId: null, extraLabel: parsed.label, parsedSeason: null, parsedNumber: null });
      return 'ingested';
    }
    const episodeId = await placeEpisode(state.ctx, dir.titleId, dir.seasonNumber, parsed);
    if (episodeId === null) return toPending('unmapped_episode');
    registerFile(db, facts, { titleId: dir.titleId, episodeId, extraLabel: null, parsedSeason: parsed.season, parsedNumber: parsed.number });
    return 'ingested';
  }

  // One TMDB lookup per folder per scan; without TMDB the folder becomes a placeholder title.
  function resolveDir(state: ScanState, dirRel: string, folder: string): Promise<Assignment> {
    let hit = state.dirs.get(dirRel);
    if (!hit) {
      hit = (async () => {
        if (!state.offline) {
          try {
            return await assignSeries(state.ctx, dirRel, folder);
          } catch (err) {
            goOffline(state, err);
          }
        }
        const known = get<{ title_id: number; season_number: number | null }>(db, 'SELECT title_id, season_number FROM source_dirs WHERE path = ?', dirRel);
        if (known) return { status: 'matched', titleId: known.title_id, seasonNumber: known.season_number } as const;
        const titleId = createLocalTitle(db, 'series', folder);
        setSourceDir(db, dirRel, titleId, null);
        return { status: 'matched', titleId, seasonNumber: null } as const;
      })();
      state.dirs.set(dirRel, hit);
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
        const dirs = all<{ path: string }>(db, 'SELECT path FROM source_dirs WHERE title_id = ?', t.id);
        if (dirs.length === 0) continue;
        const found = await matchSeries(state.ctx, t.title);
        if ('candidates' in found) continue;
        run(db, 'DELETE FROM seasons WHERE title_id = ?', t.id);
        let titleId = t.id;
        for (const d of dirs) titleId = (await adoptSeries(state.ctx, d.path, found.tv, found.group, titleId)).titleId;
        await relinkFiles(state.ctx, titleId);
      }
      const orphans = all<{ title_id: number }>(
        db,
        `SELECT DISTINCT m.title_id FROM media_files m JOIN titles t ON t.id = m.title_id
         WHERE m.episode_id IS NULL AND m.extra_label IS NULL AND m.parsed_number IS NOT NULL AND t.metadata_status = 'ready'`,
      );
      for (const o of orphans) await relinkFiles(state.ctx, o.title_id);
    } catch (err) {
      goOffline(state, err);
    }
  }

  function schedule(ms: number, slot: 'debounce' | 'recent') {
    clearTimeout(timers[slot]);
    timers[slot] = setTimeout(() => void scan(), ms);
    timers[slot].unref();
  }

  function start(intervalMin: number) {
    stop();
    void scan();
    timers.interval = setInterval(() => void scan(), intervalMin * 60_000);
    timers.interval.unref();
    try {
      timers.watcher = watch(contentDir, { recursive: true }, () => schedule(DEBOUNCE_MS, 'debounce'));
      timers.watcher.on('error', (err) => log('warn', `watcher error: ${err.message}`));
    } catch (err) {
      log('warn', `fs.watch unavailable, relying on periodic scans: ${(err as Error).message}`);
    }
  }

  function stop() {
    clearInterval(timers.interval);
    clearTimeout(timers.debounce);
    clearTimeout(timers.recent);
    timers.watcher?.close();
    timers = {};
  }

  const confirm = (id: number, body: ConfirmBody) =>
    confirmPending({ ctx: { db, tmdb: memoize(opts.tmdb), dataDir }, probe, contentDir }, id, body);

  return { scan, start, stop, confirm };
}
