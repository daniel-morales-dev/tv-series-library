import { describe, expect, it } from 'vitest';
import { type TmdbClient, memoize, unavailableTmdb } from './tmdb.ts';

const MIN = 60_000;

function counting(overrides: Partial<TmdbClient> = {}) {
  const calls: string[] = [];
  const client: TmdbClient = {
    ...unavailableTmdb(),
    searchTv: async (q) => (calls.push(`search:${q}`), []),
    tv: async (id) => (calls.push(`tv:${id}`), { id } as never),
    ...overrides,
  };
  return { client, calls };
}

describe('memoize', () => {
  it('reuses successful lookups across wrappers of the same client', async () => {
    const { client, calls } = counting();
    await memoize(client).tv(1);
    await memoize(client).tv(1);
    expect(calls).toEqual(['tv:1']);
  });

  it('retries an empty search only after a growing wait', async () => {
    const { client, calls } = counting();
    let t = 0;
    const m = () => memoize(client, () => t);
    await m().searchTv('x');
    t = 14 * MIN;
    await m().searchTv('x');
    expect(calls).toHaveLength(1);
    t = 16 * MIN;
    await m().searchTv('x');
    expect(calls).toHaveLength(2);
    t = 45 * MIN; // the second empty answer doubled the wait to 30 min
    await m().searchTv('x');
    expect(calls).toHaveLength(2);
    t = 47 * MIN;
    await m().searchTv('x');
    expect(calls).toHaveLength(3);
  });

  it('goes quiet after a failure, keeps serving cached answers, and tries again after the wait', async () => {
    let down = false;
    const calls: string[] = [];
    const client: TmdbClient = {
      ...unavailableTmdb(),
      searchTv: async (q) => {
        calls.push(q);
        if (down) throw new Error('network down');
        return [{ id: 1, name: 'a', original_name: 'a' }];
      },
    };
    let t = 0;
    const m = () => memoize(client, () => t);
    await m().searchTv('cached');
    down = true;
    await expect(m().searchTv('other')).rejects.toThrow('network down');
    await expect(m().searchTv('another')).rejects.toThrow('network down');
    expect(calls).toEqual(['cached', 'other']);
    expect(await m().searchTv('cached')).toHaveLength(1);
    t = 61_000;
    await expect(m().searchTv('other')).rejects.toThrow('network down');
    expect(calls).toHaveLength(3);
    t = 61_000 + 90_000; // the second failure doubled the wait to 2 min
    await expect(m().searchTv('other')).rejects.toThrow('network down');
    expect(calls).toHaveLength(3);
    t = 61_000 + 121_000;
    down = false;
    await m().searchTv('other');
    expect(calls).toHaveLength(4);
  });
});
