/**
 * A ready login yields a usable runtime with no step: derived at read time from the logins, never written, and any
 * runtime the owner made for the same login wins. An old file that still carries `agent` is read and the field dropped.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ModelSetFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { deriveRuntimes, withDerived } from '../../../daemon/lib/account/derived-runtimes.ts';
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
    expect(derived.profiles.get('ferretry-claude')?.contents).toEqual(['modelSets/ferretry-claude']);
    expect(derived.modelSets.get('ferretry-codex')?.models.length).toBe(1);
  });

  it('gives a login that is not ready nothing', () => {
    expect(deriveRuntimes({ ...none, logins: [notReady] }).runtimes.size).toBe(0);
  });

  it('leaves an environment login (a key or endpoint) to be added on purpose', () => {
    expect(deriveRuntimes({ ...none, logins: [sampleLogin('key', { store: 'environment' })] }).runtimes.size).toBe(0);
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

    expect(derived.profiles.size).toBe(0);
    expect(derived.runtimes.get('atomi')?.profile).toBe('ferretry-claude');
  });

  it('shows in the model Runtimes assembles, with no file behind it', () => {
    const assembled = assembleRuntimesModel(files({ logins: [sampleLogin('atomi', { store: 'ferretry' }), notReady] }));

    expect(Object.keys(assembled.model.runtimes)).toEqual(['atomi']);
    expect(assembled.model.runtimes.atomi).toMatchObject({ credential: 'atomi', profile: 'ferretry-claude' });
    expect(assembled.sources).toBe(2);
    expect(assembled.unreadable).toEqual([]);
  });
});
