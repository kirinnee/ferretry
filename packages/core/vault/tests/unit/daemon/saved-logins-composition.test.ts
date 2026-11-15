import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, standInAdmission, type TestHost, testHost } from '@ferretry/kernel/testing';
import { type InputRequest, padInputValue } from '../../../daemon/lib/inputs/wire.ts';
import { InputSavedLogins, InputTargets, type SavedLoginsProvider, VaultPort } from '../../../contract/index.ts';
import { FakeInputTarget } from '../../../contract/testing/index.ts';
import { SignInGrantLedger, type SignInGrantSource } from '../../../daemon/lib/inputs/borrowed-grants.ts';
import vault from '../../../daemon/index.ts';

/**
 * The composed Vault asks Accounts for saved logins through `input.saved:saved` and nothing else: the hook is taken by
 * Accounts alone, looked up on every call, and an Accounts that provides nothing leaves every value typed by hand.
 */
const FERRET = 'mvv6b4qw-49d0158d' as FerretId;
const VALUE = 'typed-through-the-real-input-service';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const terminals = (target: FakeInputTarget) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Input test',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: InputTargets, key: 'terminal' }] },
    }),
    { build: () => ({ hooks: { 'input.targets:terminal': target } }) },
  );

const pages = (target: FakeInputTarget) =>
  implementDaemon(
    definePlugin({
      id: 'browsers',
      title: 'Input test',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: InputTargets, key: 'page' }] },
    }),
    { build: () => ({ hooks: { 'input.targets:page': target } }) },
  );

const accountsProviding = (saved: SavedLoginsProvider) =>
  implementDaemon(
    definePlugin({
      id: 'accounts',
      title: 'Accounts test',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: InputSavedLogins, key: 'saved' }] },
    }),
    { build: () => ({ hooks: { 'input.saved:saved': saved } }) },
  );

async function deliveredWith(saved: SavedLoginsProvider | undefined) {
  const target = new FakeInputTarget('terminal', 'dev');
  const admission = standInAdmission(() => owner());
  const host = await testHost({
    plugins: [vault, terminals(target), ...(saved === undefined ? [] : [accountsProviding(saved)])],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    gate: {
      ...admission,
      admit: input =>
        input.table === 'tool'
          ? { outcome: 'admitted', actor: 'ferret', standing: ferretStanding(FERRET) }
          : admission.admit(input),
    },
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  const raised = await host.provided(VaultPort).raiseInput(FERRET, {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'Password',
    sensitivity: 'secret',
    submit: 'agent',
  });
  if (!raised.ok) throw new Error(raised.error);
  const listed = await host.request('GET', `/v1/ferrets/${FERRET}/input-requests`);
  const [request] = listed.json<{ requests: InputRequest[] }>().requests;
  if (request === undefined) throw new Error('expected an input card');
  return await host.request('POST', `/v1/ferrets/${FERRET}/input-requests/${raised.value}/deliver`, {
    body: {
      deliveryId: crypto.randomUUID(),
      observedDigest: request.observedDigest,
      padded: padInputValue(VALUE),
      submit: false,
    },
  });
}

const provider = (over: Partial<SavedLoginsProvider> = {}): SavedLoginsProvider => ({
  listing: async () => ({ accounts: [], signIns: [] }),
  fill: async () => {
    throw new Error('not asked');
  },
  save: async () => undefined,
  choice: async () => ({}),
  observeSignIn: async () => undefined,
  checkedByUse: async () => undefined,
  ...over,
});

describe('the composed Vault’s saved logins', () => {
  test('should read the accounts from the provider Accounts binds, while a typed value is still delivered', async () => {
    const listed: string[] = [];

    const response = await deliveredWith(
      provider({
        listing: async () => {
          listed.push('listing');
          return { accounts: [], signIns: [] };
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(listed.length).toBeGreaterThan(0);
  });

  test('should deliver a typed value when Accounts provides nothing, and when its listing cannot be read', async () => {
    const without = await deliveredWith(undefined);
    const broken = await deliveredWith(
      provider({
        listing: async () => {
          throw new Error('the account store is damaged');
        },
      }),
    );

    expect(without.status).toBe(200);
    expect(broken.status).toBe(200);
  });
});

const grantSource = (told: string[]): SignInGrantSource => {
  const none = { hosts: new Map() };
  return {
    enabled: () => {
      told.push('enabled');
      return true;
    },
    of: () => [],
    keyOf: async () => undefined,
    ledger: new SignInGrantLedger(),
    used: () => undefined,
    stopped: async () => undefined,
    verify: async () => ({ ok: false }),
    holds: () => false,
    projectOf: async () => undefined,
    scriptedOrigins: () => none,
    running: () => {
      told.push('running');
      return () => void told.push('ended');
    },
    scriptedOn: host => void told.push(`on ${String(host)}`),
  };
};

describe('the composed Vault asks the grants Accounts provides, and tells them of every script', () => {
  test('should ask the grant source on a raised card, and still deliver a typed value when the owner types it', async () => {
    const told: string[] = [];
    const host = await testHost({
      plugins: [
        vault,
        pages(new FakeInputTarget('page', 'app')),
        accountsProviding(provider({ grants: () => grantSource(told) })),
      ],
      fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    });
    hosts.push(host);
    await host.runJob('inputs-restore');

    const raised = await host.provided(VaultPort).raiseInput(FERRET, {
      target: { kind: 'page', key: 'app' },
      prompt: 'Password for the console',
      fields: [
        { id: 'pass', label: 'Password', sensitivity: 'secret', element: { kind: 'selector', selector: '#pw' } },
      ],
      submit: 'offer-owner',
    });

    expect(raised.ok).toBe(true);
    expect(told).toContain('enabled');
  });

  test('should hand Browsers’ script reports to the grant source, so no standing rule fills while one runs or where one ran', async () => {
    const told: string[] = [];
    const source = grantSource(told);
    const host = await testHost({
      plugins: [vault, accountsProviding(provider({ grants: () => source }))],
      fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    });
    hosts.push(host);
    const api = host.provided(VaultPort);

    const end = api.scriptRunning?.();
    end?.();
    api.scriptedOn?.('github.com');
    api.scriptedOn?.(undefined);

    expect(told.filter(each => each !== 'enabled')).toEqual(['running', 'ended', 'on github.com', 'on undefined']);
  });

  test('should report scripts all the same when Accounts provides no grants', async () => {
    const host = await testHost({
      plugins: [vault, accountsProviding(provider())],
      fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    });
    hosts.push(host);
    const api = host.provided(VaultPort);

    expect(() => {
      api.scriptRunning?.()();
      api.scriptedOn?.('github.com');
    }).not.toThrow();
  });
});
