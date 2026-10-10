import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityCount, itemContext, processingControl, type Activity, type ActivityItem } from './activity.ts';
import { api } from './api.ts';

const item = (extra: Partial<ActivityItem> = {}): ActivityItem => ({
  mediaFileId: 1,
  jobId: 1,
  status: 'queued',
  progress: 0,
  error: null,
  kind: 'film',
  title: 'T',
  extraLabel: null,
  season: null,
  episode: null,
  episodeName: null,
  ...extra,
});

describe('activityCount', () => {
  it('adds the running jobs to the whole queue, not just the preview window', () => {
    const activity: Activity = {
      running: [item({ status: 'running' }), item({ status: 'running' })],
      queued: [item(), item()],
      queuedTotal: 12,
      failed: [item({ status: 'error' })],
      paused: false,
    };
    expect(activityCount(activity)).toBe(14);
  });

  it('is zero for no data and for an idle library with only failures', () => {
    expect(activityCount(null)).toBe(0);
    expect(activityCount({ running: [], queued: [], queuedTotal: 0, failed: [item({ status: 'error' })], paused: false })).toBe(0);
  });
});

describe('itemContext', () => {
  it('episode shows the season/episode code and the episode name', () => {
    expect(itemContext(item({ kind: 'episode', season: 1, episode: 3, episodeName: 'El inicio' }))).toBe('T1E3 · El inicio');
  });

  it('episode falls back to the code alone, then to a generic label', () => {
    expect(itemContext(item({ kind: 'episode', season: 5, episode: 2, episodeName: null }))).toBe('T5E2');
    expect(itemContext(item({ kind: 'episode' }))).toBe('Episodio');
  });

  it('extra shows its label', () => {
    expect(itemContext(item({ kind: 'extra', extraLabel: 'OP1' }))).toBe('Extra · OP1');
    expect(itemContext(item({ kind: 'extra', extraLabel: null }))).toBe('Extra');
  });

  it('film has no context line', () => {
    expect(itemContext(item({ kind: 'film' }))).toBeNull();
  });
});

describe('processingControl', () => {
  it('normal state offers pause', () => {
    expect(processingControl(false, false)).toEqual({ kind: 'pause', label: 'Pausar procesado' });
  });

  it('paused state shows the chip and offers resume', () => {
    expect(processingControl(true, false)).toEqual({ kind: 'resume', label: 'Reanudar procesado', chip: 'En pausa' });
  });

  it('processing-disabled server replaces the control with a note', () => {
    expect(processingControl(false, true)).toEqual({ kind: 'disabled', note: 'Procesado desactivado en este servidor' });
    expect(processingControl(true, true).kind).toBe('disabled');
  });
});

describe('processing 409', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the processing_disabled body to its own error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'processing_disabled' }), { status: 409 })));
    await expect(api.pauseProcessing()).rejects.toThrow('processing_disabled');
  });
});
