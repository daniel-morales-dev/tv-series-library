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
// Spanish ordinal words for a season name ("Cuarta Temporada"): primera=1 .. décima=10, accent-insensitive.
const ORDINAL_WORD = new Map([
  ['primera', 1],
  ['segunda', 2],
  ['tercera', 3],
  ['cuarta', 4],
  ['quinta', 5],
  ['sexta', 6],
  ['septima', 7],
  ['octava', 8],
  ['novena', 9],
  ['decima', 10],
]);
const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Folds a full name for identity comparison: accents, punctuation and case removed. Shared by the
// folder/group matcher and the season-name collision check.
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// Season number spelled in a folder or as a show-name suffix: "Season 3", "Temporada 4",
// "Cuarta Temporada", "4ª Temporada", "S5".
const SEASON_PHRASE = /^(?:season|temporada|s)[\s._-]*(\d+)$|^(\d{1,2})\s*[ªa]?[\s._-]+temporada$|^([a-záéíóú]+)[\s._-]+temporada$/i;
function seasonNumber(text: string): number | null {
  const m = SEASON_PHRASE.exec(text);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  if (m[2]) return Number(m[2]);
  const word = m[3] ? ORDINAL_WORD.get(fold(m[3])) : undefined;
  return word ?? null;
}
// Episode-number token, e.g. "01", "E12", "09v2"; also the value after a season pair ("Show S5 - 01").
const EPISODE_NUMBER = /^(?:E|EP|EPISODE)?\d{1,4}(?:v\d)?$/i;
// Glued single-token pairs. Marker form "S5E1"/"S05-E01v2"/"T5-EP01": the marker makes the
// "-" optional. Dash form "S5-01"/"S05-01v2"/"T5-01": "-" required, so "S501" stays unmatched.
const GLUED_MARKER = /^[ST](\d{1,2})-?(?:EPISODE|EP|E)(\d{1,4})(?:v\d)?$/i;
const GLUED_DASH = /^[ST](\d{1,2})-(\d{1,4})(?:v\d)?$/i;
const GLUED_CROSS = /^(\d{1,2})x(\d{1,3})$/i;
// Adjacent-token season: "S5"/"T5" or an uppercase roman numeral ("V", "XII"), value 1-20.
const SEASON_TOKEN = /^[ST](\d{1,2})$/i;
const ROMAN_TOKEN = /^[IVXLCDM]{1,5}$/;
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
// Standard roman value, or null when the token is not a valid season candidate (1-20).
function romanSeason(token: string): number | null {
  if (!ROMAN_TOKEN.test(token)) return null;
  let value = 0;
  for (let i = 0; i < token.length; i++) {
    const current = ROMAN_VALUES[token[i]!]!;
    value += current < (ROMAN_VALUES[token[i + 1] ?? ''] ?? 0) ? -current : current;
  }
  return value >= 1 && value <= 20 ? value : null;
}

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

// Trailing season marker on a show name: "Show S2", "Show Season 3", "Show 2nd Season",
// "Show Cuarta Temporada", "Show Temporada 4", "Show 4ª Temporada".
const SEASON_MARKER = /\s+(?:S(\d{1,2})|Season\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+Season|Temporada\s+(\d{1,2})|(\d{1,2})\s*[ªa]?\s+Temporada|([a-záéíóú]+)\s+Temporada)$/i;
export function splitSeasonMarker(name: string): { show: string; season: number | null } {
  const m = SEASON_MARKER.exec(name);
  if (!m) return { show: name, season: null };
  const ordinal = m[6] !== undefined ? ORDINAL_WORD.get(fold(m[6])) : undefined;
  // A word before "Temporada" that is not an ordinal is part of the show name, not a marker.
  if (m[6] !== undefined && ordinal === undefined) return { show: name, season: null };
  return { show: name.slice(0, m.index), season: ordinal ?? Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) };
}

// T72: season/episode pair inside a container title tag ("S05E06-Orario: Distorted City"), using the
// same token vocabulary as the file-name parser: glued "S05E06"/"5x01", adjacent "S3 - 12".
export function parseTitleTag(title: string): { season: number; number: number } | null {
  const tokens = cleanName(title).split(/[\s-]+/).filter(Boolean);
  for (const t of tokens) {
    const m = GLUED_MARKER.exec(t) ?? GLUED_CROSS.exec(t);
    if (m) return { season: Number(m[1]), number: Number(m[2]) };
  }
  for (const [i, t] of tokens.entries()) {
    const next = tokens[i + 1];
    if (!next || !EPISODE_NUMBER.test(next)) continue;
    const m = SEASON_TOKEN.exec(t);
    const season = m ? Number(m[1]) : romanSeason(t);
    if (season !== null) return { season, number: Number(/\d+/.exec(next)![0]) };
  }
  return null;
}

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
  const dirSeason = parts.slice(2, -1).map(seasonNumber).find((n) => n !== null) ?? null;

  for (const [i, t] of tokens.entries()) {
    const m = GLUED_MARKER.exec(t) ?? GLUED_DASH.exec(t) ?? GLUED_CROSS.exec(t);
    if (m) return withShow(show(i), { season: Number(m[1]), number: Number(m[2]) });
  }
  const extra = tokens.findIndex((t) => EXTRA.test(t));
  if (extra >= 0) {
    const name = splitSeasonMarker(show(extra)).show;
    // "NCED 01" / "NCED Special": keep the qualifier that tells creditless variants apart.
    const next = tokens[extra + 1];
    const qualified = /^NC(?:OP|ED)$/i.test(tokens[extra]!) && next && /^(?:\d{1,2}[a-z]?|special)$/i.test(next);
    const label = qualified ? `${tokens[extra]} ${next}` : tokens[extra]!;
    return name ? { kind: 'extra', show: name, label } : UNPARSED;
  }
  // "Show S5 - 01": cleanName drops the "-" later, so the season token and the episode
  // number sit adjacent. Roman seasons ("V - 02v2", "XII EP12") take the same path.
  for (const [i, t] of tokens.entries()) {
    const next = tokens[i + 1];
    if (!next || !EPISODE_NUMBER.test(next)) continue;
    const m = SEASON_TOKEN.exec(t);
    const season = m ? Number(m[1]) : romanSeason(t);
    if (season !== null) {
      return withShow(show(i), { season, number: Number(/\d+/.exec(next)![0]) });
    }
  }
  const abs = tokens.findLastIndex((t) => EPISODE_NUMBER.test(t));
  if (abs < 0) return UNPARSED;
  // The file name may carry the season marker ("ReZero Cuarta Temporada - 17") even when the folder
  // does not; the folder still names the show. File marker beats the folder one, the folder still wins
  // as the show name.
  const named = splitSeasonMarker(tokens.slice(0, abs).join(' '));
  return withShow(folder ?? named.show, { season: dirSeason ?? named.season, number: Number(/\d+/.exec(tokens[abs]!)![0]) });
}

// The file's own season wins; the show's trailing marker only fills a missing one.
function withShow(name: string, ep: { season: number | null; number: number }): Parsed {
  const { show, season } = splitSeasonMarker(name);
  return show ? { kind: 'episode', show, ...ep, season: ep.season ?? season } : UNPARSED;
}

// `relPath` is relative to the content dir, with `/` separators.
export function parsePath(relPath: string): Parsed {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length < 2) return UNPARSED;
  if (parts[0] === 'films') return parseMovie(parts);
  if (parts[0] === 'shows') return parseShow(parts);
  return UNPARSED;
}
