import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as osConstants, tmpdir, userInfo } from 'node:os';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface CommandResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

type FakeHarnessStep =
  | { readonly type: 'say'; readonly text: string }
  | { readonly type: 'ask'; readonly text: string; readonly expect: string }
  | { readonly type: 'write'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | { readonly type: 'exit'; readonly code: number };

export interface FakeHarnessScenario {
  readonly version: 1;
  readonly steps: readonly FakeHarnessStep[];
}

export interface FakeHarnessInvocation {
  readonly wrapper: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface E2ePaths {
  readonly root: string;
  readonly fyHome: string;
  readonly home: string;
  readonly bin: string;
  readonly tmuxSocket: string;
  readonly harnessScenario: string;
  readonly harnessInvocations: string;
}

export interface E2ePorts {
  readonly api: number;
  readonly webSocket: number;
}

export interface E2eEnvironmentOptions {
  readonly runRoot?: string;
  readonly cliBin?: string;
  readonly fakeHarnessName?: string;
}

export interface StartDaemonOptions {
  /** An explicit executable path is required; the fixture never falls back to a live `fyd` on PATH. */
  readonly command: readonly [string, ...string[]];
  readonly env?: Readonly<Record<string, string>>;
  readonly readyUrl?: string;
  readonly timeoutMs?: number;
}

export interface WebSocketEventOptions<T> {
  readonly url?: string;
  readonly predicate: (event: T) => boolean;
  readonly timeoutMs?: number;
}

interface CapturedProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exited: Promise<CommandResult>;
  readonly output: () => Pick<CommandResult, 'out' | 'err'>;
}

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const FORBIDDEN_HOME_NAMES = ['.kteam', '.ferretry'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;

function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith(`~${sep}`)) return join(home, input.slice(2));
  return input;
}

function isInside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder));
}

async function canonicalizeWithMissingTail(input: string): Promise<string> {
  let cursor = input;
  const missing: string[] = [];

  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return input;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Rejects paths resolving into either live state home before the caller performs any IO there. */
export async function assertNoLiveStatePath(input: string, label = 'path'): Promise<string> {
  const liveHome = resolve(userInfo().homedir);
  const lexical = resolve(expandHome(input, liveHome));
  const forbiddenRoots = FORBIDDEN_HOME_NAMES.map(name => resolve(liveHome, name));

  for (const forbidden of forbiddenRoots) {
    if (isInside(forbidden, lexical)) {
      throw new Error(`E2E safety assertion refused ${label}: path resolves under live state`);
    }
  }

  const canonical = await canonicalizeWithMissingTail(lexical);
  for (const forbidden of forbiddenRoots) {
    if (isInside(forbidden, canonical)) {
      throw new Error(`E2E safety assertion refused ${label}: canonical path resolves under live state`);
    }
  }
  return canonical;
}

async function resolveExecutable(command: string, cwd: string, pathValue: string): Promise<string> {
  const candidates = command.includes(sep)
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : pathValue
        .split(delimiter)
        .filter(Boolean)
        .map(directory => resolve(directory, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return assertNoLiveStatePath(candidate, `executable ${command}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') {
        throw error;
      }
    }
  }
  throw new Error(`E2E executable is unavailable: ${command}`);
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}

function captureProcess(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): CapturedProcess {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    out += String(chunk);
  });
  child.stderr.on('data', chunk => {
    err += String(chunk);
  });

  const exited = new Promise<CommandResult>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      resolveExit({ code: code ?? signalExitCode(signal), out, err });
    });
  });
  return { child, exited, output: () => ({ out, err }) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCaptured(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<CommandResult> {
  const captured = captureProcess(executable, args, options);
  try {
    return await withTimeout(captured.exited, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, basename(executable));
  } catch (error) {
    captured.child.kill('SIGKILL');
    await captured.exited.catch(() => undefined);
    const output = captured.output();
    throw new Error(`${(error as Error).message}\nstdout:\n${output.out}\nstderr:\n${output.err}`, { cause: error });
  }
}

class PortLease {
  private released = false;

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async reserve(): Promise<PortLease> {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('failed to reserve an IPv4 E2E port');
    }
    return new PortLease(address.port, server);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      this.server.close(error => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateScenario(input: FakeHarnessScenario): void {
  if (input.version !== 1 || !Array.isArray(input.steps)) throw new Error('fake harness scenario must use version 1');
  for (const step of input.steps) {
    if (step.type === 'say') {
      if (typeof step.text !== 'string') throw new Error('fake harness say.text must be a string');
    } else if (step.type === 'ask') {
      if (typeof step.text !== 'string' || typeof step.expect !== 'string') {
        throw new Error('fake harness ask requires string text and expect fields');
      }
    } else if (step.type === 'write') {
      if ((step.stream !== 'stdout' && step.stream !== 'stderr') || typeof step.text !== 'string') {
        throw new Error('fake harness write requires a valid stream and string text');
      }
    } else if (step.type === 'exit') {
      if (!Number.isInteger(step.code) || step.code < 0 || step.code > 255) {
        throw new Error('fake harness exit.code must be an integer from 0 through 255');
      }
    } else {
      throw new Error('fake harness scenario contains an unknown step');
    }
  }
}

export class E2eEnvironment {
  readonly paths: E2ePaths;
  readonly ports: E2ePorts;
  readonly fakeHarnessName: string;
  readonly repositoryRoot = REPOSITORY_ROOT;

  private readonly apiPortLease: PortLease;
  private readonly webSocketPortLease: PortLease;
  private readonly realTmux: string;
  private readonly sessionName: string;
  private readonly suiteRoot: string;
  private readonly cliBin: string;
  private portsReleased = false;
  private tmuxStarted = false;
  private daemon: CapturedProcess | undefined;
  private disposePromise: Promise<void> | undefined;

  private constructor(input: {
    paths: E2ePaths;
    ports: E2ePorts;
    fakeHarnessName: string;
    apiPortLease: PortLease;
    webSocketPortLease: PortLease;
    realTmux: string;
    sessionName: string;
    suiteRoot: string;
    cliBin: string;
  }) {
    this.paths = input.paths;
    this.ports = input.ports;
    this.fakeHarnessName = input.fakeHarnessName;
    this.apiPortLease = input.apiPortLease;
    this.webSocketPortLease = input.webSocketPortLease;
    this.realTmux = input.realTmux;
    this.sessionName = input.sessionName;
    this.suiteRoot = input.suiteRoot;
    this.cliBin = input.cliBin;
  }

  static async create(options: E2eEnvironmentOptions = {}): Promise<E2eEnvironment> {
    const suiteRootInput = options.runRoot ?? process.env.FY_E2E_RUN_ROOT ?? tmpdir();
    const suiteRoot = await assertNoLiveStatePath(suiteRootInput, 'E2E run root');
    await mkdir(suiteRoot, { recursive: true });
    const root = await mkdtemp(join(suiteRoot, 'fy-e2e-'));
    const paths: E2ePaths = {
      root,
      fyHome: join(root, 'state'),
      home: join(root, 'home'),
      bin: join(root, 'bin'),
      tmuxSocket: join(root, 'tmux.sock'),
      harnessScenario: join(root, 'harness-scenario.json'),
      harnessInvocations: join(root, 'harness-invocations.jsonl'),
    };

    let apiPortLease: PortLease | undefined;
    let webSocketPortLease: PortLease | undefined;
    let subject: E2eEnvironment | undefined;
    try {
      for (const [label, path] of Object.entries(paths)) await assertNoLiveStatePath(path, label);
      await Promise.all([
        mkdir(paths.fyHome, { recursive: true }),
        mkdir(paths.home, { recursive: true }),
        mkdir(paths.bin, { recursive: true }),
        mkdir(join(paths.home, '.config'), { recursive: true }),
        mkdir(join(paths.home, '.cache'), { recursive: true }),
        mkdir(join(paths.home, '.local', 'state'), { recursive: true }),
      ]);

      const parentPath = process.env.PATH ?? '';
      const realTmux = await resolveExecutable('tmux', REPOSITORY_ROOT, parentPath);
      const cliBin = await resolveCliBinary(options.cliBin);
      apiPortLease = await PortLease.reserve();
      webSocketPortLease = await PortLease.reserve();
      const suffix = basename(root)
        .replaceAll(/[^a-zA-Z0-9]/g, '')
        .slice(-12);
      subject = new E2eEnvironment({
        paths,
        ports: { api: apiPortLease.port, webSocket: webSocketPortLease.port },
        fakeHarnessName: options.fakeHarnessName ?? 'fy-e2e-agent',
        apiPortLease,
        webSocketPortLease,
        realTmux,
        sessionName: `fy-e2e-${suffix}`,
        suiteRoot,
        cliBin,
      });
      await subject.initialize();
      return subject;
    } catch (error) {
      if (subject !== undefined) {
        await subject.dispose().catch(cleanupError => {
          throw new AggregateError([error, cleanupError], 'E2E setup and cleanup both failed');
        });
      } else {
        await Promise.allSettled([apiPortLease?.release(), webSocketPortLease?.release()]);
        await rm(root, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await this.installFixtureExecutable('fake-harness.ts', this.fakeHarnessName);
    await this.installFixtureExecutable('scoped-tmux.sh', 'tmux');
    await this.setFakeHarnessScenario({ version: 1, steps: [{ type: 'exit', code: 0 }] });
    await writeFile(this.paths.harnessInvocations, '', 'utf8');

    const started = await this.runRealTmux([
      '-f',
      '/dev/null',
      '-S',
      this.paths.tmuxSocket,
      'new-session',
      '-d',
      '-s',
      this.sessionName,
      '-n',
      'control',
    ]);
    if (started.code !== 0) throw new Error(`failed to start isolated tmux server: ${started.err}`);
    this.tmuxStarted = true;

    const configured = await this.runTmux(['set-option', '-g', 'remain-on-exit', 'on']);
    if (configured.code !== 0) throw new Error(`failed to configure isolated tmux server: ${configured.err}`);
    const directSocket = await this.runTmux(['display-message', '-p', '#{socket_path}']);
    if (directSocket.code !== 0 || directSocket.out.trim() !== this.paths.tmuxSocket) {
      throw new Error('isolated tmux server reported an unexpected socket');
    }

    const routedSocket = await this.runCapturedExecutable(join(this.paths.bin, 'tmux'), [
      'display-message',
      '-p',
      '#{socket_path}',
    ]);
    if (routedSocket.code !== 0 || routedSocket.out.trim() !== this.paths.tmuxSocket) {
      throw new Error('PATH tmux router did not resolve to the isolated server');
    }
  }

  private async installFixtureExecutable(sourceName: string, targetName: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]+$/.test(targetName) || targetName === '.' || targetName === '..') {
      throw new Error(`invalid E2E executable name: ${targetName}`);
    }
    const source = await assertNoLiveStatePath(join(REPOSITORY_ROOT, 'scripts', 'test', sourceName), sourceName);
    const target = await assertNoLiveStatePath(join(this.paths.bin, targetName), targetName);
    await copyFile(source, target);
    await chmod(target, 0o755);
    return target;
  }

  async installFakeHarness(name: string): Promise<string> {
    return this.installFixtureExecutable('fake-harness.ts', name);
  }

  childEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/(?:api_?key|token|secret|password|credential)/i.test(name)) continue;
      if (name === 'CODEX_HOME' || name === 'CLAUDE_CONFIG_DIR') continue;
      env[name] = value;
    }
    Object.assign(env, extra);
    Object.assign(env, {
      HOME: this.paths.home,
      XDG_CONFIG_HOME: join(this.paths.home, '.config'),
      XDG_CACHE_HOME: join(this.paths.home, '.cache'),
      XDG_STATE_HOME: join(this.paths.home, '.local', 'state'),
      FY_HOME: this.paths.fyHome,
      FY_E2E_API_PORT: String(this.ports.api),
      FY_E2E_WS_PORT: String(this.ports.webSocket),
      FY_E2E_REAL_TMUX: this.realTmux,
      FY_E2E_TMUX_SOCKET: this.paths.tmuxSocket,
      FY_E2E_HARNESS_SCRIPT: this.paths.harnessScenario,
      FY_E2E_HARNESS_INVOCATIONS: this.paths.harnessInvocations,
      PATH: `${this.paths.bin}${delimiter}${process.env.PATH ?? ''}`,
      NO_COLOR: '1',
    });
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
    return env;
  }

  async assertSafePath(path: string, label?: string): Promise<string> {
    return assertNoLiveStatePath(path, label);
  }

  async setFakeHarnessScenario(scenario: FakeHarnessScenario): Promise<void> {
    validateScenario(scenario);
    await writeFile(this.paths.harnessScenario, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  }

  async readFakeHarnessInvocations(): Promise<readonly FakeHarnessInvocation[]> {
    const content = await readFile(this.paths.harnessInvocations, 'utf8');
    if (content.trim() === '') return [];
    return content
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as FakeHarnessInvocation);
  }

  async runFy(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
    const executable = await assertNoLiveStatePath(this.cliBin, 'compiled CLI');
    await access(executable, fsConstants.X_OK);
    return this.runCapturedExecutable(executable, args, env);
  }

  async runFakeHarnessInTmux(
    args: readonly string[] = [],
    inputLines: readonly string[] = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CommandResult> {
    const env = this.childEnvironment();
    const fakeExecutable = await resolveExecutable(this.fakeHarnessName, REPOSITORY_ROOT, env.PATH ?? '');
    const canonicalBin = await realpath(this.paths.bin);
    if (!isInside(canonicalBin, fakeExecutable))
      throw new Error('fake harness resolved outside the isolated bin directory');

    const captureRoot = await mkdtemp(join(this.paths.root, 'pane-'));
    const stdoutPath = join(captureRoot, 'stdout');
    const stderrPath = join(captureRoot, 'stderr');
    const command = `${shellQuote(fakeExecutable)}${args.length === 0 ? '' : ` ${args.map(shellQuote).join(' ')}`} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`;
    const launched = await this.runTmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      REPOSITORY_ROOT,
      '-t',
      `${this.sessionName}:`,
      '-n',
      'fake-harness',
      command,
    ]);
    if (launched.code !== 0) throw new Error(`failed to launch fake harness pane: ${launched.err}`);
    const paneId = launched.out.trim();

    try {
      for (const line of inputLines) {
        const sent = await this.runTmux(['send-keys', '-t', paneId, '-l', line]);
        if (sent.code !== 0) throw new Error(`failed to send fake harness input: ${sent.err}`);
        const entered = await this.runTmux(['send-keys', '-t', paneId, 'Enter']);
        if (entered.code !== 0) throw new Error(`failed to submit fake harness input: ${entered.err}`);
      }

      const deadline = Date.now() + timeoutMs;
      let code: number | undefined;
      while (Date.now() < deadline) {
        const state = await this.runTmux(['display-message', '-p', '-t', paneId, '#{pane_dead}:#{pane_dead_status}']);
        if (state.code !== 0) throw new Error(`failed to inspect fake harness pane: ${state.err}`);
        const [dead, status] = state.out.trim().split(':');
        if (dead === '1') {
          code = Number(status);
          break;
        }
        await Bun.sleep(20);
      }
      if (code === undefined || !Number.isInteger(code))
        throw new Error(`fake harness pane timed out after ${timeoutMs}ms`);
      const [out, err] = await Promise.all([readFile(stdoutPath, 'utf8'), readFile(stderrPath, 'utf8')]);
      return { code, out, err };
    } finally {
      await this.runTmux(['kill-pane', '-t', paneId]);
    }
  }

  async runTmux(args: readonly string[]): Promise<CommandResult> {
    return this.runRealTmux(['-S', this.paths.tmuxSocket, ...args]);
  }

  async tmuxServerIsRunning(): Promise<boolean> {
    const actual = await this.runRealTmux(['-S', this.paths.tmuxSocket, 'has-session', '-t', this.sessionName]);
    return actual.code === 0;
  }

  private async runRealTmux(args: readonly string[]): Promise<CommandResult> {
    return runCaptured(this.realTmux, args, {
      cwd: REPOSITORY_ROOT,
      env: this.childEnvironment(),
      timeoutMs: 5_000,
    });
  }

  private async runCapturedExecutable(
    executable: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<CommandResult> {
    const safeExecutable = await assertNoLiveStatePath(executable, 'child executable');
    return runCaptured(safeExecutable, args, {
      cwd: REPOSITORY_ROOT,
      env: this.childEnvironment(extraEnv),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  private assertLoopbackHarnessUrl(input: string): URL {
    const url = new URL(input);
    const port = Number(url.port);
    if (url.hostname !== '127.0.0.1' || (port !== this.ports.api && port !== this.ports.webSocket)) {
      throw new Error("E2E network helpers only connect to this run's loopback ephemeral ports");
    }
    return url;
  }

  httpUrl(path = '/', port = this.ports.api): string {
    return new URL(path, `http://127.0.0.1:${port}`).toString();
  }

  webSocketUrl(path = '/events', port = this.ports.webSocket): string {
    return new URL(path, `ws://127.0.0.1:${port}`).toString();
  }

  async waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
    const safeUrl = this.assertLoopbackHarnessUrl(url);
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(safeUrl, { signal: AbortSignal.timeout(Math.min(1_000, timeoutMs)) });
        if (response.ok) return;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(25);
    }
    throw new Error(`E2E HTTP readiness timed out for ${safeUrl}`, { cause: lastError });
  }

  async awaitWebSocketEvent<T>(options: WebSocketEventOptions<T>): Promise<T> {
    const url = this.assertLoopbackHarnessUrl(options.url ?? this.webSocketUrl());
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        return await this.awaitWebSocketAttempt(url, options.predicate, remaining);
      } catch (error) {
        lastError = error;
        if (Date.now() < deadline) await Bun.sleep(25);
      }
    }
    throw new Error(`E2E WebSocket event timed out for ${url}`, { cause: lastError });
  }

  private async awaitWebSocketAttempt<T>(url: URL, predicate: (event: T) => boolean, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolveEvent, rejectEvent) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => rejectEvent(new Error('WebSocket event attempt timed out')));
      }, timeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
        socket.close();
      };
      socket.addEventListener('message', event => {
        void decodeWebSocketData(event.data)
          .then(text => JSON.parse(text) as T)
          .then(value => {
            if (predicate(value)) finish(() => resolveEvent(value));
          })
          .catch(error => finish(() => rejectEvent(error)));
      });
      socket.addEventListener('error', () => finish(() => rejectEvent(new Error('WebSocket connection failed'))), {
        once: true,
      });
      socket.addEventListener(
        'close',
        () => finish(() => rejectEvent(new Error('WebSocket closed before a matching event'))),
        { once: true },
      );
    });
  }

  private async releasePortLeases(): Promise<void> {
    if (this.portsReleased) return;
    await Promise.all([this.apiPortLease.release(), this.webSocketPortLease.release()]);
    this.portsReleased = true;
  }

  async startDaemon(options: StartDaemonOptions): Promise<void> {
    if (this.daemon !== undefined) throw new Error('E2E daemon is already running');
    if (!isAbsolute(options.command[0])) throw new Error('E2E daemon command must use an explicit absolute path');
    const executable = await assertNoLiveStatePath(options.command[0], 'daemon executable');
    await access(executable, fsConstants.X_OK);
    await this.releasePortLeases();

    const daemon = captureProcess(executable, options.command.slice(1), {
      cwd: REPOSITORY_ROOT,
      env: this.childEnvironment(options.env),
    });
    this.daemon = daemon;
    if (options.readyUrl === undefined) return;

    try {
      await Promise.race([
        this.waitForHttp(options.readyUrl, options.timeoutMs ?? 10_000),
        daemon.exited.then(result => {
          throw new Error(`E2E daemon exited before readiness (code ${result.code})\n${result.err}`);
        }),
      ]);
    } catch (error) {
      await this.stopDaemon().catch(() => undefined);
      throw error;
    }
  }

  async stopDaemon(timeoutMs = 5_000): Promise<CommandResult | undefined> {
    const daemon = this.daemon;
    if (daemon === undefined) return undefined;
    this.daemon = undefined;

    if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGTERM');
    try {
      return await withTimeout(daemon.exited, timeoutMs, 'E2E daemon shutdown');
    } catch {
      daemon.child.kill('SIGKILL');
      return daemon.exited;
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    const errors: unknown[] = [];
    await this.stopDaemon().catch(error => errors.push(error));
    if (this.tmuxStarted) {
      const killed = await this.runTmux(['kill-server']).catch(error => {
        errors.push(error);
        return undefined;
      });
      if (killed !== undefined && killed.code !== 0 && !killed.err.includes('no server running'))
        errors.push(new Error(killed.err));
      this.tmuxStarted = false;
    }
    await this.releasePortLeases().catch(error => errors.push(error));

    const safeRoot = await assertNoLiveStatePath(this.paths.root, 'owned E2E cleanup root').catch(error => {
      errors.push(error);
      return undefined;
    });
    const child = safeRoot === undefined ? '..' : relative(this.suiteRoot, safeRoot);
    if (
      safeRoot !== undefined &&
      !child.startsWith(`..${sep}`) &&
      child !== '..' &&
      basename(safeRoot).startsWith('fy-e2e-')
    ) {
      await rm(safeRoot, { recursive: true, force: true }).catch(error => errors.push(error));
    } else if (safeRoot !== undefined) {
      errors.push(new Error('refused to remove an unowned E2E path'));
    }
    if (errors.length > 0) throw new AggregateError(errors, 'E2E cleanup failed');
  }
}

async function resolveCliBinary(configured: string | undefined): Promise<string> {
  const explicit = configured ?? process.env.CLI_BIN;
  if (explicit !== undefined && explicit !== '') {
    return assertNoLiveStatePath(isAbsolute(explicit) ? explicit : resolve(REPOSITORY_ROOT, explicit), 'compiled CLI');
  }
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as {
    readonly name: string;
    readonly bin: Readonly<Record<string, string>>;
  };
  const binaryName = Object.keys(packageJson.bin)[0] ?? packageJson.name;
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return assertNoLiveStatePath(
    join(REPOSITORY_ROOT, 'dist', 'bin', `${binaryName}-${platform}-${architecture}`),
    'compiled CLI',
  );
}

async function decodeWebSocketData(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

export async function withE2eEnvironment<T>(
  callback: (environment: E2eEnvironment) => Promise<T>,
  options: E2eEnvironmentOptions = {},
): Promise<T> {
  const subject = await E2eEnvironment.create(options);
  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = await callback(subject);
  } catch (error) {
    callbackError = error;
  }

  let cleanupError: unknown;
  try {
    await subject.dispose();
  } catch (error) {
    cleanupError = error;
  }
  if (callbackError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([callbackError, cleanupError], 'E2E journey and cleanup both failed');
  }
  if (callbackError !== undefined) throw callbackError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}
