import { describe, expect, test } from 'bun:test';
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
  test('the fake passes the conformance suite', async () => {
    const result = await runtimesConformance(fakeRuntimes);
    expect(result.ok).toBe(true);
  });

  test('the manifest declares fifteen routes under /v1/runtimes and the Ferrets need', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    expect(keys).toHaveLength(15);
    expect(keys.every(key => key.includes(' /v1/runtimes'))).toBe(true);
    expect(Object.keys(manifest.needs)).toEqual(['ferrets']);
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
    expect(
      manifest.actions.routes.find(route => route.key === 'POST /v1/runtimes/recommend')?.capability,
    ).toBeUndefined();
  });

  test('no two verbs are the same and none is a bare setup or import', () => {
    const verbs = manifest.actions.cli.map(entry => entry.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(verbs).not.toContain('setup');
    expect(verbs).not.toContain('import');
    expect(verbs).toContain('runtime import');
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
