import { describe, expect, it } from 'vitest';
import { fileStatus, needsPolling } from './fileStatus.ts';
import type { Job, MediaFile } from './types.ts';

const file = (status: MediaFile['status']): MediaFile => ({ id: 1, status, episodeId: 1, extraLabel: null, durationS: null });
const job = (status: Job['status'], progress = 0, error: string | null = null): Job => ({ id: 1, mediaFileId: 1, status, progress, error });

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
