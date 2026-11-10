import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { FakeInputTarget } from '../../../../contract/testing/index.ts';
import { LoginProbeThroughHook } from '../../../../daemon/adapters/inputs/targets.ts';

/**
 * The daemon's own looks at a sign-in, through the targets' own reads (I136): what the page or the screen shows is read
 * where the value was typed, pinned to the surfaces the observer was given, and reduced to whether a value shows. These
 * ran with the integration suite in v4; they use only in-memory fakes, so they live with the unit tests of the Vault.
 */

test('I136 the login observer looks through the targets’ own reads, pinned to the surfaces it was given', async () => {
  const seen: unknown[][] = [];
  class Looking extends FakeInputTarget {
    async where(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['where', ferret, key, surfaces]);
      return { navigationId: 'n1', host: 'login.example.test' };
    }
    async text(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['text', ferret, key, surfaces]);
      return 'welcome back, fake-pw-000';
    }
    async promptLine(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['promptLine', ferret, key, surfaces]);
      return 'Password:';
    }
  }
  const page = new Looking('page', 'login');
  const terminal = new Looking('terminal', 'dev');
  const probe = new LoginProbeThroughHook(kind => (kind === 'page' ? page : terminal));
  const ferret = 'f1' as FerretId;
  expect(await probe.where(ferret, 'login', ['login'])).toEqual({ navigationId: 'n1', host: 'login.example.test' });
  expect(await probe.prompt?.(ferret, 'dev', ['dev', '%3'])).toBe('Password:');
  const pageTarget = { kind: 'page', key: 'login' } as const;
  const terminalTarget = { kind: 'terminal', key: 'dev' } as const;
  expect(await probe.shows(ferret, pageTarget, ['login'], ['fake-pw-000'])).toBe(true);
  expect(await probe.shows(ferret, terminalTarget, ['dev'], ['other-value', ''])).toBe(false);
  // Nothing to look for, or nothing read: cannot tell.
  expect(await probe.shows(ferret, pageTarget, ['login'], [])).toBeUndefined();
  expect(seen.filter(entry => entry[0] === 'text')).toHaveLength(2);
  expect(seen).toContainEqual(['promptLine', ferret, 'dev', ['dev', '%3']]);
});

test('I136 a target that offers no look, or a provider that is off, leaves every sign-in fact unknown', async () => {
  const ferret = 'f1' as FerretId;
  const target = { kind: 'page', key: 'login' } as const;
  for (const provider of [() => new FakeInputTarget('page', 'login'), () => undefined]) {
    const probe = new LoginProbeThroughHook(provider);
    expect(await probe.where(ferret, 'login', ['login'])).toBeUndefined();
    expect(await probe.shows(ferret, target, ['login'], ['value'])).toBeUndefined();
    expect(await probe.prompt?.(ferret, 'dev', ['dev'])).toBeUndefined();
  }
});
