import { describe, expect, it } from 'bun:test';
import type { FleetAccountChangeView } from '@ferretry/protocol';
import {
  canSignOutFirst,
  confirmLabel,
  defaultChoices,
  ferretsOnLogin,
  ferretsOnRemoved,
  initialChoices,
  moveTargetsFor,
  removeChange,
  removesDefault,
  runtimesOnLogin,
  signOutWarning,
  switchTargets,
  usedBySentence,
} from '../../../../../src/features/fleet/credentials/login-remove-model.ts';
import { credential, machine, runtime, withStatus } from '../account-support.ts';

const OLD = credential({ id: 'kirin-old', usedBy: ['alpha', 'beta'] });
const WORK = credential({ id: 'kirin-work' });
const WAITING = credential({ id: 'kirin-waiting', ...withStatus('needs_sign_in') });
const CODEX = credential({ id: 'codex', harness: 'codex' });
const BOTH = credential({ id: 'deepseek', store: 'environment', harnesses: ['claude', 'codex'] });
const LOGINS = [OLD, WAITING, WORK, CODEX, BOTH];

const ALPHA = runtime({ name: 'alpha', agent: true });
const BETA = runtime({ name: 'beta' });
const GAMMA = runtime({ name: 'gamma', agent: true });
const RUNTIMES = [ALPHA, BETA, GAMMA, runtime({ name: 'codex-default', harness: 'codex' })];

const staged = (runningSessions: readonly { id: string; runtime: string }[]): FleetAccountChangeView =>
  ({
    consequences: [],
    preview: {
      kind: 'apply',
      runningSessions: runningSessions.map(session => ({ ...session, name: session.id, harness: 'claude' })),
    },
  }) as unknown as FleetAccountChangeView;

describe('who uses the login', () => {
  it('lists the runtimes on it, and says when none is', () => {
    expect(runtimesOnLogin(OLD, RUNTIMES).map(item => item.name)).toEqual(['alpha', 'beta']);
    expect(usedBySentence(runtimesOnLogin(OLD, RUNTIMES))).toBe('Used by 2 runtimes: alpha, beta');
    expect(usedBySentence(runtimesOnLogin(credential({ id: 'one', usedBy: ['beta'] }), RUNTIMES))).toBe(
      'Used by 1 runtime: beta',
    );
    expect(usedBySentence([])).toBe('Not used by any runtime.');
  });
});

describe('what a runtime can switch to', () => {
  it('offers only logins that drive its CLI, signed-in ones first, never the login being removed', () => {
    expect(switchTargets(OLD, ALPHA, LOGINS).map(login => login.id)).toEqual([
      'kirin-work',
      'deepseek',
      'kirin-waiting',
    ]);
    expect(switchTargets(OLD, RUNTIMES[3] as (typeof RUNTIMES)[number], LOGINS).map(login => login.id)).toEqual([
      'codex',
      'deepseek',
    ]);
  });

  it('defaults to switching where a compatible login exists, and to removing where none does', () => {
    expect(initialChoices(OLD, [ALPHA, BETA], LOGINS)).toEqual({
      alpha: { kind: 'switch', to: 'kirin-work' },
      beta: { kind: 'switch', to: 'kirin-work' },
    });
    expect(initialChoices(OLD, [ALPHA], [OLD, CODEX])).toEqual({ alpha: { kind: 'remove' } });
  });
});

describe('the change the choices add up to', () => {
  it('is a bare removal when nothing uses the login', () => {
    expect(removeChange(WORK, {}, null)).toEqual({ kind: 'credential.remove', id: 'kirin-work' });
  });

  it('carries the switches, the removals and the new default only when a removed runtime was the default', () => {
    const choices = { alpha: { kind: 'switch', to: 'spare' }, beta: { kind: 'remove' } } as const;
    expect(removeChange(OLD, choices, 'gamma')).toEqual({
      kind: 'credential.remove',
      id: 'kirin-old',
      switchRuntimes: { alpha: 'spare' },
      removeRuntimes: ['beta'],
      defaultRuntime: 'gamma',
    });
    expect(removeChange(OLD, { alpha: { kind: 'switch', to: 'spare' } }, 'gamma')).toEqual({
      kind: 'credential.remove',
      id: 'kirin-old',
      switchRuntimes: { alpha: 'spare' },
    });
  });

  it('needs a new default only when the default runtime is among those removed, and offers agent runtimes that stay', () => {
    const choices = { alpha: { kind: 'remove' }, beta: { kind: 'switch', to: 'kirin-work' } } as const;
    expect(removesDefault(choices, machine({ defaultRuntime: 'alpha' }))).toBe(true);
    expect(removesDefault(choices, machine({ defaultRuntime: 'beta' }))).toBe(false);
    expect(removesDefault(choices, null)).toBe(false);
    expect(defaultChoices(choices, RUNTIMES).map(item => item.name)).toEqual(['gamma']);
  });
});

describe('the ferrets', () => {
  const dry = staged([
    { id: 'a-1', runtime: 'alpha' },
    { id: 'b-1', runtime: 'beta' },
  ]);

  it('counts every ferret on the login, and only those on removed runtimes can be moved', () => {
    const choices = { alpha: { kind: 'switch', to: 'kirin-work' }, beta: { kind: 'remove' } } as const;
    expect(ferretsOnLogin(dry)).toBe(2);
    expect(ferretsOnLogin(null)).toBe(0);
    expect(ferretsOnRemoved(dry, choices).map(session => session.id)).toEqual(['b-1']);
    expect(ferretsOnRemoved(dry, { alpha: { kind: 'switch', to: 'kirin-work' } })).toEqual([]);
    expect(ferretsOnRemoved(null, choices)).toEqual([]);
  });

  it('moves them only to runtimes that stay and can launch', () => {
    const choices = { alpha: { kind: 'remove' } } as const;
    const stuck = runtime({ name: 'stuck', launch: { available: false, reason: 'Sign in to launch' } });
    expect(moveTargetsFor(choices, [...RUNTIMES, stuck]).map(item => item.name)).toEqual([
      'beta',
      'gamma',
      'codex-default',
    ]);
  });

  it('warns about signing out only when ferrets are running', () => {
    expect(signOutWarning(0)).toBeNull();
    expect(signOutWarning(2)).toContain('2 ferrets running on it may ask to sign in again');
  });
});

describe('the confirm button', () => {
  it('says exactly what happens', () => {
    const both = { alpha: { kind: 'switch', to: 'kirin-work' }, beta: { kind: 'switch', to: 'kirin-work' } } as const;
    const mixed = { alpha: { kind: 'switch', to: 'kirin-work' }, beta: { kind: 'remove' } } as const;
    expect(confirmLabel(OLD, {}, { count: 0, to: null }, false)).toBe('Remove kirin-old');
    expect(confirmLabel(OLD, both, { count: 0, to: null }, false)).toBe(
      'Switch 2 runtimes to kirin-work and remove kirin-old',
    );
    expect(confirmLabel(OLD, mixed, { count: 0, to: null }, false)).toBe(
      'Switch 1 runtime to kirin-work, remove 1 runtime and remove kirin-old',
    );
    expect(confirmLabel(OLD, { beta: { kind: 'remove' } }, { count: 2, to: 'gamma' }, true)).toBe(
      'Sign out, move 2 ferrets to gamma, remove 1 runtime and remove kirin-old',
    );
  });
});

describe('signing out first', () => {
  it('is offered only for a login Ferretry keeps a sign-in for, that can be signed out', () => {
    expect(canSignOutFirst(OLD)).toBe(true);
    expect(canSignOutFirst(credential({ id: 'mine', store: 'host' }))).toBe(false);
    expect(canSignOutFirst(credential({ id: 'env', store: 'environment' }))).toBe(false);
    expect(
      canSignOutFirst(
        credential({
          id: 'gone',
          signOut: { available: false, sentence: 'Nothing to sign out.', runtimesAffected: 0, signsOutTerminal: false },
        }),
      ),
    ).toBe(false);
  });
});
