import { describe, expect, it } from 'vitest';
import { tmdbSectionState, type AppConfig } from './config.ts';

const config = (tmdbConfigured: boolean): AppConfig => ({
  status: 'ready',
  contentDir: '/media/tv',
  libraryId: 'lib-1',
  suggestedDefault: '/media/tv',
  tmdbConfigured,
});

describe('tmdbSectionState', () => {
  it('shows "Sin configurar" and blocks Probar until there is a token to test', () => {
    const state = tmdbSectionState(config(false), '', false);
    expect(state.state).toBe('Sin configurar');
    expect(state.canTest).toBe(false);
    // Saving an empty token is allowed: that is how the token is cleared.
    expect(state.canSave).toBe(true);
  });

  it('shows "Configurado ✓" and can test the saved token with an empty input', () => {
    const state = tmdbSectionState(config(true), '', false);
    expect(state.state).toBe('Configurado ✓');
    expect(state.canTest).toBe(true);
  });

  it('a typed token can be tested before it is saved', () => {
    expect(tmdbSectionState(config(false), '  abc  ', false).canTest).toBe(true);
  });

  it('locks both buttons while a request is in flight', () => {
    expect(tmdbSectionState(config(true), 'abc', true)).toEqual({ state: 'Configurado ✓', canSave: false, canTest: false });
  });

  it('an unreachable config still renders as unconfigured instead of failing', () => {
    expect(tmdbSectionState(null, '', false).state).toBe('Sin configurar');
    expect(tmdbSectionState(null, 'abc', false).canTest).toBe(true);
  });
});
