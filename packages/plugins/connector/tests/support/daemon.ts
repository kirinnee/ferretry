import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FerretRecordSchema } from '../../../../core/ferrets/contract/ids.ts';
import { FerretTokensSchema } from '../../../../core/ferrets/contract/state.ts';

/**
 * A REAL 5.0 daemon for the connector's end-to-end test: the production `fyd` (every real plugin, the real route spine,
 * Gate and the kernel's public door) on a temp FY_HOME with an OS-chosen API port, and the real `fy` run as the owner
 * against it. Fake values only, loopback only; nothing reads a real home or credential. The test calls `dispose()` from
 * its own `afterAll`, which stops the daemon and removes the home.
 */
const ROOT = join(import.meta.dir, '../../../../..');
const FYD = join(ROOT, 'packages/core/kernel/host/fyd.ts');
const FY = join(ROOT, 'packages/cli/bin/fy.ts');
const READY_MS = 90_000;

interface RanFy {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly json: unknown;
}

/** The one ferret every real daemon here is seeded with, so a test can present a REAL ferret credential. */
export const SEEDED_FERRET = 'e2e-ferret';

export interface RealDaemon {
  readonly home: string;
  /** The seeded ferret's own session credential (a fake value the daemon holds only the digest of). */
  readonly ferretToken: string;
  /** Everything the daemon has written to stdout and stderr so far. */
  output(): string;
  dispose(): Promise<void>;
  /** One owner request to the daemon's API (the admin bearer from the home's own token file). */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<{ status: number; text: string }>;
  /** Runs `fy <args>` as the owner. */
  fy(args: readonly string[]): Promise<RanFy>;
}

/** @param seed files (path under FY_HOME → text) written before the first boot. */
export async function bootRealDaemon(seed: Readonly<Record<string, string>> = {}): Promise<RealDaemon> {
  const root = await mkdtemp(join(tmpdir(), 'fy-connector-real-'));
  const home = join(root, 'fy-home');
  const userHome = join(root, 'user-home');
  await mkdir(userHome, { recursive: true });
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'connector-real-daemon', createdAt: '2026-11-13T00:00:00.000Z' }),
  );
  // A schema-validated ferret record plus its bearer's digest, as the CLI's real-daemon tier seeds one: no harness or pane.
  const ferretToken = `fys_${randomBytes(32).toString('base64url')}`;
  const stamp = '2026-11-13T00:00:00.000Z';
  await mkdir(join(home, 'state/ferrets', SEEDED_FERRET), { recursive: true });
  await writeFile(
    join(home, 'state/ferrets', SEEDED_FERRET, 'ferret.json'),
    JSON.stringify(
      FerretRecordSchema.parse({
        format: 1,
        id: SEEDED_FERRET,
        name: SEEDED_FERRET,
        role: 'lead',
        mode: 'auto',
        harness: 'codex',
        runner: 'tmux',
        folder: root,
        state: 'starting',
        birth: 'person',
        createdAt: stamp,
        stateAt: stamp,
      }),
    ),
  );
  await writeFile(
    join(home, 'state/ferrets/tokens.json'),
    JSON.stringify(
      FerretTokensSchema.parse({
        format: 1,
        tokens: [
          { ferret: SEEDED_FERRET, digest: createHash('sha256').update(ferretToken).digest('hex'), issuedAt: stamp },
        ],
      }),
    ),
    { mode: 0o600 },
  );
  for (const [path, text] of Object.entries(seed)) {
    await mkdir(join(home, path, '..'), { recursive: true });
    await writeFile(join(home, path), text);
  }
  const base = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: userHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    FY_HOME: home,
    // Offline, as scripts/ci/test.sh runs every tier.
    FY_MODEL_CATALOG: 'off',
    FY_LOCAL_MODELS: 'off',
    FY_RELAY_DIRECTORY_ORIGIN: 'off',
    FY_UPDATE_CHECK: 'off',
    FYD_BACKGROUND_DELAY_SECONDS: '3600',
  };
  const child = Bun.spawn({
    cmd: [process.execPath, FYD],
    cwd: ROOT,
    env: { ...base, FY_PORT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const log: string[] = [];
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      log.push(text);
      if (/\bfyd \S+ ready \(/u.test(text)) ready = true;
    }
  };
  void pump(child.stderr as ReadableStream<Uint8Array>);
  void pump(child.stdout as ReadableStream<Uint8Array>);
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill('SIGKILL');
  };
  const until = Date.now() + READY_MS;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`fyd exited ${String(child.exitCode)}: ${log.join('').slice(-1500)}`);
    await Bun.sleep(200);
  }
  if (!ready) {
    await stop();
    throw new Error(`fyd was not ready in ${String(READY_MS)} ms: ${log.join('').slice(-1500)}`);
  }
  const run = JSON.parse(await readFile(join(home, 'run/daemon.json'), 'utf8')) as { port: number };
  const admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
  const url = `http://127.0.0.1:${String(run.port)}`;
  return {
    home,
    ferretToken,
    output: () => log.join(''),
    async dispose() {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${admin}`,
          'x-ferretry-client': 'cli',
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    },
    async fy(args) {
      const proc = Bun.spawn({
        cmd: [process.execPath, FY, ...args],
        cwd: ROOT,
        env: { ...base, FY_URL: url },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        json = undefined;
      }
      return { code, out, err, json };
    },
  };
}
