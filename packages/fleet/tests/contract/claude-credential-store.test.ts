/**
 * Claude Code's credential sharing, measured against the harness this build pins (design §8.1.1, §8.5).
 *
 * The account model gives every runtime on one credential its own `CLAUDE_CONFIG_DIR` and ONE
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`. That variable is undocumented, so these tests are the only thing
 * that notices when a Claude release renames it, stops honouring it, or changes how a refresh is
 * serialised. Each claim has the control that makes it load-bearing.
 *
 * A refresh needs a token endpoint, and Claude only talks to its own host, so the recording proxy
 * splices that one host to a loopback TLS server trusted through `NODE_EXTRA_CA_CERTS`. `claude mcp
 * list` is the trigger: it takes Claude's own refresh-if-expired path and invokes no model (the same
 * path `process-token-refresh.ts` relies on). Any attempt to reach the inference host dies at the
 * proxy's CONNECT line.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { lstat, mkdir, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { claudeCredential, claudeTokenAnswer, readClaudeRefreshToken } from './support/fixtures.ts';
import {
  contract,
  harnessEnv,
  requireHarness,
  run,
  type Sandbox,
  sandbox,
  treeContains,
  until,
} from './support/harness.ts';
import {
  makeTlsMaterial,
  type RecordingProxy,
  startProxy,
  startTokenEndpoint,
  type TlsMaterial,
  type TokenEndpoint,
} from './support/network.ts';

const STORE_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
const TOKEN_HOST = 'platform.claude.com';
/** The keychain replaces the file on macOS; those claims live in `claude-keychain.test.ts`. */
const fileStore = process.platform !== 'darwin';

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

/** Every credential file under a config dir — the thing a shared store must never create. */
const credentialFilesIn = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  return entries.filter(entry => path.basename(String(entry)) === '.credentials.json');
};

describe.skipIf(!contract.enabled)('claude contract: one secure-storage store shared by many config dirs', () => {
  let box: Sandbox;
  let tls: TlsMaterial;
  const claude = () => requireHarness('claude');

  beforeAll(async () => {
    box = await sandbox('claude-store');
    tls = await makeTlsMaterial(box.dir('tls'), [TOKEN_HOST]);
  });
  afterAll(async () => {
    await box.dispose();
  });

  /** A fresh world: a store with one credential and `configs` empty config dirs. */
  const world = async (name: string, options: { expired: boolean; configs: string[] }) => {
    const root = box.dir(name);
    const store = path.join(root, 'store');
    const home = path.join(root, 'home');
    await mkdir(store, { recursive: true });
    await mkdir(home, { recursive: true });
    for (const config of options.configs) await mkdir(path.join(root, config), { recursive: true });
    if (fileStore) await writeFile(path.join(store, '.credentials.json'), claudeCredential(options), { mode: 0o600 });
    return { root, store, home, config: (config: string) => path.join(root, config) };
  };

  const status = async (env: Record<string, string>) => {
    const ran = await run([claude().bin, 'auth', 'status', '--json'], { env });
    return JSON.parse(ran.stdout) as { loggedIn?: boolean };
  };

  it(`still reads ${STORE_VARIABLE} (a rename fails here, by name)`, async () => {
    const found = await treeContains(claude().root, STORE_VARIABLE);
    should(found).be.true(
      `the installed claude no longer contains ${STORE_VARIABLE}: Ferretry's credential sharing is broken for this version — fall back to per-runtime sign-in (design §9.5)`,
    );
  });

  it.skipIf(!fileStore)(
    'reports two config dirs logged in from one store, and writes no credential into either',
    async () => {
      const proxy = startProxy();
      try {
        const w = await world('two-dirs', { expired: false, configs: ['a', 'b'] });
        for (const config of ['a', 'b']) {
          const reported = await status(
            harnessEnv(w.home, proxy.port, { CLAUDE_CONFIG_DIR: w.config(config), [STORE_VARIABLE]: w.store }),
          );
          should(reported.loggedIn).equal(true, `config dir ${config} did not read the shared store`);
          should(await credentialFilesIn(w.config(config))).be.empty();
        }
      } finally {
        proxy.stop();
      }
    },
  );

  it.skipIf(!fileStore)(`is load-bearing: without ${STORE_VARIABLE} the same config dir is logged out`, async () => {
    const proxy = startProxy();
    try {
      const w = await world('control', { expired: false, configs: ['b'] });
      const reported = await status(harnessEnv(w.home, proxy.port, { CLAUDE_CONFIG_DIR: w.config('b') }));
      should(reported.loggedIn).equal(false);
    } finally {
      proxy.stop();
    }
  });

  describe.skipIf(!fileStore)('refresh', () => {
    let endpoint: TokenEndpoint;
    let proxy: RecordingProxy;

    beforeAll(() => {
      endpoint = startTokenEndpoint({ tls, issue: claudeTokenAnswer });
      proxy = startProxy({ [TOKEN_HOST]: endpoint.port });
    });
    afterAll(() => {
      proxy.stop();
      endpoint.stop();
    });

    const refreshEnv = (home: string, config: string, store: string) =>
      harnessEnv(home, proxy.port, {
        CLAUDE_CONFIG_DIR: config,
        [STORE_VARIABLE]: store,
        NODE_EXTRA_CA_CERTS: tls.caFile,
      });
    const refresh = (home: string, config: string, store: string) =>
      Bun.spawn([claude().bin, 'mcp', 'list'], {
        env: refreshEnv(home, config, store),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });

    it('lands the rotated token in the store, not in the config dir', async () => {
      const w = await world('rotate', { expired: true, configs: ['a'] });
      const before = endpoint.presented.length;
      const child = refresh(w.home, w.config('a'), w.store);
      await until(
        async () => (await readClaudeRefreshToken(path.join(w.store, '.credentials.json'))) === endpoint.lastIssued(),
        30_000,
      );
      child.kill('SIGKILL');
      await child.exited;
      should(endpoint.presented.length).equal(before + 1, 'the expired credential did not trigger exactly one refresh');
      should(await readClaudeRefreshToken(path.join(w.store, '.credentials.json'))).equal(endpoint.lastIssued());
      should(await credentialFilesIn(w.config('a'))).be.empty();
    });

    it('serialises a refresh on a lock keyed on the STORE: a second runtime waits, re-reads, and never spends the token', async () => {
      const w = await world('lock', { expired: true, configs: ['a', 'b'] });
      const before = endpoint.presented.length;
      endpoint.hold();
      const first = refresh(w.home, w.config('a'), w.store);
      let second: ReturnType<typeof refresh> | undefined;
      try {
        should(await until(() => endpoint.presented.length === before + 1, 30_000)).be.true(
          'the first runtime never asked to refresh',
        );
        // The first runtime is now inside its refresh, holding the lock.
        should(await exists(`${w.store}.lock`)).be.true('no lock beside the store while a refresh is in flight');
        should(await exists(`${w.config('a')}.lock`)).be.false();
        second = refresh(w.home, w.config('b'), w.store);
        await Bun.sleep(3_000);
        should(endpoint.presented.length).equal(
          before + 1,
          'the second runtime spent the refresh token while the first held the lock',
        );
      } finally {
        endpoint.release();
      }
      await until(
        async () => (await readClaudeRefreshToken(path.join(w.store, '.credentials.json'))) === endpoint.lastIssued(),
        30_000,
      );
      await Promise.race([second?.exited, Bun.sleep(20_000)]);
      first.kill('SIGKILL');
      second?.kill('SIGKILL');
      await Promise.all([first.exited, second?.exited]);
      should(endpoint.presented.length).equal(
        before + 1,
        'after the lock released, the second runtime POSTed instead of adopting the rotated token',
      );
      should(await readClaudeRefreshToken(path.join(w.store, '.credentials.json'))).equal(endpoint.lastIssued());
    });

    it('turns a symlinked credential into a regular file on the first refresh — why Ferretry never links one', async () => {
      const w = await world('symlink', { expired: true, configs: ['a'] });
      const canonical = path.join(w.root, 'canonical.json');
      await Bun.write(canonical, await Bun.file(path.join(w.store, '.credentials.json')).text());
      await unlink(path.join(w.store, '.credentials.json'));
      await symlink(canonical, path.join(w.store, '.credentials.json'));
      const child = refresh(w.home, w.config('a'), w.store);
      await until(async () => !(await lstat(path.join(w.store, '.credentials.json'))).isSymbolicLink(), 30_000);
      child.kill('SIGKILL');
      await child.exited;
      should((await lstat(path.join(w.store, '.credentials.json'))).isSymbolicLink()).be.false();
      should(await readClaudeRefreshToken(path.join(w.store, '.credentials.json'))).equal(endpoint.lastIssued());
      should(await readClaudeRefreshToken(canonical)).equal(
        'sk-ant-ort01-FAKE',
        'the link target moved: a symlink might share after all',
      );
    });
  });
});
