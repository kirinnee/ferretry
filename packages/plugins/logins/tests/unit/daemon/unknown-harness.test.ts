/**
 * RUNTIMES PLAN U4b (Logins): a harness Logins has no behaviour for is REFUSED by name wherever the code once read "if codex
 * … else Claude", and never handed Claude's paths, flags or parser. The unknown harness is the fake third harness's key (the
 * one the U4a composed daemon test starts a ferret on) and a typo (`gemni`).
 *
 * The first half is the REAL daemon (`testHost`): a login file or a change that names the fake third harness is refused with
 * the one sentence at the boundary where a plugin key meets Logins. The second half is each former else-Claude branch, one
 * by one, with a hand-built value no boundary would let through.
 */
import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { describe, expect, test } from 'bun:test';
import { testHost } from '@ferretry/kernel/testing';
import type { LoginFile } from '../../../contract/index.ts';
import { unsupportedHarnessSentence } from '../../../contract/harness-words.ts';
import daemon from '../../../daemon/index.ts';
import { credentialLaunchEnvironment, resolveCredentialStore } from '../../../daemon/lib/credentials/credentials.ts';
import { localCredentialFacts } from '../../../daemon/lib/credentials/credential-status.ts';
import { activeUsageRead, readStoreMaterial } from '../../../daemon/adapters/credentials/material-read.ts';
import { loginKinds, kindOf } from '../../../daemon/lib/kinds.ts';
import { credentialOf } from '../../../daemon/lib/shared/credential.ts';
import {
  byHarness,
  harnessKey,
  harnessKind,
  HarnessKindSchema,
  isHarness,
  isKind,
  isSupportedKind,
  refuseHarness,
  supportedKinds,
  supportedKindOfKey,
  UnsupportedHarnessError,
} from '../../../daemon/lib/shared/harness.ts';
import { credentialShape } from '../../../daemon/lib/shared/identity.ts';
import { emptyVault } from '../../support/fake-vault.ts';
import { sampleLogin } from '../../../contract/testing/index.ts';

const UNKNOWN = [THIRD_HARNESS_KEY, 'gemni'] as const;

const refused = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedHarnessError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal, but nothing was refused');
};

describe('the fake third harness through the real logins daemon', () => {
  const boot = async (logins: Record<string, unknown>) =>
    await testHost({
      plugins: [daemon],
      fakes: { gate: new FakeGate(), vault: emptyVault() },
      config: { logins },
    });

  test('a login file that names it is refused with the one sentence, and the machine does not boot on it', async () => {
    const attempt = boot({ third: { harness: THIRD_HARNESS_KEY, store: 'host' } });

    await expect(attempt).rejects.toThrow(unsupportedHarnessSentence(THIRD_HARNESS_KEY));
  });

  test('a change that adds a login on it is refused as an invalid request, and stages nothing', async () => {
    const host = await boot({ work: { harness: 'claude-code', store: 'host' } });
    try {
      const added = await host.request('POST', '/v1/logins/changes', {
        body: { kind: 'login.add', id: 'newone', harness: THIRD_HARNESS_KEY },
      });

      expect(added.status).toBe(400);
      expect(added.json<{ code: string; error: string }>()).toMatchObject({ code: 'invalid_request' });
      expect(added.body).toContain(unsupportedHarnessSentence(THIRD_HARNESS_KEY));
    } finally {
      await host.stop();
    }
  });

  test('the two shipped harnesses are listed exactly as before', async () => {
    const host = await boot({
      work: { harness: 'claude-code', store: 'host' },
      team: { harness: 'codex', store: 'ferretry' },
    });
    try {
      const list = await host.request('GET', '/v1/logins');

      expect(
        list.json<{ logins: readonly { id: string; harness: string }[] }>().logins.map(l => [l.id, l.harness]),
      ).toEqual([
        ['team', 'codex'],
        ['work', 'claude-code'],
      ]);
    } finally {
      await host.stop();
    }
  });
});

describe('the stored words of the two shipped harnesses stay what they were on disk', () => {
  test('claude is the plugin claude-code and codex is codex, both ways', () => {
    expect(supportedKinds()).toEqual(['claude', 'codex']);
    expect(harnessKind('claude-code')).toBe('claude');
    expect(harnessKind('codex')).toBe('codex');
    expect(harnessKey('claude')).toBe('claude-code');
    expect(harnessKey('codex')).toBe('codex');
    expect(HarnessKindSchema.parse('claude')).toBe('claude');
    expect(isHarness({ harness: 'claude' as const }, 'claude')).toBe(true);
    expect(isKind('claude-code', 'claude')).toBe(true);
    expect(isKind('codex', 'claude')).toBe(false);
    expect(byHarness('claude-code', { claude: () => 1, codex: () => 2 })).toBe(1);
    expect(byHarness('codex', { claude: () => 1, codex: () => 2 })).toBe(2);
  });
});

describe.each(UNKNOWN)('a harness Logins has no behaviour for (%s)', unknown => {
  const sentence = unsupportedHarnessSentence(unknown);

  test('is no supported word or key, and is no member of either', () => {
    expect(isSupportedKind(unknown)).toBe(false);
    expect(supportedKindOfKey(unknown)).toBeUndefined();
    expect(isKind(unknown, 'claude')).toBe(false);
    expect(isKind(unknown, 'codex')).toBe(false);
    expect(HarnessKindSchema.safeParse(unknown).success).toBe(false);
  });

  test('is refused where a key becomes a stored word, and where a case is chosen', () => {
    expect(refused(() => harnessKind(unknown))).toBe(sentence);
    expect(refused(() => byHarness(unknown, { claude: () => 'Claude', codex: () => 'Codex' }))).toBe(sentence);
    expect(refused(() => refuseHarness({ harness: unknown } as never))).toBe(sentence);
    expect(refused(() => refuseHarness(unknown as never))).toBe(sentence);
  });

  test('the kind of a login on it is refused, never "anthropic"', () => {
    expect(refused(() => kindOf({ harness: unknown, store: 'ferretry' } as unknown as LoginFile))).toBe(sentence);
    expect(refused(() => credentialOf({ harness: unknown, store: 'ferretry' } as unknown as LoginFile))).toBe(sentence);
  });

  test('where its credential is kept is refused, never Claude’s secure-storage directory', () => {
    const credential = { harness: unknown, store: 'ferretry' } as never;
    const paths = { fleetRoot: '/fy/fleet', userHome: '/home/x' } as never;

    expect(refused(() => resolveCredentialStore('login', credential, paths))).toBe(sentence);
    expect(refused(() => credentialLaunchEnvironment({ harness: unknown, store: 'ferretry' } as never))).toBe(sentence);
  });

  test('its credential is never read in Claude’s shape, and no usage read is made for it', async () => {
    expect(refused(() => credentialShape(unknown as never, { outcome: 'absent' }))).toBe(sentence);
    expect(refused(() => localCredentialFacts(unknown as never, { outcome: 'absent' }, undefined))).toBe(sentence);
    await expect(
      activeUsageRead(unknown as never, { outcome: 'absent' }, { anthropic: {} as never, codex: {} as never }),
    ).rejects.toThrow(sentence);
  });

  test('a store file is not read at all, because no rule about it is Claude’s or Codex’s to borrow', async () => {
    const reader = {
      lstat: async () => ({ kind: 'symlink', links: 2 }),
      stat: async () => undefined,
      readText: async () => '',
    };

    await expect(readStoreMaterial(reader, '/x', unknown as never)).rejects.toThrow(sentence);
  });
});

describe('the login kinds with a harness they do not serve', () => {
  const files = new Map<string, LoginFile>([
    ['work', { harness: 'claude-code', store: 'host' } as LoginFile],
    ['team', { harness: 'codex', store: 'ferretry' } as LoginFile],
    ['ds', { harness: 'claude-code', store: 'environment', preset: 'deepseek', env: {} } as LoginFile],
  ]);
  const kinds = loginKinds({
    clock: { sleep: async () => undefined },
    launchStore: async () => ({ kind: 'none' }),
    files: () => files,
    view: async id => sampleLogin(id),
    check: async id => sampleLogin(id),
    startSignIn: async () => {
      throw new Error('not used');
    },
    signInStatus: async () => {
      throw new Error('not used');
    },
    credentialProblem: async () => undefined,
    shareCredential: async () => undefined,
  });

  test.each(UNKNOWN)('hands %s no environment, no launch variables and no sign-in file', async unknown => {
    const sentence = unsupportedHarnessSentence(unknown);

    await expect(kinds.endpoint.env('ds', unknown)).rejects.toThrow(sentence);
    expect(await kinds.anthropic.launchEnvironment?.('work', unknown)).toEqual({ ok: false, error: sentence });
    expect(await kinds.openai.credential?.('team', unknown)).toMatchObject({ kind: 'unavailable' });
  });

  test('still gives Codex no launch variables from an Anthropic login, as before', async () => {
    expect(await kinds.anthropic.launchEnvironment?.('work', 'codex')).toEqual({ ok: true, value: {} });
  });
});
