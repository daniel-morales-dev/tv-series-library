import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProbeStreams, type RunFfmpeg, extractArgs, mainArgs, nameRenditions } from './ffmpeg.ts';
import { type Plan, buildPlan } from './plan.ts';
import type { ProcessResult } from './queue.ts';

// Writes through a sibling file so a player never reads a half-written master.
// `strict` skips a master ffmpeg is still writing (it ends with a rendition's playlist URI).
async function nameMaster(dir: string, plan: Plan, strict: boolean): Promise<boolean> {
  const path = join(dir, 'master.m3u8');
  const text = await readFile(path, 'utf8');
  if (strict && !/\.m3u8\n$/.test(text)) return false;
  await writeFile(`${path}.new`, nameRenditions(text, plan));
  await rename(`${path}.new`, path);
  return true;
}

export interface ProcessDeps {
  dataDir: string;
  contentDir: string;
  runFfmpeg: RunFfmpeg;
  probeStreams: ProbeStreams;
  threads?: number;
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
    // Subtitles and fonts first, so they exist as soon as playback can start.
    if (plan.subtitles.some((s) => s.supported) || plan.fonts.length > 0) await deps.runFfmpeg(extractArgs(plan, src, tmpDir), { signal });

    // ffmpeg writes the master once, early: name the audio tracks right away so playback shows them.
    let named = false;
    let naming: Promise<void> | undefined;
    await deps.runFfmpeg(mainArgs(plan, src, tmpDir, { threads: deps.threads }), {
      signal,
      onProgress: (s) => {
        opts.onProgress?.(info.durationS > 0 ? Math.min(s / info.durationS, 1) : 0);
        if (named || naming) return;
        naming = nameMaster(tmpDir, plan, true)
          .then((ok) => void (named = ok), () => {})
          .finally(() => (naming = undefined));
      },
    });
    await naming;
    await nameMaster(tmpDir, plan, false);
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
