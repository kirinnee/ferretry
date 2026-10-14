/**
 * Claude's macOS keychain path for a shared store — gap G1, a release gate for U3 (design §8.1.1).
 *
 * The Linux build compiles the keychain out, so everything the design says about it was INFERRED
 * from reading the bundle. On macOS the store is a keychain item, not a file, and its service name is
 * derived from `CLAUDE_SECURESTORAGE_CONFIG_DIR`:
 *
 * - set to a directory: `Claude Code-credentials-<first 8 hex of sha256(directory)>`;
 * - set to `""`: the BARE `Claude Code-credentials`, the item the person's own `claude` uses — which
 *   is why the `host` store must export `""` and never the absolute `~/.claude`.
 *
 * Each claim is measured by planting a fake item under the computed name and asking Claude, and the
 * write path by letting a refresh rotate one. One claim is about FERRETRY's reader rather than
 * Claude's: with a stale item of the same name under another `acct`, Ferretry's store reads the item
 * Claude reads — the read a web sign-in's post-check makes. It writes the login keychain, so it runs only on the CI
 * runner (see `support/keychain.ts`) and removes every item it planted.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  harnessKeychainAccount,
  PlatformFleetCredentialStore,
  SpawnCredentialCommand,
} from '../../src/adapters/credential-store.ts';
import { resolveCredentialStore } from '../../src/lib/account/credentials.ts';
import { CredentialSchema } from '../../src/lib/account/schema.ts';
import { claudeCredential, claudeTokenAnswer } from './support/fixtures.ts';
import { contract, harnessEnv, requireHarness, run, type Sandbox, sandbox, until } from './support/harness.ts';
import {
  BARE_SERVICE,
  keychainVisibleFrom,
  keychainWritable,
  plantKeychainItem,
  plantKeychainItemAs,
  readKeychainItem,
  refreshTokenIn,
  removeKeychainItem,
  removePlantedKeychainItems,
  serviceFor,
} from './support/keychain.ts';
import {
  makeTlsMaterial,
  type RecordingProxy,
  startProxy,
  startTokenEndpoint,
  type TokenEndpoint,
} from './support/network.ts';

const STORE_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
const TOKEN_HOST = 'platform.claude.com';
/**
 * The runner's REAL home, not a throwaway one. `security` finds the login keychain through the search
 * list kept under `~/Library`, so under a throwaway HOME no keychain is searched at all and every read
 * comes back empty — measured on the first macos-15 run, where even the bare item was invisible. This
 * suite runs only on the CI runner, and `CLAUDE_CONFIG_DIR` still keeps Claude's own files in the sandbox.
 */
const KEYCHAIN_HOME = process.env.HOME ?? '';

describe.skipIf(!(contract.enabled && keychainWritable))(
  'claude contract (macOS): the shared store is a keychain item named from the store dir',
  () => {
    let box: Sandbox;
    let proxy: RecordingProxy;
    let endpoint: TokenEndpoint;
    let caFile = '';
    const claude = () => requireHarness('claude');

    beforeAll(async () => {
      box = await sandbox('claude-keychain');
      const tls = await makeTlsMaterial(box.dir('tls'), [TOKEN_HOST]);
      caFile = tls.caFile;
      endpoint = startTokenEndpoint({ tls, issue: claudeTokenAnswer });
      proxy = startProxy({ [TOKEN_HOST]: endpoint.port });
      // Record what `security` can see from each HOME, so a red run says which one failed.
      const probe = 'fy-contract-visibility-probe';
      await mkdir(box.home, { recursive: true });
      await plantKeychainItem(probe, 'not-a-secret');
      const fromReal = await keychainVisibleFrom(KEYCHAIN_HOME, probe);
      const fromThrowaway = await keychainVisibleFrom(box.home, probe);
      console.log(`keychain probe: real HOME ${fromReal}; throwaway HOME ${fromThrowaway}`);
      await removeKeychainItem(probe);
    });
    afterAll(async () => {
      await removePlantedKeychainItems();
      proxy.stop();
      endpoint.stop();
      await box.dispose();
    });

    const world = async (name: string) => {
      const root = box.dir(name);
      const store = path.join(root, 'store');
      for (const directory of ['store', 'config', 'home']) await mkdir(path.join(root, directory), { recursive: true });
      const env = (storeValue: string) =>
        harnessEnv(KEYCHAIN_HOME, proxy.port, {
          CLAUDE_CONFIG_DIR: path.join(root, 'config'),
          [STORE_VARIABLE]: storeValue,
          NODE_EXTRA_CA_CERTS: caFile,
        });
      return { root, store, env };
    };
    const loggedIn = async (env: Record<string, string>): Promise<boolean | undefined> => {
      const ran = await run([claude().bin, 'auth', 'status', '--json'], { env });
      try {
        return (JSON.parse(ran.stdout) as { loggedIn?: boolean }).loggedIn;
      } catch {
        throw new Error(`claude auth status said: ${ran.stdout}${ran.stderr}`.slice(0, 600));
      }
    };
    const filesUnder = async (root: string): Promise<string[]> =>
      (await readdir(root, { recursive: true }))
        .map(String)
        .filter(entry => path.basename(entry) === '.credentials.json');

    it('reads the item named from the store directory, and writes no credential file', async () => {
      const w = await world('hashed');
      await plantKeychainItem(serviceFor(w.store), claudeCredential({ expired: false }));
      should(await loggedIn(w.env(w.store))).equal(true, `claude did not read keychain item "${serviceFor(w.store)}"`);
      should(await filesUnder(w.root)).be.empty();
    });

    it('does not read that item for a different store directory (the control)', async () => {
      const w = await world('other');
      should(await loggedIn(w.env(w.store))).equal(false);
    });

    it(`reads the bare "${BARE_SERVICE}" item when ${STORE_VARIABLE} is ""`, async () => {
      const w = await world('bare');
      await plantKeychainItem(BARE_SERVICE, claudeCredential({ expired: false }));
      try {
        should(await loggedIn(w.env(''))).equal(true, 'an empty store variable did not select the bare keychain item');
      } finally {
        await removeKeychainItem(BARE_SERVICE);
      }
    });

    it("reads the person's own login by Claude's acct, past a stale item of the same name", async () => {
      // A Mac that ran an older Ferretry holds a second bare item under another `acct`. It is planted
      // FIRST, so a read by service name alone meets it before the one Claude wrote under $USER.
      const w = await world('stale-sibling');
      const stale = 'fy-contract-stale-acct';
      const dead = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } });
      await plantKeychainItemAs(stale, BARE_SERVICE, dead);
      await plantKeychainItem(BARE_SERVICE, claudeCredential({ expired: false }));
      try {
        should(await loggedIn(w.env(''))).equal(true, 'claude did not read its own item under $USER');
        const store = new PlatformFleetCredentialStore({
          platform: process.platform,
          command: new SpawnCredentialCommand(),
          now: () => Date.now(),
          keychainAccount: harnessKeychainAccount([process.env.USER]),
        });
        const resolution = resolveCredentialStore(
          'claude-you',
          CredentialSchema.parse({ harness: 'claude', store: 'host' }),
          { fleetRoot: path.join(w.root, 'fleet'), userHome: path.join(w.root, 'home') },
        );
        if (resolution.store === 'environment' || 'unavailable' in resolution) throw new Error('fixture');
        should((await store.readStored(resolution)).state).equal(
          'valid',
          'Ferretry read a different item than the one Claude reads',
        );
      } finally {
        await removeKeychainItem(BARE_SERVICE);
        await removeKeychainItem(BARE_SERVICE, stale);
      }
    });

    it('writes a refreshed token back into the same named item', async () => {
      const w = await world('write');
      const service = serviceFor(w.store);
      await plantKeychainItem(service, claudeCredential({ expired: true }));
      const child = Bun.spawn([claude().bin, 'mcp', 'list'], {
        env: w.env(w.store),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await until(async () => refreshTokenIn(await readKeychainItem(service)) === endpoint.lastIssued(), 30_000, 500);
      child.kill('SIGKILL');
      await child.exited;
      should(endpoint.presented.length).be.above(0, 'the expired keychain credential never triggered a refresh');
      should(refreshTokenIn(await readKeychainItem(service))).equal(endpoint.lastIssued());
      should(await filesUnder(w.root)).be.empty();
    });
  },
);
