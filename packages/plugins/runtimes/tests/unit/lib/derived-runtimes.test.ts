/**
 * A ready login yields a usable runtime with no step: derived at read time from the logins, never written, and any
 * runtime the owner made for the same login wins. An old file that still carries `agent` is read and the field dropped.
 */
import { describe, expect, it } from 'bun:test';
import type { EnvironmentLoginTemplate } from '@ferretry/plugin-logins/contract';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ModelSetFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { deriveRuntimes, freeRuntimeName, withDerived } from '../../../daemon/lib/account/derived-runtimes.ts';
import { resolveDefaultRuntime } from '../../../daemon/lib/account/schema.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../daemon/lib/account/runtimes-model.ts';

const none = {
  runtimes: new Map<string, RuntimeFile>(),
  profiles: new Map<string, ProfileFile>(),
  modelSets: new Map<string, ModelSetFile>(),
};

/** Logins' clean variable templates for the given environment logins (what a derived runtime on one needs). */
const templatesFor = (...ids: readonly string[]): ReadonlyMap<string, EnvironmentLoginTemplate> =>
  new Map(ids.map(id => [id, { kind: 'templates', id, harness: 'claude-code' } as EnvironmentLoginTemplate]));

const notReady = sampleLogin('claude-out', {
  store: 'ferretry',
  status: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'access_current',
    explanation: 'Sign in again.',
    lastCheckInconclusive: false,
  },
});

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  ...none,
  settings: undefined,
  logins: [],
  templates: new Map(),
  components: NO_COMPONENTS,
  ...overrides,
});

describe('runtimes derived from logins', () => {
  it('gives every ready login a runtime on Ferretry’s default profile, Claude and Codex alike', () => {
    const derived = deriveRuntimes({
      ...none,
      logins: [
        sampleLogin('atomi', { store: 'ferretry' }),
        sampleLogin('personal', { harness: 'codex', harnesses: ['codex'] }),
        sampleLogin('third', { store: 'ferretry' }),
      ],
    });

    expect([...derived.runtimes.keys()].toSorted()).toEqual(['atomi', 'personal', 'third']);
    expect(derived.runtimes.get('atomi')).toEqual({ login: 'atomi', profile: 'ferretry-claude' });
    expect(derived.runtimes.get('personal')).toEqual({ login: 'personal', profile: 'ferretry-codex' });
    expect([...derived.profiles.keys()].toSorted()).toEqual(['ferretry-claude', 'ferretry-codex']);
    expect(derived.profiles.get('ferretry-claude')?.contents).toEqual([
      'modelSets/ferretry-claude',
      'instructions/ferretry-work-alone',
      'settings/ferretry-claude-comfort',
    ]);
    expect(derived.profiles.get('ferretry-codex')?.contents).toEqual([
      'modelSets/ferretry-codex',
      'instructions/ferretry-work-alone',
    ]);
    expect(derived.modelSets.get('ferretry-codex')?.models.length).toBe(1);
  });

  it('gives a login that is not ready nothing', () => {
    expect(deriveRuntimes({ ...none, logins: [notReady] }).runtimes.size).toBe(0);
  });

  it('gives a ready environment login (a key or endpoint) a runtime too, on the profile of its harness', () => {
    const derived = deriveRuntimes({
      ...none,
      templates: templatesFor('kimi-key', 'local-codex'),
      logins: [
        sampleLogin('kimi-key', { store: 'environment' }),
        sampleLogin('local-codex', { store: 'environment', harness: 'codex', harnesses: ['codex'] }),
      ],
    });

    expect(derived.runtimes.get('kimi-key')).toEqual({ login: 'kimi-key', profile: 'ferretry-claude' });
    expect(derived.runtimes.get('local-codex')).toEqual({ login: 'local-codex', profile: 'ferretry-codex' });
  });

  it('gives an environment login whose templates Logins withheld or could not give NO runtime (it would be a stand-in)', () => {
    const key = sampleLogin('kimi-key', { store: 'environment' });
    const withheld = new Map<string, EnvironmentLoginTemplate>([
      ['kimi-key', { kind: 'withheld', id: 'kimi-key', harness: 'claude-code', variables: ['MOONSHOT_API_KEY'] }],
    ]);

    expect(deriveRuntimes({ ...none, logins: [key], templates: withheld }).runtimes.size).toBe(0);
    expect(deriveRuntimes({ ...none, logins: [key], templates: undefined }).runtimes.size).toBe(0);
    expect(deriveRuntimes({ ...none, logins: [key], templates: templatesFor('kimi-key') }).runtimes.size).toBe(1);
  });

  it('gives a name clash -2, -3...: the login id is taken by an owner runtime of that name on another login', () => {
    const own = new Map([
      ['atomi', { login: 'other', profile: 'mine' } as RuntimeFile],
      ['atomi-2', { login: 'other-two', profile: 'mine' } as RuntimeFile],
    ]);
    const derived = deriveRuntimes({ ...none, runtimes: own, logins: [sampleLogin('atomi', { store: 'ferretry' })] });

    expect([...derived.runtimes.keys()]).toEqual(['atomi-3']);
    expect(derived.runtimes.get('atomi-3')).toEqual({ login: 'atomi', profile: 'ferretry-claude' });
  });

  it('never lets a suffixed name take another login’s plain id', () => {
    const own = new Map([['atomi', { login: 'other', profile: 'mine' } as RuntimeFile]]);
    const derived = deriveRuntimes({
      ...none,
      runtimes: own,
      logins: [sampleLogin('atomi', { store: 'ferretry' }), sampleLogin('atomi-2', { store: 'ferretry' })],
    });

    expect(derived.runtimes.get('atomi-2')).toEqual({ login: 'atomi-2', profile: 'ferretry-claude' });
    expect(derived.runtimes.get('atomi-3')).toEqual({ login: 'atomi', profile: 'ferretry-claude' });
  });

  it('settles a clash the same way whatever order the logins are listed in', () => {
    const own = new Map([['a', { login: 'other', profile: 'mine' } as RuntimeFile]]);
    const first = sampleLogin('a', { store: 'ferretry' });
    const second = sampleLogin('a-2', { store: 'ferretry' });
    const forward = deriveRuntimes({ ...none, runtimes: own, logins: [first, second] });
    const backward = deriveRuntimes({ ...none, runtimes: own, logins: [second, first] });

    expect([...forward.runtimes.entries()].toSorted()).toEqual([...backward.runtimes.entries()].toSorted());
    expect(forward.runtimes.get('a-3')?.login).toBe('a');
  });

  it('runs a login that drives both CLIs on the first installed one, Claude first, and says which', () => {
    const both = sampleLogin('gateway', {
      store: 'environment',
      harness: 'claude-code',
      harnesses: ['claude-code', 'codex'],
    });
    const on = (installed: readonly ('claude' | 'codex')[] | undefined) =>
      deriveRuntimes({ ...none, logins: [both], installed, templates: templatesFor('gateway') }).runtimes.get(
        'gateway',
      );

    expect(on(['claude', 'codex'])).toEqual({ login: 'gateway', profile: 'ferretry-claude', harness: 'claude-code' });
    expect(on(['codex'])).toEqual({ login: 'gateway', profile: 'ferretry-codex', harness: 'codex' });
    // Neither installed, or not known: the first it drives; the runtime then says its CLI is missing.
    expect(on([])?.harness).toBe('claude-code');
    expect(on(undefined)?.harness).toBe('claude-code');
  });

  it('freeRuntimeName: its own id when free, else the first free suffix, nothing for an id the grammar refuses', () => {
    expect(freeRuntimeName('kimi', () => true)).toBe('kimi');
    expect(freeRuntimeName('kimi', name => name !== 'kimi')).toBe('kimi-2');
    expect(freeRuntimeName('kimi', name => name !== 'kimi' && name !== 'kimi-2')).toBe('kimi-3');
    expect(freeRuntimeName('Not A Name!', () => true)).toBeUndefined();
  });

  it('never replaces what the owner made: a login that already has a runtime gets no second one', () => {
    const own = new Map([['claude-default', { login: 'atomi', profile: 'mine' } as RuntimeFile]]);
    const derived = deriveRuntimes({ ...none, runtimes: own, logins: [sampleLogin('atomi', { store: 'ferretry' })] });

    expect(derived.runtimes.size).toBe(0);
    expect(withDerived(own, derived.runtimes).get('claude-default')?.profile).toBe('mine');
  });

  it('keeps an explicit profile or model set of the default name as it is', () => {
    const profile = { contents: ['modelSets/ferretry-claude'] } as ProfileFile;
    const derived = deriveRuntimes({
      ...none,
      profiles: new Map([['ferretry-claude', profile]]),
      logins: [sampleLogin('atomi', { store: 'ferretry' })],
    });

    // The explicit one stands; only the other harness's built-in is derived.
    expect([...derived.profiles.keys()]).toEqual(['ferretry-codex']);
    expect(derived.runtimes.get('atomi')?.profile).toBe('ferretry-claude');
  });

  it('always carries the built-in profiles and model sets, with no login at all', () => {
    const derived = deriveRuntimes({ ...none, logins: [] });

    expect([...derived.profiles.keys()].toSorted()).toEqual(['ferretry-claude', 'ferretry-codex']);
    expect([...derived.modelSets.keys()].toSorted()).toEqual(['ferretry-claude', 'ferretry-codex']);
  });

  it('never dangles a runtime the owner saved on a built-in preset: fresh one-login home, save my-claude, read again', () => {
    // Arrange — the saved runtime takes the login, so the derived one for it is gone; its preset must still be there.
    const mine = new Map([['my-claude', { login: 'atomi', profile: 'ferretry-claude' } as RuntimeFile]]);

    // Act
    const assembled = assembleRuntimesModel(
      files({ logins: [sampleLogin('atomi', { store: 'ferretry' })], runtimes: mine }),
    );

    // Assert — valid, and nothing was written for the built-ins
    expect(Object.keys(assembled.model.runtimes)).toEqual(['my-claude']);
    expect(assembled.model.profiles['ferretry-claude']).toBeDefined();
    expect(assembled.model.components.modelSets['ferretry-claude']).toBeDefined();
    expect(assembled.sources).toBe(2);
  });

  it('reads a saved default that no longer exists as unset, falls back to the first runtime and says so (2 logins, one not ready)', () => {
    // Arrange — the owner saved the derived runtime of a login that has since needed sign-in.
    const assembled = assembleRuntimesModel(
      files({
        logins: [sampleLogin('claude-two', { store: 'ferretry' }), notReady],
        settings: { defaultRuntime: 'claude-out' } as never,
      }),
    );

    // Assert — not a refusal of the whole model
    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-two']);
    expect(assembled.model.machine.defaultRuntime).toBeUndefined();
    expect(resolveDefaultRuntime(assembled.model)).toBe('claude-two');
    expect(assembled.notices).toHaveLength(1);
    expect(assembled.notices[0]).toContain('"claude-out"');
    expect(assembled.unreadable).toEqual([]);
  });

  it('keeps a saved default that is still there, with no notice', () => {
    const assembled = assembleRuntimesModel(
      files({
        logins: [sampleLogin('claude-two', { store: 'ferretry' }), sampleLogin('claude-three', { store: 'ferretry' })],
        settings: { defaultRuntime: 'claude-three' } as never,
      }),
    );

    expect(resolveDefaultRuntime(assembled.model)).toBe('claude-three');
    expect(assembled.notices).toEqual([]);
  });

  it('shows in the model Runtimes assembles, with no file behind it', () => {
    const assembled = assembleRuntimesModel(files({ logins: [sampleLogin('atomi', { store: 'ferretry' }), notReady] }));

    expect(Object.keys(assembled.model.runtimes)).toEqual(['atomi']);
    expect(assembled.model.runtimes.atomi).toMatchObject({ credential: 'atomi', profile: 'ferretry-claude' });
    expect(assembled.sources).toBe(2);
    expect(assembled.unreadable).toEqual([]);
  });
});
