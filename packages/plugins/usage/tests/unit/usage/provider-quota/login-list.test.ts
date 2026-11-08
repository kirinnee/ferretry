import { describe, expect, test } from 'bun:test';
import type { LoginList, ProviderPresetCatalog } from '../../../../contract/index.ts';
import { providerQuotaLogins } from '../../../../daemon/lib/usage/provider-quota/logins.ts';

/** Only the fields the reader looks at; the rest of a login's view is Logins' own. */
const list = (...logins: unknown[]): LoginList => ({ format: 1, machine: 'box', logins }) as unknown as LoginList;
const presets = (...found: unknown[]): ProviderPresetCatalog =>
  ({ presets: found }) as unknown as ProviderPresetCatalog;

const PRESET = {
  id: 'zai',
  origin: 'built-in',
  unverified: [],
  variables: [
    { kind: 'plain', name: 'BASE_URL' },
    { kind: 'secret', name: 'API_KEY', secret: 'zai_key' },
  ],
};

describe('providerQuotaLogins', () => {
  test('lists no harness sign-in, and no environment login without its environment', () => {
    expect(
      providerQuotaLogins(list({ id: 'claude-a', store: 'host' }, { id: 'broken', store: 'environment' }), presets()),
    ).toEqual([]);
  });

  test('builds an environment login: plain values as written, one secret as a ${secret:NAME} reference', () => {
    const [login] = providerQuotaLogins(
      list({
        id: 'zai-1',
        store: 'environment',
        environment: {
          quotaSource: 'zai-coding-plan',
          preset: { id: 'zai' },
          codexProvider: { baseUrl: 'https://codex.example/v1' },
          variables: [
            { kind: 'plain', name: 'BASE_URL', value: 'https://api.example' },
            { kind: 'secret', name: 'API_KEY', secrets: ['zai_key'] },
          ],
        },
      }),
      presets(PRESET),
    );
    expect(login).toEqual({
      id: 'zai-1',
      source: 'zai-coding-plan',
      variables: { BASE_URL: 'https://api.example', API_KEY: '${secret:zai_key}' },
      keyVariable: 'API_KEY',
      presetSecretName: 'zai_key',
      codexBaseUrl: 'https://codex.example/v1',
      builtIn: true,
      unverified: false,
      agent: 'zai-1',
    });
  });

  test('leaves out a secret variable that names no secret or several, and any other kind', () => {
    const [login] = providerQuotaLogins(
      list({
        id: 'e1',
        store: 'environment',
        environment: {
          quotaSource: 'none',
          variables: [
            { kind: 'secret', name: 'NONE', secrets: [] },
            { kind: 'secret', name: 'MANY', secrets: ['a', 'b'] },
            { kind: 'hidden', name: 'HIDDEN' },
          ],
        },
      }),
      presets(),
    );
    expect(login?.variables).toEqual({});
  });

  test('a login with no known preset has no key variable, secret name or Codex URL, and is not built in', () => {
    const [login] = providerQuotaLogins(
      list({
        id: 'e2',
        store: 'environment',
        environment: { quotaSource: 'none', preset: { id: 'gone' }, variables: [] },
      }),
      presets(PRESET),
    );
    expect(login).toEqual({
      id: 'e2',
      source: 'none',
      variables: {},
      builtIn: false,
      unverified: false,
      agent: 'e2',
    });
  });

  test('a preset with no secret variable names no key, and one with unverified facts is marked so', () => {
    const [login] = providerQuotaLogins(
      list({
        id: 'e3',
        store: 'environment',
        environment: { quotaSource: 'none', preset: { id: 'file-one' }, variables: [] },
      }),
      presets({
        id: 'file-one',
        origin: 'file',
        unverified: ['the quota endpoint'],
        variables: [{ kind: 'plain', name: 'X' }],
      }),
    );
    expect(login).toMatchObject({ builtIn: false, unverified: true });
    expect(login).not.toHaveProperty('keyVariable');
    expect(login).not.toHaveProperty('presetSecretName');
  });

  test('a secret preset variable that declares no secret name leaves presetSecretName out', () => {
    const [login] = providerQuotaLogins(
      list({
        id: 'e4',
        store: 'environment',
        environment: { quotaSource: 'none', preset: { id: 'p' }, variables: [] },
      }),
      presets({ id: 'p', origin: 'built-in', unverified: [], variables: [{ kind: 'secret', name: 'KEY' }] }),
    );
    expect(login).toMatchObject({ keyVariable: 'KEY' });
    expect(login).not.toHaveProperty('presetSecretName');
  });
});
