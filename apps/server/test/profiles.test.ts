import { describe, expect, it } from 'vitest';
import { setup } from './helpers.ts';

describe('profiles API', () => {
  it('creates, lists, updates and deletes a profile', async () => {
    const { app } = setup();
    const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Ana', theme: 'light' } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(created.json()).toMatchObject({ name: 'Ana', theme: 'light', preferredAudioLang: null });

    expect((await app.inject('/api/profiles')).json()).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}`,
      payload: { preferredAudioLang: 'ja' },
    });
    expect(patched.json()).toMatchObject({ name: 'Ana', preferredAudioLang: 'ja' });

    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${id}` })).statusCode).toBe(204);
    expect((await app.inject('/api/profiles')).json()).toHaveLength(0);
  });

  it('rejects invalid body with 400 and duplicate name with 409', async () => {
    const { app } = setup();
    const bad = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '', theme: 'neon' } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Ana' } });
    const dup = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Ana' } });
    expect(dup.statusCode).toBe(409);
  });

  it('returns 404 for unknown profile on patch and delete', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'PATCH', url: '/api/profiles/99', payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/profiles/99' })).statusCode).toBe(404);
  });
});
