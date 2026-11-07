#!/usr/bin/env bun
/**
 * Builds a realistic Ferretry 4.291.5 home, in a throwaway folder, with the RELEASED v4 binaries.
 *
 *   bun fixtures/build-v4-home.ts --out <empty folder under the OS temp dir> --v4-dir <folder holding fy and fyd>
 *                                 [--keep-panes]
 *
 * `--v4-dir` is what `fetch-v4.sh` prints. This program does no network access of its own.
 *
 * Nothing here can touch a real home: `<out>` must be under the OS temp dir and empty, the daemon and every command
 * it runs get `FY_HOME=<out>/home` and `HOME=<out>/user` (so a harness, a git config or an XDG folder resolves inside
 * `<out>`), `claude` and `codex` are the fakes in `support/`, and the daemon owns a private tmux server whose socket is
 * `<out>/home/tmux.sock`. Everything is made through the v4 `fy` CLI and the daemon's own HTTP API: a step the v4 CLI
 * cannot do is recorded as skipped with the reason, never faked by writing a v4 file by hand.
 *
 * Result: `<out>/home` (stopped, ready for the converter) and `<out>/made.json` — ids and names only, never a value.
 * Exit 0 when every REQUIRED step worked (skipped optional steps are listed in made.json), 1 otherwise.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deviceSession, newTestDevice, pairOverSession, type TestDevice } from './support/pairing/session-client.ts';

/** The one secret the fixture stores. It is a constant on purpose: a fixture value, not a credential. */
const FIXTURE_SECRET_NAME = 'FIXTURE_NOT_A_SECRET';
const FIXTURE_SECRET_VALUE = 'fixture-not-a-secret';
const V4_VERSION = '4.291.5';
const SUPPORT = join(import.meta.dir, 'support');

// ─── what the run has made, and what it could not ────────────────────────────────────────────────────────────────

interface StepRecord {
  readonly name: string;
  readonly status: 'done' | 'skipped' | 'failed';
  readonly required: boolean;
  readonly reason?: string;
}

interface FerretRecord {
  readonly role: string;
  readonly id: string;
  readonly name: string;
  readonly mode: 'auto' | 'interactive';
  readonly requestedParent: string | null;
  /** The parent the daemon reports, when its answer names one. */
  observedParent?: string | null;
  state: 'running' | 'ended';
}

const made: Record<string, unknown> & { steps: StepRecord[]; ferrets: FerretRecord[] } = {
  format: 1,
  tool: 'ferretry-v4-fixture-builder',
  v4Version: V4_VERSION,
  createdAt: new Date().toISOString(),
  ferrets: [],
  steps: [],
};

class StepFailure extends Error {}

/** Anything that must never reach a log or made.json: the daemon token, a pairing code, the fixture secret value. */
const redactions = new Set<string>([FIXTURE_SECRET_VALUE]);

function redact(text: string): string {
  let out = text;
  for (const value of redactions) if (value.length >= 6) out = out.split(value).join('[redacted]');
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

function log(line: string): void {
  console.log(redact(line));
}

/** Runs one creation step. A required step's failure ends the run; an optional one is recorded as skipped. */
async function step(name: string, required: boolean, body: () => Promise<void>): Promise<boolean> {
  try {
    await body();
    made.steps.push({ name, status: 'done', required });
    log(`✅ ${name}`);
    return true;
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : String(error));
    made.steps.push({ name, status: required ? 'failed' : 'skipped', required, reason });
    log(`${required ? '❌' : '⚠️  skipped'} ${name}: ${reason}`);
    if (required) throw new StepFailure(`${name}: ${reason}`);
    return false;
  }
}

/** A step the v4 CLI has no way to do, recorded without trying. */
function cannot(name: string, reason: string): void {
  made.steps.push({ name, status: 'skipped', required: false, reason });
  log(`⚠️  skipped ${name}: ${reason}`);
}

// ─── running programs ────────────────────────────────────────────────────────────────────────────────────────────

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(
  executable: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string; stdin?: string; timeoutMs?: number },
): Promise<Ran> {
  const child = Bun.spawn([executable, ...args], {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The first string found at any of `keys`, searching nested objects; the daemon's answer shape is not a contract. */
function findString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 6 || typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string;
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('could not reserve a loopback port');
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return address.port;
}

// ─── arguments and the safety checks ─────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: bun build-v4-home.ts --out <empty folder under the OS temp dir> --v4-dir <fy/fyd folder> [--keep-panes]';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'v4-dir': { type: 'string' },
    'keep-panes': { type: 'boolean', default: false },
  },
  strict: true,
});
if (values.out === undefined || (values['v4-dir'] ?? process.env.FY_V4_DIR) === undefined) {
  console.error(USAGE);
  process.exit(64);
}

const out = resolve(values.out);
const v4Dir = resolve(values['v4-dir'] ?? process.env.FY_V4_DIR ?? '');
const keepPanes = values['keep-panes'] ?? false;

/** `<out>` must be inside the OS temp dir (so never a real home) and empty. Anything else refuses before a write. */
class Refused extends Error {}

async function refuseUnlessDisposable(): Promise<void> {
  const temp = await realpath(tmpdir());
  // Decided from the real path of the nearest existing parent BEFORE anything is created.
  const parent = await realpath(dirname(out)).catch(() => undefined);
  if (parent === undefined) throw new Refused(`refusing: the parent of ${out} does not exist`);
  const inside = relative(temp, join(parent, basename(out)));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new Refused(
      `refusing: ${out} is not under the OS temp dir (${temp}); the fixture never builds anywhere else`,
    );
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) throw new Refused(`refusing: ${out} is not empty`);
}

// ─── the world the daemon and every command run in ───────────────────────────────────────────────────────────────

const paths = {
  fyHome: join(out, 'home'),
  userHome: join(out, 'user'),
  harnessBin: join(out, 'harness-bin'),
  work: join(out, 'work'),
  daemonLog: join(out, 'fyd.log'),
  fakeClaudeLog: join(out, 'fake-claude.log'),
  fakeCodexLog: join(out, 'fake-codex.log'),
  tmuxSocket: join(out, 'home', 'tmux.sock'),
};

let baseUrl = '';
let token = '';

function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Nothing that looks like a credential reaches the daemon or a command it runs.
    if (/(?:api_?key|token|secret|password|credential)/iu.test(name)) continue;
    if (name === 'CODEX_HOME' || name === 'CLAUDE_CONFIG_DIR' || name.startsWith('TMUX')) continue;
    env[name] = value;
  }
  return {
    ...env,
    HOME: paths.userHome,
    XDG_CONFIG_HOME: join(paths.userHome, '.config'),
    XDG_CACHE_HOME: join(paths.userHome, '.cache'),
    XDG_STATE_HOME: join(paths.userHome, '.local', 'state'),
    FY_HOME: paths.fyHome,
    PATH: [paths.harnessBin, process.env.PATH ?? ''].join(delimiter),
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
    // The daemon's launch guard: a session whose harness resolves to a real install fails.
    FERRETRY_TEST: '1',
    FY_UPDATE_CHECK: 'off',
    FY_LOCAL_MODELS: 'off',
    // A closed loopback port: nothing here reaches a rendezvous or the hosted directory.
    FY_RELAY_DIRECTORY_ORIGIN: 'http://127.0.0.1:9',
    FY_CLAUDE_BIN: join(paths.harnessBin, 'claude'),
    FY_CODEX_BIN: join(paths.harnessBin, 'codex'),
    FY_E2E_FAKE_CLAUDE_LOG: paths.fakeClaudeLog,
    FY_E2E_FAKE_CODEX_LOG: paths.fakeCodexLog,
    ...extra,
  };
}

/** One `fy` command as the owner at this machine, optionally acting as a ferret (`FY_SESSION_ID`). */
async function fy(
  args: readonly string[],
  options: { as?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  return run(join(v4Dir, 'fy'), args, {
    env: childEnvironment({
      FY_URL: baseUrl,
      FY_TOKEN: token,
      ...(options.as === undefined ? {} : { FY_SESSION_ID: options.as }),
    }),
    cwd: paths.work,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Like {@link fy} but a non-zero exit is a failure carrying the command's own words. */
async function fyOk(
  args: readonly string[],
  options: { as?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const ran = await fy(args, options);
  if (ran.code !== 0)
    throw new Error(`fy ${args.slice(0, 3).join(' ')} exited ${String(ran.code)}: ${(ran.err || ran.out).trim()}`);
  return ran.out;
}

async function owner(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: parseJson(text) ?? text };
}

// ─── the daemon ──────────────────────────────────────────────────────────────────────────────────────────────────

let daemon: ChildProcess | undefined;
let daemonExit: Promise<number> | undefined;

async function startDaemon(): Promise<void> {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${String(port)}`;
  const logFd = openSync(paths.daemonLog, 'a', 0o600);
  daemon = spawn(join(v4Dir, 'fyd'), ['--host', '127.0.0.1', '--port', String(port)], {
    env: childEnvironment(),
    cwd: paths.work,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  daemonExit = new Promise<number>(resolveExit => {
    daemon?.once('exit', code => resolveExit(code ?? -1));
    daemon?.once('error', () => resolveExit(-1));
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    const exited = await Promise.race([daemonExit, Bun.sleep(0).then(() => undefined)]);
    if (exited !== undefined)
      throw new Error(`fyd exited with ${String(exited)} before it served; see ${paths.daemonLog}`);
    const health = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    const tokenText = await readFile(join(paths.fyHome, 'api-token'), 'utf8').catch(() => '');
    if (health?.ok === true && tokenText.trim() !== '') {
      token = tokenText.trim();
      redactions.add(token);
      return;
    }
    if (Date.now() > deadline) throw new Error(`fyd did not serve within 45 s; see ${paths.daemonLog}`);
    await Bun.sleep(200);
  }
}

/** SIGTERM to the daemon this program started (its own child, never a pattern), SIGKILL only if it will not go. */
async function stopDaemon(): Promise<void> {
  const child = daemon;
  if (child === undefined || daemonExit === undefined) return;
  daemon = undefined;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const gone = await Promise.race([daemonExit.then(() => true), Bun.sleep(20_000).then(() => false)]);
  if (!gone) {
    child.kill('SIGKILL');
    await Promise.race([daemonExit, Bun.sleep(5_000)]);
  }
}

async function tmux(args: readonly string[]): Promise<Ran> {
  const found = Bun.which('tmux');
  if (found === null) return { code: 127, out: '', err: 'tmux is not installed' };
  return run(found, ['-S', paths.tmuxSocket, ...args], { env: childEnvironment(), timeoutMs: 10_000 });
}

// ─── the build ───────────────────────────────────────────────────────────────────────────────────────────────────

async function startFerret(
  role: string,
  name: string,
  prompt: string,
  options: { mode: 'auto' | 'interactive'; parent?: string; cwd: string },
): Promise<FerretRecord> {
  const args = [
    'start',
    '--agent',
    runtime,
    '--mode',
    options.mode,
    '--name',
    name,
    '--cwd',
    options.cwd,
    '--json',
    prompt,
  ];
  let ran = await fy(args, { ...(options.parent === undefined ? {} : { as: options.parent }), timeoutMs: 180_000 });
  if (ran.code !== 0 && options.parent !== undefined) {
    // The ambient-session spelling was refused; the explicit one is the same lineage.
    ran = await fy([...args.slice(0, -1), '--parent', options.parent, prompt], { timeoutMs: 180_000 });
  }
  if (ran.code !== 0) throw new Error(`fy start exited ${String(ran.code)}: ${(ran.err || ran.out).trim()}`);
  const parsed = parseJson(ran.out);
  const id = findString((parsed as { config?: unknown } | undefined)?.config ?? parsed, ['id']);
  if (id === undefined) throw new Error('fy start printed no session id');
  const record: FerretRecord = {
    role,
    id,
    name,
    mode: options.mode,
    requestedParent: options.parent ?? null,
    state: 'running',
  };
  made.ferrets.push(record);
  return record;
}

let runtime = 'claude-default';
let pairedDevice: { daemonId: string; deviceId: string; device: TestDevice } | undefined;

async function build(): Promise<void> {
  await refuseUnlessDisposable();
  for (const name of ['fy', 'fyd'])
    if ((await Bun.file(join(v4Dir, name)).exists()) === false)
      throw new Error(`${join(v4Dir, name)} is missing; run fetch-v4.sh`);
  if (Bun.which('tmux') === null)
    throw new Error('tmux is not installed; the v4 daemon cannot run a ferret without it');

  made.out = out;
  made.fyHome = paths.fyHome;
  made.tmux = { socket: paths.tmuxSocket, keptPanes: keepPanes };

  // Layout: a disposable HOME with a fake Claude login, the two fake harnesses first on PATH, a folder for projects.
  await step('prepare the disposable world', true, async () => {
    for (const folder of [paths.fyHome, paths.userHome, paths.harnessBin, paths.work, join(paths.userHome, '.claude')])
      await mkdir(folder, { recursive: true });
    for (const folder of ['.config', '.cache', join('.local', 'state')])
      await mkdir(join(paths.userHome, folder), { recursive: true });
    await copyFile(join(SUPPORT, 'fake-claude-tui.sh'), join(paths.harnessBin, 'claude'));
    await copyFile(join(SUPPORT, 'fake-codex-login.ts'), join(paths.harnessBin, 'codex'));
    await chmod(join(paths.harnessBin, 'claude'), 0o755);
    await chmod(join(paths.harnessBin, 'codex'), 0o755);
    await writeFile(join(paths.userHome, '.claude', 'CLAUDE.md'), '# fixture\n', 'utf8');
    // The shape the setup scan reads as "signed in". Invented values; nothing here can reach an account.
    await writeFile(
      join(paths.userHome, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fake-fixture-access',
          refreshToken: 'fake-fixture-refresh',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    const version = await run(join(v4Dir, 'fyd'), ['--version'], { env: childEnvironment(), timeoutMs: 20_000 });
    if (!version.out.includes(V4_VERSION))
      throw new Error(`fyd reports "${version.out.trim()}", expected ${V4_VERSION}`);
  });

  await step('start the v4 daemon on the disposable home', true, startDaemon);

  await step('import the (fake) Claude Code as a runtime', true, async () => {
    await fyOk(['daemon', 'import', 'claude']);
    const runtimes = parseJson(await fyOk(['runtimes', '--json']));
    const names = Array.isArray(runtimes) ? (runtimes as { name?: string; id?: string; agent?: boolean }[]) : [];
    const agent = names.find(item => item.agent === true);
    runtime = agent?.name ?? agent?.id ?? 'claude-default';
    made.runtime = runtime;
  });

  // A project: a real git repository, because that is what a project is.
  const projectDir = join(paths.work, 'alpha');
  await step('register a project', true, async () => {
    await mkdir(projectDir, { recursive: true });
    const git = Bun.which('git');
    if (git !== null) await run(git, ['init', '--quiet', projectDir], { env: childEnvironment() });
    await fyOk(['project', 'add', projectDir]);
    const listing = parseJson(await fyOk(['project', 'ls', '--json']));
    made.project = { name: 'alpha', path: projectDir, id: findString(listing, ['id']) ?? null };
  });

  // Ferrets: a parent with two sub-ferrets, one standalone that ends, one interactive that is left running.
  const refs: { parent?: FerretRecord; running?: FerretRecord } = {};
  await step('start a parent ferret and two sub-ferrets (lineage)', true, async () => {
    const lead = await startFerret('parent', 'Fixture parent', 'Fixture: the lead of two sub-ferrets.', {
      mode: 'auto',
      cwd: projectDir,
    });
    refs.parent = lead;
    await startFerret('sub-a', 'Fixture sub A', 'Fixture: first sub-ferret.', {
      mode: 'auto',
      parent: lead.id,
      cwd: projectDir,
    });
    await startFerret('sub-b', 'Fixture sub B', 'Fixture: second sub-ferret.', {
      mode: 'auto',
      parent: lead.id,
      cwd: projectDir,
    });
  });
  await step('start a ferret that is left running in its pane', true, async () => {
    refs.running = await startFerret('running', 'Fixture running', 'Fixture: left running.', {
      mode: 'interactive',
      cwd: projectDir,
    });
  });
  await step('start a ferret and end it', true, async () => {
    const ended = await startFerret('ended', 'Fixture ended', 'Fixture: ended on purpose.', {
      mode: 'auto',
      cwd: projectDir,
    });
    await fyOk(['stop', '--reason', 'fixture: ended on purpose', 'orphan', '--yes', ended.id]);
    ended.state = 'ended';
  });
  cannot(
    'a ferret archived by the daemon',
    'the daemon archives an autonomous ferret only after it has been ended for more than a day; the fixture cannot wait a day and may not edit v4 files, so the ended ferret stays live-but-ended',
  );

  await step('read the lineage the daemon reports', false, async () => {
    for (const ferret of made.ferrets) {
      const status = parseJson(await fyOk(['status', ferret.id, '--json']));
      ferret.observedParent = findString(status, ['parentId', 'parent', 'parentSessionId']) ?? null;
    }
  });

  if (refs.running === undefined) throw new StepFailure('no running ferret');
  const target = refs.running.id;

  await step('queue messages for the running ferret', false, async () => {
    for (const text of ['fixture message one', 'fixture message two', 'fixture message three'])
      await fyOk(['send', target, '--kind', 'fyi', text]);
    const queue = parseJson(await fyOk(['queue', target, '--json']));
    const messages = (queue as { messages?: unknown[] } | undefined)?.messages ?? [];
    made.queue = {
      ferret: target,
      messages: messages.map(message => ({
        id: findString(message, ['id']) ?? null,
        state: findString(message, ['state', 'status']) ?? null,
      })),
    };
  });

  await step('pin a note and pin a ferret', false, async () => {
    await fyOk(['pin', '--session', target, 'add', 'fixture pinned note']);
    const pins = parseJson(await fyOk(['pin', '--session', target, 'ls', '--json']));
    made.pins = { ferret: target, ids: collectIds(pins) };
    await fyOk(['session', 'pin', target]);
    made.pinnedFerret = target;
  });

  await step('make board cards in two lanes, with a link, a dependency and history', false, async () => {
    await fy(['board', 'on', '--project', 'alpha']);
    const create = async (kind: string, title: string, extra: readonly string[]): Promise<string> => {
      const text = await fyOk([
        'task',
        'create',
        '--kind',
        kind,
        '--title',
        title,
        '--summary',
        `${title} summary`,
        '--ask',
        `${title}: the owner's words`,
        '--ask-source',
        'fixture',
        '--workflow',
        'quick',
        '--public',
        '--assignee',
        target,
        '--project',
        'alpha',
        '--json',
        ...extra,
      ]);
      const id = findString(parseJson(text), ['id']) ?? /\b([BFIC][1-9][0-9]*)\b/u.exec(text)?.[1];
      if (id === undefined) throw new Error('fy task create printed no card id');
      return id;
    };
    const first = await create('feature', 'Fixture card one', []);
    const second = await create('bug', 'Fixture card two', ['--depends-on', first]);
    await fyOk(['task', 'link', first, '--pr', 'https://example.invalid/fixture/pull/1']);
    await fyOk(['task', 'note', first, 'fixture history note one']);
    await fyOk(['task', 'note', second, 'fixture history note two']);
    await fyOk(['task', 'move', second, 'implement']);
    made.cards = [
      { id: first, lane: 'todo', link: 'pr', dependencyOf: second },
      { id: second, lane: 'implement', dependsOn: first },
    ];
  });

  await step('raise agenda asks: one answered, one open, and a notice', false, async () => {
    const add = async (kind: string, title: string, ask: string): Promise<string> => {
      const text = await fyOk(
        [
          'agenda',
          '--json',
          'add',
          '--title',
          title,
          '--kind',
          kind,
          '--ask',
          ask,
          '--premise',
          'Fixture: a v4 home is being built for the converter.',
          '--context',
          'Fixture: nothing here is real.',
        ],
        {
          as: target,
        },
      );
      const id = findString(parseJson(text), ['id']) ?? /\bA[1-9][0-9]*\b/u.exec(text)?.[0];
      if (id === undefined) throw new Error('fy agenda add printed no item id');
      return id.replace(/^[!&]/u, '');
    };
    const answered = await add('yesno', 'Fixture answered ask', 'Fixture: ship it?');
    const open = await add('yesno', 'Fixture open ask', 'Fixture: still open?');
    await fyOk(['agenda', 'done', `!${answered}`, '--yes', '--note', 'fixture answer']);
    made.agenda = [
      { id: answered, kind: 'yesno', state: 'answered', answer: 'yes' },
      { id: open, kind: 'yesno', state: 'open' },
    ];
    await fyOk(['notify', 'fixture notice'], { as: target });
    made.notices = [{ ferret: target, summary: 'fixture notice' }];
  });

  await step('file a lesson suggestion', false, async () => {
    const text = await fyOk([
      'lesson',
      'suggest',
      'Fixture rule: say what you did.',
      '--scope',
      'global',
      '--session',
      target,
      '--json',
    ]);
    made.lessons = [{ ferret: target, scope: 'global', id: findString(parseJson(text), ['id']) ?? null }];
  });

  await step('set one secret by name', false, async () => {
    await fyOk(['secret', 'set', FIXTURE_SECRET_NAME], { stdin: `${FIXTURE_SECRET_VALUE}\n` });
    const listing = await fyOk(['secret', 'ls', '--json']);
    if (!listing.includes(FIXTURE_SECRET_NAME)) throw new Error('the secret is not listed after it was set');
    made.secret = { name: FIXTURE_SECRET_NAME };
  });

  await step('pair a device with a generated key', false, async () => {
    const minted = await owner('POST', '/v1/pair/code');
    if (minted.status < 200 || minted.status >= 300)
      throw new Error(`minting a pairing code answered ${String(minted.status)}`);
    const body = minted.body as { daemonId?: string; code?: string };
    if (typeof body.daemonId !== 'string' || typeof body.code !== 'string')
      throw new Error('the mint answered without a daemon id and code');
    redactions.add(body.code);
    // Only somebody at the machine may loosen the unlock a new device must pass; the fixture is not measuring passkeys.
    await owner('PATCH', '/v1/security', { unlockOnOpen: false });
    const device = await newTestDevice();
    const paired = await pairOverSession(baseUrl, body.daemonId, body.code, 'Fixture phone', device);
    if (paired.kind !== 'paired') throw new Error('the daemon refused the fresh pairing code');
    pairedDevice = { daemonId: body.daemonId, deviceId: paired.response.deviceId, device };
    const spki = Buffer.from(device.publicKey, 'base64url');
    made.device = {
      id: paired.response.deviceId,
      name: 'Fixture phone',
      daemonId: body.daemonId,
      // Public material only: the key the daemon keeps in devices.json, and its SHA-256.
      publicKey: device.publicKey,
      publicKeySha256: createHash('sha256').update(spki).digest('base64url'),
    };
  });

  await step('leave a shared draft for the running ferret', false, async () => {
    if (pairedDevice === undefined)
      throw new Error('no paired device: a draft belongs to its owner, and only a device may edit it');
    const session = await deviceSession(baseUrl, pairedDevice.daemonId, pairedDevice.deviceId, pairedDevice.device);
    try {
      const path = `/v1/sessions/${encodeURIComponent(target)}/shared-draft`;
      const current = await session.request('GET', path);
      if (current.status !== 200) throw new Error(`GET shared-draft answered ${String(current.status)}`);
      const snapshot = JSON.parse(current.body) as { generation: unknown; epoch: number; rev: number };
      const edited = await session.request('POST', path, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          generation: snapshot.generation,
          epoch: snapshot.epoch,
          base: snapshot.rev,
          text: ['fixture shared draft'],
        }),
      });
      if (edited.status >= 300) throw new Error(`POST shared-draft answered ${String(edited.status)}`);
    } finally {
      session.close();
    }
    made.sharedDraft = { ferret: target, editedBy: 'the paired device' };
  });

  // Capture the running ferret's pane while the daemon and tmux are still up, then stop politely.
  await step('record the running ferret and its tmux pane', false, async () => {
    const panes = await tmux([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_dead}',
    ]);
    if (panes.code !== 0) throw new Error(`tmux list-panes exited ${String(panes.code)}: ${panes.err.trim()}`);
    const rows = panes.out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [session, window, windowName, pane, dead] = line.split('\t');
        return {
          session: session ?? '',
          window: Number(window),
          windowName: windowName ?? '',
          pane: pane ?? '',
          dead: dead === '1',
        };
      });
    made.running = {
      ferret: target,
      panes: rows,
      // Which pane is this ferret's, when a tmux name carries its id; otherwise every pane is listed above.
      pane: rows.find(row => row.session.includes(target) || row.windowName.includes(target)) ?? null,
    };
  });
}

function collectIds(value: unknown, depth = 0): string[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.id === 'string' ? [record.id] : [];
  return [...own, ...Object.values(record).flatMap(nested => collectIds(nested, depth + 1))];
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────────────────────────

let failure: string | undefined;
try {
  await build();
} catch (error) {
  failure = redact(error instanceof Error ? error.message : String(error));
  console.error(`❌ ${failure}`);
  // A refusal wrote nothing and starts nothing: it must not even leave a made.json in a folder it refused.
  if (error instanceof Refused) process.exit(2);
}

// Always: stop the daemon politely, then (by default) the tmux server BY ITS OWN SOCKET, never by pattern.
await stopDaemon();
if (!keepPanes && Bun.which('tmux') !== null) await tmux(['kill-server']);

made.complete = failure === undefined;
if (failure !== undefined) made.failure = failure;
await mkdir(dirname(join(out, 'made.json')), { recursive: true }).catch(() => undefined);
await writeFile(join(out, 'made.json'), `${JSON.stringify(made, null, 2)}\n`, { mode: 0o600 });
log(
  `made.json: ${join(out, 'made.json')} (${String(made.steps.filter(item => item.status === 'skipped').length)} skipped)`,
);
process.exit(failure === undefined ? 0 : 1);
