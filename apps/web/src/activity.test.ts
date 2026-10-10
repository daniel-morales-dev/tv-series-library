import { describe, expect, it } from 'vitest';
import { activityCount, itemContext, type Activity, type ActivityItem } from './activity.ts';

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
    };
    expect(activityCount(activity)).toBe(14);
  });

  it('is zero for no data and for an idle library with only failures', () => {
    expect(activityCount(null)).toBe(0);
    expect(activityCount({ running: [], queued: [], queuedTotal: 0, failed: [item({ status: 'error' })] })).toBe(0);
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
