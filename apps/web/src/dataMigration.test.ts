import { describe, expect, it } from 'vitest';
import { formatGb, migrationView, type DataPlan, type DataStatus } from './dataMigration.ts';

const GB = 1024 ** 3;
const plan = (over: Partial<DataPlan> = {}): DataPlan => ({
  from: '/home/u/.local/share/sala/hls',
  to: '/media/hdd/series/.sala/hls',
  method: 'copy',
  pendingCount: 40,
  movedCount: 0,
  pendingBytes: 17.5 * GB,
  totalBytes: 17.5 * GB,
  freeBytes: 200 * GB,
  requiredBytes: 27.5 * GB,
  fits: true,
  ...over,
});
const status = (over: Partial<DataStatus> = {}): DataStatus => ({
  job: { state: 'idle', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, error: null },
  pointerSwitched: false,
  restartRequired: false,
  canFreeOrigin: false,
  alreadyThere: false,
  ...over,
});

describe('formatGb', () => {
  it('uses a decimal comma and one decimal', () => {
    expect(formatGb(17.5 * GB)).toBe('17,5 GB');
    expect(formatGb(0)).toBe('0,0 GB');
  });
});

describe('migrationView', () => {
  it('offers the move with the sizes and space of the plan', () => {
    const v = migrationView(plan(), status());
    expect(v.stage).toBe('ready');
    expect(v.canStart).toBe(true);
    expect(v.lines.join('\n')).toContain('40 paquetes (17,5 GB)');
    expect(v.lines.join('\n')).toContain('200,0 GB libres');
  });

  it('explains that links cost no extra space on the same partition', () => {
    expect(migrationView(plan({ method: 'link', requiredBytes: 0 }), status()).lines.join('\n')).toContain('no ocupa espacio extra');
  });

  it('blocks the start when the destination does not fit', () => {
    const v = migrationView(plan({ fits: false, freeBytes: 5 * GB }), status());
    expect(v.stage).toBe('nospace');
    expect(v.canStart).toBe(false);
  });

  it('shows progress while running and nothing to click', () => {
    const v = migrationView(null, status({ job: { state: 'running', done: 10, total: 40, bytesDone: 4 * GB, bytesTotal: 16 * GB, current: '12', error: null } }));
    expect(v).toMatchObject({ stage: 'running', canStart: false, canFree: false, progress: 25 });
  });

  it('lets a failed run resume and shows the error', () => {
    const v = migrationView(plan({ movedCount: 3, pendingCount: 37 }), status({ job: { state: 'failed', done: 3, total: 40, bytesDone: 0, bytesTotal: 0, current: null, error: 'Poco espacio' } }));
    expect(v).toMatchObject({ stage: 'failed', canStart: true });
    expect(v.lines.join('\n')).toContain('Poco espacio');
  });

  it('asks for a restart before offering to free the origin', () => {
    const v = migrationView(null, status({ pointerSwitched: true, restartRequired: true }));
    expect(v).toMatchObject({ stage: 'restart', canFree: false });
    expect(v.lines.join('\n')).toContain('sala restart');
  });

  it('offers to free the origin only after the restart', () => {
    expect(migrationView(null, status({ pointerSwitched: true, canFreeOrigin: true }))).toMatchObject({ stage: 'free', canFree: true, canStart: false });
  });

  it('reports a library that already holds its data', () => {
    expect(migrationView(null, status({ alreadyThere: true }))).toMatchObject({ stage: 'done', canStart: false, canFree: false });
  });

  it('has nothing to do without pending packages', () => {
    expect(migrationView(plan({ pendingCount: 0, movedCount: 5 }), status()).canStart).toBe(false);
  });
});
