import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_RUN_FILE, DaemonRunSchema } from '@ferretry/kernel/contract';
import { PairingCodeMintResponseSchema } from '../../../../contract/index.ts';

/**
 * THE MERGE-BAR LINE: `fy pair` GIVES A LINK ON A LOOPBACK DAEMON (docs/rebuild/merge-bar.md, before-merge line 8;
 * smoke-list step 1 "pair a fresh browser").
 *
 * The 5.0 preview answered `fy pair` with a code and "no port recorded yet, so there is no address to hand out" while
 * the daemon was listening on a loopback port the whole time: the pairing service asked Connections for its
 * advertisement ONCE, when it was built (before the kernel had bound anything), and Connections took its port from
 * `connections.yaml` alone. Every unit test faked the one piece that was wrong. This one boots the REAL `fyd` (the
 * production entry point, every real plugin) on a temp FY_HOME and an ephemeral loopback port, with NO
 * `connections.yaml` port, and asks it for a code over HTTP and through the real `fy pair`.
 *
 * Loopback only, fake values only. The hosted relay directory is never asked: the configuration names one relay
 * explicitly (a relay SOURCE on, so the box is "loopback + relay"), and an explicit relay is never discovered. The
 * rendezvous itself is therefore not reachable from here and nothing depends on it.
 *
 * A PAIRING CODE IS A LIVE CREDENTIAL: nothing below prints one, a failure message never carries a response body, and
 * every code minted is cancelled (or superseded, then cancelled) before the daemon is stopped.
 */

const FYD = join(import.meta.dir, '../../../../../../core/kernel/host/fyd.ts');
const FY = join(import.meta.dir, '../../../../../../cli/bin/fy.ts');
const REPO = join(import.meta.dir, '../../../../../../..');
const READY_MS = 90_000;
setDefaultTimeout(150_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

interface Daemon {
  readonly home: string;
  readonly port: number;
  mint(): Promise<ReturnType<typeof PairingCodeMintResponseSchema.parse>>;
  cancel(pairingId: string): Promise<number>;
  fyPair(): Promise<{ code: number; out: string; err: string }>;
}

async function boot(options: {
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}): Promise<Daemon> {
  const root = await mkdtemp(join(tmpdir(), 'fy-pair-link-'));
  const home = join(root, 'fy-home');
  const userHome = join(root, 'user-home');
  await mkdir(userHome, { recursive: true });
  const files: Record<string, string> = {
    [join(home, 'home.json')]: JSON.stringify({
      format: 1,
      createdBy: 'pair-link-e2e',
      createdAt: new Date().toISOString(),
    }),
    // A relay source ON, named explicitly so no directory is asked. NO `direct` block: the port must come from the listener.
    [join(home, 'config/connections.yaml')]: 'relay:\n  - url: wss://relay.invalid/fy\n    enabled: true\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
  }
  const stderr: string[] = [];
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: userHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    FY_HOME: home,
    FY_MODEL_CATALOG: 'off',
    FY_LOCAL_MODELS: 'off',
    FY_RELAY_DIRECTORY_ORIGIN: 'off',
    FY_UPDATE_CHECK: 'off',
    ...options.env,
  };
  const child: Subprocess<'ignore', 'pipe', 'pipe'> = spawn({
    cmd: [process.execPath, FYD, ...(options.args ?? [])],
    cwd: REPO,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      stderr.push(text);
      if (/\bfyd \S+ ready \(/u.test(text)) ready = true;
    }
  };
  void pump(child.stderr);
  void pump(child.stdout);
  cleanups.push(async () => {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const until = Date.now() + READY_MS;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`fyd exited ${String(child.exitCode)}: ${stderr.join('').slice(-1500)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`fyd was not ready in ${String(READY_MS)} ms: ${stderr.join('').slice(-1500)}`);
  const run = DaemonRunSchema.parse(JSON.parse(await readFile(join(home, DAEMON_RUN_FILE), 'utf8')));
  const base = `http://127.0.0.1:${String(run.port)}`;
  const admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${admin}`, 'x-ferretry-client': 'cli', accept: 'application/json' };
  return {
    home,
    port: run.port,
    mint: async () => {
      const response = await fetch(`${base}/v1/pair/code`, { method: 'POST', headers });
      if (response.status !== 201) throw new Error(`the mint answered ${String(response.status)}`);
      return PairingCodeMintResponseSchema.parse(await response.json());
    },
    cancel: async pairingId => (await fetch(`${base}/v1/pair/code/${pairingId}`, { method: 'DELETE', headers })).status,
    fyPair: async () => {
      const proc = Bun.spawn([process.execPath, FY, 'pair', '--no-wait'], {
        cwd: REPO,
        env: { PATH: env.PATH, HOME: userHome, NO_COLOR: '1', FY_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, out, err };
    },
  };
}

/** The assertions that must hold on a daemon bound on loopback, however its port was chosen. */
async function expectsALink(daemon: Daemon): Promise<void> {
  // The real `fy pair` first: it mints a code of its own, which the mint below then supersedes.
  const screen = await daemon.fyPair();
  expect(screen.code).toBe(0);
  const text = `${screen.out}\n${screen.err}`;
  expect(text.includes('no address to hand out')).toBe(false);
  expect(text.includes('no port recorded')).toBe(false);
  expect(text.includes(`http://127.0.0.1:${String(daemon.port)}`)).toBe(true);
  expect(text.includes('/pair')).toBe(true);

  const minted = await daemon.mint();
  expect(minted.refusal).toBeUndefined();
  expect(minted.reach).toBe('local-only');
  expect(minted.daemonUrl).toBe(`http://127.0.0.1:${String(daemon.port)}/`);
  expect(typeof minted.pairUrl).toBe('string');
  expect(
    new URL(minted.pairUrl as string).hash.includes(encodeURIComponent(`http://127.0.0.1:${String(daemon.port)}/`)),
  ).toBe(true);
  expect(await daemon.cancel(minted.pairingId)).toBe(200);
}

describe('a real fyd bound on loopback gives `fy pair` a link', () => {
  test('on the port FY_PORT chose, with no connections.yaml port', async () => {
    await expectsALink(await boot({ env: { FY_PORT: '0' } }));
  });

  test('a wildcard bind still refuses with wildcard-bind (and keeps the code)', async () => {
    const daemon = await boot({ args: ['--host', '0.0.0.0'], env: { FY_PORT: '0' } });
    const minted = await daemon.mint();
    expect(minted.refusal).toBe('wildcard-bind');
    expect(minted.pairUrl).toBeUndefined();
    expect(await daemon.cancel(minted.pairingId)).toBe(200);
  });
});
