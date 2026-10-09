import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProbeStreams, type RunFfmpeg, extractArgs, mainArgs, nameRenditions } from './ffmpeg.ts';
import { buildPlan } from './plan.ts';
import type { ProcessResult } from './queue.ts';

export interface ProcessDeps {
  dataDir: string;
  contentDir: string;
  runFfmpeg: RunFfmpeg;
  probeStreams: ProbeStreams;
}

export class SourceMissingError extends Error {
  constructor(path: string) {
    super(`source file not found: ${path}`);
  }
}

// Writes the HLS package to `hls/<id>.tmp` and swaps it into place only when everything succeeded.
export async function processMedia(
  deps: ProcessDeps,
  file: { id: number; path: string },
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
  const src = join(deps.contentDir, file.path);
  if (!(await stat(src).catch(() => null))?.isFile()) throw new SourceMissingError(file.path);

  const info = await deps.probeStreams(src);
  const plan = buildPlan(info);
  const rel = `hls/${file.id}`;
  const finalDir = join(deps.dataDir, rel);
  const tmpDir = `${finalDir}.tmp`;

  await rm(tmpDir, { recursive: true, force: true });
  try {
    for (const dir of ['v', ...plan.audio.map((a) => `a${a.n}`), 'subs', 'fonts']) await mkdir(join(tmpDir, dir), { recursive: true });
    const { signal } = opts;
    await deps.runFfmpeg(mainArgs(plan, src, tmpDir), {
      signal,
      onProgress: (s) => opts.onProgress?.(info.durationS > 0 ? Math.min(s / info.durationS, 1) : 0),
    });
    if (plan.subtitles.some((s) => s.supported) || plan.fonts.length > 0) await deps.runFfmpeg(extractArgs(plan, src, tmpDir), { signal });

    const masterPath = join(tmpDir, 'master.m3u8');
    await writeFile(masterPath, nameRenditions(await readFile(masterPath, 'utf8'), plan));
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return {
    hlsDir: rel,
    audio: plan.audio.map((a) => ({ index: a.index, codec: a.codec, language: a.language, title: a.title, channels: a.channels, playlist: a.playlist })),
    subtitles: plan.subtitles.map((s) => ({
      index: s.index, codec: s.codec, language: s.language, title: s.title, supported: s.supported, vtt: s.vtt, ass: s.ass,
    })),
  };
}
