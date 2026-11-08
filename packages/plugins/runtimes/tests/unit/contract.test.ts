import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { LoginChangesPort, LoginsUsedBy } from '@ferretry/plugin-logins/contract';
import {
  AccountChangeRequestSchema,
  CloneBundleSchema,
  ModelSetFileSchema,
  ProfileFileSchema,
  RuntimeFileSchema,
  RuntimeIdSchema,
  runtimeFileLoosens,
  runtimeLoosening,
  RUNTIMES_AUDIT,
} from '../../contract/index.ts';
import { fakeRuntimes, runtimesConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('runtimes contract', () => {
  test('keeps runtimes and onboarding pending until real assembly and screens are ported', () => {
    const pending = JSON.parse(
      readFileSync(new URL('../../../../../ports-pending.json', import.meta.url), 'utf8'),
    ).pending;
    expect(pending).toContain('runtimes');
    expect(pending).toContain('onboarding');
  });

  test('the fake passes the conformance suite', async () => {
    const result = await runtimesConformance(fakeRuntimes);
    expect(result.ok).toBe(true);
  });

  test('the manifest owns sixteen routes and requires Logins', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    expect(keys).toHaveLength(16);
    expect(keys.filter(key => !key.includes(' /v1/runtimes'))).toEqual([
      'GET /v1/ferrets/:id/runtime-models',
      'POST /v1/ferrets/:id/runtime',
    ]);
    expect(Object.keys(manifest.needs)).toEqual(['ferrets', 'logins', 'loginChanges']);
  });

  test('Runtimes answers which runtimes use a login (logins.used-by) and is the only plugin that writes logins', () => {
    expect(manifest.hooks?.takes).toEqual([{ hook: LoginsUsedBy, key: 'runtimes' }]);
    expect(manifest.needs.loginChanges).toBe(LoginChangesPort);
    expect(LoginsUsedBy.takers).toEqual(['runtimes']);
  });

  test('every route is operator-minimum and no-store, and a ferret may not apply a change', () => {
    for (const route of manifest.actions.routes) {
      expect(route.minimum).toBe('operator');
      expect(route.noStore).toBe(true);
    }
    const apply = manifest.actions.routes.find(route => route.key.endsWith('/apply'));
    expect(apply?.caller).toBe('person');
    expect(apply?.audit as unknown).toEqual({ record: RUNTIMES_AUDIT.apply });
  });

  test('reading is fleet.use and changing is fleet.configure, as today', () => {
    const axis = (key: string) => manifest.actions.routes.find(route => route.key === key)?.capability?.axis;
    expect(axis('GET /v1/runtimes')).toBe('use');
    expect(axis('POST /v1/runtimes/profiles/preview')).toBe('use');
    expect(axis('POST /v1/runtimes/proposals')).toBe('configure');
    expect(axis('GET /v1/runtimes/setup/scan')).toBe('configure');
    expect(axis('GET /v1/runtimes/export')).toBe('configure');
  });

  test('no two verbs are the same and none is a bare setup or import, and a harness is linked', () => {
    const verbs = manifest.actions.cli.map(entry => entry.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(verbs).not.toContain('setup');
    expect(verbs).not.toContain('import');
    expect(verbs).not.toContain('runtime import');
    expect(verbs).toContain('runtime link');
  });

  test('a runtime id is a name', () => {
    expect(RuntimeIdSchema.safeParse('claude-default').success).toBe(true);
    expect(RuntimeIdSchema.safeParse('claude.work').success).toBe(false);
    expect(RuntimeIdSchema.safeParse('-edge').success).toBe(false);
  });

  test('a runtime file names a login and refuses a raw field', () => {
    expect(RuntimeFileSchema.parse({ login: 'work', profile: 'default' }).agent).toBe(false);
    expect(RuntimeFileSchema.safeParse({ login: 'work', profile: 'default', credential: 'work' }).success).toBe(false);
  });

  test('a profile layer is <kind>/<name> or profile/<name>', () => {
    expect(ProfileFileSchema.safeParse({ contents: ['mcp/notes', 'profile/base', 'modelSets/fast'] }).success).toBe(
      true,
    );
    expect(ProfileFileSchema.safeParse({ contents: ['nonsense/x'] }).success).toBe(false);
    expect(ProfileFileSchema.safeParse({ contents: ['mcp'] }).success).toBe(false);
  });

  test('a model set default must be one of its models', () => {
    expect(ModelSetFileSchema.safeParse({ models: ['a', 'b'], default: 'a' }).success).toBe(true);
    expect(ModelSetFileSchema.safeParse({ models: ['a', 'b'], default: 'c' }).success).toBe(false);
    expect(ModelSetFileSchema.safeParse({ models: ['a', 'a'], default: 'a' }).success).toBe(false);
  });

  test('moving a runtime off a budgeted login is a loosening; off an unbudgeted one is not', () => {
    const budgeted = (login: string) => login === 'work';
    const off = runtimeLoosening('r', { login: 'work' }, { login: 'play' }, budgeted);
    expect(off).toHaveLength(1);
    expect(runtimeLoosening('r', { login: 'work' }, undefined, budgeted)).toHaveLength(1);
    expect(runtimeLoosening('r', { login: 'play' }, { login: 'work' }, budgeted)).toEqual([]);
    // the kernel-side rule cannot see budgets, so it fails closed on any login change
    const file = (login: string) => RuntimeFileSchema.parse({ login, profile: 'p' });
    expect(runtimeFileLoosens(file('a'), file('b'))).toHaveLength(1);
    expect(runtimeFileLoosens(file('a'), file('a'))).toEqual([]);
    expect(runtimeFileLoosens(undefined, file('a'))).toEqual([]);
  });

  test('T-0034 a shell newly entered is held, on a new file too; dropping or keeping it is not', () => {
    const file = (shell?: string) => RuntimeFileSchema.parse({ login: 'a', profile: 'p', ...(shell ? { shell } : {}) });
    const held = ['a runtime now enters the shell "dev"'];
    expect(runtimeFileLoosens(undefined, file('dev'))).toEqual(held);
    expect(runtimeFileLoosens(file(), file('dev'))).toEqual(held);
    expect(runtimeFileLoosens(file('ops'), file('dev'))).toEqual(held);
    expect(runtimeFileLoosens(file('dev'), file('dev'))).toEqual([]);
    expect(runtimeFileLoosens(file('dev'), file())).toEqual([]);
  });

  test('a change names one intent and is strict', () => {
    expect(AccountChangeRequestSchema.safeParse({ change: { kind: 'runtime.remove', name: 'x' } }).success).toBe(true);
    expect(
      AccountChangeRequestSchema.safeParse({ change: { kind: 'runtime.remove', name: 'x', extra: 1 } }).success,
    ).toBe(false);
    expect(AccountChangeRequestSchema.safeParse({ change: { kind: 'credential.remove', id: 'work' } }).success).toBe(
      true,
    );
  });

  test('a clone bundle has one format, version 1', () => {
    const bundle = {
      format: 'ferretry-clone',
      version: 1,
      machine: 'a',
      daemon: 'd',
      exportedAt: '2026-11-07T00:00:00Z',
      credentials: [],
      components: {},
      profiles: {},
      runtimes: {},
      files: [],
      notCopied: [],
      keys: {},
    };
    expect(CloneBundleSchema.safeParse(bundle).success).toBe(true);
    expect(CloneBundleSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
  });
});

describe('runtime file shell (Q18)', () => {
  test('a runtime file may name a shell item, and the field is optional', async () => {
    const { RuntimeFileSchema } = await import('../../contract/index.ts');
    expect(RuntimeFileSchema.safeParse({ login: 'claude-main', profile: 'default' }).success).toBe(true);
    const named = RuntimeFileSchema.parse({ login: 'claude-main', profile: 'default', shell: 'nix-dev' });
    expect(named.shell).toBe('nix-dev');
    expect(RuntimeFileSchema.safeParse({ login: 'claude-main', profile: 'default', shell: 'a/b' }).success).toBe(false);
  });
});
