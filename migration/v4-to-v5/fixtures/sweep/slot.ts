#!/usr/bin/env bun
/**
 * One sweep slot: a RICH v4 home and the 5.0 conversion of it, each with its own daemon, side by side, so an agent can
 * walk every v4 screen and every v4 command against 5.0 ON THE SAME DATA.
 *
 *   bun slot.ts up   <1..9>     build (or rebuild) the pair and start both daemons
 *   bun slot.ts down <1..9> [--keep-files]
 *   bun slot.ts status <1..9>
 *   bun slot.ts cli  <1..9> <v4|v5> [args…]       the fy4s<N> / fy5s<N> wrappers call this
 *   bun slot.ts pair <1..9> <v4|v5>               opens ONE agent-browser tab already pairing (the link never appears here)
 *   bun slot.ts upgrade-v5 <1..9> <libexec-dir>   move ONLY the 5.0 daemon to a newer build, keeping its home, data and pairing
 *   bun slot.ts stamp-v5 <libexec-dir> <commit>   record which commit a 5.0 build came from (BUILD.json), for upgrade-v5
 *
 * Everything lives under SWEEP_ROOT/slot<N>/ (refused anywhere else, links resolved first). Ports: v4 is 7600+2N, 5.0 is
 * 7601+2N. Nothing here touches ~/.ferretry (v4, 7457), ~/.ferretry-v5 (the owner's preview, 7458) or v4's default 7431:
 * the port pin is written into each home BEFORE any daemon verb can run, and every wrapper reads it back from the home's
 * own files (never from FY_URL / FY_PORT) and refuses if it is not this slot's.
 *
 * Both daemons run with a private XDG_RUNTIME_DIR (no user systemd manager, no session bus), an EMPTY HOME, an allow-list
 * environment, their own tmux socket, and the fake claude/codex first on PATH. No real model is ever called.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path';
import {
  candidateRunIds,
  deployJobSucceeded,
  PREVIEW_BRANCHES,
  PREVIEW_DEPLOY_JOB,
  PREVIEW_DEPLOY_WORKFLOW,
} from './deploy-gate.ts';

const SWEEP_ROOT = '/tmp/claude-1000/sweep';
const FIXTURES = join(import.meta.dir, '..');
const CONVERTER = process.env.SWEEP_CONVERTER ?? join(FIXTURES, '..', 'src', 'main.ts');
/** The ports nobody here may ever reach: v4's default bind (a real daemon may run there), v4's own home, the owner's preview. */
const V5_PROGRAMS = ['fy', 'fyd', 'fyd-browser-worker'] as const;
/** Written beside the three programs when they are built (sweep-build-v5.sh / `stamp-v5`): which commit, and their sha256. */
const STAMP = 'BUILD.json';
const FORBIDDEN_PORTS = new Set([7431, 7457, 7458]);
const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The hosted relay is a real service the owner pays for (lead ruling 2026-11-13): it is OFF in a fake home unless the
 * sweeper switches it on for one side with SWEEP_RELAY_V4=on / SWEEP_RELAY_V5=on (only the access/connections sweep does).
 * "Off" is the explicit `{ kind: 'relay', source: 'discovery', enabled: false }` entry, never an omission, because an
 * omitted relay means the hosted default.
 */
const relayOn = (side: 'v4' | 'v5'): boolean => process.env[`SWEEP_RELAY_${side.toUpperCase()}`] === 'on';
const RELAY_OFF = { kind: 'relay', source: 'discovery', enabled: false } as const;
const ENV_PASSTHROUGH = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ'] as const;

type Which = 'v4' | 'v5';

// ─── the slot's world ────────────────────────────────────────────────────────────────────────────────────────────

interface Slot {
  readonly n: number;
  readonly dir: string;
  readonly v4Port: number;
  readonly v5Port: number;
  readonly v4: { out: string; home: string; lock: string; tmux: string };
  readonly v5: {
    dir: string;
    home: string;
    user: string;
    harness: string;
    runtime: string;
    bin: string;
    lock: string;
    tmux: string;
  };
  readonly bin: string;
}

function slotOf(n: number): Slot {
  const dir = join(SWEEP_ROOT, `slot${String(n)}`);
  const v4out = join(dir, 'v4');
  const v5dir = join(dir, 'v5');
  return {
    n,
    dir,
    v4Port: 7600 + 2 * n,
    v5Port: 7601 + 2 * n,
    v4: {
      out: v4out,
      home: join(v4out, 'home'),
      lock: join(v4out, 'home', 'daemon.lock'),
      tmux: join(v4out, 'home', 'tmux.sock'),
    },
    v5: {
      dir: v5dir,
      home: join(v5dir, 'home'),
      user: join(v5dir, 'user'),
      harness: join(v5dir, 'harness-bin'),
      runtime: join(v5dir, 'xdg-run'),
      bin: join(v5dir, 'bin'),
      lock: join(v5dir, 'home', 'run', 'daemon.lock'),
      tmux: join(v5dir, 'home', 'state', 'terminals', 'tmux.sock'),
    },
    bin: join(SWEEP_ROOT, 'bin'),
  };
}

function parseSlot(text: string | undefined): Slot {
  const n = Number(text);
  if (!SLOTS.includes(n as (typeof SLOTS)[number]))
    die(`slot must be one of ${SLOTS.join(', ')}, not "${String(text)}"`, 64);
  return slotOf(n);
}

/** A refusal or failure with the sentence to say and the exit code to leave with. */
class Failure extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function die(sentence: string, code = 1): never {
  throw new Failure(sentence, code);
}

/** The slot folder must be a real folder inside the sweep root: no link in the way, no `..`. Decided before any write. */
async function assertSlotPath(slot: Slot): Promise<void> {
  await mkdir(SWEEP_ROOT, { recursive: true, mode: 0o700 });
  const root = await realpath(SWEEP_ROOT);
  if (root !== SWEEP_ROOT) die(`refusing: ${SWEEP_ROOT} resolves to ${root}; the sweep root may not be a link`, 99);
  const existing = await lstat(slot.dir).catch(() => undefined);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) die(`refusing: ${slot.dir} is a symbolic link`, 99);
    const real = await realpath(slot.dir);
    const inside = relative(root, real);
    if (inside !== `slot${String(slot.n)}`)
      die(`refusing: ${slot.dir} resolves to ${real}, outside the slot folder`, 99);
  }
}

// ─── the port pin and the guard every wrapper runs ──────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The port a home's own files pin, read from the home and nothing else. `undefined` when it pins none. */
async function pinnedPort(slot: Slot, which: Which): Promise<{ port: number | undefined; others: number[] }> {
  const home = which === 'v4' ? slot.v4.home : slot.v5.home;
  const text = await readFile(join(home, 'config', 'daemon.json'), 'utf8').catch(() => undefined);
  if (text === undefined) return { port: undefined, others: [] };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { port: undefined, others: [] };
  }
  const ports: number[] = [];
  if (isRecord(document) && Array.isArray(document.carriers))
    for (const entry of document.carriers)
      if (isRecord(entry) && entry.kind === 'bind' && typeof entry.port === 'number') ports.push(entry.port);
  // 5.0 only: connections.yaml, when it names ports, may name only this slot's.
  const others: number[] = [];
  if (which === 'v5') {
    const connections = await readFile(join(home, 'config', 'connections.yaml'), 'utf8').catch(() => '');
    for (const match of connections.matchAll(/^\s*port:\s*(\d+)/gmu)) others.push(Number(match[1]));
  }
  return { port: ports.length === 1 ? ports[0] : undefined, others };
}

/** Refuses (exit 99, a loud sentence) unless the home pins exactly this slot's port for this side. Returns the port. */
async function guard(slot: Slot, which: Which): Promise<number> {
  const expected = which === 'v4' ? slot.v4Port : slot.v5Port;
  const { port, others } = await pinnedPort(slot, which);
  const where = join(which === 'v4' ? slot.v4.home : slot.v5.home, 'config', 'daemon.json');
  const refuse = (why: string): never =>
    die(
      `SWEEP GUARD REFUSED (slot ${String(slot.n)} ${which}): ${why}. A ${which === 'v4' ? 'v4' : '5.0'} daemon verb finds its daemon from the home's own files, not from FY_URL/FY_PORT, and with no pin it would resolve to ${which === 'v4' ? '7431 (a real daemon may run there)' : 'its default'}. Nothing was run.`,
      99,
    );
  if (port === undefined) refuse(`${where} pins no single bind port`);
  if (FORBIDDEN_PORTS.has(port as number))
    refuse(`${where} pins ${String(port)}, a port this kit never touches (7431, 7457, 7458)`);
  if (port !== expected) refuse(`${where} pins ${String(port)}, not this slot's ${String(expected)}`);
  for (const other of others)
    if (other !== expected) refuse(`connections.yaml names port ${String(other)}, not this slot's ${String(expected)}`);
  return expected;
}

// ─── the environment a daemon or a command gets ─────────────────────────────────────────────────────────────────

/** An allow-list: only what is named here exists. Nothing ambient (FY_*, DBUS, SSH, tokens, GH_*, CLAUDE*, CODEX*) passes. */
function baseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.LANG ??= 'C.UTF-8';
  env.NO_COLOR = '1';
  return env;
}

const richHelpers = (): Record<string, string> => ({
  FY_FIXTURE_RICH: '1',
  FY_FIXTURE_BUN: process.execPath,
  FY_FIXTURE_HELPER: join(FIXTURES, 'support', 'fake-claude-rich.ts'),
});

function daemonEnvironment(slot: Slot, which: Which): Record<string, string> {
  const world =
    which === 'v4'
      ? {
          user: join(slot.v4.out, 'user'),
          harness: join(slot.v4.out, 'harness-bin'),
          runtime: join(slot.v4.out, 'xdg-runtime'),
          home: slot.v4.home,
          logs: slot.v4.out,
        }
      : {
          user: slot.v5.user,
          harness: slot.v5.harness,
          runtime: slot.v5.runtime,
          home: slot.v5.home,
          logs: slot.v5.dir,
        };
  const base = baseEnvironment();
  return {
    ...base,
    HOME: world.user,
    XDG_CONFIG_HOME: join(world.user, '.config'),
    XDG_CACHE_HOME: join(world.user, '.cache'),
    XDG_STATE_HOME: join(world.user, '.local', 'state'),
    XDG_RUNTIME_DIR: world.runtime,
    FY_HOME: world.home,
    PATH: [world.harness, base.PATH ?? ''].join(':'),
    FERRETRY_TEST: '1',
    FY_UPDATE_CHECK: 'off',
    FY_LOCAL_MODELS: 'off',
    // The v4 hosted app reaches a daemon ONLY through the hosted relay (it never dials 127.0.0.1 itself), so the v4 daemon keeps
    // its default directory and dials it ONLY when SWEEP_RELAY_V4=on (relayOn). The 5.0 side gets its OWN identity (freshIdentityForV5): the converter carries v4's,
    // and a rendezvous holds one claim per identity, so two daemons under one identity would answer each other's apps.
    FY_CLAUDE_BIN: join(world.harness, 'claude'),
    FY_CODEX_BIN: join(world.harness, 'codex'),
    FY_E2E_FAKE_CLAUDE_LOG: join(world.logs, 'fake-claude.log'),
    FY_E2E_FAKE_CODEX_LOG: join(world.logs, 'fake-codex.log'),
    ...richHelpers(),
  };
}

// ─── programs ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The released v4 `fy`/`fyd` the owner runs: a folder of links to them, made once. Returns the folder and its version. */
async function v4Programs(): Promise<{ dir: string; version: string }> {
  const dir = join(SWEEP_ROOT, 'v4bin');
  await mkdir(dir, { recursive: true });
  for (const name of ['fy', 'fyd', 'fyd-browser-worker']) {
    const found = Bun.which(name);
    if (found === null && name !== 'fyd-browser-worker')
      die(`${name} is not on PATH; the sweep needs the installed v4 release`, 69);
    if (found === null) continue;
    const real = await realpath(found);
    const target = join(dir, name);
    const current = await readlink(target).catch(() => undefined);
    if (current !== real) {
      await rm(target, { force: true });
      await symlink(real, target);
    }
  }
  const ran = Bun.spawnSync([join(dir, 'fyd'), '--version'], { env: baseEnvironment() });
  const version = /\b(\d+\.\d+\.\d+)\b/u.exec(new TextDecoder().decode(ran.stdout))?.[1];
  if (version === undefined || !version.startsWith('4.')) die(`${join(dir, 'fyd')} does not report a 4.x version`, 69);
  return { dir, version };
}

/**
 * The 5.0 binaries, COPIED from a libexec folder (default: the owner's preview libexec; read-only use, never run from there)
 * into THIS SLOT'S OWN folder, so that upgrading one slot (upgrade-v5) can never change another slot's programs. The build
 * stamp (BUILD.json) comes along when the source has one.
 */
async function v5Programs(slot: Slot): Promise<string> {
  const dir = slot.v5.bin;
  const source = process.env.FY_V5_LIBEXEC ?? join(process.env.HOME ?? '', '.ferretry-v5', 'libexec');
  await mkdir(dir, { recursive: true });
  for (const name of [...V5_PROGRAMS, STAMP]) {
    const from = join(source, name);
    if ((await lstat(from).catch(() => undefined)) === undefined) {
      if (name === 'fyd-browser-worker' || name === STAMP) continue;
      die(`${from} is missing; build 5.0 first or set FY_V5_LIBEXEC to a folder holding its fy and fyd`, 69);
    }
    await copyFile(from, join(dir, name));
    await chmod(join(dir, name), name === STAMP ? 0o644 : 0o755);
  }
  return dir;
}

/**
 * The folder whose `fy` a wrapper runs for this slot: the slot's own folder; for a slot built by an older kit (shared or
 * hand-patched bin folder) the folder its RUNNING daemon was started from, which is what its wrapper was patched to use too;
 * last, the old shared one.
 */
async function v5Fy(slot: Slot): Promise<string> {
  const own = join(slot.v5.bin, 'fy');
  if ((await lstat(own).catch(() => undefined)) !== undefined) return own;
  const running = await daemonExecutable(slot);
  if (running !== undefined) return join(dirname(running), 'fy');
  return join(SWEEP_ROOT, 'bin5', 'fy');
}

// ─── running things ──────────────────────────────────────────────────────────────────────────────────────────────

async function run(
  program: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([program, ...args], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

async function portFree(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolveFree => {
    const server = createNetServer();
    server.once('error', () => resolveFree(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolveFree(true)));
  });
}

/** Pids that hold `lockFile` open, read from /proc/<pid>/fd link targets only. */
async function pidsHolding(lockFile: string): Promise<number[]> {
  const held: number[] = [];
  for (const name of (await readdir('/proc').catch(() => [] as string[])).filter(entry => /^\d+$/u.test(entry))) {
    for (const fd of await readdir(`/proc/${name}/fd`).catch(() => [] as string[])) {
      if ((await readlink(`/proc/${name}/fd/${fd}`).catch(() => '')) === lockFile) {
        held.push(Number(name));
        break;
      }
    }
  }
  return held;
}

async function waitUntil(label: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) die(`${label} did not happen within ${String(Math.round(ms / 1000))} s`, 1);
    await Bun.sleep(400);
  }
}

function startDaemon(
  program: string,
  port: number,
  env: Record<string, string>,
  logFile: string,
  cwd: string,
): ChildProcess {
  const fd = openSync(logFile, 'a', 0o600);
  const child = spawn(program, ['--host', '127.0.0.1', '--port', String(port)], {
    env,
    cwd,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);
  child.unref();
  return child;
}

async function stopByLock(lock: string, label: string): Promise<void> {
  const pids = await pidsHolding(lock);
  if (pids.length === 0) {
    console.log(`  ${label}: no process holds ${lock}`);
    return;
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 25_000;
  while ((await pidsHolding(lock)).length > 0 && Date.now() < deadline) await Bun.sleep(400);
  const left = await pidsHolding(lock);
  for (const pid of left) process.kill(pid, 'SIGKILL');
  console.log(`  ${label}: stopped pid ${pids.join(', ')}${left.length > 0 ? ' (needed SIGKILL)' : ''}`);
}

async function killTmux(socket: string, label: string): Promise<void> {
  const tmux = Bun.which('tmux');
  if (tmux === null || (await lstat(socket).catch(() => undefined)) === undefined) return;
  const ran = await run(tmux, ['-S', socket, 'kill-server'], baseEnvironment());
  console.log(`  ${label}: tmux server on its own socket ${ran.code === 0 ? 'killed' : 'was not running'}`);
}

// ─── up ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function up(slot: Slot, reuse: boolean): Promise<void> {
  try {
    await upInner(slot, reuse);
  } catch (error) {
    // A half-built slot must not leave a daemon or a tmux server behind: stop what this slot started, keep its logs.
    await down(slot, { keepFiles: true, quiet: true }).catch(() => undefined);
    throw error;
  }
}

async function upInner(slot: Slot, reuse: boolean): Promise<void> {
  await assertSlotPath(slot);
  if ((await pidsHolding(slot.v4.lock)).length + (await pidsHolding(slot.v5.lock)).length > 0)
    die(`slot ${String(slot.n)} is already up; run sweep-down.sh ${String(slot.n)} first (or use it as it is)`);
  for (const port of [slot.v4Port, slot.v5Port])
    if (!(await portFree(port)))
      die(`port ${String(port)} is taken by something else; slot ${String(slot.n)} cannot start`);
  // --reuse (for fixing this kit, not for sweeping): keep a v4 build that finished and redo everything after it. Its panes are
  // gone with the old tmux server, so v4 revives its ferrets as it would after a restart; it is NOT a fresh identical pair.
  const kept =
    reuse && (await readFile(join(slot.v4.out, 'made.json'), 'utf8').catch(() => '')).includes('"complete": true');
  if (kept) await rm(slot.v5.dir, { recursive: true, force: true });
  else await rm(slot.dir, { recursive: true, force: true });
  await mkdir(slot.dir, { recursive: true, mode: 0o700 });
  await assertSlotPath(slot);
  const started = Date.now();
  const { dir: v4Dir, version } = await v4Programs();
  const v5Bin = await v5Programs(slot);
  console.log(`slot ${String(slot.n)}: building a RICH v4 ${version} home (this takes several minutes) …`);

  // 1. The rich v4 home, through v4's own CLI, with the panes left running.
  const build = kept
    ? { code: 0, out: '', err: '' }
    : await run(
        process.execPath,
        [
          join(FIXTURES, 'build-v4-home.ts'),
          '--out',
          slot.v4.out,
          '--v4-dir',
          v4Dir,
          '--v4-version',
          version,
          '--rich',
          '--keep-panes',
          '--port',
          String(slot.v4Port),
        ],
        baseEnvironment(),
      );
  if (!kept) await writeFile(join(slot.dir, 'build.log'), build.out + build.err, { mode: 0o600 });
  if (build.code !== 0) {
    die(`the rich v4 build failed (exit ${String(build.code)}); its log is ${join(slot.dir, 'build.log')}`);
  }

  // 2. The port pin, written into the v4 home BEFORE any daemon verb can run; limits OFF and accepted; the orphaned Chrome stopped.
  await pinV4(slot);
  await limitsOffV4(slot);
  await stopSlotChrome(slot, 'v4 build');

  // 3. A COPY of the (stopped) v4 home goes through the converter. The copy leaves sockets and locks behind.
  const copy = join(slot.v5.dir, 'conv-src');
  await mkdir(slot.v5.dir, { recursive: true, mode: 0o700 });
  await cp(slot.v4.home, copy, {
    recursive: true,
    preserveTimestamps: true,
    filter: source => !/\.(sock|lock)$/u.test(source),
  });
  await workaroundMovedHome(copy, slot.v4.home);
  await settleCopyForThisSlot(copy, slot);
  const conversion = await run(
    process.execPath,
    [CONVERTER, '--from', copy, '--to', slot.v5.home, '--report', join(slot.v5.dir, 'conversion-report.json')],
    baseEnvironment(),
    join(FIXTURES, '..'),
  );
  await writeFile(join(slot.v5.dir, 'conversion.log'), conversion.out + conversion.err, { mode: 0o600 });
  console.log(
    `  converter: exit ${String(conversion.code)} (${conversion.code === 0 ? 'complete' : 'some step pending: see ' + join(slot.v5.dir, 'conversion.log')})`,
  );

  // 4. The 5.0 world: an empty HOME, no systemd manager, the fake harness, the port pin, relay switched off.
  for (const folder of [slot.v5.user, slot.v5.runtime, slot.v5.harness])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const name of ['claude', 'codex']) {
    await copyFile(join(slot.v4.out, 'harness-bin', name), join(slot.v5.harness, name));
    await chmod(join(slot.v5.harness, name), 0o755);
  }
  await freshIdentityForV5(slot);
  await pinV5(slot);
  await verifyLimitsOffV5(slot);

  // 5. Both daemons. v4 first (its panes are still in the builder's tmux server, which it adopts).
  startDaemon(
    join(v4Dir, 'fyd'),
    slot.v4Port,
    daemonEnvironment(slot, 'v4'),
    join(slot.v4.out, 'fyd.log'),
    join(slot.v4.out, 'work'),
  );
  await waitUntil(
    'the v4 daemon serving',
    90_000,
    async () =>
      (await fetch(`http://127.0.0.1:${String(slot.v4Port)}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok,
  );
  startDaemon(
    join(v5Bin, 'fyd'),
    slot.v5Port,
    daemonEnvironment(slot, 'v5'),
    join(slot.v5.dir, 'fyd.log'),
    slot.v5.user,
  );
  await waitUntil(
    'the 5.0 daemon serving',
    180_000,
    async () =>
      (await fetch(`http://127.0.0.1:${String(slot.v5Port)}/healthz`, { signal: AbortSignal.timeout(2000) })).ok,
  );

  // 6. The wrappers, then the one setting lizzette's rehearsal ruling allows on the 5.0 FAKE home.
  await stopSlotChrome(slot, 'up');
  await writeWrappers(slot);
  const note: Record<string, unknown> = { slot: slot.n, builtAt: new Date().toISOString(), v4Version: version };
  const before = await cli(slot, 'v5', ['daemon', 'security', 'show']);
  note.unlockOnOpenBefore = (before.out + before.err).trim().slice(0, 400);
  const set = await cli(slot, 'v5', ['daemon', 'security', 'set', 'unlockOnOpen', 'off']);
  note.unlockOnOpenSet = { exit: set.code, said: (set.out + set.err).trim().slice(0, 300) };
  await writeFile(join(slot.dir, 'slot.json'), `${JSON.stringify(note, null, 2)}\n`, { mode: 0o600 });

  console.log(`\nslot ${String(slot.n)} is up (${String(Math.round((Date.now() - started) / 1000))} s)\n`);
  await status(slot);
}

/**
 * WORKAROUND — REMOVE THIS STEP once the converter accepts a moved home (hsm round 2; the migration prompt's own `mv H B`
 * then `--from B` hits the same refusal). SWEEP.md says so too.
 *
 * A v4 home names itself by ABSOLUTE path (the harness-home entries of fleet/manifest.json, each ferret's transcript home).
 * The converter reads a home where it is, and refuses one whose own record of where it lives disagrees ("runtime identity
 * mismatch"), so the COPY is told it lives where it now does. Only JSON documents are touched, only in the copy, and
 * never the browser profile; the v4 home itself is left exactly as the builder made it.
 */
async function workaroundMovedHome(copy: string, original: string): Promise<void> {
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'browser') await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const text = await readFile(path, 'utf8');
        if (text.includes(original)) await writeFile(path, text.split(original).join(copy));
      }
    }
  };
  await walk(copy);
}

/**
 * The COPY is told what this slot's 5.0 side must be, BEFORE the converter reads it, so the converter carries it as
 * written and records it as accepted (an edit made to the converted home afterwards would be HELD for the owner, and the
 * held one would not govern): the bind port is the slot's 5.0 port, and WebRTC is off (no STUN server is asked). The relay is OFF unless SWEEP_RELAY_V5=on (then the hosted
 * relay, which both hosted apps can reach a daemon through).
 */
async function settleCopyForThisSlot(copy: string, slot: Slot): Promise<void> {
  const file = join(copy, 'config', 'daemon.json');
  const document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  document.carriers = [{ kind: 'bind', host: '127.0.0.1', port: slot.v5Port }, ...(relayOn('v5') ? [] : [RELAY_OFF])];
  const webrtc = isRecord(document.webrtc) ? document.webrtc : {};
  document.webrtc = { ...webrtc, enabled: false };
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The converter carries v4's daemon identity into the 5.0 home (right for a real migration, wrong for two daemons on one
 * machine): the hosted relay holds ONE claim per identity, so with a shared identity the 5.0 hosted app, dialling by
 * fingerprint, lands on the v4 daemon and is told "this machine no longer accepts this browser". The 5.0 side therefore
 * starts under a fresh identity of its own (the daemon makes one when none exists). The paired devices the converter carried are dropped with it
 * (listed under known limits in SWEEP.md); signed catalog entries naming the old identity stay as converted.
 */
async function freshIdentityForV5(slot: Slot): Promise<void> {
  await rm(join(slot.v5.home, 'state', 'kernel', 'identity.json'), { force: true });
  // Access refuses device grants that belong to a different identity, so the carried device records go with it.
  await rm(join(slot.v5.home, 'state', 'access', 'devices.json'), { force: true });
}

/**
 * Ferret limits are OFF in a sandbox, and that is ACCEPTED, before any daemon starts. Limits launch every ferret of EVERY daemon
 * this Linux user runs into ONE shared `<product>_fleet.slice` and correct that slice's properties at each launch, so a sandbox
 * daemon would run its fake ferrets beside the owner's REAL ones and could re-set the caps they live under. Writing
 * `enabled: false` alone is not enough: switching limits off is a loosening, and a home that has an accepted-config record HOLDS
 * it for the owner (the limits stay ON). So the kit also records the file as accepted, the way v4 does
 * (`state/config-accepted.json`, `{ "limits.yaml": { etag: sha256(text), text } }`, merged into what is there). This is fixture
 * setup in a FAKE home the kit made, like the rehearsal's --owner. It is done in the v4 home, with its daemon stopped, BEFORE the
 * copy, so the converter carries the file and its acceptance into the 5.0 home (verified by `sweep-up.sh`, see verifyLimitsOff).
 */
const LIMITS_OFF_TEXT = 'enabled: false\n';

async function limitsOffV4(slot: Slot): Promise<void> {
  const file = join(slot.v4.home, 'config', 'limits.yaml');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, LIMITS_OFF_TEXT, { mode: 0o600 });
  const record = join(slot.v4.home, 'state', 'config-accepted.json');
  const parsed: unknown = JSON.parse((await readFile(record, 'utf8').catch(() => '{}')) || '{}');
  const accepted = isRecord(parsed) ? parsed : {};
  accepted['limits.yaml'] = {
    etag: createHash('sha256').update(LIMITS_OFF_TEXT, 'utf8').digest('hex'),
    text: LIMITS_OFF_TEXT,
  };
  await mkdir(dirname(record), { recursive: true, mode: 0o700 });
  await writeFile(record, `${JSON.stringify(accepted, null, 2)}\n`, { mode: 0o600 });
}

/** The 5.0 side must carry the same: the converted file says off, and its accepted record holds that text. */
async function verifyLimitsOffV5(slot: Slot): Promise<void> {
  const text = await readFile(join(slot.v5.home, 'config', 'limits.yaml'), 'utf8').catch(() => '');
  const dir = join(slot.v5.home, 'state', 'kernel', 'accepted-config');
  const records = await readdir(dir).catch(() => [] as string[]);
  const name = records.find(entry => entry.startsWith('limits.yaml'));
  const recordText =
    name === undefined ? '' : ((JSON.parse(await readFile(join(dir, name), 'utf8')) as { text?: string }).text ?? '');
  if (!/^enabled:\s*false\s*$/mu.test(text) || !/^enabled:\s*false\s*$/mu.test(recordText))
    die(
      `the 5.0 home does not carry "limits off, accepted" (config/limits.yaml: ${text === '' ? 'absent' : 'present'}, accepted record: ${name ?? 'absent'}); a sandbox daemon would share the owner's fleet slice`,
    );
}

/**
 * K1: the rich fixture leaves a headless Chrome on the v4 browser profile; v4 then refuses `browser page open` ("live orphaned
 * Chrome pid"). Stops ONLY Chrome processes whose own `--user-data-dir` is inside this slot's folder (read from each candidate's
 * command line, never matched by name alone).
 */
async function stopSlotChrome(slot: Slot, label: string): Promise<void> {
  const prefix = `--user-data-dir=${slot.dir}${'/'}`;
  const listed = await run('pgrep', ['-f', '--', `--user-data-dir=${slot.dir}/`], baseEnvironment());
  const mine: number[] = [];
  for (const text of listed.out.split('\n')) {
    const pid = Number.parseInt(text, 10);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const argv = (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (argv.some(arg => arg.startsWith(prefix))) mine.push(pid);
  }
  if (mine.length === 0) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of mine)
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log(
    `  ${label}: stopped ${String(mine.length)} headless Chrome process(es) on this slot's own browser profile`,
  );
}

/** The v4 home pins its bind port: written by this kit, once, with the daemon stopped. */
async function pinV4(slot: Slot): Promise<void> {
  const file = join(slot.v4.home, 'config', 'daemon.json');
  const document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const carriers = (Array.isArray(document.carriers) ? (document.carriers as Record<string, unknown>[]) : []).filter(
    entry => relayOn('v4') || entry.kind !== 'relay',
  );
  if (!relayOn('v4')) carriers.push({ ...RELAY_OFF });
  const bind = carriers.find(entry => entry.kind === 'bind');
  if (bind === undefined) carriers.unshift({ kind: 'bind', host: '127.0.0.1', port: slot.v4Port });
  else {
    bind.host = '127.0.0.1';
    bind.port = slot.v4Port;
  }
  document.carriers = carriers;
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await guard(slot, 'v4');
}

/** The 5.0 home pins its bind port and switches the hosted relay OFF (direct only, nothing leaves this machine). */
async function pinV5(slot: Slot): Promise<void> {
  const file = join(slot.v5.home, 'config', 'daemon.json');
  const document =
    (JSON.parse((await readFile(file, 'utf8').catch(() => '{}')) || '{}') as Record<string, unknown>) ?? {};
  document.carriers = [{ kind: 'bind', host: '127.0.0.1', port: slot.v5Port }];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await guard(slot, 'v5');
}

// ─── the wrappers ────────────────────────────────────────────────────────────────────────────────────────────────

async function writeWrappers(slot: Slot): Promise<void> {
  await mkdir(slot.bin, { recursive: true });
  for (const which of ['v4', 'v5'] as const) {
    const name = `fy${which === 'v4' ? '4' : '5'}s${String(slot.n)}`;
    const path = join(slot.bin, name);
    await writeFile(
      path,
      `#!/bin/sh\n# ${name}: the ${which === 'v4' ? 'v4' : '5.0'} CLI pointed at sweep slot ${String(slot.n)}. Generated by sweep-up.sh; it refuses unless the home pins this slot's port.\nexec '${process.execPath}' '${join(import.meta.dir, 'slot.ts')}' cli ${String(slot.n)} ${which} "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(path, 0o755);
  }
}

/** One `fy` command against the slot's v4 or 5.0 home, after the guard. The only thing a wrapper runs. */
async function cli(
  slot: Slot,
  which: Which,
  args: readonly string[],
  inherit = false,
): Promise<{ code: number; out: string; err: string }> {
  const port = await guard(slot, which);
  const program = which === 'v4' ? join(SWEEP_ROOT, 'v4bin', 'fy') : await v5Fy(slot);
  const env = { ...baseEnvironment(), ...slotCliEnvironment(slot, which, port) };
  if (which === 'v4') {
    const token = (await readFile(join(slot.v4.home, 'api-token'), 'utf8').catch(() => '')).trim();
    if (token !== '') env.FY_TOKEN = token;
  }
  if (!inherit) return await run(program, args, env, join(slot.v4.out, 'work'));
  const child = Bun.spawn([program, ...args], {
    env,
    cwd: join(slot.v4.out, 'work'),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return { code: await child.exited, out: '', err: '' };
}

function slotCliEnvironment(slot: Slot, which: Which, port: number): Record<string, string> {
  const daemon = daemonEnvironment(slot, which);
  return {
    HOME: daemon.HOME ?? '',
    XDG_CONFIG_HOME: daemon.XDG_CONFIG_HOME ?? '',
    XDG_RUNTIME_DIR: daemon.XDG_RUNTIME_DIR ?? '',
    FY_HOME: daemon.FY_HOME ?? '',
    FY_PORT: String(port),
    FY_URL: `http://127.0.0.1:${String(port)}`,
    FY_UPDATE_CHECK: 'off',
    FY_LOCAL_MODELS: 'off',
    FERRETRY_TEST: '1',
    FY_CLAUDE_BIN: daemon.FY_CLAUDE_BIN ?? '',
    FY_CODEX_BIN: daemon.FY_CODEX_BIN ?? '',
  };
}

// ─── status, down ────────────────────────────────────────────────────────────────────────────────────────────────

async function status(slot: Slot): Promise<void> {
  const v4Up = (await pidsHolding(slot.v4.lock)).length > 0;
  const v5Up = (await pidsHolding(slot.v5.lock)).length > 0;
  const n = String(slot.n);
  console.log(`slot ${n}   v4 daemon: ${v4Up ? 'UP' : 'down'}   5.0 daemon: ${v5Up ? 'UP' : 'down'}`);
  console.log(
    `  v4   http://127.0.0.1:${String(slot.v4Port)}    app: https://ferretry.pages.dev/app/    CLI: fy4s${n}   home: ${slot.v4.home}`,
  );
  console.log(
    `  5.0  http://127.0.0.1:${String(slot.v5Port)}    app: https://ferretry-v5.pages.dev/app/    CLI: fy5s${n}   home: ${slot.v5.home}`,
  );
  console.log(`  put ${slot.bin} first on PATH to use fy4s${n} / fy5s${n}`);
  console.log(`  pair an agent browser (the link never reaches a tool argument or result):`);
  console.log(
    `    bun ${join(import.meta.dir, 'slot.ts')} pair ${n} v4      then   bun ${join(import.meta.dir, 'slot.ts')} pair ${n} v5`,
  );
  console.log(
    `  each prints one loopback URL; open ONLY that in the agent browser and click the button: the app opens in a new tab`,
  );
}

async function down(slot: Slot, options: { keepFiles: boolean; quiet?: boolean }): Promise<void> {
  await assertSlotPath(slot);
  if (options.quiet !== true) console.log(`slot ${String(slot.n)}: stopping`);
  await stopByLock(slot.v5.lock, '5.0 daemon');
  await stopByLock(slot.v4.lock, 'v4 daemon');
  await killTmux(slot.v5.tmux, '5.0');
  await killTmux(slot.v4.tmux, 'v4');
  await stopSlotChrome(slot, 'down');
  for (const which of ['4', '5']) await rm(join(slot.bin, `fy${which}s${String(slot.n)}`), { force: true });
  if (!options.keepFiles) await rm(slot.dir, { recursive: true, force: true });
  if (options.quiet !== true)
    console.log(`slot ${String(slot.n)}: down${options.keepFiles ? ' (files kept)' : ' and removed'}`);
}

// ─── upgrade-v5: move ONLY the 5.0 daemon to a newer build ───────────────────────────────────────────────────────

/** The program the slot's running 5.0 daemon was started from (its own /proc exe link), or undefined when it is down. */
async function daemonExecutable(slot: Slot): Promise<string | undefined> {
  for (const pid of await pidsHolding(slot.v5.lock)) {
    const exe = (await readlink(`/proc/${String(pid)}/exe`).catch(() => '')).replace(/ \(deleted\)$/u, '');
    if (exe !== '' && basename(exe) === 'fyd') return exe;
  }
  return undefined;
}

const sha256File = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

interface Stamp {
  readonly commit: string;
  readonly sha256: Readonly<Record<string, string>>;
}

/** The build stamp beside a set of 5.0 programs, or undefined when there is none or it is not a stamp. */
async function readStamp(dir: string): Promise<Stamp | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, STAMP), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.commit))
    return undefined;
  if (!isRecord(parsed.sha256)) return undefined;
  const sha256: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.sha256)) if (typeof value === 'string') sha256[name] = value;
  return { commit: parsed.commit, sha256 };
}

/**
 * `stamp-v5 <libexec-dir> <commit>`: records WHICH COMMIT the three programs in a folder were built from, and their sha256, in
 * BUILD.json beside them. sweep-build-v5.sh calls it right after compiling (the commit is the one it checked out). upgrade-v5
 * trusts the stamp only while the programs still hash to what it says, so a stamp cannot ride along with other binaries.
 */
async function stampV5(dirArg: string | undefined, commitArg: string | undefined): Promise<void> {
  if (dirArg === undefined || commitArg === undefined) die('usage: slot.ts stamp-v5 <libexec-dir> <commit>', 64);
  const dir = resolve(dirArg);
  const resolved = await run(
    'git',
    ['rev-parse', '--verify', `${commitArg}^{commit}`],
    process.env as Record<string, string>,
    FIXTURES,
  );
  const commit = resolved.out.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit))
    die(`"${commitArg}" is not a commit in this repository`, 64);
  const sha256: Record<string, string> = {};
  for (const name of V5_PROGRAMS) {
    const path = join(dir, name);
    if ((await lstat(path).catch(() => undefined))?.isFile() !== true)
      die(`${path} is missing or not a regular file`, 69);
    sha256[name] = await sha256File(path);
  }
  await writeFile(
    join(dir, STAMP),
    `${JSON.stringify({ commit, builtAt: new Date().toISOString(), sha256 }, null, 2)}\n`,
  );
  console.log(`stamped ${dir}: commit ${commit}`);
}

/**
 * The new build, checked before anything is stopped: three regular files; `fy` and `fyd` report a 5.x version (the browser
 * worker takes no `--version`: it is only required to exist and to be the one the stamp hashed); and a BUILD.json whose commit
 * the programs still hash to.
 */
async function checkNewBuild(slot: Slot, libexec: string): Promise<Stamp> {
  for (const name of V5_PROGRAMS) {
    const path = join(libexec, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) die(`refusing: ${path} is missing or not a regular file (no links)`);
  }
  const probe = join(slot.dir, 'upgrade-probe');
  await mkdir(probe, { recursive: true, mode: 0o700 });
  try {
    for (const name of ['fy', 'fyd']) {
      const ran = await run(
        join(libexec, name),
        ['--version'],
        { ...baseEnvironment(), HOME: probe, FY_HOME: join(probe, 'home') },
        probe,
      );
      const version = /\b(\d+\.\d+\.\d+)\b/u.exec(ran.out)?.[1];
      if (version === undefined || !version.startsWith('5.'))
        die(
          `refusing: ${join(libexec, name)} does not report a 5.x version (it said "${ran.out.trim().slice(0, 80)}")`,
        );
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  const stamp = await readStamp(libexec);
  if (stamp === undefined)
    die(
      `refusing: ${join(libexec, STAMP)} is missing, so nobody can say which commit this build is. Build it with sweep-build-v5.sh, or record it with: bun ${join(import.meta.dir, 'slot.ts')} stamp-v5 ${libexec} <commit>`,
    );
  for (const name of V5_PROGRAMS)
    if (stamp.sha256[name] !== (await sha256File(join(libexec, name))))
      die(
        `refusing: ${name} in ${libexec} is not the program ${STAMP} was written for (its sha256 differs); stamp it again if you rebuilt it`,
      );
  return stamp;
}

/**
 * The hosted 5.0 app must already be live for the commit, or the app would say "Reload to get the new app". Read-only `gh`.
 * The rule (deploy-gate.ts): a successful preview Pages run for this exact commit on `rebuild/5.0` or `rebuild/5.0-after`
 * whose `Deploy PWA` job itself succeeded; a run whose deploy was skipped (the never-backwards skip) deployed nothing.
 */
async function assertPagesDeployLive(commit: string): Promise<void> {
  const env = process.env as Record<string, string>;
  const ran = await run(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      PREVIEW_DEPLOY_WORKFLOW,
      '--limit',
      '300',
      '--json',
      'databaseId,headSha,conclusion,headBranch',
    ],
    env,
    FIXTURES,
  );
  if (ran.code !== 0)
    die(
      `refusing: could not read the Pages deploy runs with gh (exit ${String(ran.code)}: ${ran.err.trim().slice(0, 200)}), so I cannot say commit ${commit.slice(0, 10)} is live`,
    );
  let runs: unknown;
  try {
    runs = JSON.parse(ran.out);
  } catch {
    die('refusing: gh did not return the deploy runs as JSON');
  }
  for (const id of candidateRunIds(runs, commit).slice(0, 10)) {
    const viewed = await run('gh', ['run', 'view', String(id), '--json', 'jobs'], env, FIXTURES);
    if (viewed.code !== 0)
      die(
        `refusing: could not read the jobs of Pages deploy run ${String(id)} with gh (exit ${String(viewed.code)}: ${viewed.err.trim().slice(0, 200)}), so I cannot say commit ${commit.slice(0, 10)} is live`,
      );
    let view: unknown;
    try {
      view = JSON.parse(viewed.out);
    } catch {
      die(`refusing: gh did not return the jobs of run ${String(id)} as JSON`);
    }
    if (deployJobSucceeded(view)) return;
  }
  die(
    `refusing: commit ${commit.slice(0, 10)} has no successful "${PREVIEW_DEPLOY_WORKFLOW}" run on ${PREVIEW_BRANCHES.join(' or ')} whose "${PREVIEW_DEPLOY_JOB}" job succeeded (a run whose deploy was skipped does not count), so the hosted app does not match it; nothing was stopped`,
  );
}

async function upgradeV5(slot: Slot, libexecArg: string | undefined): Promise<void> {
  if (libexecArg === undefined) die('usage: slot.ts upgrade-v5 <1..9> <libexec-dir>', 64);
  const n = String(slot.n);
  await assertSlotPath(slot);
  await guard(slot, 'v5');
  const running = await daemonExecutable(slot);
  if (running === undefined)
    die(`refusing: slot ${n}'s 5.0 side is not up (no fyd holds ${slot.v5.lock}); start it with sweep-up.sh first`);
  const bin = dirname(running);
  if (relative(SWEEP_ROOT, bin).startsWith('..') || isAbsolute(relative(SWEEP_ROOT, bin)))
    die(
      `refusing: slot ${n}'s daemon runs from ${bin}, outside ${SWEEP_ROOT}; this command only rewrites programs inside the sweep root`,
      99,
    );
  const libexec = resolve(libexecArg);
  if (libexec === bin) die('refusing: the new build folder is the folder the daemon already runs from');
  for (const other of SLOTS) {
    if (other === slot.n) continue;
    const exe = await daemonExecutable(slotOf(other));
    if (exe !== undefined && dirname(exe) === bin)
      die(
        `refusing: slot ${String(other)}'s 5.0 daemon also runs from ${bin}; replacing its programs would move that slot too`,
      );
  }
  const next = await checkNewBuild(slot, libexec);
  await assertPagesDeployLive(next.commit);
  const before = await readStamp(bin);
  const oldLabel = before === undefined ? 'unknown (no BUILD.json beside the running programs)' : before.commit;
  if (before?.commit === next.commit && V5_PROGRAMS.every(name => before.sha256[name] === next.sha256[name])) {
    console.log(`slot ${n}: already on ${next.commit}; nothing to do`);
    return;
  }
  console.log(`slot ${n}: 5.0 daemon ${oldLabel} -> ${next.commit} (programs in ${bin})`);

  const prev = (name: string): string => join(bin, `${name}.prev`);
  const files = [...V5_PROGRAMS, STAMP] as const;
  const startAndWait = async (which: 'new' | 'old'): Promise<string | undefined> => {
    const child = startDaemon(
      join(bin, 'fyd'),
      slot.v5Port,
      daemonEnvironment(slot, 'v5'),
      join(slot.v5.dir, 'fyd.log'),
      slot.v5.user,
    );
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null)
        return `the ${which} daemon exited (${child.exitCode === null ? String(child.signalCode) : 'code ' + String(child.exitCode)}) before it served; see ${join(slot.v5.dir, 'fyd.log')}`;
      const ok = await fetch(`http://127.0.0.1:${String(slot.v5Port)}/healthz`, {
        signal: AbortSignal.timeout(2000),
      }).then(
        response => response.ok,
        () => false,
      );
      if (ok) return undefined;
      if (Date.now() > deadline)
        return `the ${which} daemon did not serve /healthz within 180 s; see ${join(slot.v5.dir, 'fyd.log')}`;
      await Bun.sleep(400);
    }
  };

  // Stop ONLY this slot's 5.0 daemon, by its own lock. v4, every tmux server, the home and the identity are not touched.
  await stopByLock(slot.v5.lock, '5.0 daemon');
  // From here on EVERY failure (a copy, a chmod, a spawn, a daemon that never serves) takes the rollback below. `moved` is what THIS
  // run put aside as <name>.prev, so a leftover .prev from an older upgrade is never mistaken for this run's backup.
  const moved: string[] = [];
  let failure: string | undefined;
  try {
    for (const name of files) {
      await rm(prev(name), { force: true });
      if ((await lstat(join(bin, name)).catch(() => undefined)) !== undefined) {
        await rename(join(bin, name), prev(name));
        moved.push(name);
      }
    }
    for (const name of files) {
      await copyFile(join(libexec, name), join(bin, name));
      await chmod(join(bin, name), name === STAMP ? 0o644 : 0o755);
    }
    failure = await startAndWait('new');
  } catch (error) {
    failure = `the new programs could not be put in place or started (${error instanceof Error ? error.message : String(error)})`;
  }
  if (failure === undefined) {
    console.log(
      `slot ${n}: 5.0 daemon is serving on http://127.0.0.1:${String(slot.v5Port)}  ${oldLabel} -> ${next.commit}`,
    );
    console.log(
      `  the old programs are kept as ${bin}/<name>.prev; the home, identity and paired devices were not touched`,
    );
    return;
  }

  // Roll back. The .prev set is the only copy of the old programs, so it is COPIED back, never renamed or removed: it stays
  // intact through every unsuccessful recovery and is dropped only once the old daemon is proved healthy.
  console.error(`slot ${n}: ${failure}. Rolling back to ${oldLabel}.`);
  const start = `fy5s${n} daemon start (the wrapper in ${slot.bin})`;
  // Only what THIS run moved aside is restored: a .prev left by an older upgrade is not this run's backup.
  const recovery =
    moved.length === 0
      ? `No program was moved aside, so the programs are untouched and nothing needs restoring. Start it: ${start}`
      : `The old programs are intact as ${bin}/<name>.prev (${moved.join(', ')}); the home was not touched. To put them back by hand: for f in ${moved.join(' ')}; do cp -p '${bin}/'"$f".prev '${bin}/'"$f"; done   then start it: ${start}`;
  let again: string | undefined;
  try {
    await stopByLock(slot.v5.lock, 'new 5.0 daemon');
    for (const name of moved) {
      const temp = join(bin, `${name}.restore`);
      await copyFile(prev(name), temp);
      await chmod(temp, name === STAMP ? 0o644 : 0o755);
      await rename(temp, join(bin, name));
    }
    again = await startAndWait('old');
  } catch (error) {
    again = `restoring the old programs failed (${error instanceof Error ? error.message : String(error)})`;
  }
  if (again !== undefined) {
    await stopByLock(slot.v5.lock, 'old 5.0 daemon (failed start)').catch(() => undefined);
    die(
      `slot ${n}: the upgrade failed (${failure}) AND the old programs did not start either (${again}). The slot has NO running 5.0 daemon. ${recovery}`,
      2,
    );
  }
  for (const name of moved) await rm(prev(name), { force: true });
  die(
    `slot ${n}: the upgrade to ${next.commit} failed (${failure}); rolled back, the old programs (${oldLabel}) are serving again and the .prev set was dropped`,
    2,
  );
}

// ─── pairing an agent browser, code-free ─────────────────────────────────────────────────────────────────────────

/**
 * `fy pair --open --no-wait` hands the pairing link to the host's browser through `xdg-open`. A shim on PATH catches it,
 * and a one-shot loopback page serves it as a button that does `window.open`, so the agent's tool only ever names
 * `http://127.0.0.1:<port>/`. This program never prints, logs or returns the link.
 */
async function pair(slot: Slot, which: Which): Promise<void> {
  await guard(slot, which);
  const shimDir = join(slot.dir, `pair-shim-${which}`);
  await mkdir(shimDir, { recursive: true, mode: 0o700 });
  const caught = join(shimDir, 'caught');
  await rm(caught, { force: true });
  await writeFile(
    join(shimDir, 'xdg-open'),
    `#!/bin/sh\numask 077\nprintf '%s' "$1" > '${caught}'\n# The CLI sweeps its redirect file as soon as the opener returns: keep a private copy of the page now.\n[ -f "$1" ] && cp "$1" '${caught}.page'\nexit 0\n`,
    {
      mode: 0o755,
    },
  );
  const base = await guardedEnv(slot, which);
  const port = await guard(slot, which);
  const program = which === 'v4' ? join(SWEEP_ROOT, 'v4bin', 'fy') : await v5Fy(slot);
  const env: Record<string, string> = {
    ...base,
    PATH: `${shimDir}:${base.PATH ?? ''}`,
    DISPLAY: ':0',
    BROWSER: join(shimDir, 'xdg-open'),
  };
  if (which === 'v4') env.FY_TOKEN = (await readFile(join(slot.v4.home, 'api-token'), 'utf8').catch(() => '')).trim();
  void port;
  const ran = await run(program, ['pair', '--open', '--no-wait'], env, join(slot.v4.out, 'work'));
  const argument = (await readFile(caught, 'utf8').catch(() => '')).trim();
  const copied = await readFile(`${caught}.page`, 'utf8').catch(() => undefined);
  await rm(caught, { force: true });
  await rm(`${caught}.page`, { force: true });
  if (argument === '') {
    // Never echo the command's own output: it may carry the link.
    die(`fy pair did not hand a link to the browser opener (exit ${String(ran.code)}); nothing was served`, 1);
  }
  // `argument` is either the link itself or the path of a redirect page the CLI wrote; read it into memory, delete it.
  let page: string;
  const asFile = isAbsolute(argument)
    ? (copied ?? (await readFile(argument, 'utf8').catch(() => undefined)))
    : undefined;
  if (asFile !== undefined) {
    page = asFile;
  } else {
    page = `<!doctype html><meta charset=utf-8><title>pair</title><body style="font:16px sans-serif;padding:2em"><button id=go style="font-size:1.2em;padding:.6em 1.2em">Pair this browser</button><script>document.getElementById('go').onclick=()=>window.open(${JSON.stringify(argument)},'_blank')</script></body>`;
  }
  if (!/window\.open/u.test(page)) {
    // A redirect page that navigates the tab itself would put the link in the tool's result: wrap it, open it in a new tab.
    // `<` is escaped so the page's own text can never close this script; a Blob page is opened in the NEW tab.
    const embedded = JSON.stringify(page).replaceAll('<', '\\u003c');
    page = `<!doctype html><meta charset=utf-8><title>pair</title><body style="font:16px sans-serif;padding:2em"><button id=go style="font-size:1.2em;padding:.6em 1.2em">Pair this browser</button><script>const html=${embedded};document.getElementById('go').onclick=()=>{window.open(URL.createObjectURL(new Blob([html],{type:'text/html'})),'_blank');}</script></body>`;
  }
  if (process.env.SWEEP_PAIR_DEBUG === '1') {
    // The SHAPE of what the opener got, with every fragment, query and token removed: never the link.
    const strip = (text: string): string =>
      text
        .replace(/#[^\s"'<>)]*/gu, '#<removed>')
        .replace(/\?[^\s"'<>#)]*/gu, '?<removed>')
        .replace(/[A-Za-z0-9_-]{24,}/gu, '<token>');
    console.log(
      `debug: the opener got ${asFile === undefined ? 'a URL' : 'a file'}; after wrapping, the page is ${String(page.length)} chars: ${strip(page).slice(0, 700)}`,
    );
  }
  let served = false;
  const server: Server = createServer((request, response) => {
    if (served || request.url !== '/') {
      response.writeHead(404).end('gone');
      return;
    }
    served = true;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
    setTimeout(() => process.exit(0), 3000);
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const loopback = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`open ONLY this in the agent browser: http://127.0.0.1:${String(loopback)}/`);
  console.log(
    'click the button; the app opens in a NEW tab (wait 10 s, then judge it by its page content, never by its URL).',
  );
  console.log('this page is served once and this process exits 3 s after, or after 120 s.');
  setTimeout(() => process.exit(0), 120_000);
}

async function guardedEnv(slot: Slot, which: Which): Promise<Record<string, string>> {
  const port = await guard(slot, which);
  return { ...baseEnvironment(), ...slotCliEnvironment(slot, which, port) };
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────────────────────────

try {
  const [command, slotArg, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'up':
      await up(parseSlot(slotArg), rest.includes('--reuse'));
      break;
    case 'down':
      await down(parseSlot(slotArg), { keepFiles: rest.includes('--keep-files') });
      break;
    case 'status':
      await status(parseSlot(slotArg));
      break;
    case 'cli': {
      const slot = parseSlot(slotArg);
      const which = rest[0];
      if (which !== 'v4' && which !== 'v5') die('usage: slot.ts cli <1..9> <v4|v5> [args…]', 64);
      process.exit((await cli(slot, which, rest.slice(1), true)).code);
      break;
    }
    case 'pair': {
      const which = rest[0];
      if (which !== 'v4' && which !== 'v5') die('usage: slot.ts pair <1..9> <v4|v5>', 64);
      await pair(parseSlot(slotArg), which);
      break;
    }
    case 'upgrade-v5':
      await upgradeV5(parseSlot(slotArg), rest[0]);
      break;
    case 'stamp-v5':
      await stampV5(slotArg, rest[0]);
      break;
    default:
      die('usage: slot.ts <up|down|status|cli|pair|upgrade-v5|stamp-v5> <slot 1..9> …', 64);
  }
} catch (error) {
  if (error instanceof Failure) {
    console.error(error.message);
    process.exit(error.code);
  }
  throw error;
}
