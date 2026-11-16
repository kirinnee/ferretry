import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { LoginChangesPort, LoginsUsedBy } from '@ferretry/plugin-logins/contract';
import { AutoResumeDecide, LaunchParts, RuntimeStart, StartDecide } from '@ferretry/core-ferrets/contract';
import { ProfileSecrets } from '@ferretry/core-vault/contract';
import { ITEM_NAME_PATTERN as StdItemNamePattern } from '@ferretry/std';
import {
  INSTRUCTION_ITEMS,
  ITEM_NAME_PATTERN,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  AccountChangeRequestSchema,
  ApplyOutcomeSchema,
  CloneBundleSchema,
  ModelSetFileSchema,
  ProposalApplyRequestSchema,
  type RuntimeHomeReader,
  type RuntimeSummary,
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

  test('every Runtimes collection names its items by the one shared item-name pattern, never a copy of it', () => {
    for (const def of [RUNTIME_ITEMS, PROFILE_ITEMS, INSTRUCTION_ITEMS, MODEL_SET_ITEMS]) {
      expect((def as unknown as { name: RegExp }).name).toBe(ITEM_NAME_PATTERN);
    }
    expect(ITEM_NAME_PATTERN).toBe(StdItemNamePattern);
  });

  test('the fake passes the conformance suite', async () => {
    const result = await runtimesConformance(fakeRuntimes);
    expect(result.ok).toBe(true);
  });

  test('the fake answers the homes a test sets, and a reader only for a listed id', async () => {
    const fake = fakeRuntimes();
    const home = {
      id: 'h1',
      harness: 'claude-code',
      runtimes: [],
      home: '/fleet/homes/h1',
      wrapper: '/fleet/bin/w',
    } as const;
    const reader = {} as RuntimeHomeReader;
    expect(await fake.homes()).toEqual([]);
    expect(fake.home('h1')).toBeUndefined();
    fake.setHomes([home], { h1: reader, h2: reader });
    expect(await fake.homes()).toEqual([home]);
    expect(fake.home('h1')).toBe(reader);
    expect(fake.home('h2')).toBeUndefined();
    fake.setHomes([home]);
    expect(fake.home('h1')).toBeUndefined();
    expect((await runtimesConformance(() => fake)).ok).toBe(true);
    fake.setHomes([home, home]);
    expect((await runtimesConformance(() => fake)).ok).toBe(false);
  });

  test('the conformance suite fails an implementation that answers a reader for an unlisted id', async () => {
    const result = await runtimesConformance(() => ({ ...fakeRuntimes(), home: () => ({}) as RuntimeHomeReader }));
    expect(result).toEqual({ ok: false, error: ['home() is undefined for an id homes() does not list'] });
  });

  const summary = (id: string, extra: Partial<RuntimeSummary> = {}): RuntimeSummary => ({
    id: RuntimeIdSchema.parse(id),
    harness: 'claude-code',
    login: 'work',
    profile: 'default',
    agent: true,
    launch: { available: true },
    ...extra,
  });

  test('the fake resolves a runtime as Runtimes does: unknown, switched off, not signed in, or ready', async () => {
    const fake = fakeRuntimes();
    const ready = summary('ready');
    const off = summary('off', { disabled: { reason: 'paused' } });
    const out = summary('out', { launch: { available: false, reason: 'Sign in first.' } });
    fake.setRuntimes([ready, off, out], ready.id);
    expect(await fake.resolve(RuntimeIdSchema.parse('nope'))).toMatchObject({ ok: false, refusal: 'unknown' });
    expect(await fake.resolve(off.id)).toEqual({ ok: false, refusal: 'disabled', sentence: 'off is switched off.' });
    expect(await fake.resolve(out.id)).toEqual({ ok: false, refusal: 'not_signed_in', sentence: 'Sign in first.' });
    expect(await fake.resolve(ready.id)).toEqual({ ok: true, runtime: ready });
    // no id: the default
    expect(await fake.resolve()).toEqual({ ok: true, runtime: ready });
    expect(await fake.default()).toBe(ready.id);
    fake.setRuntimes([ready]);
    expect(await fake.resolve()).toMatchObject({ ok: false, refusal: 'unknown' });
  });

  test('R2 the fake answers the profiles and layers a test set, edits the profiles it holds, and records every change', async () => {
    const fake = fakeRuntimes();
    const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };
    const layers = { runtime: RuntimeIdSchema.parse('r'), profile: 'p', mcp: ['notes'], skills: [] };
    fake.setProfiles([{ name: 'p', layers: ['mcp/notes'], etag: 'e1' }], [layers]);
    expect(await fake.profiles()).toEqual([{ name: 'p', layers: ['mcp/notes'], etag: 'e1' }]);
    expect(await fake.layers(layers.runtime)).toEqual(layers);
    expect(await fake.layers(RuntimeIdSchema.parse('nope'))).toBeUndefined();
    const change = { kind: 'add', profile: 'p', layer: 'skills/x' } as const;
    expect(await fake.changeProfileLayers(change, owner)).toEqual({ kind: 'written', profiles: ['p'] });
    expect((await fake.profiles())[0]?.layers).toEqual(['mcp/notes', 'skills/x']);
    // As the real act: a caller carrying no standing is refused, and nothing changes.
    expect(await fake.changeProfileLayers(change)).toMatchObject({ kind: 'refused', code: 'fleet_change_refused' });
    expect(fake.changes).toEqual([change, change]);
  });

  test('the conformance suite names each way an implementation can fail it', async () => {
    const fake = fakeRuntimes();
    const bad = { ...summary('bad'), harness: 'nonsense' } as unknown as RuntimeSummary;
    fake.setRuntimes([bad], RuntimeIdSchema.parse('ghost'));
    expect(await runtimesConformance(() => fake)).toEqual({
      ok: false,
      error: ['list() returns summaries (bad)', 'default() names a runtime that exists'],
    });
    const wrongWord = { ...fakeRuntimes(), resolve: async () => ({ ok: false, refusal: 'disabled', sentence: 's' }) };
    expect(await runtimesConformance(() => wrongWord as never)).toEqual({
      ok: false,
      error: ['resolve() names an unknown runtime "unknown"'],
    });
    const lenient = { ...fakeRuntimes(), resolve: async () => ({ ok: true, runtime: summary('x') }) };
    expect(await runtimesConformance(() => lenient as never)).toEqual({
      ok: false,
      error: ['resolve() refuses an unknown runtime'],
    });
    const twice = fakeRuntimes();
    const home = { id: 'h', harness: 'claude-code', runtimes: [], home: '/f/h', wrapper: '/f/w' } as const;
    twice.setHomes([home, home]);
    expect(await runtimesConformance(() => twice)).toEqual({ ok: false, error: ['homes() lists each id once'] });
  });

  test('a change is strict: it carries no document; an apply body is empty; an outcome carries its result', () => {
    expect(
      AccountChangeRequestSchema.safeParse({ change: { kind: 'runtime.remove', name: 'x', document: {} } }).success,
    ).toBe(false);
    expect(ProposalApplyRequestSchema.safeParse({ approval: 'x' }).success).toBe(false);
    expect(ApplyOutcomeSchema.safeParse({ outcome: 'committed' }).success).toBe(false);
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

  test('Runtimes answers which runtimes use a login (logins.used-by) and whether an auto-resume may spend and which login a runtime starts with, and is the only plugin that writes logins', () => {
    expect(manifest.hooks?.takes).toEqual([
      { hook: LoginsUsedBy, key: 'runtimes' },
      { hook: AutoResumeDecide },
      { hook: StartDecide },
      { hook: RuntimeStart, key: 'runtimes' },
      { hook: LaunchParts },
      { hook: ProfileSecrets, key: 'profiles' },
    ]);
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

  test('B01 a removed runtime file is judged by what it was and never thrown on: it is held (the budget is unseen), shell or not', () => {
    const file = (login: string, shell?: string) =>
      RuntimeFileSchema.parse({ login, profile: 'p', ...(shell ? { shell } : {}) });
    expect(() => runtimeFileLoosens(file('work'), undefined)).not.toThrow();
    // fails closed like a re-point: the file cannot see Logins' budgets, so every removal is held, as v4 held one off a budgeted login
    expect(runtimeFileLoosens(file('work'), undefined)).toEqual([
      'a runtime is removed from login "work", which may leave a budget that counts and stops it',
    ]);
    expect(runtimeFileLoosens(file('work', 'dev'), undefined)).toHaveLength(1);
    expect(runtimeFileLoosens(undefined, undefined)).toEqual([]);
    // the same function still holds what it held: a re-point and a shell newly entered
    expect(runtimeFileLoosens(file('work'), file('play'))).toHaveLength(1);
    expect(runtimeFileLoosens(file('work'), file('work', 'dev'))).toHaveLength(1);
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
