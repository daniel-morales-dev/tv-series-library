import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { sendFile } from '../../http/static-file.ts';
import { all, get } from '../../db/sql.ts';
import { touchPlayed } from './cache.ts';
import { enqueue, listJobs } from './queue.ts';
import type { Worker } from './worker.ts';

const STREAM_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const idParams = (name: string) => ({ type: 'object', properties: { [name]: { type: 'integer' } }, required: [name] }) as const;

type ActivityStatus = 'running' | 'queued' | 'error';

interface ActivityItem {
  mediaFileId: number;
  jobId: number | null;
  status: ActivityStatus;
  progress: number;
  error: string | null;
  kind: 'episode' | 'film' | 'extra';
  title: string;
  extraLabel: string | null;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
}

// T32: enough for the drawer's preview; the badge uses queuedTotal for the real number.
const QUEUED_PREVIEW = 10;

const DISPLAY_COLS = `m.id AS media_file_id, m.extra_label, t.title AS title_name,
  e.number AS episode_number, e.name AS episode_name, s.number AS season_number`;
const DISPLAY_JOINS = `JOIN titles t ON t.id = m.title_id
  LEFT JOIN episodes e ON e.id = m.episode_id
  LEFT JOIN seasons s ON s.id = e.season_id`;

function activityItem(row: Record<string, unknown>, status: ActivityStatus): ActivityItem {
  const episode = (row.episode_number as number | null) ?? null;
  const extraLabel = (row.extra_label as string | null) ?? null;
  return {
    mediaFileId: row.media_file_id as number,
    jobId: (row.job_id as number | null) ?? null,
    status,
    progress: (row.progress as number | null) ?? 0,
    error: (row.error as string | null) ?? null,
    kind: extraLabel !== null ? 'extra' : episode !== null ? 'episode' : 'film',
    title: row.title_name as string,
    extraLabel,
    season: (row.season_number as number | null) ?? null,
    episode,
    episodeName: (row.episode_name as string | null) ?? null,
  };
}

// What the activity drawer polls: what runs now, the queue preview (run order, extras last)
// and every failed file, all with display names joined in.
function activityView(db: DatabaseSync) {
  const jobCols = `j.id AS job_id, j.progress, j.error, ${DISPLAY_COLS}`;
  const order = 'j.priority DESC, (m.extra_label IS NOT NULL), j.id';
  const running = all<Record<string, unknown>>(
    db,
    `SELECT ${jobCols} FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     ${DISPLAY_JOINS}
     WHERE j.type = 'process' AND j.status = 'running' ORDER BY ${order}`,
  ).map((row) => activityItem(row, 'running'));
  const queued = all<Record<string, unknown>>(
    db,
    `SELECT ${jobCols} FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     ${DISPLAY_JOINS}
     WHERE j.type = 'process' AND j.status = 'queued' ORDER BY ${order} LIMIT ?`,
    QUEUED_PREVIEW,
  ).map((row) => activityItem(row, 'queued'));
  const queuedTotal = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE type = 'process' AND status = 'queued'")!.n;
  const failed = all<Record<string, unknown>>(
    db,
    `SELECT m.error, ${DISPLAY_COLS} FROM media_files m ${DISPLAY_JOINS}
     WHERE m.status = 'error' ORDER BY m.created_at DESC, m.id DESC`,
  ).map((row) => activityItem(row, 'error'));
  return { running, queued, queuedTotal, failed };
}

/** T47d: `present` tells whether the library disk is mounted; `hlsOnLibrary` means the HLS tree lives inside it. */
export interface DiskGuard {
  present: () => boolean;
  hlsOnLibrary?: boolean;
}

export function processingRoutes(api: FastifyInstance, db: DatabaseSync, hlsDir: string, worker?: Worker, disk: DiskGuard = { present: () => true }): void {
  api.get('/jobs', async () => listJobs(db));
  api.get('/activity', async () => {
    const lowDisk = worker?.lowDisk() ?? null;
    return {
      ...activityView(db),
      paused: worker?.isPaused() ?? false,
      lowDisk: lowDisk !== null,
      lowDiskMessage: lowDisk?.message ?? null,
      diskAbsent: !disk.present(),
    };
  });
  const diskAbsent = (reply: FastifyReply) => reply.code(503).header('Retry-After', '5').send({ error: 'disk_absent' });

  // A ready copy-mode file whose package was never built (or was evicted): built on demand, ahead of the queue.
  const isLazy = (f: { status: string; hls_dir: string | null; pkg_mode: string | null }) =>
    f.status === 'ready' && f.hls_dir === null && f.pkg_mode === 'copy';
  function requestPackage(id: number): number {
    const jobId = enqueue(db, id, true);
    worker?.prioritize(id);
    return jobId;
  }

  api.post('/processing/pause', async (_req, reply) => {
    if (!worker) return reply.code(409).send({ error: 'processing_disabled' });
    worker.pause();
    return { paused: true };
  });

  api.post('/processing/resume', async (_req, reply) => {
    if (!worker) return reply.code(409).send({ error: 'processing_disabled' });
    worker.resume();
    return { paused: false };
  });

  api.post<{ Params: { id: number } }>('/media-files/:id/process', { schema: { params: idParams('id') } }, async (req, reply) => {
    const file = get<{ status: string }>(db, 'SELECT status FROM media_files WHERE id = ?', req.params.id);
    if (!file) return reply.code(404).send({ error: 'not_found' });
    if (file.status === 'downloading') return reply.code(409).send({ error: 'downloading' });
    const jobId = enqueue(db, req.params.id);
    worker?.kick();
    return reply.code(202).send({ jobId });
  });

  api.post<{ Params: { id: number } }>('/media-files/:id/play', { schema: { params: idParams('id') } }, async (req, reply) => {
    const file = get<{ status: string; hls_dir: string | null; pkg_mode: string | null }>(
      db,
      'SELECT status, hls_dir, pkg_mode FROM media_files WHERE id = ?',
      req.params.id,
    );
    if (!file) return reply.code(404).send({ error: 'not_found' });
    if (file.status === 'downloading') return reply.code(409).send({ error: 'downloading' });
    const lazy = isLazy(file);
    if (lazy && !disk.present()) return diskAbsent(reply); // building the package needs the original
    if (file.status === 'ready' && !lazy) {
      touchPlayed(db, req.params.id);
      return { status: 'ready' };
    }
    // `processing` is what the player already waits on; `preparing` tells it this is only the on-demand package.
    return reply.code(202).send({ status: 'processing', preparing: lazy, jobId: requestPackage(req.params.id) });
  });

  // Playlists change when a file is reprocessed, so only the media itself may be cached.
  // While a file is being processed its package lives in `<id>.tmp`.
  api.get<{ Params: { mediaFileId: number; '*': string } }>(
    '/stream/:mediaFileId/*',
    { schema: { params: { ...idParams('mediaFileId'), properties: { mediaFileId: { type: 'integer' }, '*': { type: 'string' } } } } },
    async (req, reply) => {
      if (disk.hlsOnLibrary && !disk.present()) return diskAbsent(reply);
      const dir = join(hlsDir, String(req.params.mediaFileId));
      const base = (await stat(dir).catch(() => null))?.isDirectory() ? dir : `${dir}.tmp`;
      if (base !== dir && !(await stat(base).catch(() => null))?.isDirectory()) {
        if (!disk.present()) return diskAbsent(reply); // nothing to serve and nothing can be built
        const file = get<{ status: string; hls_dir: string | null; pkg_mode: string | null }>(
          db,
          'SELECT status, hls_dir, pkg_mode FROM media_files WHERE id = ?',
          req.params.mediaFileId,
        );
        if (file && isLazy(file)) {
          requestPackage(req.params.mediaFileId);
          return reply.code(503).header('Retry-After', '2').send({ error: 'preparing' });
        }
      }
      touchPlayed(db, req.params.mediaFileId);
      return sendFile(reply, base, req.params['*'], STREAM_TYPES, (ext) => (ext === '.m3u8' ? 'no-cache' : 'public, max-age=3600'));
    },
  );
}
