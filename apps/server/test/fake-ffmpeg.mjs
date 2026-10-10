// Stand-in for the main ffmpeg run: appends `-progress` blocks until the gate file exists, then writes a
// minimal HLS package and a final `progress=end`. Never the real ffmpeg.
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const progress = args[args.indexOf('-progress') + 1];
const out = dirname(dirname(args.at(-1)));
const gate = process.env.FAKE_FFMPEG_GATE;
let t = 0;

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
  for (const d of ['v', ...audio]) writeFileSync(join(out, d, 'index.m3u8'), '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
  appendFileSync(progress, 'out_time_us=100000000\nprogress=end\n');
  process.exit(0);
}, 40);
