import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FerretRecordSchema } from '../../../../core/ferrets/contract/ids.ts';
import { FerretTokensSchema } from '../../../../core/ferrets/contract/state.ts';

/**
 * A REAL 5.0 daemon for a CLI test: the production `fyd` (every real plugin, the real route spine, grants and Asks engine)
 * on a temp FY_HOME with an OS-chosen loopback port, and the REAL `fy` run as a child process against it, as a ferret
 * (its own session id and bearer) or as the owner (no session). Nothing here is a fixture of the daemon's answers: a verb
 * that did nothing, wrote to the wrong item, or closed fewer than it said shows in the board the daemon serves afterwards.
 *
 * Ferrets are seeded as schema-validated idle records with a bearer each, so no harness, model or pane is ever launched.
 * Fake values only; loopback only; nothing reads a real home or credential. The test file calls `dispose()` from its own
 * `afterAll` (a hook cannot be registered from inside `beforeAll`), which stops the daemon and removes the home.
 */

const ROOT = join(import.meta.dir, '../../../../..');
const FYD = join(ROOT, 'packages/core/kernel/host/fyd.ts');
const FY = join(ROOT, 'packages/cli/bin/fy.ts');
const STAMP = '2026-11-13T00:00:00.000Z';
const READY_MS = 90_000;

export interface SeededFerret {
  readonly id: string;
  readonly mode: 'auto' | 'interactive';
  /** The lead this ferret is a helper of. */
  readonly parent?: string;
}

interface RanFy {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** The stdout parsed as JSON when it is, else undefined. */
  readonly json: unknown;
}

export interface RealDaemon {
  readonly home: string;
  /** Stops the daemon and removes its home. */
  dispose(): Promise<void>;
  /** One owner request to the daemon's HTTP API (the admin bearer from the home's own token file), for what the CLI does not say. */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<{ status: number; text: string }>;
  /** Runs `fy <args>` as a ferret (`actor` is its id) or as the owner (`'owner'`). */
  fy(actor: string, args: readonly string[]): Promise<RanFy>;
}

/**
 * @param seed files (path under FY_HOME → text) written before the first boot: the state a ferret with no live agent cannot
 *   be made to produce (a message the owner sent it, which a daemon without a pane refuses to take).
 */
export async function bootRealDaemon(
  ferrets: readonly SeededFerret[],
  seed: Readonly<Record<string, string>> = {},
): Promise<RealDaemon> {
  const root = await mkdtemp(join(tmpdir(), 'fy-cli-real-'));
  const home = join(root, 'fy-home');
  const userHome = join(root, 'user-home');
  await mkdir(userHome, { recursive: true });
  for (const path of ['config', 'state/ferrets']) await mkdir(join(home, path), { recursive: true });
  await writeFile(
    join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'cli-real-daemon', createdAt: STAMP }),
  );
  for (const [path, text] of Object.entries(seed)) {
    await mkdir(join(home, path, '..'), { recursive: true });
    await writeFile(join(home, path), text);
  }
  const tokens: Record<string, string> = {};
  for (const ferret of ferrets) {
    await mkdir(join(home, 'state/ferrets', ferret.id), { recursive: true });
    const record = FerretRecordSchema.parse({
      format: 1,
      id: ferret.id,
      name: ferret.id,
      role: ferret.parent === undefined ? 'lead' : 'helper',
      ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
      mode: ferret.mode,
      harness: 'codex',
      runner: 'tmux',
      folder: root,
      state: 'idle',
      birth: 'person',
      createdAt: STAMP,
      stateAt: STAMP,
    });
    await writeFile(join(home, 'state/ferrets', ferret.id, 'ferret.json'), JSON.stringify(record));
    tokens[ferret.id] = `fys_${randomBytes(32).toString('base64url')}`;
  }
  await writeFile(
    join(home, 'state/ferrets/tokens.json'),
    JSON.stringify(
      FerretTokensSchema.parse({
        format: 1,
        tokens: Object.entries(tokens).map(([ferret, token]) => ({
          ferret,
          digest: createHash('sha256').update(token).digest('hex'),
          issuedAt: STAMP,
        })),
      }),
    ),
    { mode: 0o600 },
  );
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
  void pump(child.stderr);
  void pump(child.stdout);
  const dispose = async (): Promise<void> => {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  };
  const until = Date.now() + READY_MS;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`fyd exited ${String(child.exitCode)}: ${log.join('').slice(-1500)}`);
    await Bun.sleep(200);
  }
  if (!ready) {
    await dispose();
    throw new Error(`fyd was not ready in ${String(READY_MS)} ms: ${log.join('').slice(-1500)}`);
  }
  const run = JSON.parse(await readFile(join(home, 'run/daemon.json'), 'utf8')) as { port: number };
  const url = `http://127.0.0.1:${String(run.port)}`;
  const admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
  return {
    home,
    dispose,
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
    async fy(actor, args) {
      const proc = Bun.spawn({
        cmd: [process.execPath, FY, ...args],
        cwd: ROOT,
        env: {
          ...base,
          FY_URL: url,
          ...(actor === 'owner' ? {} : { FY_SESSION_ID: actor, FY_SESSION_TOKEN: tokens[actor] ?? '' }),
        },
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
