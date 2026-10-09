import { describe, expect, it } from 'vitest';
import { createTmdbClient } from '../src/modules/ingest/tmdb.ts';

describe('createTmdbClient', () => {
  it('sends the bearer token and es-MX, and never leaks the token in errors', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const client = createTmdbClient('SECRET-TOKEN', fetchImpl);
    const err = await client.searchTv('naruto').catch((e: Error) => e);
    expect(seen[0]!.auth).toBe('Bearer SECRET-TOKEN');
    expect(seen[0]!.url).toContain('language=es-MX');
    expect(seen[0]!.url).toContain('/search/tv');
    expect((err as Error).message).not.toContain('SECRET-TOKEN');
  });

  it('returns null for a missing season and for a missing image', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch;
    const client = createTmdbClient('t', fetchImpl);
    expect(await client.tvSeason(1, 9)).toBeNull();
    expect(await client.image('w500', '/x.jpg')).toBeNull();
  });
});
