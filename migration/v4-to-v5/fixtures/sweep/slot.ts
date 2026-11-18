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
 *   bun slot.ts upgrade-v5 <1..9> <libexec-dir>   move ONLY the 5.0 daemon to a newer build, keeping its home, data and pairing. FIRST it fast-forwards the
 *                                      preview ref (origin rebuild/preview) to the build's commit and waits for that deploy (the hosted app moves only
 *                                      with the slot; never backwards), and only then stops the daemon
 *   bun slot.ts stamp-v5 <libexec-dir> <commit>   record which commit a 5.0 build came from (BUILD.json), for upgrade-v5
 *   bun slot.ts persist <1..9> [dir]   move ONE slot to a persistent folder (default ~/.local/share/fy-sweep/slot<N>) and run
 *                                      both daemons as enabled user units, so they come back after a reboot with the same
 *                                      identity, pairing and data (the ferrets' panes do not: they are revived, as after a restart)
 *   bun slot.ts unpersist <1..9>       the reverse: units removed, folder back under the sweep root, daemons running as before
 *   bun slot.ts wrappers <1..9> [--cli-name <name>] [--v4-cli-name <name>]
 *                                      (re)write ONLY the wrappers + kit copy of an already persisted slot: stops and restarts nothing.
 *                                      --cli-name records what the owner types for the 5.0 CLI (e.g. fy5): the daemon prints it in its
 *                                      hints (FY_BINARY_NAME), from the next daemon start on; default is the wrapper's name (fy5s<N>)
 *   bun slot.ts real-claude <1..9> on <login> [--binary <abs path>] | off [--force]
 *                                      the ONE exception to "no real model": a persisted slot's 5.0 side runs the REAL claude for ONE
 *                                      ferretry-managed login (the owner signs in on the 5.0 Logins screen); every other caller keeps the fake
 *   bun slot.ts reset-v5 <1..9> --empty <libexec-dir> [--keep-real-claude]
 *                                      a PERSISTED slot's 5.0 side back to an EMPTY first-run home (new identity, nothing from the fixture, only the port pin written): only the 5.0
 *                                      daemon and its tmux server stop; the old home is MOVED (never copied, packed or deleted) into <slot>/kept/<stamp>; the port
 *                                      pin, units, wrappers, CLI names and hosted relay discovery stay; v4 is untouched
 *   bun slot.ts restore-v5 <1..9> <stamp>   move a kept home back (the current home, if any, is moved into kept/ first)
 *
 * Everything lives under SWEEP_ROOT/slot<N>/ (refused anywhere else, links resolved first). Ports: v4 is 7600+2N, 5.0 is
 * 7601+2N. Nothing here touches ~/.ferretry (v4, 7457), ~/.ferretry-v5 (the owner's preview, 7458) or v4's default 7431:
 * the port pin is written into each home BEFORE any daemon verb can run, and every wrapper reads it back from the home's
 * own files (never from FY_URL / FY_PORT) and refuses if it is not this slot's.
 *
 * Both daemons run with a private XDG_RUNTIME_DIR (no user systemd manager, no session bus), an EMPTY HOME, an allow-list
 * environment, their own tmux socket, and the fake claude/codex first on PATH. No real model is ever called, EXCEPT after
 * `real-claude <N> on <login>`: then `harness-bin/claude` is a dispatcher that runs the real claude only for that login's store.
 *
 * WHERE they run (the caller's tool, not the daemon's environment): each daemon is a transient USER SERVICE of the caller's
 * systemd manager (fy4-slot<N>.service / fy5-slot<N>.service, Restart=on-failure, KillMode=process), so a crash brings it back
 * and a ferret's cgroup kill or a fleet limit never reaches it; each side's tmux server runs in its own scope
 * (fy<4|5>-slot<N>-terminals.scope) so a daemon restart never kills a pane. See "user services" below. `persist` turns the
 * transient units into enabled unit files (and the scopes into terminals services) and the slot folder into a persistent one.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { ensurePreviewDeployed as ensurePreviewDeployedWith, PreviewRefusal } from './preview-ref.ts';
import { fakeCodexAuthText } from './fake-codex-auth.ts';
import {
  KIT_FILES,
  LINK_SCRIPT,
  addStoreRoots,
  cliNamesFile,
  cliNamesText,
  daemonBinaryName,
  daemonUnitText,
  defaultPersistDir,
  isCliName,
  ownerLauncher,
  parseCliNames,
  persistTargetProblem,
  persistedBinDir,
  persistedKitDir,
  pointerDir,
  pointerFile,
  restartTerminals,
  revertFailedPersist,
  storePathsIn,
  storeRootOf,
  terminalsUnitText,
  unitMarker,
  userUnitDir,
  wrapperName,
  wrapperText,
} from './persist.ts';
import {
  FAKE_NAME,
  Refusal,
  RECORD_FILE,
  disableReal,
  enableReal,
  isShim,
  readRecord,
  recordPathOf,
  runtimesUsing,
  statusLine,
  type RealPaths,
} from './real-claude.ts';
import {
  ResetRefusal,
  installPrograms,
  keptDirOf,
  resetV5,
  restoreV5,
  touchSlotFile,
  writeBindPin,
  writeSlotFile,
  type ResetPaths,
} from './reset.ts';
import {
  assertScopeOwned,
  assertServiceOwned,
  showUnit,
  stopScope,
  stopService,
  type GuardPorts,
  type UnitInfo,
} from './service-guard.ts';

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
  /** The LOGICAL slot folder, always <sweep root>/slot<N>: what every home records about itself. */
  readonly dir: string;
  /** Where the slot's files really are: `dir` itself, or (a PERSISTED slot) the persistent folder `dir` is a link to. */
  readonly real: string;
  readonly persisted: boolean;
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
  /** Where the wrapper FILES (fy4s<N>, fy5s<N>) live: the sweep's shared bin folder, or (a PERSISTED slot) <persistent folder>/bin. */
  readonly bin: string;
  /** The shared PATH folder (<sweep root>/bin): for a persisted slot it holds links to the wrappers in `bin`, gone after a boot. */
  readonly pathBin: string;
}

/** The persistent folder the kit's own pointer file names for this slot, or undefined when the slot is not persisted. */
function persistedDirOf(n: number): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(pointerFile(n), 'utf8'));
  } catch {
    return undefined;
  }
  // The pointer is believed only as far as a fresh `persist` target would be: unpersist MOVES this folder and down may delete it.
  const read = pointerDir({ document, slot: n, sweepRoot: SWEEP_ROOT, home: homedir() });
  if (read.problem !== undefined)
    die(
      `refusing: ${pointerFile(n)} names a folder that is not an allowed slot folder (${read.problem}); nothing was touched. Fix or delete that pointer file`,
      99,
    );
  return read.dir;
}

function slotOf(n: number): Slot {
  const dir = join(SWEEP_ROOT, `slot${String(n)}`);
  const real = persistedDirOf(n) ?? dir;
  const v4out = join(dir, 'v4');
  const v5dir = join(dir, 'v5');
  return {
    n,
    dir,
    real,
    persisted: real !== dir,
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
    bin: real === dir ? join(SWEEP_ROOT, 'bin') : persistedBinDir(real),
    pathBin: join(SWEEP_ROOT, 'bin'),
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
    if (existing.isSymbolicLink()) {
      // The ONE link allowed is a persisted slot's, and only to exactly the folder the kit's pointer file recorded.
      const folder = slot.persisted ? await lstat(slot.real).catch(() => undefined) : undefined;
      if (
        folder?.isDirectory() !== true ||
        folder.isSymbolicLink() ||
        (await readlink(slot.dir)) !== slot.real ||
        (await realpath(slot.dir)) !== (await realpath(slot.real))
      )
        die(
          `refusing: ${slot.dir} is a symbolic link${slot.persisted ? ` that does not lead to its persistent folder ${slot.real}` : ''}`,
          99,
        );
      return;
    }
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

/** A persisted slot carries its OWN copy of the fake ferret's helper: the checkout the kit ran from may be gone by then. */
const richHelpers = (slot: Slot): Record<string, string> => ({
  FY_FIXTURE_RICH: '1',
  FY_FIXTURE_BUN: process.execPath,
  FY_FIXTURE_HELPER: slot.persisted
    ? join(slot.dir, 'support', 'fake-claude-rich.ts')
    : join(FIXTURES, 'support', 'fake-claude-rich.ts'),
});

/** The CLI names recorded for this slot (`wrappers <N> --cli-name fy5`); none recorded, or a record that does not parse, is {}. */
function readCliNames(slot: Slot): ReturnType<typeof parseCliNames> {
  try {
    return parseCliNames(readFileSync(cliNamesFile(slot.real), 'utf8'));
  } catch {
    return {};
  }
}

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
    // The CLI name the daemon's own hints print: what the owner types (the recorded override, else the wrapper's name), NOT the
    // product default `fy`. The daemon reads it from this variable only; the env file is rewritten from here at every start.
    FY_BINARY_NAME: daemonBinaryName(slot.n, which, readCliNames(slot)),
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
    ...richHelpers(slot),
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

/** The v4 `fy` a wrapper runs for this slot: the slot's own copy when it is persisted, else the shared links. */
async function v4Fy(slot: Slot): Promise<string> {
  const own = join(slot.dir, 'v4-bin', 'fy');
  return (await lstat(own).catch(() => undefined)) === undefined ? join(SWEEP_ROOT, 'v4bin', 'fy') : own;
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
  // /proc names an open file by its resolved path: a persisted slot's lock, opened through the slot link, shows as the real one.
  const resolved = await realpath(dirname(lockFile)).then(
    folder => join(folder, basename(lockFile)),
    () => lockFile,
  );
  const held: number[] = [];
  for (const name of (await readdir('/proc').catch(() => [] as string[])).filter(entry => /^\d+$/u.test(entry))) {
    for (const fd of await readdir(`/proc/${name}/fd`).catch(() => [] as string[])) {
      const target = await readlink(`/proc/${name}/fd/${fd}`).catch(() => '');
      if (target === lockFile || target === resolved) {
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

// ─── user services: daemons that restart on a crash, tmux servers that outlive them ──────────────────────────────

/*
 * Each slot daemon is a transient user service of the CALLER's systemd manager, and each side's tmux server runs in its own
 * scope, so that (1) a crashed daemon comes back by itself, (2) a daemon restart never kills a pane, and (3) neither lands
 * in the cgroup of whoever ran the kit (a ferret's scope, or ferretry_fleet.slice), where a fleet limit or a cgroup kill
 * would take the owner's preview down. systemd-run/systemctl are the CALLER's tools: the daemon's own environment is still
 * exactly daemonEnvironment() (private XDG_RUNTIME_DIR, no bus).
 *
 * REBOOT SURVIVAL is opt-in, per slot, and is `persist` (below): a slot lives under /tmp, which systemd-tmpfiles wipes at boot
 * ("D /tmp"), so by default no unit file is written to ~/.config/systemd/user and the units are transient and end with the
 * user manager. A persisted slot has real unit files (enabled) and a persistent folder instead.
 */

/** The cgroup a daemon or tmux server inside this slice would sit in with a ferret's own processes: the limit that kills. */
const FLEET_SLICE = 'ferretry_fleet.slice';

/** `fy4-slot<N>` / `fy5-slot<N>`: one unit per slot AND side. */
const unitOf = (slot: Slot, which: Which): string => `fy${which === 'v4' ? '4' : '5'}-slot${String(slot.n)}`;
const serviceOf = (slot: Slot, which: Which): string => `${unitOf(slot, which)}.service`;
const scopeOf = (slot: Slot, which: Which): string => `${unitOf(slot, which)}-terminals.scope`;
/** The unit a side's tmux server lives in: a transient scope, or (a persisted slot) an enabled terminals service. */
const terminalsOf = (slot: Slot, which: Which): string =>
  slot.persisted ? `${unitOf(slot, which)}-terminals.service` : scopeOf(slot, which);
const sideOf = (slot: Slot, which: Which): { dir: string; lock: string; tmux: string } =>
  which === 'v4'
    ? { dir: slot.v4.out, lock: slot.v4.lock, tmux: slot.v4.tmux }
    : { dir: slot.v5.dir, lock: slot.v5.lock, tmux: slot.v5.tmux };
const labelOf = (which: Which): string => (which === 'v4' ? 'v4' : '5.0');

/**
 * Names that look like a credential: the same patterns as the preview's credential check (preview/credential-check.ts, which
 * cannot be imported here: it pulls in the whole converter). A unit or env file is never written with one.
 */
const CREDENTIAL_NAMES: readonly RegExp[] = [
  /_(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?)$/u,
  /^(GH|GITHUB|GIT|SSH|AWS|AZURE|GOOGLE|GCLOUD|NPM|DOCKER|ANTHROPIC|OPENAI|CLAUDE|CODEX)_/u,
  /^(GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK)$/u,
];

function assertNoCredentialNames(env: Readonly<Record<string, string>>): void {
  const bad = Object.keys(env).filter(name => CREDENTIAL_NAMES.some(pattern => pattern.test(name)));
  if (bad.length > 0)
    die(
      `refusing: the daemon environment has credential-shaped name(s) ${bad.join(', ')}; nothing is written to a unit or an env file`,
      99,
    );
}

/** What the caller needs to reach ITS user manager (and nothing else): the kit's allow-list plus the manager's own address. */
function managerEnvironment(): Record<string, string> {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime === undefined || runtime === '')
    die(
      'no user systemd manager is reachable (XDG_RUNTIME_DIR is not set); the sweep slots run as user services, so run this from a login session of the owning user',
      69,
    );
  const env = baseEnvironment();
  env.XDG_RUNTIME_DIR = runtime;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (bus !== undefined && bus !== '') env.DBUS_SESSION_BUS_ADDRESS = bus;
  return env;
}

const systemctlUser = async (args: readonly string[]): Promise<{ code: number; out: string; err: string }> =>
  await run('systemctl', ['--user', ...args], managerEnvironment());

/** One unit's state, or `undefined` when the user manager cannot be reached at all (then the callers fall back, or die). */
const unitInfo = async (name: string): Promise<UnitInfo | undefined> => await showUnit(realPorts, name);

/** The ownership guard's ports, wired to the real systemctl, /proc and tmux. Its decisions live in service-guard.ts. */
const realPorts: GuardPorts = {
  systemctl: systemctlUser,
  holders: pidsHolding,
  stopByLock,
  cgroupPids: async cgroup => {
    // Unreadable is NOT empty: a control group whose members cannot be listed cannot be shown to be this slot's.
    const text = await readFile(join('/sys/fs/cgroup', cgroup, 'cgroup.procs'), 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    return text
      .split('\n')
      .map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 0);
  },
  tmuxServerPid: async socket => await tmuxServerPid(socket),
  panePids: async socket => {
    const tmux = Bun.which('tmux');
    if (tmux === null) return [];
    const ran = await run(tmux, ['-u', '-S', socket, 'list-panes', '-a', '-F', '#{pane_pid}'], baseEnvironment());
    return ran.code === 0
      ? ran.out
          .split('\n')
          .map(Number)
          .filter(pid => Number.isInteger(pid) && pid > 0)
      : [];
  },
  parentOf: async pid => {
    // /proc/<pid>/stat is `pid (comm) state ppid …`; comm may hold spaces and parentheses, so read after the LAST ")".
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => '');
    const ppid = Number(
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(' ')[1],
    );
    return Number.isInteger(ppid) ? ppid : undefined;
  },
  log: line => console.log(line),
  refuse: sentence => die(sentence, 99),
};

/** The path a unit's ExecStart (and its guard identity) names. A persisted slot's units never depend on the /tmp link existing. */
const physical = (slot: Slot, path: string): string =>
  path === slot.dir
    ? slot.real
    : path.startsWith(`${slot.dir}/`)
      ? join(slot.real, path.slice(slot.dir.length + 1))
      : path;
const envFileOf = (slot: Slot, which: Which): string => physical(slot, join(sideOf(slot, which).dir, 'fyd.env'));
const guardIds = (slot: Slot, which: Which): { name: string; lock: string; envFile: string } => ({
  name: serviceOf(slot, which),
  lock: sideOf(slot, which).lock,
  envFile: envFileOf(slot, which),
});
const scopeIds = (slot: Slot, which: Which): { name: string; socket: string } => ({
  name: terminalsOf(slot, which),
  socket: sideOf(slot, which).tmux,
});

/** The cgroup a pid lives in, from its own /proc file (the unified hierarchy's single `0::` line). */
async function cgroupOfPid(pid: number): Promise<string> {
  const text = await readFile(`/proc/${String(pid)}/cgroup`, 'utf8').catch(() => '');
  return (
    text
      .split('\n')
      .find(line => line.startsWith('0::'))
      ?.slice(3) ?? '(unknown)'
  );
}

/** Tmux's own pid for the server on `socket`, or undefined when none runs there. Starts nothing (display-message never does). */
async function tmuxServerPid(socket: string): Promise<number | undefined> {
  const tmux = Bun.which('tmux');
  if (tmux === null || (await lstat(socket).catch(() => undefined)) === undefined) return undefined;
  const ran = await run(tmux, ['-u', '-S', socket, 'display-message', '-p', '#{pid}'], baseEnvironment());
  const pid = Number.parseInt(ran.out.trim(), 10);
  return ran.code === 0 && Number.isInteger(pid) ? pid : undefined;
}

const warnFleetSlice = (what: string, cgroup: string): void => {
  if (cgroup.includes(FLEET_SLICE))
    console.log(`  WARNING: ${what} is inside ${FLEET_SLICE} (${cgroup}): a fleet limit can take it down`);
};

/** The wrapper every daemon and tmux server is exec'd through: it builds the EXACT environment at each exec (see fyd-exec.sh). */
const WRAPPER_SOURCE = join(import.meta.dir, 'fyd-exec.sh');
const SHELL = '/bin/sh';
const ENV_PROGRAM = '/usr/bin/env';

/**
 * The argv that runs `command` through the wrapper: `/bin/sh fyd-exec.sh <env> <env file> command…`. The wrapper does `env -i`
 * plus the slot's private env file, then EXECs the command, so the pid stays the command's own. The env file holds the values;
 * nothing here carries one (not argv, not a unit property).
 */
function wrapped(envFile: string, command: readonly string[]): string[] {
  const wrapper = join(dirname(envFile), 'fyd-exec.sh');
  // The system's own env, never the caller's (a devshell's coreutils lives in an unrooted nix store path a GC can delete).
  if (!existsSync(ENV_PROGRAM)) die(`${ENV_PROGRAM} does not exist`, 69);
  const program = command[0];
  if (program === undefined || !isAbsolute(program) || program.includes('='))
    die(`refusing: ${String(program)} is not an absolute program path without "="`, 99);
  return [SHELL, wrapper, ENV_PROGRAM, envFile, ...command];
}

/** `systemd-run --user --scope --unit <scope>` around a wrapped command: the caller's ambient environment never reaches it. */
function inScope(
  slot: Slot,
  which: Which,
  envFile: string,
  command: readonly string[],
): { program: string; args: string[] } {
  return {
    program: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--unit',
      scopeOf(slot, which).replace(/\.scope$/u, ''),
      '--description',
      `sweep slot ${String(slot.n)} ${labelOf(which)} terminals (tmux server and panes)`,
      '--',
      ...wrapped(envFile, command),
    ],
  };
}

/**
 * The wrapper is COPIED next to the env file it reads (0700, in the slot folder), so a unit's restart never depends on the
 * checkout the kit ran from (a worktree can go away) and the slot folder holds everything a restart needs.
 */
async function installWrapper(slot: Slot, envFile: string): Promise<void> {
  // Through a temp file and a rename in a folder just proven to be a real folder of THIS slot: a link at the name or in the folder's
  // chain is refused, never written through.
  await writeSlotFile(slot.real, dirname(envFile), 'fyd-exec.sh', await readFile(WRAPPER_SOURCE), 0o700);
}

/**
 * The slot's private env source: `NAME=value` lines (0600, inside the slot folder), the daemon allow-list and nothing else.
 * fyd-exec.sh parses it at every exec. Refuses a credential-shaped name, a bad name or a line break BEFORE writing.
 */
async function writeEnvFile(slot: Slot, which: Which): Promise<void> {
  const env = daemonEnvironment(slot, which);
  const file = envFileOf(slot, which);
  await writeSlotFile(slot.real, dirname(file), basename(file), environmentFileText(env), 0o600);
  await installWrapper(slot, file);
}

/**
 * Makes sure this side's tmux server runs on its socket, in its OWN scope, so that fyd attaches to an existing server and a
 * daemon restart never takes a pane with it. Started exactly as fyd would (`-u -S <socket>`, `exit-empty off` in the same
 * client, the tmux runner's own recipe); a server that is already there is left alone and its cgroup said out loud.
 */
async function ensureTmux(slot: Slot, which: Which): Promise<void> {
  const side = sideOf(slot, which);
  const label = `${labelOf(which)} tmux`;
  const existing = await tmuxServerPid(side.tmux);
  if (existing !== undefined) {
    const cgroup = await cgroupOfPid(existing);
    console.log(
      `  ${label}: a server already runs on its socket (pid ${String(existing)}, cgroup ${cgroup}); left alone`,
    );
    warnFleetSlice(`the ${label} server`, cgroup);
    return;
  }
  const tmux = Bun.which('tmux');
  if (tmux === null) die('tmux is not on PATH', 69);
  // A scope under this name that is not this slot's is refused before anything is started in it.
  await assertScopeOwned(realPorts, scopeIds(slot, which));
  await mkdir(dirname(side.tmux), { recursive: true, mode: 0o700 });
  await writeEnvFile(slot, which);
  if (slot.persisted) {
    // A persisted slot's tmux server is the enabled terminals service (its unit file holds the same recipe as below).
    // No server answers, so RESTART (not start): the unit is a RemainAfterExit oneshot that still reads active (exited) after its
    // tmux server died, and starting an active unit does nothing.
    const name = terminalsOf(slot, which);
    const restarted = await restartTerminals(
      { serverPid: async () => await tmuxServerPid(side.tmux), systemctl: systemctlUser },
      name,
    );
    if ('why' in restarted) die(`could not start the ${label} server with ${name} (${restarted.why})`);
    console.log(
      `  ${label}: server pid ${String(restarted.pid)} started by ${name} (cgroup ${await cgroupOfPid(restarted.pid)})`,
    );
    return;
  }
  const started = inScope(slot, which, envFileOf(slot, which), [
    tmux,
    '-u',
    '-S',
    side.tmux,
    'start-server',
    ';',
    'set-option',
    '-s',
    'exit-empty',
    'off',
  ]);
  const ran = await run(started.program, started.args, managerEnvironment());
  const pid = await tmuxServerPid(side.tmux);
  if (ran.code !== 0 || pid === undefined)
    die(
      `could not start the ${label} server in ${scopeOf(slot, which)} (exit ${String(ran.code)}: ${(ran.err + ran.out).trim().slice(0, 300)})`,
    );
  console.log(
    `  ${label}: server pid ${String(pid)} started in ${scopeOf(slot, which)} (cgroup ${await cgroupOfPid(pid)})`,
  );
}

/** The env file body: one `NAME=value` per line, parsed (never evaluated) by fyd-exec.sh. Never a credential-shaped name. */
function environmentFileText(env: Readonly<Record<string, string>>): string {
  assertNoCredentialNames(env);
  return Object.entries(env)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
        die(`refusing: "${name}" is not a valid environment variable name`, 99);
      if (/[\n\r\0]/u.test(value)) die(`refusing: the value of ${name} holds a line break`, 99);
      return `${name}=${value}`;
    })
    .join('\n')
    .concat('\n');
}

/**
 * Starts this side's daemon as `fy<4|5>-slot<N>.service`: Restart=on-failure after 2 s; KillMode=process so a daemon restart
 * never kills a tmux server or a ferret; stdout and stderr appended to the same log file as before; the working directory as
 * before. ExecStart is the wrapper (fyd-exec.sh), which builds the allow-list environment from the slot's env file at EVERY
 * exec, restarts included, and execs the daemon: the manager's environment is never read and never inherited. A unit already
 * under this name that is not this slot's is refused before anything is reset or started.
 */
async function startService(
  slot: Slot,
  which: Which,
  program: string,
  port: number,
  logFile: string,
  cwd: string,
): Promise<void> {
  const name = serviceOf(slot, which);
  const command = wrapped(envFileOf(slot, which), [program, '--host', '127.0.0.1', '--port', String(port)]);
  const info = await assertServiceOwned(realPorts, guardIds(slot, which));
  if (info === undefined)
    die(`no user systemd manager is reachable, so ${name} cannot be started (the daemons run as user services)`, 69);
  if (info.loaded && info.active !== 'inactive' && info.active !== 'failed')
    die(`refusing: ${name} is already ${info.active} (pid ${String(info.mainPid)}); stop it first`, 99);
  if (info.loaded) await systemctlUser(['reset-failed', name]);
  await writeEnvFile(slot, which);
  await touchSlotFile(slot.real, dirname(physical(slot, logFile)), basename(logFile));
  if (slot.persisted) {
    // The enabled unit file already holds the command, the log and the directory; only the env file is rewritten above.
    const began = await systemctlUser(['start', name]);
    if (began.code !== 0)
      die(`could not start ${name} (exit ${String(began.code)}: ${(began.err + began.out).trim().slice(0, 300)})`);
    return;
  }
  const properties = [
    'Restart=on-failure',
    'RestartSec=2s',
    'KillMode=process',
    'TimeoutStopSec=30s',
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    `WorkingDirectory=${cwd}`,
  ];
  const ran = await systemdRun(slot, which, properties, command);
  if (ran.code !== 0)
    die(`could not start ${name} (exit ${String(ran.code)}: ${(ran.err + ran.out).trim().slice(0, 300)})`);
}

async function systemdRun(
  slot: Slot,
  which: Which,
  properties: readonly string[],
  command: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  return await run(
    'systemd-run',
    [
      '--user',
      '--quiet',
      '--unit',
      unitOf(slot, which),
      '--description',
      `sweep slot ${String(slot.n)} ${labelOf(which)} daemon`,
      ...properties.flatMap(property => ['-p', property]),
      '--',
      ...command,
    ],
    managerEnvironment(),
  );
}

/** Stops this side's daemon (see stopService): a unit that is not this slot's is refused first. Never touches tmux. */
async function stopDaemon(slot: Slot, which: Which, label: string): Promise<void> {
  await stopService(realPorts, guardIds(slot, which), label);
}

/** Ends this side's tmux server (by its own socket) and the scope it lived in, once the scope is proved this slot's. */
async function stopTerminals(slot: Slot, which: Which): Promise<void> {
  await stopScope(realPorts, scopeIds(slot, which), async () => {
    await killTmux(sideOf(slot, which).tmux, labelOf(which));
  });
}

/** Proves every unit and scope named for this slot is this slot's, BEFORE any of them is stopped, reset or cleaned up. */
async function assertSlotUnitsOwned(slot: Slot): Promise<void> {
  for (const which of ['v5', 'v4'] as const) {
    await assertServiceOwned(realPorts, guardIds(slot, which));
    await assertScopeOwned(realPorts, scopeIds(slot, which));
  }
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
  if (slot.persisted)
    die(
      `refusing: slot ${String(slot.n)} is persisted at ${slot.real}; "up" rebuilds a slot from scratch. Run unpersist ${String(slot.n)} first`,
      99,
    );
  await assertSlotPath(slot);
  // A rebuild would copy the fakes over the shim and reconvert the home, which deletes the login the owner signed in.
  if ((await readRecord(realPathsOf(slot))) !== undefined)
    die(
      `refusing: slot ${String(slot.n)} has real claude switched on (${recordPathOf(realPathsOf(slot))}); "up" would wipe the shim and the login. Run "slot.ts real-claude ${String(slot.n)} off" first`,
      99,
    );
  if ((await pidsHolding(slot.v4.lock)).length + (await pidsHolding(slot.v5.lock)).length > 0)
    die(`slot ${String(slot.n)} is already up; run sweep-down.sh ${String(slot.n)} first (or use it as it is)`);
  // A unit or scope under this slot's name that is not this slot's refuses the whole up before anything is removed or started.
  await assertSlotUnitsOwned(slot);
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
  // The builder leaves its tmux server running (--keep-panes) for the v4 daemon to adopt, so the builder itself runs in the
  // v4 terminals scope: that server then lives there, not in the cgroup of whoever ran the kit.
  // Its environment is the kit's allow-list only, from a private 0600 file of its own (never argv).
  const buildEnv = join(slot.dir, 'build.env');
  await writeFile(buildEnv, environmentFileText(baseEnvironment()), { mode: 0o600 });
  await chmod(buildEnv, 0o600);
  await installWrapper(slot, buildEnv);
  const builder = inScope(slot, 'v4', buildEnv, [
    process.execPath,
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
  ]);
  const build = kept ? { code: 0, out: '', err: '' } : await run(builder.program, builder.args, managerEnvironment());
  if (!kept) await writeFile(join(slot.dir, 'build.log'), build.out + build.err, { mode: 0o600 });
  if (build.code !== 0) {
    die(`the rich v4 build failed (exit ${String(build.code)}); its log is ${join(slot.dir, 'build.log')}`);
  }

  // 2. The port pin, written into the v4 home BEFORE any daemon verb can run; limits OFF and accepted; the orphaned Chrome stopped.
  await pinV4(slot);
  await limitsOffV4(slot);
  await signInFakeCodex(slot.v4.home, 'fleet', 'credentials');
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
  // The converter carries the credential folders; this makes sure the Codex login is signed in on the 5.0 side whatever it did.
  await signInFakeCodex(slot.v5.home, 'state', 'logins', 'credentials');

  // 5. Both daemons. v4 first (its panes are still in the builder's tmux server, which it adopts).
  await ensureTmux(slot, 'v4');
  await startService(
    slot,
    'v4',
    join(v4Dir, 'fyd'),
    slot.v4Port,
    join(slot.v4.out, 'fyd.log'),
    join(slot.v4.out, 'work'),
  );
  await waitUntil(
    'the v4 daemon serving',
    90_000,
    async () =>
      (await fetch(`http://127.0.0.1:${String(slot.v4Port)}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok,
  );
  await ensureTmux(slot, 'v5');
  await startService(slot, 'v5', join(v5Bin, 'fyd'), slot.v5Port, join(slot.v5.dir, 'fyd.log'), slot.v5.user);
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
 * The fixture's Codex login (`codex-main`) is added with --no-sign-in, so `codex-main-agent` would refuse to resume ("Login
 * codex-main needs sign-in"). Gives it the FAKE sign-in file the daemon's own rule reads as signed in (fake-codex-auth.ts: made-up
 * markers, never a real token; the fake `codex` never reads it). Only a login folder that exists and holds no `auth.json` is
 * touched; a file that is already there is never replaced.
 */
async function signInFakeCodex(home: string, ...credentials: string[]): Promise<void> {
  const folder = join(home, ...credentials, 'codex-main');
  if ((await lstat(folder).catch(() => undefined))?.isDirectory() !== true) return;
  const file = join(folder, 'auth.json');
  if ((await lstat(file).catch(() => undefined)) !== undefined) return;
  await writeFile(file, fakeCodexAuthText(), { mode: 0o600 });
  await chmod(file, 0o600);
  console.log(`  codex-main: the fake sign-in file is in place (${relative(home, file)})`);
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
async function stopSlotChrome(slot: Slot, label: string, root: string = slot.dir): Promise<void> {
  const prefix = `--user-data-dir=${root}${'/'}`;
  const listed = await run('pgrep', ['-f', '--', `--user-data-dir=${root}/`], baseEnvironment());
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

/** Where `cli` is run from: a persisted slot's own kit copy (no checkout needed), else this very file. */
const slotScript = (slot: Slot): string =>
  slot.persisted ? join(persistedKitDir(slot.real), 'slot.ts') : join(import.meta.dir, 'slot.ts');

/**
 * A persisted slot's kit copy: exactly the files `slot.ts cli` imports (KIT_FILES), in <persistent folder>/kit/, each put in
 * place by a rename so a wrapper that is running right now never reads a half-written file. Run from the kit copy itself it
 * has nothing to copy.
 */
async function installKit(slot: Slot): Promise<string> {
  const kit = persistedKitDir(slot.real);
  await mkdir(kit, { recursive: true, mode: 0o700 });
  if ((await realpath(import.meta.dir)) === (await realpath(kit))) return kit;
  for (const name of KIT_FILES) {
    const temp = join(kit, `.${name}.new`);
    await copyFile(join(import.meta.dir, name), temp);
    await chmod(temp, 0o644);
    await rename(temp, join(kit, name));
  }
  return kit;
}

async function writeWrappers(slot: Slot): Promise<void> {
  const generatedBy = slot.persisted ? 'slot.ts (persist / wrappers)' : 'sweep-up.sh';
  if (slot.persisted) await installKit(slot);
  await mkdir(slot.bin, { recursive: true });
  for (const which of ['v4', 'v5'] as const) {
    const path = join(slot.bin, wrapperName(slot.n, which));
    // rm first: a path that is still a link to a wrapper must never be written THROUGH.
    await rm(path, { force: true });
    await writeFile(
      path,
      wrapperText({ slot: slot.n, side: which, bun: process.execPath, slotTs: slotScript(slot), generatedBy }),
      { mode: 0o755 },
    );
    await chmod(path, 0o755);
  }
  await linkPathWrappers(slot);
}

/** A persisted slot's wrappers, also reachable from the shared PATH folder (links; /tmp is empty after a boot, the files are not). */
async function linkPathWrappers(slot: Slot): Promise<void> {
  if (!slot.persisted) return;
  await mkdir(slot.pathBin, { recursive: true });
  for (const which of ['v4', 'v5'] as const) {
    const link = join(slot.pathBin, wrapperName(slot.n, which));
    const target = join(slot.bin, wrapperName(slot.n, which));
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink() === true && (await readlink(link)) === target)
      continue;
    await rm(link, { force: true });
    await symlink(target, link);
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
  const program = which === 'v4' ? await v4Fy(slot) : await v5Fy(slot);
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
  for (const which of ['v4', 'v5'] as const) await statusServices(slot, which);
  console.log(`  ${await realClaudeLine(slot)}`);
  if (slot.persisted) {
    const names = [serviceOf(slot, 'v4'), serviceOf(slot, 'v5'), terminalsOf(slot, 'v4'), terminalsOf(slot, 'v5')];
    const enabled = await Promise.all(
      names.map(async name => `${name}: ${(await systemctlUser(['is-enabled', name])).out.trim() || 'unknown'}`),
    );
    console.log(`  PERSISTED at ${slot.real} (${slot.dir} is a link to it); units: ${enabled.join(', ')}`);
    console.log(`  ${await lingerNote()}`);
  }
  console.log(`  put ${slot.pathBin} first on PATH to use fy4s${n} / fy5s${n}`);
  if (slot.persisted)
    console.log(
      `  or call them where they survive a reboot: ${join(slot.bin, wrapperName(slot.n, 'v4'))} / ${join(slot.bin, wrapperName(slot.n, 'v5'))}  (${slotScript(slot)} runs from the slot's own kit copy)`,
    );
  console.log(`  pair an agent browser (the link never reaches a tool argument or result):`);
  console.log(`    bun ${slotScript(slot)} pair ${n} v4      then   bun ${slotScript(slot)} pair ${n} v5`);
  console.log(
    `  each prints one loopback URL; open ONLY that in the agent browser and click the button: the app opens in a new tab`,
  );
}

/** Each side's unit state, its daemon's cgroup and its tmux server's, with a warning for anything inside the fleet slice. */
async function statusServices(slot: Slot, which: Which): Promise<void> {
  const label = labelOf(which);
  const side = sideOf(slot, which);
  const info = await unitInfo(serviceOf(slot, which));
  if (info === undefined)
    console.log(`  ${label}   no user systemd manager is reachable from here: unit state unknown`);
  else if (!info.loaded)
    console.log(`  ${label}   ${serviceOf(slot, which)}: no unit (a daemon an older kit started, or none)`);
  else {
    const cgroup = info.mainPid > 0 ? await cgroupOfPid(info.mainPid) : '-';
    console.log(
      `  ${label}   ${serviceOf(slot, which)}: ${info.active} (${info.sub})  daemon pid ${info.mainPid > 0 ? String(info.mainPid) : '-'}  cgroup ${cgroup}`,
    );
    warnFleetSlice(`the ${label} daemon`, cgroup);
  }
  const holders = await pidsHolding(side.lock);
  const tmuxPid = await tmuxServerPid(side.tmux);
  if (holders.length > 0 && (info?.loaded !== true || !holders.includes(info.mainPid)))
    for (const pid of holders) {
      const cgroup = await cgroupOfPid(pid);
      console.log(`  ${label}   daemon pid ${String(pid)} runs OUTSIDE its service, cgroup ${cgroup}`);
      warnFleetSlice(`the ${label} daemon`, cgroup);
    }
  if (tmuxPid === undefined) console.log(`  ${label}   tmux server: none on ${side.tmux}`);
  else {
    const cgroup = await cgroupOfPid(tmuxPid);
    console.log(`  ${label}   tmux server pid ${String(tmuxPid)}  cgroup ${cgroup}`);
    warnFleetSlice(`the ${label} tmux server`, cgroup);
  }
}

async function down(slot: Slot, options: { keepFiles: boolean; quiet?: boolean }): Promise<void> {
  await assertSlotPath(slot);
  if (slot.persisted && !options.keepFiles)
    die(
      `refusing: slot ${String(slot.n)} is persisted at ${slot.real}; "down" without --keep-files would delete a persistent folder. Run unpersist ${String(slot.n)} first, or use down ${String(slot.n)} --keep-files to stop it only`,
      99,
    );
  // Ownership first: a unit or scope under this slot's name that is not this slot's refuses the whole down, nothing stopped.
  await assertSlotUnitsOwned(slot);
  if (options.quiet !== true) console.log(`slot ${String(slot.n)}: stopping`);
  await stopDaemon(slot, 'v5', '5.0 daemon');
  await stopDaemon(slot, 'v4', 'v4 daemon');
  await stopTerminals(slot, 'v5');
  await stopTerminals(slot, 'v4');
  await stopSlotChrome(slot, 'down');
  // The PATH entries (files of a plain slot, links of a persisted one). A persisted slot's own wrappers stay: they live in its folder, which down --keep-files keeps.
  for (const which of ['4', '5']) await rm(join(slot.pathBin, `fy${which}s${String(slot.n)}`), { force: true });
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
 * The hosted 5.0 app must be live for the commit, or the app would say "Reload to get the new app". It deploys only when the preview
 * ref is pushed, so this FIRST fast-forwards `rebuild/preview` to the commit (refusing a commit that is not a descendant of what the
 * ref holds: never backwards), then waits for that run's `Deploy PWA` job to succeed (preview-ref.ts; the rules are deploy-gate.ts).
 * Everything here happens before anything is stopped. `reset-v5` calls it at the same point.
 */
async function ensurePreviewDeployed(commit: string): Promise<void> {
  const env = process.env as Record<string, string>;
  const seam = (program: string) => (args: readonly string[]) => run(program, args, env, FIXTURES);
  try {
    await ensurePreviewDeployedWith(
      {
        git: seam('git'),
        gh: seam('gh'),
        sleep: ms => Bun.sleep(ms),
        now: () => Date.now(),
        say: line => console.log(line),
      },
      commit,
    );
  } catch (error) {
    if (error instanceof PreviewRefusal) die(`refusing: ${error.message}`);
    throw error;
  }
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
  const inside = (root: string): boolean => !relative(root, bin).startsWith('..') && !isAbsolute(relative(root, bin));
  if (!inside(SWEEP_ROOT) && !(slot.persisted && inside(slot.real)))
    die(
      `refusing: slot ${n}'s daemon runs from ${bin}, outside ${SWEEP_ROOT}${slot.persisted ? ` and ${slot.real}` : ''}; this command only rewrites programs inside the slot's own folder`,
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
  const before = await readStamp(bin);
  const oldLabel = before === undefined ? 'unknown (no BUILD.json beside the running programs)' : before.commit;
  if (before?.commit === next.commit && V5_PROGRAMS.every(name => before.sha256[name] === next.sha256[name])) {
    console.log(`slot ${n}: already on ${next.commit}; nothing to do`);
    return;
  }
  // Only now: a slot that is already on this build pushes nothing. Every refusal of this step is before anything is stopped.
  await ensurePreviewDeployed(next.commit);
  console.log(`slot ${n}: 5.0 daemon ${oldLabel} -> ${next.commit} (programs in ${bin})`);

  const prev = (name: string): string => join(bin, `${name}.prev`);
  const files = [...V5_PROGRAMS, STAMP] as const;
  const startAndWait = async (which: 'new' | 'old'): Promise<string | undefined> => {
    // The tmux server is NOT touched by an upgrade: kept when it runs, started in its own scope only when it is missing.
    await ensureTmux(slot, 'v5');
    await startService(slot, 'v5', join(bin, 'fyd'), slot.v5Port, join(slot.v5.dir, 'fyd.log'), slot.v5.user);
    const deadline = Date.now() + 180_000;
    for (;;) {
      // A daemon that crashes is restarted by its unit; one that keeps crashing is "failed" or waiting to restart: say so.
      const state = await unitInfo(serviceOf(slot, 'v5'));
      if (
        state === undefined ||
        state.active === 'failed' ||
        state.active === 'inactive' ||
        state.sub === 'auto-restart'
      )
        return `the ${which} daemon's service ${serviceOf(slot, 'v5')} is ${state === undefined ? 'unreadable' : `${state.active} (${state.sub})`} before it served; see ${join(slot.v5.dir, 'fyd.log')}`;
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

  // Stop ONLY this slot's 5.0 daemon (its unit once proved this slot's, else its own lock). v4, every tmux server, the home and
  // the identity are not touched.
  await assertServiceOwned(realPorts, guardIds(slot, 'v5'));
  await stopDaemon(slot, 'v5', '5.0 daemon');
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
    // A 5.0 build that changes how claude is found would skip the shim: say where real claude stands after every upgrade.
    console.log(`  ${await realClaudeLine(slot)}`);
    return;
  }

  // Roll back. The .prev set is the only copy of the old programs, so it is COPIED back, never renamed or removed: it stays
  // intact through every unsuccessful recovery and is dropped only once the old daemon is proved healthy.
  console.error(`slot ${n}: ${failure}. Rolling back to ${oldLabel}.`);
  const start = `bun ${join(import.meta.dir, 'slot.ts')} upgrade-v5 ${n} <the old build folder> (or sweep-up.sh ${n} for a fresh pair)`;
  // Only what THIS run moved aside is restored: a .prev left by an older upgrade is not this run's backup.
  const recovery =
    moved.length === 0
      ? `No program was moved aside, so the programs are untouched and nothing needs restoring. Start it: ${start}`
      : `The old programs are intact as ${bin}/<name>.prev (${moved.join(', ')}); the home was not touched. To put them back by hand: for f in ${moved.join(' ')}; do cp -p '${bin}/'"$f".prev '${bin}/'"$f"; done   then start it: ${start}`;
  let again: string | undefined;
  try {
    await stopDaemon(slot, 'v5', 'new 5.0 daemon');
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
    await stopDaemon(slot, 'v5', 'old 5.0 daemon (failed start)').catch(() => undefined);
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
  const program = which === 'v4' ? await v4Fy(slot) : await v5Fy(slot);
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

// ─── persist / unpersist: one slot that survives a reboot ────────────────────────────────────────────────────────

/*
 * WHAT MOVES AND WHAT STAYS. The slot folder moves to a persistent one (a rename: same file system, so every file keeps its
 * mtime; a copy only across file systems, verified before the original is removed). The logical path <sweep root>/slot<N> stays
 * as a SYMLINK to it, because both homes record absolute paths of themselves (the fleet manifest, transcript homes, accepted
 * config text hashed with its etag): rewriting those would break the very files that make the slot "the same slot", while a link
 * keeps every one of them true. After a boot /tmp is empty, so every unit's ExecStartPre (link-slot.sh) recreates the link
 * before its daemon runs; the units themselves name only persistent paths.
 *
 * What the kit owns IS rewritten: fyd.env (the helper path), the wrapper copies, the four unit files, fy4s<N>/fy5s<N>, the pointer
 * file. Ferrets' panes do not survive the move (both tmux servers are stopped first, as for any restart of the daemons): each side
 * revives them, as after a restart.
 */

/** The four unit files a persisted slot owns, with the text each must hold. */
function persistedUnits(slot: Slot): { name: string; text: string }[] {
  const tmux = Bun.which('tmux');
  if (tmux === null) die('tmux is not on PATH', 69);
  const link = ['/bin/sh', join(slot.real, 'link-slot.sh'), slot.real, slot.dir];
  const out: { name: string; text: string }[] = [];
  for (const which of ['v4', 'v5'] as const) {
    const side = sideOf(slot, which);
    const envFile = envFileOf(slot, which);
    const program =
      which === 'v4' ? physical(slot, join(slot.dir, 'v4-bin', 'fyd')) : physical(slot, join(slot.v5.bin, 'fyd'));
    const terminals = terminalsOf(slot, which);
    const daemon = serviceOf(slot, which);
    out.push({
      name: daemon,
      text: daemonUnitText({
        slot: slot.n,
        side: which,
        name: daemon,
        terminalsName: terminals,
        execStartPre: link,
        execStart: wrapped(envFile, [
          program,
          '--host',
          '127.0.0.1',
          '--port',
          String(which === 'v4' ? slot.v4Port : slot.v5Port),
        ]),
        workingDirectory: physical(slot, which === 'v4' ? join(slot.v4.out, 'work') : slot.v5.user),
        logFile: physical(slot, join(side.dir, 'fyd.log')),
      }),
    });
    out.push({
      name: terminals,
      text: terminalsUnitText({
        slot: slot.n,
        side: which,
        name: terminals,
        execStartPre: link,
        execStart: wrapped(envFile, [
          tmux,
          '-u',
          '-S',
          side.tmux,
          'start-server',
          ';',
          'set-option',
          '-s',
          'exit-empty',
          'off',
        ]),
        execStop: wrapped(envFile, [tmux, '-u', '-S', side.tmux, 'kill-server']),
      }),
    });
  }
  return out;
}

/** The unit file at `path` is this kit's own for this slot (its first line is exactly the marker), or absent. */
async function unitFileState(path: string, slot: number, name: string): Promise<'absent' | 'ours' | 'foreign'> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return (await lstat(path).catch(() => undefined)) === undefined ? 'absent' : 'foreign';
  return text.split('\n')[0] === unitMarker(slot, name) ? 'ours' : 'foreign';
}

/** Same file system: a rename. Otherwise `cp -a`, verified (entry count and total size), and only then the original removed. */
async function moveTree(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const copied = await run('cp', ['-a', '--', from, to], baseEnvironment());
  const measure = async (root: string): Promise<{ entries: number; bytes: number }> => {
    let entries = 0;
    let bytes = 0;
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        entries += 1;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else bytes += (await lstat(path)).size;
      }
    };
    await walk(root);
    return { entries, bytes };
  };
  if (copied.code !== 0) {
    await rm(to, { recursive: true, force: true });
    die(
      `could not copy ${from} to ${to} (exit ${String(copied.code)}: ${copied.err.trim().slice(0, 200)}); the original is untouched`,
    );
  }
  const [a, b] = [await measure(from), await measure(to)];
  if (a.entries !== b.entries || a.bytes !== b.bytes) {
    await rm(to, { recursive: true, force: true });
    die(
      `the copy at ${to} does not match ${from} (${JSON.stringify(b)} vs ${JSON.stringify(a)}); the original is untouched`,
    );
  }
  await rm(from, { recursive: true, force: true });
}

/** After a reboot /tmp is empty: put the persisted slot's link (and its wrappers) back, and prove the link is the right one. */
async function healPersistedLink(slot: Slot): Promise<void> {
  if (!slot.persisted) return;
  const folder = await lstat(slot.real).catch(() => undefined);
  if (folder?.isDirectory() !== true || folder.isSymbolicLink())
    die(
      `slot ${String(slot.n)} is recorded as persisted at ${slot.real}, but that folder is missing or not a real folder`,
      99,
    );
  await mkdir(SWEEP_ROOT, { recursive: true, mode: 0o700 });
  if ((await lstat(slot.dir).catch(() => undefined)) === undefined) await symlink(slot.real, slot.dir);
  await assertSlotPath(slot);
  for (const which of ['4', '5']) {
    if ((await lstat(join(slot.pathBin, `fy${which}s${String(slot.n)}`)).catch(() => undefined)) === undefined) {
      // Wrappers a newer kit wrote live in the persistent folder: only their PATH links come back. A slot an OLDER kit persisted
      // has none yet: it gets them (and the kit copy) here, as it always got its wrappers back.
      const own = await lstat(join(slot.bin, wrapperName(slot.n, 'v5'))).catch(() => undefined);
      if (own === undefined) await writeWrappers(slot);
      else await linkPathWrappers(slot);
      break;
    }
  }
}

async function lingerNote(): Promise<string> {
  const uid = process.getuid?.();
  const ran = await run('loginctl', ['show-user', String(uid ?? ''), '-p', 'Linger'], managerEnvironment()).catch(
    () => undefined,
  );
  const linger = /Linger=(\w+)/u.exec(ran?.out ?? '')?.[1];
  return linger === 'yes'
    ? 'linger is on for this user: the units start at boot, without a login'
    : `WARNING: linger is ${linger ?? 'unknown'} for this user, so the units start only when this user logs in. To start them at boot, run once: loginctl enable-linger ${process.env.USER ?? '$USER'}`;
}

async function waitHealthy(slot: Slot, which: Which): Promise<void> {
  const path = which === 'v4' ? '/v1/health' : '/healthz';
  const port = which === 'v4' ? slot.v4Port : slot.v5Port;
  await waitUntil(
    `the ${labelOf(which)} daemon serving`,
    which === 'v4' ? 90_000 : 180_000,
    async () => (await fetch(`http://127.0.0.1:${String(port)}${path}`, { signal: AbortSignal.timeout(2000) })).ok,
  );
}

/** Starts both sides of a slot under its CURRENT kind of unit (transient or persisted): tmux first, then the daemon, v4 before 5.0. */
async function startBoth(slot: Slot, v4Dir: string): Promise<void> {
  await ensureTmux(slot, 'v4');
  await startService(
    slot,
    'v4',
    join(v4Dir, 'fyd'),
    slot.v4Port,
    join(slot.v4.out, 'fyd.log'),
    join(slot.v4.out, 'work'),
  );
  await waitHealthy(slot, 'v4');
  await ensureTmux(slot, 'v5');
  await startService(slot, 'v5', join(slot.v5.bin, 'fyd'), slot.v5Port, join(slot.v5.dir, 'fyd.log'), slot.v5.user);
  await waitHealthy(slot, 'v5');
}

/** The folder (inside the persistent slot) that holds one nix GC root per store path the units and env files name. */
const GCROOTS = 'gcroots';
/** What only a persisted slot carries: removed again by unpersist, and by a persist that fails. */
const PERSIST_ONLY = ['link-slot.sh', 'v4-bin', 'support', 'bin', 'kit', GCROOTS] as const;

/**
 * A unit file and an env file bake absolute programs (PATH entries, tmux, bun) and the copied v4 programs name theirs (the v4
 * fyd is a makeWrapper script that execs /nix/store/…-fyd-4.x/bin/.fyd-wrapped). A nix-collect-garbage would delete any of them
 * and the slot would not start after the next reboot. So every store path named in the units and env files, and the store path
 * each copied v4 program, tmux and bun came from, gets a GC root under <slot>/gcroots (a root keeps the whole closure).
 * A path that could not be rooted is said out loud, never silently skipped. Nothing here exists on a host without nix.
 */
async function rootBakedStorePaths(
  slot: Slot,
  units: readonly { name: string; text: string }[],
  v4Dir: string,
): Promise<void> {
  const texts = units.map(unit => unit.text);
  for (const which of ['v4', 'v5'] as const) texts.push(await readFile(envFileOf(slot, which), 'utf8'));
  const paths = new Set(texts.flatMap(storePathsIn));
  const origins = [process.execPath, Bun.which('tmux') ?? ''];
  for (const name of ['fy', 'fyd', 'fyd-browser-worker']) origins.push(join(v4Dir, name));
  for (const origin of origins) {
    const real = origin === '' ? undefined : await realpath(origin).catch(() => undefined);
    const root = real === undefined ? undefined : storeRootOf(real);
    if (root !== undefined) paths.add(root);
  }
  if (paths.size === 0) return;
  const folder = join(slot.real, GCROOTS);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const nixStore = Bun.which('nix-store');
  const { rooted, failed } = await addStoreRoots(
    { nixStore: nixStore === null ? undefined : async args => await run(nixStore, [...args], baseEnvironment()) },
    folder,
    [...paths],
  );
  console.log(`  GC roots: ${String(rooted.length)} nix store paths rooted under ${folder}`);
  for (const miss of failed)
    console.log(`  WARNING: ${miss.path} is NOT rooted (${miss.why}); a nix GC could break this slot after a reboot`);
}

async function persist(slot: Slot, targetArg: string | undefined): Promise<void> {
  const n = String(slot.n);
  if (slot.persisted) die(`slot ${n} is already persisted at ${slot.real}`, 99);
  await assertSlotPath(slot);
  if ((await lstat(slot.dir).catch(() => undefined))?.isDirectory() !== true)
    die(`slot ${n} has no folder at ${slot.dir}; bring it up first (sweep-up.sh ${n})`);
  await guard(slot, 'v4');
  await guard(slot, 'v5');
  const target = targetArg ?? defaultPersistDir(slot.n);
  const problem = persistTargetProblem({ target, sweepRoot: SWEEP_ROOT, home: homedir() });
  if (problem !== undefined) die(`refusing: ${problem}`, 99);
  const occupied = await readdir(target).catch(() => undefined);
  if (occupied !== undefined && occupied.length > 0) die(`refusing: ${target} already holds files`, 99);
  if ((await lstat(target).catch(() => undefined)) !== undefined && occupied === undefined)
    die(`refusing: ${target} exists and is not an empty folder`, 99);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Every unit under this slot's names must be this slot's (running), and no unit FILE of those names may already be there.
  await assertSlotUnitsOwned(slot);
  const files = persistedUnits({ ...slot, real: target, persisted: true }).map(unit => unit.name);
  for (const name of files)
    if ((await unitFileState(join(userUnitDir(), name), slot.n, name)) === 'foreign')
      die(`refusing: ${join(userUnitDir(), name)} already exists and is not this kit's; it is left alone`, 99);
  const v4 = await v4Programs();

  console.log(`slot ${n}: persisting to ${target}`);
  console.log(`  ${await lingerNote()}`);
  await down(slot, { keepFiles: true });
  if (occupied !== undefined) await rm(target, { recursive: true });
  await moveTree(slot.dir, target);
  const revert = async (): Promise<void> => {
    await rm(pointerFile(slot.n), { force: true });
    if ((await lstat(slot.dir).catch(() => undefined))?.isSymbolicLink() === true) await rm(slot.dir);
    await moveTree(target, slot.dir);
    for (const leftover of PERSIST_ONLY) await rm(join(slot.dir, leftover), { recursive: true, force: true });
  };
  let p: Slot;
  try {
    await symlink(target, slot.dir);
    await mkdir(dirname(pointerFile(slot.n)), { recursive: true, mode: 0o700 });
    await writeFile(
      pointerFile(slot.n),
      `${JSON.stringify({ slot: slot.n, dir: target, persistedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    p = slotOf(slot.n);
    await assertSlotPath(p);
    // Programs and helpers the units need, in the slot's own folder: nothing a restart depends on lives in a checkout or a link farm.
    await mkdir(join(p.real, 'v4-bin'), { recursive: true, mode: 0o700 });
    for (const name of ['fy', 'fyd', 'fyd-browser-worker']) {
      if ((await lstat(join(v4.dir, name)).catch(() => undefined)) === undefined) continue;
      await copyFile(join(v4.dir, name), join(p.real, 'v4-bin', name));
      await chmod(join(p.real, 'v4-bin', name), 0o755);
    }
    await mkdir(join(p.real, 'support'), { recursive: true, mode: 0o700 });
    await copyFile(join(FIXTURES, 'support', 'fake-claude-rich.ts'), join(p.real, 'support', 'fake-claude-rich.ts'));
    await writeFile(join(p.real, 'link-slot.sh'), LINK_SCRIPT, { mode: 0o700 });
    await chmod(join(p.real, 'link-slot.sh'), 0o700);
    await writeEnvFile(p, 'v4');
    await writeEnvFile(p, 'v5');
    await mkdir(userUnitDir(), { recursive: true });
    const units = persistedUnits(p);
    for (const unit of units) await writeFile(join(userUnitDir(), unit.name), unit.text, { mode: 0o644 });
    await rootBakedStorePaths(p, units, v4.dir);
  } catch (error) {
    for (const name of files) {
      if ((await unitFileState(join(userUnitDir(), name), slot.n, name)) === 'ours')
        await rm(join(userUnitDir(), name), { force: true });
    }
    // The folder goes back AND both daemons start again (persist stopped them): never a slot left stopped. This is the same
    // start `up` ends with, without any rm or re-create of the slot.
    await revertFailedPersist(
      {
        revert,
        restart: async () => {
          await startBoth(slotOf(slot.n), v4.dir);
          await writeWrappers(slotOf(slot.n));
        },
        say: line => console.log(line),
      },
      slot.n,
    ).catch((restartError: unknown) => {
      console.log(
        `  the daemons could NOT be started again (${restartError instanceof Error ? restartError.message : String(restartError)}); the slot folder is back at ${slot.dir}`,
      );
    });
    throw error;
  }
  const reloaded = await systemctlUser(['daemon-reload']);
  const enabled = await systemctlUser(['enable', ...files]);
  if (reloaded.code !== 0 || enabled.code !== 0)
    die(
      `the unit files are written but systemd would not load or enable them (${(reloaded.err + enabled.err + enabled.out).trim().slice(0, 300)}); fix that, or run unpersist ${n}`,
    );
  await startBoth(p, v4.dir);
  await writeWrappers(p);
  console.log(`\nslot ${n} is persisted at ${target}: both daemons are enabled user units and survive a reboot\n`);
  await status(p);
}

async function unpersist(slot: Slot): Promise<void> {
  const n = String(slot.n);
  if (!slot.persisted) die(`slot ${n} is not persisted`, 99);
  await healPersistedLink(slot);
  const back = slotOf(slot.n).dir;
  const names = persistedUnits(slot).map(unit => unit.name);
  for (const name of names)
    if ((await unitFileState(join(userUnitDir(), name), slot.n, name)) === 'foreign')
      die(`refusing: ${join(userUnitDir(), name)} is not this kit's unit file; it is left alone`, 99);
  await assertSlotUnitsOwned(slot);
  const v4Dir = (await v4Programs()).dir;
  console.log(`slot ${n}: unpersisting from ${slot.real}`);
  await down(slot, { keepFiles: true });
  await systemctlUser(['disable', ...names]);
  for (const name of names)
    if ((await unitFileState(join(userUnitDir(), name), slot.n, name)) === 'ours')
      await rm(join(userUnitDir(), name), { force: true });
  await systemctlUser(['daemon-reload']);
  for (const name of names) await systemctlUser(['reset-failed', name]);
  // The folder goes back where the sweep expects it; the link, the pointer and the persistence-only files go.
  if ((await lstat(slot.dir).catch(() => undefined))?.isSymbolicLink() !== true)
    die(`refusing: ${slot.dir} is not the link the persisted slot expects; nothing was moved`, 99);
  await rm(slot.dir);
  // The GC roots go first: the store paths they kept are no longer named by any unit file.
  await rm(join(slot.real, GCROOTS), { recursive: true, force: true });
  await moveTree(slot.real, back);
  await rm(pointerFile(slot.n), { force: true });
  const plain = slotOf(slot.n);
  for (const leftover of PERSIST_ONLY) await rm(join(plain.dir, leftover), { recursive: true, force: true });
  await startBoth(plain, v4Dir);
  await writeWrappers(plain);
  console.log(
    `\nslot ${n} is back under ${plain.dir}, running as transient units (no unit file, gone with the user manager)\n`,
  );
  await status(plain);
}

/** `--cli-name <name>` (the 5.0 side) and `--v4-cli-name <name>`; undefined when neither is given. Anything else is refused. */
function cliNamesFromFlags(flags: readonly string[]): { v4?: string; v5?: string } | undefined {
  if (flags.length === 0) return undefined;
  const out: { v4?: string; v5?: string } = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    const side = flag === '--cli-name' ? 'v5' : flag === '--v4-cli-name' ? 'v4' : undefined;
    if (side === undefined)
      die(`wrappers: unknown option "${String(flag)}" (use --cli-name <name> and/or --v4-cli-name <name>)`, 64);
    if (value === undefined || !isCliName(value))
      die(
        `wrappers: ${String(flag)} needs a plain program name (lowercase letters, digits, - and _, starting with a letter), not "${String(value)}"`,
        64,
      );
    out[side] = value;
  }
  return out;
}

/** Merges the given names into the slot's record, then rewrites BOTH fyd.env files from it (read at the next daemon start only). */
async function recordCliNames(slot: Slot, names: { v4?: string; v5?: string }): Promise<void> {
  const merged = { ...readCliNames(slot), ...names };
  const file = cliNamesFile(slot.real);
  await writeFile(file, cliNamesText(merged), { mode: 0o600 });
  await chmod(file, 0o600);
  for (const which of ['v4', 'v5'] as const) await writeEnvFile(slot, which);
}

/**
 * `slot.ts wrappers <N>`: (re)writes ONLY the wrappers (<persistent folder>/bin/fy4s<N>, fy5s<N>), their PATH links and the kit copy
 * they run, for a slot that is ALREADY persisted. It stops nothing and starts nothing (no systemctl, no tmux, no daemon), reads
 * and writes no file inside either home, and leaves the unit files alone, so it is safe against a slot in use. The one thing
 * besides those files it may do is add a nix GC root for the bun the wrappers name.
 */
async function wrappers(slot: Slot, flags: readonly string[] = []): Promise<void> {
  const n = String(slot.n);
  if (!slot.persisted)
    die(
      `slot ${n} is not persisted: its wrappers are written by up (sweep-up.sh ${n}); persist ${n} moves them into the persistent folder`,
      99,
    );
  await assertSlotPath(slot);
  const names = cliNamesFromFlags(flags);
  if (names !== undefined) await recordCliNames(slot, names);
  await writeWrappers(slot);
  const nixStore = Bun.which('nix-store');
  const root = storeRootOf(await realpath(process.execPath).catch(() => process.execPath));
  if (root !== undefined) {
    const folder = join(slot.real, GCROOTS);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const { failed } = await addStoreRoots(
      { nixStore: nixStore === null ? undefined : async args => await run(nixStore, [...args], baseEnvironment()) },
      folder,
      [root],
    );
    for (const miss of failed)
      console.log(
        `  WARNING: ${miss.path} (the bun the wrappers run) is NOT rooted (${miss.why}); a nix GC could break them`,
      );
  }
  console.log(
    `slot ${n}: wrappers written in ${slot.bin}; kit copy in ${persistedKitDir(slot.real)}; nothing was stopped or restarted`,
  );
  console.log(`  fy4s${n}: ${join(slot.bin, wrapperName(slot.n, 'v4'))}`);
  console.log(`  fy5s${n}: ${join(slot.bin, wrapperName(slot.n, 'v5'))}`);
  console.log(`  PATH links (gone at boot, put back by the next slot.ts command): ${slot.pathBin}/fy4s${n}, fy5s${n}`);
  if (names !== undefined) {
    const now = readCliNames(slot);
    console.log(
      `  daemon CLI names recorded in ${cliNamesFile(slot.real)}: v4 ${daemonBinaryName(slot.n, 'v4', now)}, 5.0 ${daemonBinaryName(slot.n, 'v5', now)}; both fyd.env files rewritten`,
    );
    console.log(
      `  a RUNNING daemon keeps its old name until it restarts (nothing was restarted): upgrade-v5 ${n} <libexec-dir> or systemctl --user restart ${serviceOf(slot, 'v5')}`,
    );
  }
  console.log(`  a launcher for the owner's own fy5 (e.g. ~/bin/fy5) execs the persisted wrapper:`);
  console.log(`    ${ownerLauncher(slot.real, slot.n)}`);
}

// ─── real claude, for ONE login ───────────────────────────────────────────────────────────────────────────────────

const realPathsOf = (slot: Slot): RealPaths => ({ v5Dir: slot.v5.dir, fyHome: slot.v5.home, harness: slot.v5.harness });

/** The `real claude:` line of `status` / `upgrade-v5`: off, on (with the shim checked), never anything from inside a store. */
async function realClaudeLine(slot: Slot): Promise<string> {
  const record = await readRecord(realPathsOf(slot));
  if (record === undefined) return statusLine(undefined);
  const claude = await readFile(join(slot.v5.harness, 'claude'), 'utf8').catch(() => '');
  return statusLine(record, isShim(claude) ? 'ok' : 'shim-missing');
}

/** The real claude on the caller's PATH, skipping every sweep harness-bin folder (those hold the fakes and the shim). */
async function findRealClaude(slot: Slot): Promise<string | undefined> {
  for (const folder of (process.env.PATH ?? '').split(':')) {
    if (folder === '' || !isAbsolute(folder)) continue;
    if (folder.startsWith(`${SWEEP_ROOT}/`) || folder.startsWith(`${slot.real}/`)) continue;
    const candidate = join(folder, 'claude');
    const real = await realpath(candidate).catch(() => undefined);
    if (real !== undefined) return real;
  }
  return undefined;
}

async function realClaude(slot: Slot, rest: readonly string[]): Promise<void> {
  const n = String(slot.n);
  const usage = 'usage: slot.ts real-claude <1..9> on <login> [--binary <abs path>] | off [--force]';
  const [action, ...args] = rest;
  if (action !== 'on' && action !== 'off') die(usage, 64);
  if (!slot.persisted)
    die(
      `refusing: slot ${n} is not persisted; real claude is only for a persisted slot (its folder and units survive a reboot). Run persist ${n} first`,
      99,
    );
  await assertSlotPath(slot);
  await guard(slot, 'v5');
  const paths = realPathsOf(slot);
  try {
    if (action === 'on') {
      const flag = args.indexOf('--binary');
      const given = flag >= 0 ? args[flag + 1] : undefined;
      if (flag >= 0 && given === undefined) die(usage, 64);
      const login = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1))[0];
      const binary = given ?? (await findRealClaude(slot));
      if (binary === undefined)
        die('no real claude on PATH (outside the sweep folders); pass its absolute path with --binary <path>');
      const folder = join(slot.real, GCROOTS);
      const { record, notes } = await enableReal(paths, login, binary, {
        root: async path => {
          const root = storeRootOf(path);
          if (root === undefined)
            return { link: undefined, note: `${path} is not a nix store path: it is NOT rooted against a GC` };
          const nixStore = Bun.which('nix-store');
          await mkdir(folder, { recursive: true, mode: 0o700 });
          const { rooted, failed } = await addStoreRoots(
            { nixStore: nixStore === null ? undefined : async a => await run(nixStore, [...a], baseEnvironment()) },
            folder,
            [root],
          );
          if (rooted.length === 1) return { link: join(folder, root.slice('/nix/store/'.length)) };
          return {
            link: undefined,
            note: `WARNING: ${root} is NOT rooted (${failed[0]?.why ?? 'unknown'}); a nix GC could remove the real claude`,
          };
        },
      });
      console.log(`slot ${n}: real claude is ON for login ${record.login}`);
      console.log(`  real binary: ${record.binary}`);
      console.log(`  store matched exactly: ${record.store}`);
      console.log(
        `  every other caller (every other login, store: host) still gets the fake: ${join(slot.v5.harness, FAKE_NAME)}`,
      );
      for (const note of notes) console.log(`  ${note}`);
      console.log(
        `  no daemon was stopped or restarted. Next: the owner presses Sign in on the 5.0 Logins screen for ${record.login}`,
      );
    } else {
      const { was } = await disableReal(
        paths,
        { liveFerrets: login => liveFerretsOn(slot, login) },
        { force: args.includes('--force') },
      );
      console.log(
        was === undefined
          ? `slot ${n}: real claude was already off (${RECORD_FILE} not present); nothing changed`
          : `slot ${n}: real claude is OFF; the fake claude is back and ${RECORD_FILE} is gone. Login ${was.login} and its store were not touched (remove them on the Logins screen)`,
      );
    }
  } catch (error) {
    if (error instanceof Refusal) die(`refusing: ${error.message}; nothing was changed`, 99);
    throw error;
  }
}

/**
 * `off` waits for the ferrets on the login's runtimes. Names only: the runtimes whose file says `login: <login>`, then
 * `fy ps --json` of the slot (when its 5.0 daemon is up); any of those runtime names in it is a live ferret. A daemon that is up
 * but cannot be asked refuses (--force skips this check); a daemon that is down has no live ferret.
 */
async function liveFerretsOn(slot: Slot, login: string): Promise<string | undefined> {
  const dir = join(slot.v5.home, 'config', 'runtimes');
  const files = new Map<string, string>();
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (/\.ya?ml$/u.test(name)) files.set(name, await readFile(join(dir, name), 'utf8').catch(() => ''));
  const runtimes = runtimesUsing(login, files);
  if (runtimes.length === 0 || (await pidsHolding(slot.v5.lock)).length === 0) return undefined;
  const listed = await cli(slot, 'v5', ['ps', '--json']);
  if (listed.code !== 0)
    return `could not ask the 5.0 daemon which ferrets are running (fy ps exited ${String(listed.code)}), so ${runtimes.join(', ')} may be in use; stop them, or pass --force`;
  const busy = runtimes.filter(name => listed.out.includes(`"${name}"`));
  return busy.length === 0
    ? undefined
    : `a ferret still runs on runtime ${busy.join(', ')} (login ${login}); stop it first, or pass --force`;
}

// ─── reset-v5 / restore-v5: an EMPTY 5.0 home on a persisted slot, and the way back ─────────────────────────────────

const resetPathsOf = (slot: Slot): ResetPaths => ({
  slot: slot.n,
  real: slot.real,
  v5Dir: slot.v5.dir,
  home: slot.v5.home,
  user: slot.v5.user,
  harness: slot.v5.harness,
  bin: slot.v5.bin,
  port: slot.v5Port,
});

/** Stops ONLY this slot's 5.0 side: its daemon, its tmux server (its socket lives inside the home that goes away) and its Chrome. */
async function stopV5Side(slot: Slot): Promise<void> {
  await stopDaemon(slot, 'v5', '5.0 daemon');
  await stopTerminals(slot, 'v5');
  await stopSlotChrome(slot, 'reset', slot.v5.dir);
  const holders = await pidsHolding(slot.v5.lock);
  if (holders.length > 0 || (await tmuxServerPid(slot.v5.tmux)) !== undefined)
    die(
      `refusing: the 5.0 side of slot ${String(slot.n)} is still running after its units were stopped; nothing was removed`,
      99,
    );
}

async function startV5Side(slot: Slot): Promise<void> {
  await guard(slot, 'v5');
  await ensureTmux(slot, 'v5');
  await startService(slot, 'v5', join(slot.v5.bin, 'fyd'), slot.v5Port, join(slot.v5.dir, 'fyd.log'), slot.v5.user);
  await waitHealthy(slot, 'v5');
}

/**
 * The 5.0 side on a home the kit just emptied: NO guard first (an empty home pins nothing, and a 5.0 daemon refuses a home that holds a
 * file but has no home.json, so the kit writes nothing before the first boot). The daemon is told its port on its command line; once it
 * serves, the pin is read from the home the daemon made. Only if the daemon recorded none does the kit write the bind pin (AFTER the first
 * boot, merged into whatever the daemon wrote), because every wrapper refuses a home that does not pin this slot's port.
 */
async function startFreshV5Side(slot: Slot): Promise<void> {
  // The daemon FIRST: the tmux socket lives inside the home (state/terminals/tmux.sock), so a tmux server started before the first boot would
  // make the empty home "not empty". The kit's own tmux server (its terminals unit) is started once the daemon has made the home.
  await startService(slot, 'v5', join(slot.v5.bin, 'fyd'), slot.v5Port, join(slot.v5.dir, 'fyd.log'), slot.v5.user);
  await waitHealthy(slot, 'v5');
  await ensureTmux(slot, 'v5');
  const { port } = await pinnedPort(slot, 'v5');
  if (port === slot.v5Port)
    console.log(`  port pin: the daemon recorded ${String(port)} itself; the kit wrote nothing`);
  else {
    await writeBindPin(resetPathsOf(slot), slot.v5Port); // looks at the home, config folder and daemon.json itself, right before each write
    console.log(
      `  port pin: the daemon recorded ${port === undefined ? 'none' : String(port)}; the kit wrote the bind pin ${String(slot.v5Port)} into config/daemon.json AFTER the first boot (the only file it wrote)`,
    );
  }
  await guard(slot, 'v5');
}

/** The persisted slot a reset or restore may touch: every refusal is decided before anything is stopped. */
async function assertResettable(slot: Slot, verb: string, options: { pinned: boolean }): Promise<void> {
  if (!slot.persisted)
    die(
      `refusing: slot ${String(slot.n)} is not persisted; ${verb} is only for a persisted slot (its units and folder survive a reboot). Run persist ${String(slot.n)} first`,
      99,
    );
  await assertSlotPath(slot);
  // A reset starts from a home that pins this slot's port; a restore may be undoing a half-done reset, so it checks the pin of the home it
  // PUTS BACK (startV5Side guards after the extraction), not of the one it replaces.
  if (options.pinned) await guard(slot, 'v5');
  await assertServiceOwned(realPorts, guardIds(slot, 'v5'));
  await assertScopeOwned(realPorts, scopeIds(slot, 'v5'));
}

async function resetV5Verb(slot: Slot, rest: readonly string[]): Promise<void> {
  const n = String(slot.n);
  const usage = 'usage: slot.ts reset-v5 <1..9> --empty <libexec-dir> [--keep-real-claude]';
  const keepRealClaude = rest.includes('--keep-real-claude');
  const args = rest.filter(arg => arg !== '--keep-real-claude');
  if (args.length !== 2 || args[0] !== '--empty' || args[1] === undefined) die(usage, 64);
  await assertResettable(slot, 'reset-v5', { pinned: true });
  const libexec = resolve(args[1] ?? '');
  const next = await checkNewBuild(slot, libexec);
  await ensurePreviewDeployed(next.commit);
  const bin = slot.v5.bin;
  const installBuild = async (): Promise<void> => {
    const before = await readStamp(bin);
    if (
      resolve(libexec) === resolve(bin) ||
      (before?.commit === next.commit && V5_PROGRAMS.every(name => before.sha256[name] === next.sha256[name]))
    ) {
      console.log(`  5.0 programs: already ${next.commit}`);
      return;
    }
    await installPrograms(resetPathsOf(slot), libexec, [...V5_PROGRAMS, STAMP], STAMP);
    console.log(
      `  5.0 programs: ${before?.commit ?? 'unknown'} -> ${next.commit} (the old ones are kept as <name>.prev)`,
    );
  };
  console.log(`slot ${n}: resetting the 5.0 side to an EMPTY home (v4 is not touched)`);
  let kept: { kept: string; stamp: string };
  try {
    kept = await resetV5(
      resetPathsOf(slot),
      realPathsOf(slot),
      {
        stop: async () => await stopV5Side(slot),
        installBuild,
        start: async () => await startFreshV5Side(slot),
        say: line => console.log(line),
      },
      { keepRealClaude, now: new Date() },
    );
  } catch (error) {
    if (error instanceof ResetRefusal) die(`refusing: ${error.message}; nothing was deleted`, 99);
    const why = error instanceof Error ? error.message : String(error);
    throw new Failure(
      `slot ${n}: the reset stopped half way (${why}). Nothing was deleted: the old home is either still in ${slot.v5.dir} or in the newest folder under ${keptDirOf(slot.real)}; put a kept one back with: bun ${slotScript(slot)} restore-v5 ${n} <that folder's name>`,
      2,
    );
  }
  console.log(
    `slot ${n}: 5.0 is serving an EMPTY home on http://127.0.0.1:${String(slot.v5Port)}  (new identity; no pairing code was made)`,
  );
  console.log(
    `  the old home is kept in ${kept.kept} (moved, nothing deleted); put it back with: bun ${slotScript(slot)} restore-v5 ${n} ${kept.stamp}`,
  );
  if (keepRealClaude && (await readRecord(realPathsOf(slot))) !== undefined)
    console.log(
      '  real claude: add the login again on the 5.0 Logins screen (same name), press Sign in, add the runtime; harness-claude-code.yaml (permissionMode: auto) is empty again',
    );
  console.log('');
  await status(slot);
}

async function restoreV5Verb(slot: Slot, rest: readonly string[]): Promise<void> {
  const n = String(slot.n);
  if (rest.length !== 1 || rest[0] === undefined)
    die("usage: slot.ts restore-v5 <1..9> <stamp of a folder in the slot's kept/ folder>", 64);
  await assertResettable(slot, 'restore-v5', { pinned: false });
  console.log(`slot ${n}: putting an old 5.0 home back (v4 is not touched)`);
  try {
    const done = await restoreV5(
      resetPathsOf(slot),
      {
        stop: async () => await stopV5Side(slot),
        start: async () => await startV5Side(slot),
        say: line => console.log(line),
      },
      rest[0] ?? '',
      new Date(),
    );
    console.log(
      `slot ${n}: the old home is back and serving; ${done.saved === undefined ? 'there was no current home to keep' : `the home it replaced is kept in ${done.saved}`}`,
    );
  } catch (error) {
    if (error instanceof ResetRefusal) die(`refusing: ${error.message}`, 99);
    throw error;
  }
  console.log('');
  await status(slot);
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The slot named on the command line; a persisted slot's /tmp link (empty after a boot) is put back first. */
async function healedSlot(text: string | undefined): Promise<Slot> {
  const slot = parseSlot(text);
  await healPersistedLink(slot);
  return slot;
}

try {
  const [command, slotArg, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'up':
      await up(await healedSlot(slotArg), rest.includes('--reuse'));
      break;
    case 'down':
      await down(await healedSlot(slotArg), { keepFiles: rest.includes('--keep-files') });
      break;
    case 'status':
      await status(await healedSlot(slotArg));
      break;
    case 'cli': {
      const slot = await healedSlot(slotArg);
      const which = rest[0];
      if (which !== 'v4' && which !== 'v5') die('usage: slot.ts cli <1..9> <v4|v5> [args…]', 64);
      process.exit((await cli(slot, which, rest.slice(1), true)).code);
      break;
    }
    case 'pair': {
      const which = rest[0];
      if (which !== 'v4' && which !== 'v5') die('usage: slot.ts pair <1..9> <v4|v5>', 64);
      await pair(await healedSlot(slotArg), which);
      break;
    }
    case 'upgrade-v5':
      await upgradeV5(await healedSlot(slotArg), rest[0]);
      break;
    case 'persist':
      await persist(await healedSlot(slotArg), rest[0]);
      break;
    case 'unpersist':
      await unpersist(await healedSlot(slotArg));
      break;
    case 'wrappers':
      await wrappers(await healedSlot(slotArg), rest);
      break;
    case 'real-claude':
      await realClaude(await healedSlot(slotArg), rest);
      break;
    case 'reset-v5':
      await resetV5Verb(await healedSlot(slotArg), rest);
      break;
    case 'restore-v5':
      await restoreV5Verb(await healedSlot(slotArg), rest);
      break;
    case 'stamp-v5':
      await stampV5(slotArg, rest[0]);
      break;
    default:
      die(
        'usage: slot.ts <up|down|status|cli|pair|upgrade-v5|persist|unpersist|wrappers|real-claude|reset-v5|restore-v5|stamp-v5> <slot 1..9> …',
        64,
      );
  }
} catch (error) {
  if (error instanceof Failure) {
    console.error(error.message);
    process.exit(error.code);
  }
  throw error;
}
