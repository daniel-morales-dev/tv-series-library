// Stand-in for the main ffmpeg run: appends `-progress` blocks until the gate file exists, then writes a
// minimal HLS package and a final `progress=end`. Never the real ffmpeg.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const progress = args[args.indexOf('-progress') + 1];
const out = dirname(dirname(args.at(-1)));
const gate = process.env.FAKE_FFMPEG_GATE;
let t = 0;

// FAKE_FFMPEG_BAD="<corrupt|short>:<n>": the first n runs that finish end badly (video playlist without segments,
// or `progress=end` far short of the real duration). Runs are counted in `<gate>.runs`.
const [badKind, badRuns] = (process.env.FAKE_FFMPEG_BAD ?? ':0').split(':');
function isBad() {
  const counter = `${gate}.runs`;
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeFileSync(counter, String(n));
  return n <= Number(badRuns);
}

const timer = setInterval(() => {
  appendFileSync(progress, `out_time_us=${(t += 1_000_000)}\nprogress=continue\n`);
  if (!existsSync(gate)) return;
  clearInterval(timer);
  const audio = readdirSync(out).filter((d) => /^a\d+$/.test(d));
  writeFileSync(
    join(out, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n' +
      audio.map((a, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_${i + 1}",URI="${a}/index.m3u8"\n`).join('') +
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="group_aud"\nv/index.m3u8\n\n',
  );
  const bad = isBad();
  for (const d of ['v', ...audio]) {
    const empty = bad && badKind === 'corrupt' && d === 'v';
    writeFileSync(join(out, d, 'index.m3u8'), empty ? '#EXTM3U\n' : '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
  }
  appendFileSync(progress, `out_time_us=${bad && badKind === 'short' ? 40_000_000 : 100_000_000}\nprogress=end\n`);
  process.exit(0);
}, 40);
