import { basename, extname } from 'node:path';

export type Parsed =
  | { kind: 'movie'; title: string; year: number | null }
  // season is null for absolute numbering (the assigner maps it to a season).
  | { kind: 'episode'; show: string; season: number | null; number: number }
  | { kind: 'extra'; show: string; label: string }
  | { kind: 'unparsed' };

const UNPARSED: Parsed = { kind: 'unparsed' };
const NOISE = /^(?:\d{3,4}p|x26[45]|h26[45]|hevc|bluray|brrip|bdrip|web-?dl|webrip|hdtv|dvdrip|remux)$/i;
const EXTRA = /^(?:(?:OP|ED|PV|SP)\d+[a-z]?|NCOP\d*[a-z]?|NCED\d*[a-z]?|SP|PREVIEW|MENU|COMMENTARY)$/i;
const SEASON_DIR = /^(?:season|temporada|s)[\s._-]*(\d+)$/i;

// Drops [group]/(info) blocks and turns separators into spaces.
export function cleanName(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[[\]()_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s-]+$/, '');
}

const stem = (file: string) => basename(file, extname(file));

function parseMovie(parts: string[]): Parsed {
  const raw = parts.length >= 3 ? parts[1]! : stem(parts[parts.length - 1]!);
  const years = [...raw.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].filter((m) => m.index > 0);
  const last = years.at(-1);
  let title: string;
  if (last) {
    title = cleanName(raw.slice(0, last.index));
  } else {
    const tokens = cleanName(raw).split(' ');
    const noise = tokens.findIndex((t) => NOISE.test(t));
    title = (noise > 0 ? tokens.slice(0, noise) : tokens).join(' ');
  }
  return title ? { kind: 'movie', title, year: last ? Number(last[1]) : null } : UNPARSED;
}

function parseShow(parts: string[]): Parsed {
  const tokens = cleanName(stem(parts[parts.length - 1]!))
    .split(' ')
    .filter((t) => t !== '-');
  const folder = parts.length >= 3 ? cleanName(parts[1]!) : null;
  const show = (marker: number) => folder ?? tokens.slice(0, marker).join(' ');
  const seasonDir = parts
    .slice(2, -1)
    .map((p) => SEASON_DIR.exec(p))
    .find(Boolean);

  for (const [i, t] of tokens.entries()) {
    const m = /^S(\d{1,2})E(\d{1,4})$/i.exec(t) ?? /^(\d{1,2})x(\d{1,3})$/i.exec(t);
    if (m) return withShow(show(i), { season: Number(m[1]), number: Number(m[2]) });
  }
  const extra = tokens.findIndex((t) => EXTRA.test(t));
  if (extra >= 0) {
    const name = show(extra);
    return name ? { kind: 'extra', show: name, label: tokens[extra]! } : UNPARSED;
  }
  const season = seasonDir ? Number(seasonDir[1]) : null;
  const abs = tokens.findLastIndex((t) => /^(?:E|EP|EPISODE)?\d{1,4}(?:v\d)?$/i.test(t));
  if (abs < 0) return UNPARSED;
  return withShow(show(abs), { season, number: Number(/\d+/.exec(tokens[abs]!)![0]) });
}

function withShow(show: string, ep: { season: number | null; number: number }): Parsed {
  return show ? { kind: 'episode', show, ...ep } : UNPARSED;
}

// `relPath` is relative to the content dir, with `/` separators.
export function parsePath(relPath: string): Parsed {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length < 2) return UNPARSED;
  if (parts[0] === 'films') return parseMovie(parts);
  if (parts[0] === 'shows') return parseShow(parts);
  return UNPARSED;
}
