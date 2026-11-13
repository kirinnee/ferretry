/**
 * Codex's credential sharing, measured against a real `codex` (ported from v4's `fleet/tests/contract/codex-credential-link.test.ts`,
 * design: docs/design/redesign.md, shared credentials; docs/secrets.md).
 *
 * Logins keeps ONE canonical `auth.json` per login and the KERNEL links it into every ferret's `CODEX_HOME`
 * (`RootsPort.shareCredential` -> `RootHandle.linkCredential`; the links below are made by those two real calls on a
 * temporary FY_HOME, never by `symlink`). That is safe only while these stay true, and this is where a Codex release that
 * breaks one is caught:
 *
 * 1. A refresh rewrites `auth.json` IN PLACE, so the link still points at the canonical file, and a second ferret reading
 *    through its own link sees the rotated token without spending its own.
 * 2. `cli_auth_credentials_store = "file"` keeps the credential out of the keyring, where no link could follow it. On
 *    Linux a keyring call is a D-Bus connection, so a fake bus can count it; `keyring` is the control that proves the bus
 *    is watched.
 * 3. `codex logout` in one ferret removes that ferret's link and nothing else.
 * 4. (U3) The refresh is written by Codex's own process, so the sandbox of the commands it runs does not block it: the
 *    renewal still lands with `sandbox_mode="workspace-write"` and a working folder outside the store.
 *
 * Opt-in: `FY_HARNESS_CONTRACT=1` (only `run.sh` sets it, after resolving `codex` into `FY_CONTRACT_CODEX_BIN`; a binary
 * on PATH works too, with `run.sh path`). Every other run sees a skipped suite. Fake tokens, loopback only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import { ensureInternalRootBases, nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import {
  CODEX_CREDENTIAL_STORE_FILE,
  CODEX_CREDENTIAL_STORE_KEY,
} from '../../../daemon/lib/credentials/credentials.ts';
import { codexTokenAnswer, readCodexAuth, startAppServer, writeCodexAuth } from './support/fixtures.ts';
import {
  contract,
  harnessEnv,
  reap,
  requireCodex,
  run,
  type Sandbox,
  sandbox,
  treeContains,
} from './support/harness.ts';
import {
  type RecordingProxy,
  startFakeBus,
  startProxy,
  startTokenEndpoint,
  type TokenEndpoint,
} from './support/network.ts';

const OVERRIDE_VARIABLE = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
/** The argument production passes on every launch and every renewal. */
const FILE_STORE = ['-c', `${CODEX_CREDENTIAL_STORE_KEY}="${CODEX_CREDENTIAL_STORE_FILE}"`];

describe.skipIf(!contract.enabled)(
  'codex contract: one canonical auth.json linked into many ferret homes by the kernel',
  () => {
    let box: Sandbox;
    let proxy: RecordingProxy;
    let endpoint: TokenEndpoint;
    let counter = 0;
    const codex = () => requireCodex();

    beforeAll(async () => {
      box = await sandbox('codex-link');
      proxy = startProxy();
      endpoint = startTokenEndpoint({ issue: codexTokenAnswer });
    });
    afterAll(async () => {
      await reap(box.root);
      endpoint.stop();
      proxy.stop();
      await box.dispose();
    });

    /** A canonical credential under a temp FY_HOME and `homes` ferret homes the real kernel links it into. */
    const world = async (options: { expired: boolean; homes: string[]; store?: string; link?: boolean }) => {
      counter++;
      const fyHome = box.dir(`fy-home-${counter}`);
      const canonical = path.join(fyHome, 'state/logins/credentials/work/auth.json');
      await mkdir(path.dirname(canonical), { recursive: true, mode: 0o700 });
      await writeCodexAuth(canonical, options);
      const fs = nodeFs(() => crypto.randomUUID());
      await ensureInternalRootBases(fs, { home: fyHome, plugin: 'codex' }, ['agent-homes']);
      const layout = (plugin: string) => ({ home: fyHome, plugin, worktrees: `${fyHome}-worktrees` });
      const logins: RootsPort = rootsPortFor(fs, layout('logins'), ['credentials'], () => undefined, {
        shareCredentials: ['auth.json'],
        privateFiles: ['state/logins/credentials'],
        onStop: () => {},
      });
      const receiver: RootsPort = rootsPortFor(fs, layout('codex'), ['agent-homes'], () => undefined);
      const homes = path.join(fyHome, 'state/codex/agent-homes');
      for (const runtime of options.homes) {
        const home = receiver.root('agent-homes', { subfolder: runtime });
        await mkdir(path.join(homes, runtime), { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(homes, runtime, 'config.toml'),
          `${CODEX_CREDENTIAL_STORE_KEY} = "${options.store ?? CODEX_CREDENTIAL_STORE_FILE}"\n`,
        );
        if (options.link !== false) {
          const at = home.resolve('auth.json');
          if (!at.ok) throw new Error(at.error);
          await home.linkCredential(
            await logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }),
            at.value,
          );
        }
      }
      const env = (runtime: string, extra: Record<string, string> = {}) =>
        harnessEnv(path.join(fyHome, 'home'), proxy.port, {
          CODEX_HOME: path.join(homes, runtime),
          [OVERRIDE_VARIABLE]: endpoint.url,
          ...extra,
        });
      return { fyHome, canonical, home: (runtime: string) => path.join(homes, runtime), env };
    };

    it(`still contains ${OVERRIDE_VARIABLE} and ${CODEX_CREDENTIAL_STORE_KEY} (a rename fails here, by name)`, async () => {
      expect(await treeContains(codex().root, OVERRIDE_VARIABLE)).toBe(true);
      expect(await treeContains(codex().root, CODEX_CREDENTIAL_STORE_KEY)).toBe(true);
    });

    it('rewrites auth.json in place through the link, and a second home reads the rotated token without refreshing', async () => {
      const w = await world({ expired: true, homes: ['a', 'b'] });
      const before = endpoint.presented.length;
      const first = await startAppServer(codex().bin, { env: w.env('a'), cwd: w.fyHome, flags: FILE_STORE });
      try {
        expect(await first.request('getAuthStatus', { includeToken: false, refreshToken: true })).toHaveProperty(
          'result',
        );
      } finally {
        await first.stop();
      }
      expect(endpoint.presented.length).toBeGreaterThan(before);
      expect(endpoint.presented[before]).toBe('rt-FAKE');
      for (const runtime of ['a', 'b']) {
        const link = path.join(w.home(runtime), 'auth.json');
        // the refresh replaced the link instead of writing through it if this fails
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(await realpath(w.canonical));
      }
      const rotated = await readCodexAuth(w.canonical);
      expect(rotated.tokens.refresh_token).toBe(endpoint.lastIssued() as string);

      const spent = endpoint.presented.length;
      const second = await startAppServer(codex().bin, { env: w.env('b'), cwd: w.fyHome, flags: FILE_STORE });
      try {
        const answer = (await second.request('getAuthStatus', { includeToken: true, refreshToken: false })) as {
          result?: { authToken?: string | null };
        };
        expect(answer.result?.authToken).toBe(rotated.tokens.access_token);
      } finally {
        await second.stop();
      }
      // the second home refreshed a credential that was already fresh through its link if this fails
      expect(endpoint.presented.length).toBe(spent);
    });

    it('U3: the renewal lands with a workspace-write sandbox and a working folder outside the store', async () => {
      const w = await world({ expired: true, homes: ['a'] });
      const outside = await mkdtemp(path.join(box.root, 'cwd-'));
      const before = endpoint.presented.length;
      const server = await startAppServer(codex().bin, {
        env: w.env('a'),
        cwd: outside,
        flags: [...FILE_STORE, '-c', 'sandbox_mode="workspace-write"'],
      });
      try {
        await server.request('getAuthStatus', { includeToken: false, refreshToken: true });
      } finally {
        await server.stop();
      }
      expect(endpoint.presented.length).toBeGreaterThan(before);
      expect((await readCodexAuth(w.canonical)).tokens.refresh_token).toBe(endpoint.lastIssued() as string);
      expect((await lstat(path.join(w.home('a'), 'auth.json'))).isSymbolicLink()).toBe(true);
    });

    it("removes only the logged-out ferret's link: the canonical file and the other ferret survive", async () => {
      const w = await world({ expired: false, homes: ['a', 'b'] });
      const ran = await run([codex().bin, ...FILE_STORE, 'logout'], { env: w.env('a'), cwd: w.fyHome });
      expect(ran.code, ran.stderr).toBe(0);
      await expect(lstat(path.join(w.home('a'), 'auth.json'))).rejects.toThrow();
      // logout deleted the canonical credential through the link if this fails
      expect((await lstat(w.canonical)).isFile()).toBe(true);
      expect((await lstat(path.join(w.home('b'), 'auth.json'))).isSymbolicLink()).toBe(true);
    });

    describe.skipIf(process.platform !== 'linux')(
      'file storage keeps the credential out of the keyring (Linux: a keyring call is a D-Bus connection)',
      () => {
        /** Run `codex login status` against a counting fake session bus; kill it once it has connected. */
        const busConnections = async (store: string): Promise<number> => {
          const w = await world({ expired: false, homes: ['a'], store, link: store === 'file' });
          const bus = await startFakeBus(await mkdtemp('/tmp/fyb-'));
          try {
            const child = Bun.spawn([codex().bin, 'login', 'status'], {
              env: w.env('a', { DBUS_SESSION_BUS_ADDRESS: bus.address }),
              cwd: w.fyHome,
              stdin: 'ignore',
              stdout: 'ignore',
              stderr: 'ignore',
            });
            const deadline = Date.now() + 10_000;
            let exited = false;
            void child.exited.then(() => {
              exited = true;
            });
            while (!exited && bus.connections() === 0 && Date.now() < deadline) await Bun.sleep(100);
            child.kill('SIGKILL');
            await child.exited;
            return bus.connections();
          } finally {
            await bus.stop();
          }
        };

        it('connects to the bus when told to use the keyring (the control)', async () => {
          expect(await busConnections('keyring')).toBeGreaterThan(0);
        });

        it(`never connects with ${CODEX_CREDENTIAL_STORE_KEY} = "file"`, async () => {
          expect(await busConnections('file')).toBe(0);
        });
      },
    );
  },
);
