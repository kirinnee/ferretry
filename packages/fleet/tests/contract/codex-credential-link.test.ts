/**
 * Codex's credential sharing, measured against the harness this build pins (design §8.2.1, §8.5).
 *
 * The account model keeps ONE canonical `auth.json` per credential and links it into every runtime's
 * `CODEX_HOME`. That is safe only while three things stay true, and these tests are where a Codex
 * release that breaks one is caught:
 *
 * 1. A refresh rewrites `auth.json` IN PLACE, so the link still points at the canonical file — and a
 *    second runtime reading through its own link sees the rotated token without spending its own.
 * 2. `cli_auth_credentials_store = "file"` keeps the credential out of the keyring, where no link
 *    could follow it. On Linux a keyring call is a D-Bus connection, so a fake bus can count it;
 *    `keyring` is the control that proves the bus is watched.
 * 3. `codex logout` in one runtime removes that runtime's link and nothing else (INFERRED in §8.2.1).
 *
 * The token endpoint is a loopback stand-in reached through `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { codexTokenAnswer, readCodexAuth, startAppServer, writeCodexAuth } from './support/fixtures.ts';
import {
  contract,
  harnessEnv,
  reap,
  requireHarness,
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
const STORE_KEY = 'cli_auth_credentials_store';

describe.skipIf(!contract.enabled)('codex contract: one canonical auth.json linked into many homes', () => {
  let box: Sandbox;
  let proxy: RecordingProxy;
  let endpoint: TokenEndpoint;
  let counter = 0;
  const codex = () => requireHarness('codex');

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

  /** A canonical credential and `homes` runtime homes linking to it, each forcing file storage. */
  const world = async (options: { expired: boolean; homes: string[]; store?: string; link?: boolean }) => {
    counter++;
    const root = box.dir(`w${counter}`);
    const canonical = path.join(root, 'credential', 'auth.json');
    const home = path.join(root, 'home');
    await mkdir(path.dirname(canonical), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeCodexAuth(canonical, options);
    for (const runtime of options.homes) {
      await mkdir(path.join(root, runtime), { recursive: true });
      if (options.link !== false) await symlink(canonical, path.join(root, runtime, 'auth.json'));
      await writeFile(path.join(root, runtime, 'config.toml'), `${STORE_KEY} = "${options.store ?? 'file'}"\n`);
    }
    const env = (runtime: string, extra: Record<string, string> = {}) =>
      harnessEnv(home, proxy.port, {
        CODEX_HOME: path.join(root, runtime),
        [OVERRIDE_VARIABLE]: endpoint.url,
        ...extra,
      });
    return { root, canonical, home: (runtime: string) => path.join(root, runtime), env };
  };

  it(`still contains ${OVERRIDE_VARIABLE} and ${STORE_KEY} (a rename fails here, by name)`, async () => {
    should(await treeContains(codex().root, OVERRIDE_VARIABLE)).be.true(
      `the installed codex no longer reads ${OVERRIDE_VARIABLE}, so this guard cannot stand in for the token endpoint — the refresh claims below are unmeasured until the stub is moved to the proxy`,
    );
    should(await treeContains(codex().root, STORE_KEY)).be.true(
      `the installed codex no longer knows ${STORE_KEY}: a runtime cannot be kept on file storage`,
    );
  });

  it('rewrites auth.json in place through the link, and a second home reads the rotated token without refreshing', async () => {
    const w = await world({ expired: true, homes: ['a', 'b'] });
    const before = endpoint.presented.length;
    const first = await startAppServer(codex().bin, { env: w.env('a'), cwd: w.root });
    try {
      const answer = await first.request('getAuthStatus', { includeToken: false, refreshToken: true });
      should(answer).have.property('result');
    } finally {
      await first.stop();
    }
    should(endpoint.presented.length).be.above(before, 'the expired credential was never refreshed');
    should(endpoint.presented[before]).equal('rt-FAKE');
    for (const runtime of ['a', 'b']) {
      const link = path.join(w.home(runtime), 'auth.json');
      should((await lstat(link)).isSymbolicLink()).be.true(
        `${runtime}/auth.json stopped being a link: the refresh replaced it instead of writing through it`,
      );
      should(await readlink(link)).equal(w.canonical);
    }
    const rotated = await readCodexAuth(w.canonical);
    should(rotated.tokens.refresh_token).equal(endpoint.lastIssued());

    const spent = endpoint.presented.length;
    const second = await startAppServer(codex().bin, { env: w.env('b'), cwd: w.root });
    try {
      const answer = (await second.request('getAuthStatus', { includeToken: true, refreshToken: false })) as {
        result?: { authToken?: string | null };
      };
      should(answer.result?.authToken).equal(rotated.tokens.access_token);
    } finally {
      await second.stop();
    }
    should(endpoint.presented.length).equal(
      spent,
      'the second home refreshed a credential that was already fresh through its link',
    );
  });

  it("removes only the logged-out runtime's link: the canonical file and the other runtime survive", async () => {
    const w = await world({ expired: false, homes: ['a', 'b'] });
    const ran = await run([codex().bin, 'logout'], { env: w.env('a'), cwd: w.root });
    should(ran.code).equal(0, ran.stderr);
    await should(lstat(path.join(w.home('a'), 'auth.json'))).be.rejected();
    should((await lstat(w.canonical)).isFile()).be.true('logout deleted the canonical credential through the link');
    should((await lstat(path.join(w.home('b'), 'auth.json'))).isSymbolicLink()).be.true();
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
            cwd: w.root,
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
        should(await busConnections('keyring')).be.above(0);
      });

      it(`never connects with ${STORE_KEY} = "file"`, async () => {
        should(await busConnections('file')).equal(0);
      });
    },
  );
});
