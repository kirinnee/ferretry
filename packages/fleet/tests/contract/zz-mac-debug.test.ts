// THROWAWAY DIAGNOSTIC (debug/mac-keychain-*): never merged. Logs, asserts nothing load-bearing.
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeCredential, claudeTokenAnswer } from './support/fixtures.ts';
import { contract, harnessEnv, requireHarness, run, type Sandbox, sandbox, until } from './support/harness.ts';
import { keychainWritable } from './support/keychain.ts';
import { makeTlsMaterial, type RecordingProxy, startProxy, startTokenEndpoint, type TokenEndpoint } from './support/network.ts';

const BARE = 'Claude Code-credentials';
const hash8 = (s: string) => createHash('sha256').update(s.normalize('NFC')).digest('hex').slice(0, 8);
const svc = (dir: string) => `${BARE}-${hash8(dir)}`;
const account = process.env.USER ?? '';
const REAL_HOME = process.env.HOME ?? '';
const log = (...a: unknown[]) => console.log('[MACDBG]', ...a);

const sec = (args: string[], home = REAL_HOME) =>
  run(['/usr/bin/security', ...args], { env: { PATH: '/usr/bin:/bin', HOME: home, USER: account } });

describe.skipIf(!(contract.enabled && keychainWritable))('MACDBG', () => {
  let box: Sandbox;
  let proxy: RecordingProxy;
  let endpoint: TokenEndpoint;
  let caFile = '';
  let shimDir = '';
  let shimLog = '';
  const planted: Array<[string, string | undefined]> = [];

  const plant = async (service: string, secret: string, keychain?: string) => {
    const args = ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret];
    if (keychain) args.push(keychain);
    const r = await sec(args);
    log('plant', service, keychain ?? '(default)', 'rc', r.code, r.stderr.trim());
    planted.push([service, keychain]);
  };

  beforeAll(async () => {
    box = await sandbox('macdbg');
    const tls = await makeTlsMaterial(box.dir('tls'), ['platform.claude.com']);
    caFile = tls.caFile;
    endpoint = startTokenEndpoint({ tls, issue: claudeTokenAnswer });
    proxy = startProxy({ 'platform.claude.com': endpoint.port });
    shimDir = box.dir('shim');
    shimLog = box.dir('shim.log');
    await mkdir(shimDir, { recursive: true });
    await writeFile(
      path.join(shimDir, 'security'),
      `#!/bin/bash
echo "CALL HOME=$HOME USER=$USER args: $*" >> ${shimLog}
if [[ "$1" == "-i" ]]; then
  input="$(cat)"; echo "STDIN: $(echo "$input" | sed -E 's/-X "[0-9a-f]+"/-X <hex>/')" >> ${shimLog}
  printf '%s\\n' "$input" | /usr/bin/security "$@"; rc=$?
else
  /usr/bin/security "$@"; rc=$?
fi
echo "  rc=$rc" >> ${shimLog}
exit $rc
`,
    );
    await chmod(path.join(shimDir, 'security'), 0o755);
    log('claude bin', requireHarness('claude').bin, 'USER', account, 'HOME', REAL_HOME);
    for (const home of [REAL_HOME, box.home]) {
      await mkdir(home, { recursive: true });
      for (const a of [['list-keychains'], ['list-keychains', '-d', 'user'], ['default-keychain'], ['show-keychain-info']]) {
        const r = await sec(a, home);
        log(`HOME=${home} security ${a.join(' ')} rc=${r.code}`, r.stdout.trim(), r.stderr.trim());
      }
    }
  });

  afterAll(async () => {
    for (const [s, k] of planted) await sec(['delete-generic-password', '-a', account, '-s', s, ...(k ? [k] : [])]);
    try {
      log('SHIM LOG ----\n' + (await readFile(shimLog, 'utf8')));
    } catch {
      log('no shim log');
    }
    proxy.stop();
    endpoint.stop();
    await box.dispose();
  });

  const envFor = (home: string, configDir: string, store: string | undefined) => {
    const extra: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir, NODE_EXTRA_CA_CERTS: caFile };
    if (store !== undefined) extra.CLAUDE_SECURESTORAGE_CONFIG_DIR = store;
    const env = harnessEnv(home, proxy.port, extra);
    env.PATH = `${shimDir}:${env.PATH}`;
    return env;
  };
  const status = async (label: string, env: Record<string, string>) => {
    await writeFile(shimLog, `${(await readFile(shimLog, 'utf8').catch(() => ''))}=== ${label}\n`);
    const r = await run([requireHarness('claude').bin, 'auth', 'status', '--json'], { env });
    log(`STATUS ${label}: rc=${r.code} stdout=${r.stdout.trim().slice(0, 300)} stderr=${r.stderr.trim().slice(0, 300)}`);
  };

  it('E1 hashed item, fake HOME vs real HOME, + path forms', async () => {
    const store = box.dir('e1', 'store');
    const cfg = box.dir('e1', 'config');
    await mkdir(store, { recursive: true });
    await mkdir(cfg, { recursive: true });
    const real = await realpath(store);
    log('store', store, svc(store), 'realpath', real, svc(real), 'slash', svc(`${store}/`));
    await plant(svc(store), claudeCredential({ expired: false, tag: 'E1' }));
    await status('E1a fake HOME', envFor(box.home, cfg, store));
    await status('E1b real HOME', envFor(REAL_HOME, cfg, store));
  });

  it('E2 bare item with "" , fake vs real HOME, and unset variable', async () => {
    const cfg = box.dir('e2', 'config');
    await mkdir(cfg, { recursive: true });
    const pre = await sec(['find-generic-password', '-a', account, '-s', BARE]);
    log('bare item pre-existing on runner?', pre.code);
    await plant(BARE, claudeCredential({ expired: false, tag: 'E2' }));
    await status('E2a "" fake HOME', envFor(box.home, cfg, ''));
    await status('E2b "" real HOME', envFor(REAL_HOME, cfg, ''));
    await status('E2c unset var, CLAUDE_CONFIG_DIR set, real HOME', envFor(REAL_HOME, cfg, undefined));
  });

  it('E3 two config dirs share one store item (real HOME)', async () => {
    const store = box.dir('e3', 'store');
    await mkdir(store, { recursive: true });
    await plant(svc(store), claudeCredential({ expired: false, tag: 'E3' }));
    for (const c of ['c1', 'c2']) {
      const cfg = box.dir('e3', c);
      await mkdir(cfg, { recursive: true });
      await status(`E3 ${c}`, envFor(REAL_HOME, cfg, store));
    }
  });

  it('E4 throwaway keychain inside the fake HOME', async () => {
    const kc = path.join(box.home, 'Library', 'Keychains', 'fy-contract.keychain-db');
    await mkdir(path.dirname(kc), { recursive: true });
    for (const a of [
      ['create-keychain', '-p', 'fy', kc],
      ['unlock-keychain', '-p', 'fy', kc],
      ['set-keychain-settings', kc],
      ['list-keychains', '-d', 'user', '-s', kc],
      ['default-keychain', '-d', 'user', '-s', kc],
      ['list-keychains'],
      ['default-keychain'],
    ]) {
      const r = await sec(a, box.home);
      log(`fakeHOME security ${a.join(' ')} rc=${r.code}`, r.stdout.trim(), r.stderr.trim());
    }
    const rr = await sec(['list-keychains'], REAL_HOME);
    log('REAL HOME search list after (must be unchanged):', rr.stdout.trim());
    const store = box.dir('e4', 'store');
    const cfg = box.dir('e4', 'config');
    await mkdir(store, { recursive: true });
    await mkdir(cfg, { recursive: true });
    await plant(svc(store), claudeCredential({ expired: false, tag: 'E4' }), kc);
    await status('E4a hashed in throwaway kc, fake HOME', envFor(box.home, cfg, store));
    await plant(BARE, claudeCredential({ expired: false, tag: 'E4B' }), kc);
    await status('E4b bare in throwaway kc, fake HOME', envFor(box.home, cfg, ''));
    // refresh write-back into the throwaway keychain
    const wstore = box.dir('e4', 'wstore');
    await mkdir(wstore, { recursive: true });
    await plant(svc(wstore), claudeCredential({ expired: true, tag: 'E4W' }), kc);
    const child = Bun.spawn([requireHarness('claude').bin, 'mcp', 'list'], {
      env: envFor(box.home, cfg, wstore),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const ok = await until(
      async () => {
        const r = await sec(['find-generic-password', '-a', account, '-s', svc(wstore), '-w', kc], box.home);
        const t = /^[0-9a-f]+$/i.test(r.stdout.trim()) ? Buffer.from(r.stdout.trim(), 'hex').toString() : r.stdout;
        return t.includes('ROTATED');
      },
      30_000,
      500,
    );
    child.kill('SIGKILL');
    await child.exited;
    log('E4 refresh rotated into throwaway kc item:', ok, 'presented', endpoint.presented.length);
  });

  it('E5 refresh write-back with real HOME', async () => {
    const store = box.dir('e5', 'store');
    const cfg = box.dir('e5', 'config');
    await mkdir(store, { recursive: true });
    await mkdir(cfg, { recursive: true });
    await plant(svc(store), claudeCredential({ expired: true, tag: 'E5' }));
    const before = endpoint.presented.length;
    const child = Bun.spawn([requireHarness('claude').bin, 'mcp', 'list'], {
      env: envFor(REAL_HOME, cfg, store),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const ok = await until(
      async () => {
        const r = await sec(['find-generic-password', '-a', account, '-s', svc(store), '-w']);
        const t = /^[0-9a-f]+$/i.test(r.stdout.trim()) ? Buffer.from(r.stdout.trim(), 'hex').toString() : r.stdout;
        return t.includes('ROTATED');
      },
      30_000,
      500,
    );
    child.kill('SIGKILL');
    await child.exited;
    log('E5 refresh rotated in login kc:', ok, 'presented', endpoint.presented.length - before);
  });
});
