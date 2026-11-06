/**
 * A WORLD OF TWO MACHINES over real files, for the suites that prove a copy never touches a signed-in login (design
 * §14.4): a SOURCE that is signed in and holds keys, and a TARGET that is signed in as the same account, holds its own
 * keys, an account with its sign-in, 2FA keys, sealed seeds and a passkey (`account-stores-fixture.ts`), a host
 * sign-in and an account default.
 *
 * Each machine is the daemon's own services on real files in a temporary directory: the real provisioner, the real
 * catalogue and setup services, the real configuration service and a real secret directory (a fake cipher and an
 * in-memory document, so its timestamps and sealed entries are the daemon's own). Every credential, key, address
 * and token in it is invented; no real home, login or network is read or written.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FleetCloneBundleSchema, secretReferencesIn } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import { fileFleetCatalogDeps, readDeclaredAccountModel } from '../../../src/adapters/fleet/account-model-files.ts';
import { cloneConfigFilesOver, fileFleetSetupDeps } from '../../../src/adapters/fleet/setup-files.ts';
import { FleetCatalogService } from '../../../src/lib/fleet/catalog-service.ts';
import { FleetPublication } from '../../../src/lib/fleet/publication.ts';
import { createFleetSetupSubsystem, type FleetSetupService } from '../../../src/lib/fleet/setup-service.ts';
import { SecretDirectory } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemorySecretDocuments } from '../../unit/runtime/mounts/support.ts';
import { accountStoreBytes, seedAccountStores } from './account-stores-fixture.ts';
import { type ConfigHome, configHome } from './config-files-fixture.ts';

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-clone-world-')));
  directories.push(directory);
  return directory;
}

/** Removes every directory a machine was built in; a suite calls it from its own `afterEach`. */
export async function removeTemporary(): Promise<void> {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
}

/** A placeholder Claude login: shaped like one, worth nothing. */
export const FAKE_LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'placeholder-access',
    refreshToken: 'placeholder-refresh',
    expiresAt: 4_102_444_800_000,
  },
});
export const FAKE_SECRET = 'ghp_placeholderplaceholderplaceholder0000';
/** A placeholder Codex login: shaped like one, worth nothing. */
export const FAKE_CODEX_LOGIN = JSON.stringify({ tokens: { access_token: 'placeholder-codex-access' } });

export interface Machine {
  readonly home: ConfigHome;
  readonly fleet: string;
  readonly userHome: string;
  readonly setup: FleetSetupService;
  readonly catalog: FleetCatalogService;
  readonly secrets: Map<string, string>;
}

export async function machine(
  name: string,
  options: {
    readonly claude: boolean;
    readonly emails?: Readonly<Record<string, string>>;
    /** A real secret directory (names, timestamps and all) in place of the plain map, when a test needs one. */
    readonly vault?: SecretDirectory;
  },
): Promise<Machine> {
  const root = await temporary();
  const home = await configHome(path.join(root, 'state'));
  const fleet = home.paths.fleet;
  const userHome = path.join(root, 'person');
  await mkdir(userHome, { recursive: true });
  if (options.claude) {
    const claude = path.join(userHome, '.claude');
    await mkdir(path.join(claude, 'skills', 'review'), { recursive: true });
    await writeFile(path.join(claude, 'CLAUDE.md'), 'Be kind.\n');
    await writeFile(path.join(claude, 'settings.json'), JSON.stringify({ env: { GITHUB_TOKEN: FAKE_SECRET } }));
    await writeFile(path.join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview it.\n');
    await writeFile(path.join(claude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
  }
  const secrets = new Map<string, string>();
  const credentials = {
    list: async () => ({
      format: 2 as const,
      machine: name,
      credentials: Object.entries(options.emails ?? {}).map(([id, email]) => ({ id, email })) as never,
    }),
    signOut: async () => {
      throw new Error('not exercised');
    },
  };
  const catalogDeps = fileFleetCatalogDeps({
    paths: home.paths,
    userHome,
    config: home.service,
    configDirectory: home.paths.config,
    sessionStatuses: async () => [],
    credentials,
    locate: harness => (harness === 'claude' && options.claude ? '/bin/sh' : undefined),
    machineName: () => name,
    clientName: 'fy',
    publication: new FleetPublication(),
  });
  const setup = createFleetSetupSubsystem(
    fileFleetSetupDeps({
      catalog: catalogDeps,
      configFiles: cloneConfigFilesOver(home.service),
      daemonId: () => 'daemon-source',
      credentials: {
        material: async () => ({ outcome: 'missing' }),
        storedMaterial: async () => (options.claude ? { outcome: 'found', blob: FAKE_LOGIN } : { outcome: 'missing' }),
      } as never,
      tools: { plans: () => [], install: async () => [] },
      secrets: {
        list: async () =>
          options.vault === undefined
            ? [...secrets.keys()].map(secret => ({
                name: secret,
                createdAt: '2026-11-01T00:00:00.000Z',
                updatedAt: '2026-11-01T00:00:00.000Z',
              }))
            : await options.vault.list(),
        put: async (secret, value) => {
          if (options.vault === undefined) secrets.set(secret, value);
          else await options.vault.put(secret as never, value);
        },
      },
    }),
  );
  const catalog = new FleetCatalogService({ ...catalogDeps, executors: setup.executors });
  return { home, fleet, userHome, setup, catalog, secrets };
}

/** The import a person chooses, staged and applied through the catalogue the way the app and `fy daemon import` do it. */
export async function importHost(on: Awaited<ReturnType<typeof machine>>): Promise<unknown> {
  const staged = await on.catalog.propose({ kind: 'setup.import' });
  return await on.catalog.apply(staged.id, { governed: false } as never);
}

/** The model the machine's configuration files declare now. */
export async function declared(on: Machine) {
  const model = await readDeclaredAccountModel(on.home.service, {
    configDirectory: on.home.paths.config,
    fleetDirectory: on.fleet,
  });
  should(model).not.be.undefined();
  return model as NonNullable<typeof model>;
}

/** Every file under a directory, relative to it. */
export async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, next)));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

// ── The two machines of a re-copy ──

export const crypto_ = new WebCryptoRelayCrypto();
export const HELD = 'HELD_KEY';
export const OTHER_HELD = 'OTHER_HELD_KEY';
export const MISSING = 'MISSING_KEY';
const DEFAULTS = 'sites:\n  app.clickup.com: CLICKUP_A\n';
const EMAIL = 'kirin@example.test';

export interface Vault {
  readonly documents: MemorySecretDocuments;
  readonly directory: SecretDirectory;
}

/** A secret directory whose clock moves a minute with every write, so a rewrite shows in `updatedAt`. */
const vaultAt = (start: string): Vault => {
  let at = Date.parse(start);
  const documents = new MemorySecretDocuments();
  return {
    documents,
    directory: new SecretDirectory(documents, new FakeSecretCipher(), {
      now: () => {
        at += 60_000;
        return new Date(at).toISOString();
      },
    }),
  };
};

export async function identity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

export const applyChange = async (on: Machine, change: unknown) => {
  const staged = await on.catalog.propose(change as never);
  return await on.catalog.apply(staged.id, { governed: false } as never);
};

/** A source that is signed in as `kirin@example.test`, with a second runtime when asked, and its secrets. */
export async function sourceMachine(extraRuntime: boolean): Promise<{ source: Machine; vault: Vault }> {
  const vault = vaultAt('2026-09-01T09:00:00.000Z');
  const source = await machine('studio', { claude: true, emails: { 'claude-you': EMAIL } });
  await importHost(source);
  if (extraRuntime) {
    // A second runtime needs a profile of its own: the catalog refuses one more on the same login and profile.
    const layers = (await declared(source)).profiles['claude-default']?.layers;
    if (layers === undefined) throw new Error('expected the imported profile');
    await applyChange(source, { kind: 'profile.put', name: 'claude-extra', layers: [...layers], create: true });
    await applyChange(source, {
      kind: 'runtime.put',
      name: 'claude-extra',
      credential: 'claude-you',
      profile: 'claude-extra',
      agent: true,
      create: true,
    });
  }
  // A setting of the source names both keys the copy decides on: one the target lacks and one it already holds.
  await applyChange(source, {
    kind: 'component.put',
    name: 'notes',
    component: {
      kind: 'mcp',
      command: 'npx',
      args: ['-y', 'notes'],
      env: { NOTES_API_KEY: `\${secret:${MISSING}}`, NOTES_TEAM_KEY: `\${secret:${HELD}}` },
    },
    create: true,
  });
  // The source holds the held key under ANOTHER value, and a key the target lacks.
  await vault.directory.put(HELD as never, 'source-value-for-the-held-key');
  await vault.directory.put(MISSING as never, 'source-value-for-the-missing-key');
  return { source, vault };
}

/**
 * A target that is signed in as the same account (twice, when asked), holds secrets, an environment login that
 * refers to one by `${secret:NAME}`, an account with its sign-in, 2FA keys, sealed seeds and a passkey (the real
 * stores), a host sign-in and an account default.
 */
export async function signedInMachine(name: string, twoLogins: boolean): Promise<{ target: Machine; vault: Vault }> {
  const vault = vaultAt('2026-10-01T09:00:00.000Z');
  await vault.directory.put(HELD as never, 'target-value-for-the-held-key');
  await vault.directory.put(OTHER_HELD as never, 'target-value-for-the-other-key');
  const logins = ['claude-kirin', ...(twoLogins ? ['claude-kirin-2'] : [])];
  const target = await machine(name, {
    claude: false,
    emails: { ...Object.fromEntries(logins.map(id => [id, EMAIL])), 'codex-kirin': 'codex@example.test' },
    vault: vault.directory,
  });
  const steps = [
    ...logins.map(id => ({ kind: 'credential.add', id, harness: 'claude' })),
    { kind: 'credential.add', id: 'codex-kirin', harness: 'codex' },
    {
      kind: 'component.put',
      name: 'house',
      component: { kind: 'instructions' },
      content: 'Be kind.\n',
      create: true,
    },
    { kind: 'profile.put', name: 'plain', layers: ['instructions/house'], create: true },
    { kind: 'runtime.put', name: 'mine', credential: 'claude-kirin', profile: 'plain', agent: true, create: true },
    {
      kind: 'credential.add',
      id: 'keyed',
      harness: 'claude',
      store: 'environment',
      env: { ANTHROPIC_API_KEY: `\${secret:${HELD}}` },
    },
  ];
  for (const step of steps) await applyChange(target, step);
  for (const [id, file, token] of [
    ...logins.map(id => [id, '.credentials.json', FAKE_LOGIN] as const),
    ['codex-kirin', 'auth.json', FAKE_CODEX_LOGIN] as const,
  ]) {
    const store = path.join(target.fleet, 'credentials', id);
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, file), token, { mode: 0o600 });
  }
  await seedAccountStores(target.home.paths);
  const claude = path.join(target.userHome, '.claude');
  await mkdir(claude, { recursive: true });
  await writeFile(path.join(claude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
  await writeFile(path.join(target.home.paths.config, 'account-defaults.yaml'), DEFAULTS, { mode: 0o600 });
  return { target, vault };
}

export const exportedBundle = async (source: Machine) =>
  FleetCloneBundleSchema.parse(await source.setup.exportBundle());

/**
 * The keys a copy of `bundle` may bring: every key its setup names (`${secret:NAME}` anywhere in its components, the
 * way the app reads them) that the source holds and this machine does not. A key already held is never offered.
 */
export const keysTheCopyNeeds = (
  bundle: Awaited<ReturnType<typeof exportedBundle>>,
  sourceHolds: readonly string[],
  targetHolds: readonly string[],
): readonly string[] =>
  [...new Set(secretReferencesIn(JSON.stringify(bundle.components)))].filter(
    name => sourceHolds.includes(name) && !targetHolds.includes(name),
  );

/**
 * Everything a signed-in login and its secrets are, as raw bytes: every sign-in file, every secret value,
 * and every login declaration (one holds a `${secret:NAME}` reference). Nothing is parsed,
 * so a re-rendered file counts as a change.
 */
export async function credentialBytes(on: Machine): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  const sign = path.join(on.fleet, 'credentials');
  for (const file of await filesUnder(sign))
    bytes[`credentials/${file}`] = (await readFile(path.join(sign, file))).toString('hex');
  for (const [name, value] of on.secrets) bytes[`secret:${name}`] = value;
  const config = on.home.paths.config;
  for (const file of await filesUnder(config)) {
    const raw = (await readFile(path.join(config, file))).toString('hex');
    if (file.startsWith('logins/')) bytes[`config/${file}`] = raw;
  }
  return bytes;
}

/** The files that were there before must read back the same; a copy may ADD files, never change one. */
export const unchanged = (before: Record<string, string>, after: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(before).map(key => [key, after[key] as string]));

/**
 * Every byte a sign-in, an account with its 2FA keys, their sealed seeds, a passkey, a secret entry (value,
 * timestamps) and an account default is.
 */
export async function heldBytes(on: Machine, vault: Vault): Promise<Record<string, string>> {
  const bytes = { ...(await credentialBytes(on)), ...(await accountStoreBytes(on.home.paths)) };
  const hex = async (file: string): Promise<string> => (await readFile(file)).toString('hex');
  bytes['host/.claude/.credentials.json'] = await hex(path.join(on.userHome, '.claude', '.credentials.json'));
  bytes['config/account-defaults.yaml'] = await hex(path.join(on.home.paths.config, 'account-defaults.yaml'));
  const document = await vault.documents.read();
  for (const name of [HELD, OTHER_HELD]) bytes[`vault/${name}`] = JSON.stringify(document?.entries[name]);
  return bytes;
}
