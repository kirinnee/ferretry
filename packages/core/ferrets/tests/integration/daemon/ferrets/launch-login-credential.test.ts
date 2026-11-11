import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { SharedCredential } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { Harnesses, Logins, type LoginCredentialAnswer, type LoginKind, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeLoginKind, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * The daemon half of Ferrets, booted whole, binds `FerretsPorts.loginCredential` to the `logins:<kind>` provider that
 * HOLDS the login (the same resolver the login environment uses): a file answer reaches the harness as
 * `spec.credential`, an unavailable one refuses the start before any pane, a kind with no credential adds none, and a
 * hook that throws is a fixed sentence. The provider is a stand-in with the real hook shape; the real `logins:openai`
 * credential() is covered where it lives, in the Logins package. Fake values only.
 */

const CREDENTIAL = Object.freeze(Object.create(null)) as SharedCredential;
const SENTENCE = 'the login lapsed is not signed in; sign it in from Logins and start the ferret again';

/** A Codex-spendable kind holding exactly the logins given, each with what its `credential()` answers. */
class FileKind extends FakeLoginKind implements LoginKind {
  readonly asked: [string, string][] = [];
  constructor(
    key: ConstructorParameters<typeof FakeLoginKind>[0],
    private readonly answers: Readonly<Record<string, LoginCredentialAnswer | 'throws'>>,
  ) {
    super(key, Object.keys(answers));
  }
  override readonly harnesses = ['codex'] as never;
  /** A sign-in file adds no environment: the credential is the only thing this login brings. */
  override async env() {
    return {};
  }
  override readonly credential = async (login: string, harness: string): Promise<LoginCredentialAnswer> => {
    this.asked.push([login, harness]);
    const found = this.answers[login];
    if (found === 'throws' || found === undefined) throw new Error('ENOENT /home/someone/.codex/auth.json sk-secret');
    return found;
  };
}

/** A kind with no sign-in file and no environment: it has no `credential` member at all. */
class PlainKind extends FakeLoginKind {
  override async env() {
    return {};
  }
}

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'codex',
      title: 'Codex (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'codex' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:codex': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
const loginsPlugin = (openai: LoginKind, endpoint: LoginKind) =>
  implementDaemon(
    definePlugin({
      id: 'logins',
      title: 'Logins (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: {
        takes: [
          { hook: Logins, key: 'openai' },
          { hook: Logins, key: 'endpoint' },
        ],
      },
    }),
    { build: () => ({ hooks: { 'logins:openai': openai, 'logins:endpoint': endpoint } }) },
  );

async function boot() {
  const harness = new FakeHarness('codex');
  const openai = new FileKind('openai', {
    team: { kind: 'file', credential: CREDENTIAL },
    lapsed: { kind: 'unavailable', sentence: SENTENCE },
    broken: 'throws',
  });
  const endpoint = new PlainKind('endpoint', ['gw']);
  const host: TestHost = await testHost({
    plugins: [ferrets, harnessPlugin(harness), runnerPlugin(new FakeRunner()), loginsPlugin(openai, endpoint)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  return { host, harness, openai };
}

const start = async (host: TestHost, login?: string) =>
  await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Work.', harness: 'codex', ...(login === undefined ? {} : { login }) },
  });

describe('a Codex ferret on a login with a sign-in file', () => {
  test('a signed-in login reaches the harness as spec.credential, asked as the ferret’s own harness', async () => {
    const { host, harness, openai } = await boot();

    const started = await start(host, 'team');
    await host.settle();

    expect(started.status).toBeLessThan(300);
    expect(openai.asked).toEqual([['team', 'codex']]);
    expect(harness.prepared[0]?.credential).toBe(CREDENTIAL);
    expect(harness.launched[0]?.credential).toBe(CREDENTIAL);
  });

  test('a login with no usable sign-in refuses the start with the sentence and launches no pane', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'lapsed');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain(SENTENCE);
    expect(started.body).toContain('login_unavailable');
    expect(harness.prepared).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
  });

  test('a hook that throws is a fixed sentence that quotes nothing it threw', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'broken');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain('the login broken could not be checked, so the ferret was not started');
    expect(started.body).not.toContain('sk-secret');
    expect(started.body).not.toContain('/home/someone');
    expect(harness.launched).toHaveLength(0);
  });

  test('a kind with no credential adds none, and a start with no login never asks', async () => {
    const { host, harness, openai } = await boot();

    expect((await start(host, 'gw')).status).toBeLessThan(300);
    expect((await start(host)).status).toBeLessThan(300);
    await host.settle();

    expect(openai.asked).toEqual([]);
    for (const spec of harness.launched) expect('credential' in spec).toBe(false);
  });
});
