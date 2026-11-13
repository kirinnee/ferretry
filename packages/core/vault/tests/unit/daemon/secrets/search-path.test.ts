import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { type ChildEnvironment, defineHook, type HandleCommandLookup } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon, type Needer, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { ChildEnvironmentPort, type SecretName, VaultPort } from '../../../../contract/index.ts';
import vault from '../../../../daemon/index.ts';
import { ChildEnvironments, namesSecret } from '../../../../daemon/lib/secrets/child-environments.ts';

/**
 * K18 / Q7 `searchPathOf`: the Vault hands the kernel a handle's PATH — ONLY its PATH — without spending it, only for
 * a handle minted for one of the readers the kernel names, and never a PATH built from a `${secret:…}` reference. A
 * planted variable that is not PATH, and a secret-derived value, never come back.
 */
const SECRET: SecretName = 'BIN_DIR_SECRET';
const SECRET_VALUE = 'planted-secret-folder-value';
const PLANTED = 'planted-non-path-value';

describe('K18 ChildEnvironments.searchPathOf (Q7)', () => {
  test('returns ONLY the PATH value: a planted non-PATH variable never comes back', () => {
    const environments = new ChildEnvironments();
    const handle = environments.mint(
      { PATH: '/plain/bin:/usr/bin', API_TOKEN: SECRET_VALUE, SHADOW_PATH: PLANTED, path: PLANTED, Path: PLANTED },
      { requester: 'ferrets' },
    );
    expect(environments.searchPathOf(handle, ['ferrets'])).toBe('/plain/bin:/usr/bin');
  });

  test('a handle that sets no PATH is undefined, however path-like its other variables are', () => {
    const environments = new ChildEnvironments();
    const handle = environments.mint(
      { SHADOW_PATH: PLANTED, path: '/lower/bin', HOME: '/home/x' },
      { requester: 'ferrets' },
    );
    expect(environments.searchPathOf(handle, ['ferrets'])).toBeUndefined();
  });

  test('looking does not spend the handle: open still yields every value after it, once', () => {
    const environments = new ChildEnvironments();
    const values = { PATH: '/plain/bin', TOKEN: SECRET_VALUE };
    const handle = environments.mint(values, { requester: 'ferrets' });
    expect(environments.searchPathOf(handle, ['ferrets'])).toBe('/plain/bin');
    expect(environments.searchPathOf(handle, ['ferrets'])).toBe('/plain/bin');
    expect(environments.open(handle)).toEqual(values);
    // Spent: neither opens nor answers a PATH any more.
    expect(environments.open(handle)).toBeUndefined();
    expect(environments.searchPathOf(handle, ['ferrets'])).toBeUndefined();
  });

  test('a handle for another requester, or for none, is unreadable; readers are matched exactly', () => {
    const environments = new ChildEnvironments();
    const theirs = environments.mint({ PATH: '/plain/bin' }, { requester: 'ferrets' });
    const nobodys = environments.mint({ PATH: '/plain/bin' });
    expect(environments.searchPathOf(theirs, ['terminals'])).toBeUndefined();
    expect(environments.searchPathOf(theirs, [])).toBeUndefined();
    expect(environments.searchPathOf(theirs, ['ferrets-2', 'ferret', '*'])).toBeUndefined();
    expect(environments.searchPathOf(nobodys, ['ferrets', 'terminals', 'kernel'])).toBeUndefined();
    expect(environments.searchPathOf(theirs, ['terminals', 'ferrets'])).toBe('/plain/bin');
    // Readers are a list from the kernel, never a string a substring check could match.
    expect(environments.searchPathOf(theirs, 'ferrets' as unknown as readonly string[])).toBeUndefined();
  });

  test('a secret-derived PATH is undefined (fails closed)', () => {
    const environments = new ChildEnvironments();
    const handle = environments.mint(
      { PATH: `/usr/bin:${SECRET_VALUE}` },
      { requester: 'ferrets', pathFromSecret: true },
    );
    expect(environments.searchPathOf(handle, ['ferrets'])).toBeUndefined();
  });

  test('a forged handle, a copy of a real one and a non-object are undefined', () => {
    const environments = new ChildEnvironments();
    const real = environments.mint({ PATH: '/plain/bin' }, { requester: 'ferrets' });
    const forged = Object.freeze({
      names: ['PATH'],
      toJSON: () => ({ names: ['PATH'] }),
    }) as unknown as ChildEnvironment;
    expect(environments.searchPathOf(forged, ['ferrets'])).toBeUndefined();
    expect(environments.searchPathOf({ ...real } as ChildEnvironment, ['ferrets'])).toBeUndefined();
    expect(environments.searchPathOf(null as unknown as ChildEnvironment, ['ferrets'])).toBeUndefined();
    expect(environments.searchPathOf('PATH' as unknown as ChildEnvironment, ['ferrets'])).toBeUndefined();
  });

  test('namesSecret: any reference spelling taints, a plain PATH does not', () => {
    expect(namesSecret(`/usr/bin:\${secret:${SECRET}}`)).toBe(true);
    expect(namesSecret(`\${secret?:${SECRET}}`)).toBe(true);
    expect(namesSecret(`\${secret:bad name}`)).toBe(true);
    expect(namesSecret('/usr/bin:/bin')).toBe(false);
    expect(namesSecret(undefined)).toBe(false);
    expect(namesSecret(7)).toBe(false);
  });
});

// Through the real Vault half and the kernel's whichFor ────────────────────────────────────────────────────────────

const Launch = defineHook('test.launch', { mode: 'observe' });
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

type Lookup = (name: string, env: ChildEnvironment) => Promise<HandleCommandLookup>;
type Mint = (env: Readonly<Record<string, string>>) => Promise<ChildEnvironment>;

const tenant = (
  id: string,
  seen: { lookups: Record<string, Lookup>; mints: Record<string, Mint> },
  options: { readonly offers?: true; readonly takes?: true; readonly permissions: Permissions },
) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { vault: VaultPort },
      permissions: options.permissions,
      ...(options.offers === true ? { hooks: { offers: [{ hook: Launch }] } } : {}),
      ...(options.takes === true ? { hooks: { takes: [{ hook: Launch }] } } : {}),
    }),
    {
      build: ({ needs, kernel }) => {
        seen.lookups[id] = async (name, env) => await kernel.paths.whichFor(name, env);
        seen.mints[id] = async env => {
          const minted = await needs.vault.childEnvironment('ferret_1' as never, env);
          if (!minted.ok) throw new Error(`refused: ${minted.error.unknown.join(', ')}`);
          return minted.value;
        };
        return options.takes === true ? { hooks: { 'test.launch': () => {} } } : {};
      },
    },
  );

async function world() {
  const seen = { lookups: {} as Record<string, Lookup>, mints: {} as Record<string, Mint> };
  const which: Permissions = { which: true, secrets: [SECRET] };
  const host = await testHost({
    plugins: [
      vault,
      tenant('launcher', seen, { offers: true, permissions: which }),
      tenant('runner', seen, { takes: true, permissions: which }),
      tenant('stranger', seen, { permissions: which }),
    ],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    executables: ['/handle/bin/claude', '/daemon/bin/claude'],
    searchPath: '/daemon/bin',
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  await host.provided(VaultPort).put(SECRET, SECRET_VALUE);
  const call = <T>(record: Record<string, T>, id: string): T => {
    const found = record[id];
    if (found === undefined) throw new Error(`${id} was not built`);
    return found;
  };
  return {
    host,
    mint: (id: string) => call(seen.mints, id),
    lookup: (id: string) => call(seen.lookups, id),
    opener: host.provided(ChildEnvironmentPort),
  };
}

describe('K18 the Vault records who a handle is for, and whether its PATH named a secret', () => {
  test('on the edge and self read the handle’s PATH; off the edge is unprovable; nothing is spent', async () => {
    const { mint, lookup, opener } = await world();
    const handle = await mint('launcher')({ PATH: '/handle/bin', TOKEN: `\${secret:${SECRET}}`, SHADOW_PATH: PLANTED });
    expect(await lookup('runner')('claude', handle)).toEqual({ kind: 'found', path: '/handle/bin/claude' });
    expect(await lookup('launcher')('claude', handle)).toEqual({ kind: 'found', path: '/handle/bin/claude' });
    expect(await lookup('stranger')('claude', handle)).toEqual({ kind: 'unprovable' });
    // Q7: what the Vault hands the kernel is the PATH alone — the planted variable and the secret value never.
    expect(opener.searchPathOf(handle, ['launcher'])).toBe('/handle/bin');
    // Still unspent: the child gets every value.
    expect(opener.open(handle)).toEqual({ PATH: '/handle/bin', TOKEN: SECRET_VALUE, SHADOW_PATH: PLANTED });
    expect(await lookup('runner')('claude', handle)).toEqual({ kind: 'unprovable' });
  });

  test('a PATH built from a secret reference is unprovable for every reader, and its value never comes back', async () => {
    const { mint, lookup, opener } = await world();
    const handle = await mint('launcher')({ PATH: `/handle/bin:\${secret:${SECRET}}` });
    expect(await lookup('runner')('claude', handle)).toEqual({ kind: 'unprovable' });
    expect(await lookup('launcher')('claude', handle)).toEqual({ kind: 'unprovable' });
    expect(opener.searchPathOf(handle, ['launcher', 'runner'])).toBeUndefined();
    const optional = await mint('launcher')({ PATH: `\${secret?:${SECRET}}` });
    expect(opener.searchPathOf(optional, ['launcher'])).toBeUndefined();
  });

  test('a handle that sets no PATH is unprovable, never answered from the daemon’s own PATH', async () => {
    const { mint, lookup } = await world();
    const handle = await mint('launcher')({ HOME: '/home/x', SHADOW_PATH: '/handle/bin' });
    expect(await lookup('runner')('claude', handle)).toEqual({ kind: 'unprovable' });
  });

  test('a core needer’s handle names that needer; the kernel’s own reads name the kernel', async () => {
    const { host, opener } = await world();
    const ferrets: Needer = { id: 'ferrets', permissions: {}, ownedSecretReferences: () => new Set() };
    const fromFerrets = await host
      .provided(VaultPort, ferrets)
      .childEnvironment('ferret_1' as never, { PATH: '/handle/bin' });
    const fromKernel = await host.provided(VaultPort).childEnvironment('ferret_1' as never, { PATH: '/handle/bin' });
    if (!fromFerrets.ok || !fromKernel.ok) throw new Error('expected handles');
    expect(opener.searchPathOf(fromFerrets.value, ['terminals', 'ferrets'])).toBe('/handle/bin');
    expect(opener.searchPathOf(fromFerrets.value, ['terminals'])).toBeUndefined();
    expect(opener.searchPathOf(fromKernel.value, ['ferrets'])).toBeUndefined();
    expect(opener.searchPathOf(fromKernel.value, ['kernel'])).toBe('/handle/bin');
  });
});
