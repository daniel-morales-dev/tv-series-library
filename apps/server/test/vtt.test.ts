import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeVtt, sanitizeVttFile } from '../src/modules/processing/vtt.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const cue = (text: string, ts = '00:00:01.000 --> 00:00:02.000') => `WEBVTT\n\n${ts}\n${text}\n`;

describe('sanitizeVtt', () => {
  it('removes every `{...}` sequence and keeps the rest of the line exact', () => {
    expect(sanitizeVtt(cue('{=22}Escena Oscura'))).toBe(cue('Escena Oscura'));
    expect(sanitizeVtt(cue('<b>{=22}Escena Oscura</b>'))).toBe(cue('<b>Escena Oscura</b>'));
    expect(sanitizeVtt(cue('<b>{=1}</b>Episode 11: Winter in the Northern Lands'))).toBe(cue('<b></b>Episode 11: Winter in the Northern Lands'));
    expect(sanitizeVtt(cue('Bear with it.{kuma}'))).toBe(cue('Bear with it.'));
  });

  it('drops cues that render nothing: markers or empty tags only', () => {
    expect(sanitizeVtt(cue('<b>{=1}</b>'))).toBe('WEBVTT\n');
    expect(sanitizeVtt(cue('{OP}'))).toBe('WEBVTT\n');
    expect(sanitizeVtt(cue('<b>{OP}</b>'))).toBe('WEBVTT\n');
    expect(sanitizeVtt(cue('<b></b>'))).toBe('WEBVTT\n');
  });

  it('drops lines that are only ASS drawing geometry, with or without markup', () => {
    expect(sanitizeVtt(cue('m 0 0 l 1920 0 l 1920 1080 l 0 1080'))).toBe('WEBVTT\n');
    expect(sanitizeVtt(cue('<b>m 0 0 l 1920 0 l 1920 1080 l 0 1080</b>'))).toBe('WEBVTT\n');
    expect(sanitizeVtt(cue('<b>{ \\an5\\pos(1419.99,56.25)\\p1}m 75 0 b 33 0 0 33 0 75 b 0 117 33 150 75 150</b>'))).toBe('WEBVTT\n');
  });

  it('keeps normal text, legit markup, and text that only looks numeric', () => {
    expect(sanitizeVtt(cue('<i>hola</i>'))).toBe(cue('<i>hola</i>'));
    expect(sanitizeVtt(cue('I am 5 minutes late'))).toBe(cue('I am 5 minutes late'));
    expect(sanitizeVtt(cue('B 12'))).toBe(cue('B 12'));
    expect(sanitizeVtt(cue('m 0 0 l 1920 0 esta línea es texto'))).toBe(cue('m 0 0 l 1920 0 esta línea es texto'));
  });

  it('keeps only the clean lines of a mixed cue and preserves identifiers and timestamps', () => {
    const input = 'WEBVTT\n\n7\n00:00:01.000 --> 00:00:02.000\nm 0 0 l 100 0\n<i>hola</i>\n\n8\n00:00:03.000 --> 00:00:04.000\n{=5}\n';
    expect(sanitizeVtt(input)).toBe('WEBVTT\n\n7\n00:00:01.000 --> 00:00:02.000\n<i>hola</i>\n');
  });

  it('normalizes blank lines left behind by dropped cues', () => {
    const input = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n{OP}\n\n\n2\n00:00:03.000 --> 00:00:04.000\nhola\n';
    expect(sanitizeVtt(input)).toBe('WEBVTT\n\n2\n00:00:03.000 --> 00:00:04.000\nhola\n');
  });

  it('is idempotent and leaves clean files byte-identical', () => {
    const clean = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>hola</i>\n';
    expect(sanitizeVtt(clean)).toBe(clean);
    const dirty = sanitizeVtt(cue('<b>{=1}</b>Episode 11'));
    expect(sanitizeVtt(dirty)).toBe(dirty);
  });
});

describe('sanitizeVttFile', () => {
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvlib-vtt-'));
    dirs.push(dir);
    return dir;
  };

  it('rewrites a dirty file in place and reports it', async () => {
    const path = join(tmp(), '0.vtt');
    writeFileSync(path, cue('{=22}Escena Oscura'));
    expect(await sanitizeVttFile(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(cue('Escena Oscura'));
  });

  it('leaves a clean file untouched and skips a missing one', async () => {
    const path = join(tmp(), '0.vtt');
    const clean = cue('<i>hola</i>');
    writeFileSync(path, clean);
    expect(await sanitizeVttFile(path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(clean);
    expect(await sanitizeVttFile(join(tmp(), 'missing.vtt'))).toBe(false);
  });
});
