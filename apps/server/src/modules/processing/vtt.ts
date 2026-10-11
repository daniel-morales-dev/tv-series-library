import { readFile, rename, writeFile } from 'node:fs/promises';

// ffmpeg's ASS→WebVTT conversion drops `{\...}` override blocks but keeps their payload visible as text
// (`{=1}` karaoke counters, `{OP}` signs, translator notes) along with the geometry of `\p1` drawings,
// so every generated vtt is cleaned once after extraction.
const OVERRIDE = /\{[^}]*\}/g;
const TAG = /<[^>]*>/g;
const DRAW_COMMANDS = new Set(['m', 'l', 'b', 'c', 's', 'q']);
const NUMBER = /^-?\d+(?:\.\d+)?$/;

// Conservative: the whole line must be drawing commands with their coordinate pairs (at least one pair);
// any other token keeps the line, so real text that merely contains numbers is never dropped.
function isDrawingOnly(text: string): boolean {
  const tokens = text.split(/\s+/);
  if (!DRAW_COMMANDS.has(tokens[0])) return false;
  let numbers = 0;
  for (const token of tokens) {
    if (DRAW_COMMANDS.has(token)) continue;
    if (!NUMBER.test(token)) return false;
    numbers++;
  }
  return numbers >= 2;
}

const visibleText = (line: string) => line.replace(TAG, '').trim();

// Cue text lines minus everything that renders as nothing; null = no line survived, so the cue goes away too.
function cleanCue(lines: string[]): string[] | null {
  const ts = lines.findIndex((line) => line.includes('-->'));
  if (ts === -1) return lines; // header or unknown block: untouched
  const kept = lines.slice(0, ts + 1);
  for (const line of lines.slice(ts + 1)) {
    const clean = line.replace(OVERRIDE, '');
    const text = visibleText(clean);
    if (text === '' || isDrawingOnly(text)) continue;
    kept.push(clean);
  }
  return kept.length > ts + 1 ? kept : null;
}

/** Strips ASS leftovers from a webvtt file; header, identifiers, timestamps and every other line stay exact. */
export function sanitizeVtt(content: string): string {
  const trailing = content.endsWith('\n') ? '\n' : '';
  const blocks = content
    .replaceAll('\r\n', '\n')
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block.trim() !== '');
  const kept = blocks.map((block) => cleanCue(block.split('\n'))).filter((block): block is string[] => block !== null);
  return kept.map((block) => block.join('\n')).join('\n\n') + trailing;
}

/** Rewrites one vtt in place (tmp + rename, like the rest of the pipeline) only when sanitizing changes it. */
export async function sanitizeVttFile(path: string): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return false; // missing or unreadable: nothing to fix
  const clean = sanitizeVtt(content);
  if (clean === content) return false;
  await writeFile(`${path}.new`, clean);
  await rename(`${path}.new`, path);
  return true;
}
