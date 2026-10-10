import { describe, expect, it } from 'vitest';
import { fileStatus, movieStatus, needsPolling } from './fileStatus.ts';
import type { Job, MediaFile } from './types.ts';

const file = (status: MediaFile['status']): MediaFile => ({ id: 1, status, episodeId: 1, extraLabel: null, durationS: null, audioTracks: [], subtitleTracks: [] });
const job = (status: Job['status'], progress = 0, error: string | null = null): Job => ({ id: 1, mediaFileId: 1, status, progress, error });

const movieFile = (id: number, status: MediaFile['status'], extra: Partial<MediaFile> = {}): MediaFile =>
  ({ id, status, episodeId: null, extraLabel: null, durationS: null, audioTracks: [], subtitleTracks: [], ...extra });
const movieJob = (mediaFileId: number, status: Job['status'], progress = 0, error: string | null = null): Job =>
  ({ id: 1, mediaFileId, status, progress, error });

describe('fileStatus', () => {
  it('ready file is ready regardless of jobs', () => {
    expect(fileStatus(file('ready'), [job('done', 1)])).toEqual({ kind: 'ready', label: 'listo' });
  });
  it('running job shows rounded percent', () => {
    expect(fileStatus(file('processing'), [job('running', 0.426)])).toEqual({ kind: 'processing', label: 'procesando 43 %' });
  });
  it('queued job or pending file with no job is queued', () => {
    expect(fileStatus(file('pending'), [job('queued')]).label).toBe('en cola');
    expect(fileStatus(file('pending'), []).label).toBe('en cola');
  });
  it('error carries the message', () => {
    expect(fileStatus(file('error'), [job('error', 0, 'boom')])).toEqual({ kind: 'error', label: 'error', detail: 'boom' });
  });
  it('file without job but processing has no percent', () => {
    expect(fileStatus(file('processing'), []).label).toBe('procesando');
  });
});

describe('needsPolling', () => {
  it('is true while any file is not ready', () => {
    expect(needsPolling([file('ready'), file('pending')])).toBe(true);
    expect(needsPolling([file('ready'), file('error')])).toBe(true);
    expect(needsPolling([file('ready')])).toBe(false);
    expect(needsPolling([])).toBe(false);
  });
});

describe('movieStatus', () => {
  it('is "sin archivo" when the film has no main file', () => {
    expect(movieStatus([], [])).toEqual({ kind: 'queued', label: 'sin archivo' });
  });
  it('ignores episode files and extras when picking the main file', () => {
    expect(movieStatus([file('ready'), movieFile(2, 'ready', { extraLabel: 'Trailer' })], []).label).toBe('sin archivo');
  });
  it('reports the running job percent', () => {
    expect(movieStatus([movieFile(7, 'processing')], [movieJob(7, 'running', 0.426)])).toEqual({ kind: 'processing', label: 'procesando 43 %' });
  });
  it('is "en cola" while queued and "descargando" while downloading', () => {
    expect(movieStatus([movieFile(7, 'pending')], [movieJob(7, 'queued')]).label).toBe('en cola');
    expect(movieStatus([movieFile(7, 'downloading')], []).label).toBe('descargando');
  });
  it('is "listo" when the file is ready', () => {
    expect(movieStatus([movieFile(7, 'ready')], [])).toEqual({ kind: 'ready', label: 'listo' });
  });
  it('carries the error detail', () => {
    expect(movieStatus([movieFile(7, 'error')], [movieJob(7, 'error', 0, 'boom')])).toEqual({ kind: 'error', label: 'error', detail: 'boom' });
  });
  it('prefers the newest live file when a stale one lingers', () => {
    expect(movieStatus([movieFile(4, 'ready'), movieFile(9, 'pending')], []).label).toBe('en cola');
  });
});
