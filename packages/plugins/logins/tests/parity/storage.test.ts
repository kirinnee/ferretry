/** Parity rows F-0167, F-0170, F-0172, F-0277: today's stored files, where Logins keeps them now. */
import { describe, expect, test } from 'bun:test';
import {
  ENDPOINTS_CONFIG,
  LOGINS_CONFIG,
  LOGINS_CREDENTIALS,
  LOGINS_MODELS,
  MODELS_CONFIG,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

describe('the files Logins stores', () => {
  test('F-0167 F-0170 F-0172 a login, a model catalog and a provider preset are each one named config file', () => {
    expect(
      [LOGINS_CONFIG, MODELS_CONFIG, ENDPOINTS_CONFIG].map(def => (def as { collection?: string }).collection),
    ).toEqual(['logins', 'models', 'endpoints']);
    expect(manifest.data.config.map(def => (def as { collection?: string }).collection)).toEqual(
      expect.arrayContaining(['logins', 'models', 'endpoints']),
    );
  });

  test('F-0277 the published model catalog is held in state, and a harness’s own sign-in files are opaque state', () => {
    expect(LOGINS_MODELS.path).toBe('models.json');
    expect(LOGINS_MODELS.store).toBe('json');
    expect(LOGINS_CREDENTIALS.store).toBe('opaque');
    expect(manifest.data.state.map(file => file.name)).toEqual(['credentials', 'models']);
  });
});
