import { describe, expect, it } from 'vitest';
import { type Hardware, budgetConfigFromEnv, computeBudget } from '../src/modules/processing/budget.ts';

const hw = (cores: number, memAvailableMb: number, rotational: (boolean | null)[] = [false, false]): Hardware => ({ cores, memAvailableMb, rotational });

describe('computeBudget', () => {
  // The table of the design: jobs x threadsPerJob follow cpuBudget = floor(cores * 0.5), MIN_THREADS 4, MAX_JOBS 4.
  const cases: [string, Hardware, { jobs: number; threadsPerJob: number; limitedBy: string }][] = [
    ['Pi 4 (4 cores, unknown storage)', hw(4, 8000, [null, null]), { jobs: 1, threadsPerJob: 2, limitedBy: 'cpu' }],
    ['Pi 4 with little RAM is RAM-limited', hw(4, 900, [false, false]), { jobs: 1, threadsPerJob: 2, limitedBy: 'ram' }],
    ['owner laptop (16 threads, plenty of RAM)', hw(16, 8000), { jobs: 2, threadsPerJob: 4, limitedBy: 'cpu' }],
    ['owner laptop with 4 GB available', hw(16, 4000), { jobs: 2, threadsPerJob: 4, limitedBy: 'cpu' }],
    ['laptop where RAM only allows one job', hw(16, 2800), { jobs: 1, threadsPerJob: 8, limitedBy: 'ram' }],
    ['laptop with HDD content', hw(16, 8000, [true, false]), { jobs: 1, threadsPerJob: 8, limitedBy: 'io' }],
    ['32 threads', hw(32, 16000), { jobs: 4, threadsPerJob: 4, limitedBy: 'cpu' }],
    ['many cores are capped by MAX_JOBS', hw(128, 64000), { jobs: 4, threadsPerJob: 16, limitedBy: 'cpu' }],
    ['almost no RAM never goes below one job', hw(16, 100), { jobs: 1, threadsPerJob: 8, limitedBy: 'ram' }],
    ['single core', hw(1, 4000), { jobs: 1, threadsPerJob: 1, limitedBy: 'cpu' }],
  ];
  it.each(cases)('%s', (_name, h, expected) => {
    expect(computeBudget(h, budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' }))).toMatchObject(expected);
  });

  it('never exceeds the CPU share, whatever the number of jobs', () => {
    for (const cores of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64]) {
      const b = computeBudget(hw(cores, 64000), budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' }));
      expect(b.jobs).toBeGreaterThanOrEqual(1);
      expect(b.threadsPerJob).toBeGreaterThanOrEqual(1);
      if (cores >= 2) expect(b.jobs * b.threadsPerJob).toBeLessThanOrEqual(Math.floor(cores / 2));
    }
  });

  it('only a known rotational volume limits to one job; an unknown type does not (Windows reports null)', () => {
    const unknown = hw(16, 8000, [false, null]);
    expect(computeBudget(unknown, budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' })).jobs).toBe(2);
    expect(computeBudget(hw(16, 8000, [true, null]), budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' })).jobs).toBe(1);
    expect(computeBudget(unknown, budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4', PROCESS_IO: 'ssd' })).jobs).toBe(2);
    expect(computeBudget(hw(16, 8000), budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4', PROCESS_IO: 'hdd' })).jobs).toBe(1);
  });

  it('reports how many jobs the RAM alone could host, for the play slot', () => {
    expect(computeBudget(hw(16, 8000), budgetConfigFromEnv({})).ramJobs).toBe(5);
    expect(computeBudget(hw(16, 100), budgetConfigFromEnv({})).ramJobs).toBe(0);
  });

  it('defaults to 2 jobs (T21d benchmark: 2x8 beat 1x8 by 30%), so the laptop runs 2x4 without any env', () => {
    expect(computeBudget(hw(16, 8000), budgetConfigFromEnv({}))).toMatchObject({ jobs: 2, threadsPerJob: 4 });
  });

  describe('explicit overrides win', () => {
    it('PROCESS_CONCURRENCY fixes the jobs and FFMPEG_THREADS fixes the threads', () => {
      const b = computeBudget(hw(4, 100, [true]), budgetConfigFromEnv({ PROCESS_CONCURRENCY: '3', FFMPEG_THREADS: '6' }));
      expect(b).toMatchObject({ jobs: 3, threadsPerJob: 6, limitedBy: 'env' });
    });
    it('a fixed job count derives the threads from the CPU share', () => {
      expect(computeBudget(hw(16, 8000), budgetConfigFromEnv({ PROCESS_CONCURRENCY: '2' }))).toMatchObject({ jobs: 2, threadsPerJob: 4, limitedBy: 'env' });
    });
    it('fixed threads leave the job count automatic', () => {
      expect(computeBudget(hw(32, 16000), budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4', FFMPEG_THREADS: '8' }))).toMatchObject({ jobs: 4, threadsPerJob: 8 });
    });
    it('"auto", empty and nonsense values mean automatic', () => {
      for (const v of ['auto', '', 'abc', '0', '-2']) {
        expect(computeBudget(hw(16, 8000), budgetConfigFromEnv({ PROCESS_CONCURRENCY: v, FFMPEG_THREADS: v })).limitedBy).not.toBe('env');
      }
    });
  });

  it('explains the decision', () => {
    const four = budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' });
    expect(computeBudget(hw(16, 8000, [true]), four).reason).toMatch(/almacenamiento/i);
    expect(computeBudget(hw(16, 100), four).reason).toMatch(/memoria/i);
  });
});
