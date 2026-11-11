import { describe, expect, test } from 'bun:test';
import type { SharedCredential } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import type { LaunchPart, LoginCredentialAnswer } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A ferret on a login whose sign-in is a FILE (Codex's `auth.json`) is refused, before any token or pane, when Logins says
 * the file cannot be used; and when it can, the kernel's shared credential reaches the harness as `spec.credential`, on
 * every launch (start, resume, revive). Fake values only; nothing here reads a real home or a real login.
 */

/** A stand-in for the kernel's opaque object: Ferrets only carries it, never opens it. */
const CREDENTIAL = Object.freeze(Object.create(null)) as SharedCredential;

function fixture(options: {
  readonly loginCredential?: FerretsPorts['loginCredential'];
  readonly parts?: readonly LaunchPart[];
}) {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const harness = new FakeHarness('codex');
  const runner = new FakeRunner();
  let tokenSaves = 0;
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {
      tokenSaves += 1;
    },
    harness: key => (key === 'codex' ? harness : undefined),
    harnessKeys: () => ['codex'],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [{ parts: async () => options.parts ?? [] }],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    ...(options.loginCredential === undefined ? {} : { loginCredential: options.loginCredential }),
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return {
    harness,
    runner,
    registry,
    tokenSaves: () => tokenSaves,
    service: new FerretsService(registry, tokens, ports),
  };
}

const answering =
  (answer: LoginCredentialAnswer, asked: [string, string][] = []): NonNullable<FerretsPorts['loginCredential']> =>
  async (login, harness) => {
    asked.push([login, harness]);
    return answer;
  };

describe('a ferret on a login with a sign-in file', () => {
  test('15: an unavailable answer refuses the start as login_unavailable with the sentence, and nothing starts', async () => {
    const sentence = 'the login team is not signed in; sign it in from Logins and start the ferret again';
    const f = fixture({ loginCredential: answering({ kind: 'unavailable', sentence }) });

    const started = await f.service.start({ folder: '/work', harness: 'codex', login: 'team', by: 'owner' });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe(sentence);
    expect(f.runner.starts).toBe(0);
    expect(f.harness.prepared).toHaveLength(0);
    expect(f.harness.launched).toHaveLength(0);
    // No token was issued or saved, and the record settled as a failed start.
    expect(f.tokenSaves()).toBe(0);
    const [record] = f.registry.list();
    expect(record?.state).toBe('stopped');
    expect((await f.service.get(record?.id as never))?.cause).toEqual({ kind: 'start_failed' });
  });

  test('15: a port that throws fails closed with a fixed sentence that quotes nothing it threw', async () => {
    const f = fixture({
      loginCredential: async () => {
        throw new Error('ENOENT /home/someone/auth.json sk-secret');
      },
    });

    const started = await f.service.start({ folder: '/work', harness: 'codex', login: 'team', by: 'owner' });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('login_unavailable');
    expect(started.error.reason).toBe('the login team could not be checked, so the ferret was not started');
    expect(f.runner.starts).toBe(0);
  });

  test('16: a file answer reaches prepareHome and start as spec.credential', async () => {
    const f = fixture({ loginCredential: answering({ kind: 'file', credential: CREDENTIAL }) });

    const started = await f.service.start({ folder: '/work', harness: 'codex', login: 'team', by: 'owner' });

    expect(started.ok).toBe(true);
    expect(f.harness.prepared[0]?.credential).toBe(CREDENTIAL);
    expect(f.harness.launched[0]?.credential).toBe(CREDENTIAL);
    expect(f.harness.launched[0]?.parts).toEqual([]);
  });

  test('16: start, resume and revive each ask again, so each launch carries a credential minted for it', async () => {
    const asked: [string, string][] = [];
    const first = Object.freeze(Object.create(null)) as SharedCredential;
    const second = Object.freeze(Object.create(null)) as SharedCredential;
    const third = Object.freeze(Object.create(null)) as SharedCredential;
    const answers = [first, second, third];
    const f = fixture({
      loginCredential: async (login, harness) => {
        asked.push([login, harness]);
        return { kind: 'file', credential: answers[asked.length - 1] as SharedCredential };
      },
    });

    const started = await f.service.start({ folder: '/work', harness: 'codex', login: 'team', by: 'owner' });
    if (!started.ok) throw new Error('start refused');
    await f.service.stop(started.value, 'now');
    expect((await f.service.resume(started.value)).ok).toBe(true);
    await f.service.stop(started.value, 'now');
    expect((await f.service.resume(started.value, 'carry on')).ok).toBe(true);

    expect(asked).toEqual([
      ['team', 'codex'],
      ['team', 'codex'],
      ['team', 'codex'],
    ]);
    expect(f.harness.launched.map(spec => spec.credential)).toEqual([first, second, third]);
  });

  test('16: a resume whose login has since become unavailable is refused, and nothing is launched', async () => {
    let answer: LoginCredentialAnswer = { kind: 'file', credential: CREDENTIAL };
    const f = fixture({ loginCredential: async () => answer });
    const started = await f.service.start({ folder: '/work', harness: 'codex', login: 'team', by: 'owner' });
    if (!started.ok) throw new Error('start refused');
    await f.service.stop(started.value, 'now');
    answer = { kind: 'unavailable', sentence: 'the login team needs signing in: The access token has expired.' };

    const resumed = await f.service.resume(started.value);

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.code).toBe('login_unavailable');
    expect(f.harness.launched).toHaveLength(1);
  });

  test('a none answer, a missing port and a ferret with no login add no credential, and the port is not asked without a login', async () => {
    const asked: [string, string][] = [];
    const none = fixture({ loginCredential: answering({ kind: 'none' }, asked) });
    const unbound = fixture({});

    await none.service.start({ folder: '/work', harness: 'codex', login: 'gw', by: 'owner' });
    await none.service.start({ folder: '/work', harness: 'codex', by: 'owner' });
    await unbound.service.start({ folder: '/work', harness: 'codex', login: 'gw', by: 'owner' });

    expect(asked).toEqual([['gw', 'codex']]);
    for (const spec of [...none.harness.launched, ...unbound.harness.launched])
      expect('credential' in spec).toBe(false);
  });

  test('17: a launch.parts taker cannot set a credential, and the part kinds have no field for one', () => {
    // @ts-expect-error a launch part has no `credential` member: only Ferrets sets LaunchSpec.credential, from the login.
    const forged: LaunchPart = { kind: 'env', env: {}, credential: CREDENTIAL };
    expect(forged.kind).toBe('env');
  });

  test('17: a credential smuggled into a part is never copied onto the spec', async () => {
    const smuggled = { kind: 'env', env: {}, credential: CREDENTIAL } as unknown as LaunchPart;
    const f = fixture({ parts: [smuggled] });

    await f.service.start({ folder: '/work', harness: 'codex', by: 'owner' });

    expect('credential' in (f.harness.launched[0] ?? {})).toBe(false);
  });
});
