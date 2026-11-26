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
  /** Runs `fy <args>` as a seeded ferret, with its own session id and credential. */
  fyAs(ferret: string, args: readonly string[]): Promise<RanFy>;
}

/** A ferret to seed besides the always-present {@link SEEDED_FERRET}: a record and a bearer, with no harness or pane. */
export interface ExtraFerret {
  readonly id: string;
  /** The lead it is a helper of. */
  readonly parent?: string;
}

/**
 * @param seed files (path under FY_HOME → text) written before the first boot.
 * @param options.ferrets more seeded ferrets (their ids only; the first boot's session credential for each stays unread).
 * @param options.workOn start with Board and Agenda on (`config/plugins.yaml` `work: on`, off by default).
 */
export async function bootRealDaemon(
  seed: Readonly<Record<string, string>> = {},
  options: { readonly ferrets?: readonly ExtraFerret[]; readonly workOn?: boolean } = {},
): Promise<RealDaemon> {
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
  const extra = options.ferrets ?? [];
  const extraTokens = extra.map(ferret => ({ id: ferret.id, token: `fys_${randomBytes(32).toString('base64url')}` }));
  for (const ferret of extra) {
    await mkdir(join(home, 'state/ferrets', ferret.id), { recursive: true });
    await writeFile(
      join(home, 'state/ferrets', ferret.id, 'ferret.json'),
      JSON.stringify(
        FerretRecordSchema.parse({
          format: 1,
          id: ferret.id,
          name: ferret.id,
          role: ferret.parent === undefined ? 'lead' : 'helper',
          ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
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
  }
  await writeFile(
    join(home, 'state/ferrets/tokens.json'),
    JSON.stringify(
      FerretTokensSchema.parse({
        format: 1,
        tokens: [
          { ferret: SEEDED_FERRET, digest: createHash('sha256').update(ferretToken).digest('hex'), issuedAt: stamp },
          ...extraTokens.map(({ id, token }) => ({
            ferret: id,
            digest: createHash('sha256').update(token).digest('hex'),
            issuedAt: stamp,
          })),
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
  const log: string[] = [];
  /** Starts `fyd` on this home and waits until it is ready. */
  const start = async (): Promise<{ child: ReturnType<typeof Bun.spawn>; url: string; admin: string }> => {
    const spawned = Bun.spawn({
      cmd: [process.execPath, FYD],
      cwd: ROOT,
      env: { ...base, FY_PORT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let ready = false;
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        log.push(text);
        if (/\bfyd \S+ ready \(/u.test(text)) ready = true;
      }
    };
    void pump(spawned.stderr as ReadableStream<Uint8Array>);
    void pump(spawned.stdout as ReadableStream<Uint8Array>);
    const until = Date.now() + READY_MS;
    while (!ready && Date.now() < until) {
      if (spawned.exitCode !== null)
        throw new Error(`fyd exited ${String(spawned.exitCode)}: ${log.join('').slice(-1500)}`);
      await Bun.sleep(200);
    }
    if (!ready) {
      await stop(spawned);
      throw new Error(`fyd was not ready in ${String(READY_MS)} ms: ${log.join('').slice(-1500)}`);
    }
    const run = JSON.parse(await readFile(join(home, 'run/daemon.json'), 'utf8')) as { port: number };
    const adminToken = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
    return { child: spawned, url: `http://127.0.0.1:${String(run.port)}`, admin: adminToken };
  };
  const stop = async (proc: ReturnType<typeof Bun.spawn>): Promise<void> => {
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(10_000)]);
    proc.kill('SIGKILL');
  };
  let { child, url, admin } = await start();
  if (options.workOn === true) {
    // Turning `work` on is a loosening, held for a person; the host's admin token is that person at the machine, so it
    // applies at once, and the plugins it starts are chosen at boot, so the daemon restarts on it.
    const put = await fetch(`${url}/v1/config/file`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${admin}`, 'x-ferretry-client': 'cli', 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'plugins.yaml', text: 'work: on\n' }),
    });
    if (!put.ok) throw new Error(`turning work on failed (${String(put.status)}): ${await put.text()}`);
    await stop(child);
    ({ child, url, admin } = await start());
  }
  const tokens = new Map(extraTokens.map(({ id, token }) => [id, token]));
  tokens.set(SEEDED_FERRET, ferretToken);
  const runFy = async (actor: string, args: readonly string[]): Promise<RanFy> => {
    const proc = Bun.spawn({
      cmd: [process.execPath, FY, ...args],
      cwd: ROOT,
      env: {
        ...base,
        FY_URL: url,
        ...(actor === 'owner' ? {} : { FY_SESSION_ID: actor, FY_SESSION_TOKEN: tokens.get(actor) ?? '' }),
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
  };
  return {
    home,
    ferretToken,
    output: () => log.join(''),
    async dispose() {
      await stop(child);
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
    fy: args => runFy('owner', args),
    fyAs: runFy,
  };
}
