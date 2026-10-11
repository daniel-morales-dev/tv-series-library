#!/usr/bin/env node
// T21d — parallel-processing benchmark: does N jobs x T threads beat today's 1 x 8?
//
// SAFETY: read-only over content/; every scratch file lives under /tmp/opencode/bench (never data/,
// never the DB, never the repo); it does not start, stop or touch the systemd service on :8080.
// The latency server binds 127.0.0.1 on an ephemeral port. Scratch is removed on exit, SIGINT included.
//
// Usage:
//   node scripts/bench-parallel.mjs --quick   # smoke test only: 2 cells, 1 rep, 10 s clips (~1-2 min)
//   node scripts/bench-parallel.mjs           # full matrix: ~45-60 min on an idle machine.
//                                             # The orchestrator runs this LATER, in an agreed window — NOT now.
//
// What one full run does:
//   1. Probes candidate sources with ffprobe and picks one H.264 10-bit, one HEVC and one H.264 8-bit;
//      cuts 3 x 60 s clips (-ss 300 -t 60 -c copy) into scratch and builds their real plans
//      (probeStreams + buildPlan, exactly like the worker).
//   2. Matrix jobs {1,2,3,4} x threads {2,4,8} limited to jobs*threads <= os.cpus().length; 3 reps in
//      shuffled order; 30 s cooldown between consecutive runs; aborts when loadavg1 > 0.3 x cores
//      (waiting up to 2 min first, so the benchmark's own 1-min average can decay).
//   3. Per cell: runs the worker's encode path (mainArgs with -threads N, setPriority(pid, 19)) over
//      the clip queue with `jobs` concurrent ffmpeg processes; measures
//        - throughput = sum(clip seconds) / wall seconds, plus the last `speed=` of every job
//        - RAM: per-job VmHWM (/proc/<pid>/status every 500 ms) and system min MemAvailable
//        - play latency: ephemeral HTTP server serving a ~2 MB .m4s at ~20 req/s; client p50/p95/p99
//          and perf_hooks.monitorEventLoopDelay of the serving event loop; baseline = same load, no jobs
//        - /proc/diskstats delta for the content and scratch volumes; governor and CPU temperature
//   4. Writes CSV (one row per rep) + prints the summary table and a recommendation using the design
//      criteria: throughput gain >= 10 % vs 1x8 AND p95 latency delta <= 50 ms AND RSS total within
//      jobs x 1200 MB + 1536 MB reserve.
//
// Known limitations: with 3 clips, cells with jobs > 3 run at effective concurrency 3 (logged).
// The 8-bit H.264 sample resolves to copy mode (ADR 0006), so it contributes a short copy job to every
// cell, exactly as production would; subtitle/font extraction is skipped (sub-second, thread-independent).
// --quick continues with a warning instead of aborting when the machine is busy: it exists to smoke-test
// this script, not to produce measurements.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { availableParallelism, cpus, loadavg, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const QUICK = process.argv.includes('--quick');
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTENT = join(REPO, 'content');
const BENCH_ROOT = '/tmp/opencode/bench';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = join(BENCH_ROOT, `scratch-${STAMP}`);
const LOG_FILE = join(BENCH_ROOT, `bench-${STAMP}.log`);
const CSV_FILE = join(BENCH_ROOT, `bench-${STAMP}.csv`);

const CORES = cpus().length;
const LOAD_LIMIT = 0.3 * CORES;
const RAM_PER_JOB_MB = 1200; // design default, pending this measurement
const RAM_RESERVE_MB = 1536;
const SAMPLE_SECONDS = QUICK ? 10 : 60;
const REPS = QUICK ? 1 : 3;
const COOLDOWN_MS = QUICK ? 2_000 : 30_000;
const BASELINE_MS = QUICK ? 5_000 : 20_000;
const LOAD_RATE_PER_S = 20;
const LOAD_INFLIGHT_CAP = 16;
const CLIP_START_S = 300;
const JOB_TIMEOUT_MS = QUICK ? 120_000 : 900_000;

// The processing modules are TypeScript: Node >= 23.6 runs .ts directly (type stripping), like the server.
const { mainArgs, probeStreams, encodeProfile } = await import(new URL('../apps/server/src/modules/processing/ffmpeg.ts', import.meta.url).href);
const { buildPlan } = await import(new URL('../apps/server/src/modules/processing/plan.ts', import.meta.url).href);

mkdirSync(BENCH_ROOT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(digits));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, `${line}\n`); } catch {}
}
function logCommand(bin, args) { log(`$ ${bin} ${args.join(' ')}`); }
function runSync(bin, args) {
  logCommand(bin, args);
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}: ${(r.stderr ?? '').trim().slice(-500)}`);
  return r;
}

// ---------------------------------------------------------------- samples

const WANTS = {
  'h264-10bit': (s) => s.codec_name === 'h264' && (s.pix_fmt ?? '').includes('10'),
  hevc: (s) => s.codec_name === 'hevc',
  'h264-8bit': (s) => s.codec_name === 'h264' && /^yuvj?420p$/.test(s.pix_fmt ?? ''),
};
// First match per category wins; probed at runtime and logged, so the pick is reproducible.
const CANDIDATES = [
  { want: 'h264-10bit', path: 'shows/bakemonogatari/[Coalgirls]_Bakemonogatari_15_(1920x1080_Blu-ray_FLAC)_[256D3923].mkv' },
  { want: 'h264-10bit', path: 'shows/bakemonogatari/[Coalgirls]_Bakemonogatari_14_(1920x1080_Blu-ray_FLAC)_[78E02D9C].mkv' },
  { want: 'hevc', path: 'shows/danmachi/[EMBER] Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka S5 - 06.mkv' },
  { want: 'hevc', path: 'shows/nisemonogatari/[Jaku] Nisemonogatari S02 E01 [BDRip 1080p HEVC-10bits FLAC].mkv' },
  { want: 'h264-8bit', path: 'shows/[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]/[SubsPlease] Sousou no Frieren - 04v3 (1080p) [2D946B13].mkv' },
  { want: 'h264-8bit', path: 'shows/Seitokai ni mo Ana wa Aru/Even.the.Student.Council.Has.Its.Holes.S01E01.1080p.UNCENSORED.ADN.WEB-DL.JPN.AAC2.0.H.264.MSubs-ToonsHub.mkv' },
];

function probeVideo(abs) {
  const r = runSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'json', abs]);
  const s = JSON.parse(r.stdout).streams?.[0] ?? {};
  return { codec_name: s.codec_name ?? null, profile: s.profile ?? null, pix_fmt: s.pix_fmt ?? null };
}

function pickSources() {
  log('probing sample candidates (ffprobe):');
  const picks = {};
  for (const c of CANDIDATES) {
    const abs = join(CONTENT, c.path);
    let v;
    try { v = probeVideo(abs); } catch (err) { log(`  ${c.want}: ${c.path} — unreadable (${err.message})`); continue; }
    log(`  ${c.want}: ${c.path} -> ${v.codec_name}/${v.profile}/${v.pix_fmt}`);
    if (!picks[c.want] && WANTS[c.want](v)) picks[c.want] = { id: c.want, abs };
  }
  for (const want of Object.keys(WANTS)) if (!picks[want]) throw new Error(`no candidate matched ${want}; edit CANDIDATES in this script`);
  return Object.values(picks);
}

function buildClips(picks) {
  const clips = [];
  for (const p of picks) {
    const out = join(RUN_DIR, `clip-${p.id}.mkv`);
    runSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(CLIP_START_S), '-t', String(SAMPLE_SECONDS), '-i', p.abs, '-map', '0', '-c', 'copy', out]);
    const bytes = statSync(out).size;
    log(`clip ${p.id}: ${out} (${(bytes / 1e6).toFixed(1)} MB, ${SAMPLE_SECONDS} s from ${p.abs})`);
    clips.push({ id: p.id, path: out });
  }
  return clips;
}

async function buildSamples(clips) {
  const samples = [];
  for (const c of clips) {
    const info = await probeStreams(c.path);
    const plan = buildPlan(info);
    samples.push({ id: c.id, path: c.path, durationS: info.durationS, plan, mode: plan.video.mode });
    log(`sample ${c.id}: mode=${plan.video.mode} audio=${plan.audio.length} subs=${plan.subtitles.length} duration=${info.durationS.toFixed(1)} s video=${JSON.stringify(plan.video)}`);
  }
  return samples;
}

function buildLatencyFile() {
  const out = join(RUN_DIR, 'latency-seg.m4s');
  runSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '16', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', out]);
  log(`latency segment: ${out} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
  return out;
}

// ---------------------------------------------------------------- latency server + load

async function startLatencyServer(file) {
  const body = readFileSync(file);
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/iso.segment', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/iso.segment', 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  log(`latency server: http://127.0.0.1:${port}/seg.m4s serving ${body.length} bytes`);
  return { server, port };
}

function startLoad(port) {
  const state = { latencies: [], skipped: 0, inflight: 0 };
  const url = `http://127.0.0.1:${port}/seg.m4s`;
  state.timer = setInterval(() => {
    if (state.inflight >= LOAD_INFLIGHT_CAP) { state.skipped++; return; }
    state.inflight++;
    const t0 = performance.now();
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then(() => state.latencies.push(performance.now() - t0))
      .catch(() => state.skipped++)
      .finally(() => { state.inflight--; });
  }, 1000 / LOAD_RATE_PER_S);
  return state;
}

async function stopLoad(state) {
  clearInterval(state.timer);
  const deadline = Date.now() + 2_000;
  while (state.inflight > 0 && Date.now() < deadline) await sleep(50);
  return state;
}

// ---------------------------------------------------------------- resource poller

function startPoller() {
  const stats = { perJob: new Map(), samples: [], memAvailMinMb: null };
  const pids = new Set();
  const timer = setInterval(() => {
    try {
      const m = /^MemAvailable:\s*(\d+)\s*kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (m) {
        const mb = Number(m[1]) / 1024;
        stats.memAvailMinMb = stats.memAvailMinMb === null ? mb : Math.min(stats.memAvailMinMb, mb);
      }
    } catch {}
    for (const pid of pids) {
      try {
        const m = /^VmHWM:\s*(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (!m) continue;
        const mb = Number(m[1]) / 1024;
        stats.samples.push(mb);
        if (mb > (stats.perJob.get(pid) ?? 0)) stats.perJob.set(pid, mb);
      } catch {}
    }
  }, 500);
  return { add: (pid) => pids.add(pid), remove: (pid) => pids.delete(pid), stop: () => { clearInterval(timer); return stats; } };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
const median = (values) => percentile(values, 50);

const loopHist = monitorEventLoopDelay({ resolution: 10 });
const loopStats = () => ({ p50: loopHist.percentile(50) / 1e6, p95: loopHist.percentile(95) / 1e6, p99: loopHist.percentile(99) / 1e6 });
const latencyStats = (state) => ({ p50: percentile(state.latencies, 50), p95: percentile(state.latencies, 95), p99: percentile(state.latencies, 99), n: state.latencies.length, skipped: state.skipped });

// ---------------------------------------------------------------- environment probes

function readTempC() {
  try {
    const temps = [];
    for (const zone of readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone')) continue;
      try {
        const t = Number(readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim());
        if (Number.isFinite(t) && t > 0) temps.push(t / 1000);
      } catch {}
    }
    return temps.length ? Math.max(...temps) : null;
  } catch { return null; }
}
function readGovernor() {
  try { return readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim(); } catch { return null; }
}
function devKey(path) {
  try {
    const dev = statSync(path, { bigint: true }).dev;
    const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
    const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xfffn));
    return `${major}:${minor}`;
  } catch { return null; }
}
const IO_DEVS = [...new Set([devKey(CONTENT), devKey(RUN_DIR)].filter(Boolean))];
function ioSnapshot() {
  const all = new Map();
  try {
    for (const line of readFileSync('/proc/diskstats', 'utf8').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14) continue;
      all.set(`${f[0]}:${f[1]}`, { readSectors: Number(f[5]), writeSectors: Number(f[9]) });
    }
  } catch {}
  const snap = {};
  for (const k of IO_DEVS) snap[k] = all.get(k) ?? null;
  return snap;
}
function ioDelta(before) {
  const after = ioSnapshot();
  let readMb = 0, writeMb = 0, any = false;
  for (const k of IO_DEVS) {
    const a = before[k], b = after[k];
    if (!a || !b) continue;
    any = true;
    readMb += Math.max(0, b.readSectors - a.readSectors) * 512 / 1e6;
    writeMb += Math.max(0, b.writeSectors - a.writeSectors) * 512 / 1e6;
  }
  return any ? { readMb, writeMb } : { readMb: null, writeMb: null };
}

// ---------------------------------------------------------------- idle gate

async function assertIdle(label) {
  const deadline = Date.now() + (QUICK ? 10_000 : 120_000);
  for (;;) {
    const la = loadavg()[0];
    if (la <= LOAD_LIMIT) return la;
    if (Date.now() >= deadline) {
      const msg = `${label}: machine busy — loadavg1=${la.toFixed(2)} > 0.3 x ${CORES} = ${LOAD_LIMIT.toFixed(2)}`;
      if (QUICK) { log(`WARN: ${msg}; continuing because --quick is only a smoke test`); return la; }
      throw new Error(`${msg}; aborting, rerun when the laptop is idle`);
    }
    log(`${label}: loadavg1=${la.toFixed(2)} > ${LOAD_LIMIT.toFixed(2)}; waiting 10 s for the machine to idle`);
    await sleep(10_000);
  }
}

// ---------------------------------------------------------------- jobs

const liveChildren = new Set();

async function runJob(sample, threads, outRoot, poller) {
  const outDir = join(outRoot, sample.id);
  await mkdir(join(outDir, 'v'), { recursive: true });
  for (const a of sample.plan.audio) await mkdir(join(outDir, `a${a.n}`), { recursive: true });
  const args = mainArgs(sample.plan, sample.path, outDir, { threads });
  logCommand('ffmpeg', args);
  const t0 = performance.now();
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  liveChildren.add(child);
  try { setPriority(child.pid, 19); } catch {}
  poller.add(child.pid);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, JOB_TIMEOUT_MS);
  const code = await new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  clearTimeout(timeout);
  poller.remove(child.pid);
  liveChildren.delete(child);
  const wallS = (performance.now() - t0) / 1000;
  if (code !== 0) throw new Error(`ffmpeg ${sample.id} exited ${code}: ${stderr.trim()}`);
  const progress = await readFile(join(outDir, 'progress.txt'), 'utf8').catch(() => '');
  const speeds = [...progress.matchAll(/^speed=([\d.]+)x\s*$/gm)];
  const speed = speeds.length ? Number(speeds.at(-1)[1]) : null;
  log(`  job ${sample.id} (${sample.mode}): ${wallS.toFixed(1)} s${speed === null ? '' : `, speed=${speed.toFixed(2)}x`}`);
  return { id: sample.id, mode: sample.mode, wallS, speed };
}

// Bounded worker pool; on the first error it stops picking tasks and rethrows after the in-flight ones settle.
async function pool(limit, tasks) {
  const results = new Array(tasks.length);
  const errors = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (errors.length === 0) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); } catch (err) { errors.push(err); }
    }
  });
  await Promise.all(workers);
  if (errors.length) throw errors[0];
  return results;
}

// ---------------------------------------------------------------- measurement phases

function makeRow(f) { return f; }

async function measureBaseline(port) {
  await assertIdle('baseline');
  log(`baseline: ${BASELINE_MS / 1000} s of load at ~${LOAD_RATE_PER_S} req/s, no encode jobs`);
  const load = startLoad(port);
  const poller = startPoller();
  loopHist.enable();
  loopHist.reset();
  await sleep(BASELINE_MS);
  loopHist.disable();
  await stopLoad(load);
  const rss = poller.stop();
  const la = loadavg()[0];
  return makeRow({ cell: 'baseline', jobs: 0, threads: 0, rep: 0, effJobs: 0, wallS: BASELINE_MS / 1000, videoS: 0, throughput: 0, speeds: '', jobWalls: '', rss, lat: latencyStats(load), loop: loopStats(), laBefore: la, laAfter: la, io: { readMb: 0, writeMb: 0 }, tempC: readTempC(), governor: readGovernor() });
}

async function measureCell(cell, rep, port, samples) {
  const label = `${cell.jobs}x${cell.threads} rep ${rep}`;
  await sleep(COOLDOWN_MS);
  const laBefore = await assertIdle(label);
  const outRoot = join(RUN_DIR, `out-${cell.jobs}x${cell.threads}-r${rep}`);
  const ioBefore = ioSnapshot();
  const load = startLoad(port);
  const poller = startPoller();
  loopHist.enable();
  loopHist.reset();
  const t0 = performance.now();
  const effJobs = Math.min(cell.jobs, samples.length);
  const jobs = await pool(effJobs, samples.map((s) => () => runJob(s, cell.threads, outRoot, poller)));
  const wallS = (performance.now() - t0) / 1000;
  loopHist.disable();
  await stopLoad(load);
  const rss = poller.stop();
  const io = ioDelta(ioBefore);
  const laAfter = loadavg()[0];
  await rm(outRoot, { recursive: true, force: true });
  const videoS = samples.reduce((a, s) => a + (s.durationS || 0), 0);
  const speeds = jobs.map((j) => (j.speed === null ? 'n/a' : `${j.speed.toFixed(2)}x`)).join(';');
  const jobWalls = jobs.map((j) => j.wallS.toFixed(1)).join(';');
  const lat = latencyStats(load);
  log(`  ${label}: wall ${wallS.toFixed(1)} s | thr ${(videoS / wallS).toFixed(2)}x | speeds ${speeds} | rssMax/job ${fmt(rss.samples.length ? Math.max(...rss.samples) : null)} MB | memAvailMin ${fmt(rss.memAvailMinMb)} MB | lat p95 ${fmt(lat.p95)} ms | temp ${fmt(readTempC(), 1)} C`);
  return makeRow({ cell: `${cell.jobs}x${cell.threads}`, jobs: cell.jobs, threads: cell.threads, rep, effJobs, wallS, videoS, throughput: videoS / wallS, speeds, jobWalls, rss, lat, loop: loopStats(), laBefore, laAfter, io, tempC: readTempC(), governor: readGovernor() });
}

// ---------------------------------------------------------------- output

const CSV_HEADER = 'cell,jobs,threads,rep,eff_jobs,wall_s,video_s,throughput,per_job_speeds,per_job_wall_s,rss_max_mb,rss_p95_mb,rss_total_mb,mem_avail_min_mb,lat_p50_ms,lat_p95_ms,lat_p99_ms,lat_samples,load_skipped,loop_p50_ms,loop_p95_ms,loop_p99_ms,loadavg1_before,loadavg1_after,io_read_mb,io_write_mb,temp_c,governor';

function rssTotal(rss) {
  if (rss.perJob.size === 0) return null;
  let total = 0;
  for (const mb of rss.perJob.values()) total += mb;
  return total;
}

function csvRow(r) {
  return [
    r.cell, r.jobs, r.threads, r.rep, r.effJobs,
    r.wallS.toFixed(2), r.videoS.toFixed(1), r.throughput.toFixed(3),
    `"${r.speeds}"`, `"${r.jobWalls}"`,
    fmt(r.rss.samples.length ? Math.max(...r.rss.samples) : null), fmt(percentile(r.rss.samples, 95)), fmt(rssTotal(r.rss)), fmt(r.rss.memAvailMinMb),
    fmt(r.lat.p50), fmt(r.lat.p95), fmt(r.lat.p99), r.lat.n, r.lat.skipped,
    fmt(r.loop.p50), fmt(r.loop.p95), fmt(r.loop.p99),
    r.laBefore.toFixed(2), r.laAfter.toFixed(2),
    fmt(r.io.readMb), fmt(r.io.writeMb),
    fmt(r.tempC, 1), r.governor ?? '',
  ].join(',');
}

function summarize(rows) {
  const baseline = rows.find((r) => r.cell === 'baseline') ?? null;
  const byCell = new Map();
  for (const r of rows) {
    if (r.cell === 'baseline') continue;
    if (!byCell.has(r.cell)) byCell.set(r.cell, []);
    byCell.get(r.cell).push(r);
  }
  const cells = [...byCell.entries()].map(([cell, rs]) => {
    const memMins = rs.map((r) => r.rss.memAvailMinMb).filter((v) => v !== null);
    const temps = rs.map((r) => r.tempC).filter((v) => v !== null);
    return {
      tempC: temps.length ? Math.max(...temps) : null,
      cell,
      jobs: rs[0].jobs,
      threads: rs[0].threads,
      effJobs: rs[0].effJobs,
      reps: rs.length,
      thr: median(rs.map((r) => r.throughput)),
      latP50: median(rs.map((r) => r.lat.p50).filter((v) => v !== null)),
      latP95: median(rs.map((r) => r.lat.p95).filter((v) => v !== null)),
      latP99: median(rs.map((r) => r.lat.p99).filter((v) => v !== null)),
      loopP95: median(rs.map((r) => r.loop.p95).filter((v) => v !== null)),
      rssTotal: Math.max(...rs.map((r) => rssTotal(r.rss) ?? 0)),
      rssMaxJob: Math.max(...rs.map((r) => (r.rss.samples.length ? Math.max(...r.rss.samples) : 0))),
      memAvailMin: memMins.length ? Math.min(...memMins) : null,
    };
  });
  return { baseline, cells };
}

function evaluate(rows) {
  const { baseline, cells } = summarize(rows);
  const baseP95 = baseline?.lat.p95 ?? null;
  const ref = cells.find((c) => c.jobs === 1 && c.threads === 8)
    ?? cells.filter((c) => c.jobs === 1).sort((a, b) => b.threads - a.threads)[0]
    ?? [...cells].sort((a, b) => b.thr - a.thr)[0]
    ?? null;
  const evaluated = cells.map((c) => {
    const gain = ref && ref.thr > 0 ? (c.thr / ref.thr - 1) * 100 : 0;
    const dP95 = c.latP95 !== null && baseP95 !== null ? c.latP95 - baseP95 : null;
    const ramBudget = c.jobs * RAM_PER_JOB_MB + RAM_RESERVE_MB;
    const ramOk = c.rssTotal !== null && c.rssTotal <= ramBudget;
    const pass = gain >= 10 && dP95 !== null && dP95 <= 50 && ramOk;
    return { ...c, gain, dP95, ramBudget, ramOk, pass };
  });
  return { baseline, ref, cells: evaluated };
}

function printTable(evaluation) {
  const { baseline, ref, cells } = evaluation;
  console.log('');
  console.log(`=== T21d parallel benchmark ${QUICK ? '(--quick smoke test)' : ''} — median of reps ===`);
  if (baseline) {
    console.log(`baseline (idle): lat p50/p95/p99 ${fmt(baseline.lat.p50)}/${fmt(baseline.lat.p95)}/${fmt(baseline.lat.p99)} ms | loop p95 ${fmt(baseline.loop.p95)} ms | memAvailMin ${fmt(baseline.rss.memAvailMinMb)} MB`);
  }
  const table = [['config', 'reps', 'eff', 'thr(x)', 'gain%', 'lat p50', 'lat p95', 'lat p99', 'loop p95', 'rssMax/job', 'rssTotal', 'memAvailMin', 'tempC', 'verdict']];
  for (const c of cells) {
    table.push([
      c.cell, String(c.reps), String(c.effJobs), c.thr.toFixed(2), (c.gain >= 0 ? '+' : '') + c.gain.toFixed(1),
      fmt(c.latP50), fmt(c.latP95), fmt(c.latP99), fmt(c.loopP95), fmt(c.rssMaxJob), fmt(c.rssTotal), fmt(c.memAvailMin),
      fmt(c.tempC, 1), c.cell === ref?.cell ? 'REF' : c.pass ? 'PASS' : '',
    ]);
  }
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const r of table) console.log(r.map((v, i) => v.padEnd(widths[i])).join('  '));
}

function recommend(evaluation) {
  const { baseline, ref, cells } = evaluation;
  const baseP95 = baseline?.lat.p95 ?? null;
  const lines = ['', '== Recommendation =='];
  lines.push(`baseline p95 (idle): ${baseP95 === null ? 'n/a' : `${baseP95.toFixed(1)} ms`} | RAM budget: ${RAM_PER_JOB_MB} MB/job + ${RAM_RESERVE_MB} MB reserve`);
  if (!ref) return lines.concat(['no cells measured']).join('\n');
  lines.push(`criteria: throughput gain >= 10 % vs ${ref.cell}, p95 delta <= 50 ms, RSS total <= jobs x ${RAM_PER_JOB_MB} + ${RAM_RESERVE_MB} MB`);
  for (const c of [...cells].sort((a, b) => b.thr - a.thr)) {
    lines.push(`  ${c.cell}: thr ${c.thr.toFixed(2)}x (${c.gain >= 0 ? '+' : ''}${c.gain.toFixed(1)} %), p95 ${fmt(c.latP95)} ms (${c.dP95 === null ? 'n/a' : `${c.dP95 >= 0 ? '+' : ''}${c.dP95.toFixed(1)} ms`}), rssTotal ${fmt(c.rssTotal)} MB / ${c.ramBudget} MB -> ${c.pass ? 'PASS' : 'no'}`);
  }
  const best = cells.filter((c) => c.pass && c.cell !== ref.cell).sort((a, b) => b.thr - a.thr)[0];
  if (best) {
    lines.push(`=> RECOMMENDATION: enable ${best.jobs} job(s) x ${best.threads} threads (${best.cell}) — beats ${ref.cell} by ${best.gain.toFixed(1)} % with +${best.dP95.toFixed(1)} ms p95 and ${fmt(best.rssTotal)} MB total RSS.`);
  } else {
    lines.push(`=> RECOMMENDATION: keep ${ref.cell} (today's default) — no configuration met all three criteria.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- matrix

function buildMatrix() {
  const cells = [];
  for (const jobs of [1, 2, 3, 4]) for (const threads of [2, 4, 8]) if (jobs * threads <= CORES) cells.push({ jobs, threads });
  return cells.length ? cells : [{ jobs: 1, threads: 1 }];
}
function quickCells(matrix) {
  const wanted = matrix.filter((c) => (c.jobs === 1 && c.threads === 8) || (c.jobs === 2 && c.threads === 4));
  return (wanted.length ? wanted : matrix).slice(0, 2);
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- lifecycle

function killChildren() {
  for (const child of liveChildren) { try { child.kill('SIGTERM'); } catch {} }
}
function cleanupScratch() {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
}
function onSignal(sig) {
  log(`received ${sig}: killing ${liveChildren.size} ffmpeg child(ren) and removing ${RUN_DIR}`);
  killChildren();
  cleanupScratch();
  process.exit(130);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// ---------------------------------------------------------------- main

async function main() {
  log(`T21d parallel benchmark ${QUICK ? '(--quick smoke test)' : '(full matrix)'} — cpus=${CORES} availableParallelism=${availableParallelism()} loadavg1=${loadavg()[0].toFixed(2)} governor=${readGovernor()} temp=${fmt(readTempC(), 1)} C`);
  log(`scratch=${RUN_DIR} (removed on exit) | log=${LOG_FILE} | csv=${CSV_FILE}`);
  log(`encode profile: crf=${encodeProfile().crf} tune=${encodeProfile().tune}`);
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const v = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (v.status !== 0) throw new Error(`${bin} not found in PATH`);
    log(`${bin}: ${v.stdout.split('\n')[0]}`);
  }

  await mkdir(RUN_DIR, { recursive: true });
  const sources = pickSources();
  const clips = buildClips(sources);
  const samples = await buildSamples(clips);
  const { server, port } = await startLatencyServer(buildLatencyFile());

  const matrix = buildMatrix();
  const cells = QUICK ? quickCells(matrix) : matrix;
  log(`matrix: ${matrix.map((c) => `${c.jobs}x${c.threads}`).join(', ')}`);
  log(`running: ${cells.map((c) => `${c.jobs}x${c.threads}`).join(', ')} x ${REPS} rep(s), ${COOLDOWN_MS / 1000} s cooldown between runs`);
  if (cells.some((c) => c.jobs > samples.length)) log(`note: ${samples.length} samples -> cells with jobs > ${samples.length} run at effective concurrency ${samples.length}`);

  const rows = [];
  try {
    rows.push(await measureBaseline(port));
    const tasks = shuffle(cells.flatMap((c) => Array.from({ length: REPS }, (_, i) => ({ cell: c, rep: i + 1 }))));
    for (const t of tasks) rows.push(await measureCell(t.cell, t.rep, port, samples));
  } finally {
    server.close();
  }

  writeFileSync(CSV_FILE, `${CSV_HEADER}\n${rows.map(csvRow).join('\n')}\n`);
  const evaluation = evaluate(rows);
  printTable(evaluation);
  console.log(recommend(evaluation));
  log(`csv written: ${CSV_FILE}`);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  log(`FATAL: ${err.message}`);
  exitCode = 1;
} finally {
  killChildren();
  cleanupScratch();
}
log(`done (exit ${exitCode}) — csv: ${CSV_FILE} | log: ${LOG_FILE}`);
process.exit(exitCode);
