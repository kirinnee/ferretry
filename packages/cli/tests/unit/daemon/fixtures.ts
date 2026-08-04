import { type HealthView, HealthViewSchema } from '@ferretry/protocol';
import type { DaemonEnvironmentInput, DaemonLayout } from '../../../src/lib/daemon/layout';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout';
import type {
  CommandOutcome,
  DaemonSnapshot,
  DaemonSnapshotBuild,
  DaemonStartHandle,
  DaemonSupervisorReport,
  DetachedLaunch,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonProcessPort,
  IDaemonSnapshotPort,
  INixGcRootPort,
  IServiceDefinitionSupervisor,
  IServiceFilePort,
  StopRequest,
} from '../../../src/lib/daemon/ports';

/** A temp-shaped home that is never the real one; no test may resolve a live state home. */
export const HOME = '/tmp/fy-home';

export function environment(overrides: Partial<DaemonEnvironmentInput> = {}): DaemonEnvironmentInput {
  return {
    platform: 'linux',
    homeDirectory: HOME,
    userId: 1000,
    daemonBinary: '/opt/fy/bin/fyd',
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin:/bin',
    ...overrides,
  };
}

export function layout(overrides: Partial<DaemonEnvironmentInput> = {}): DaemonLayout {
  return resolveDaemonLayout(environment(overrides));
}

/** A health view the protocol schema actually accepts, so no test asserts against an invented shape. */
export function health(overrides: Partial<HealthView> = {}): HealthView {
  return HealthViewSchema.parse({
    ok: true,
    bootstrapping: false,
    bootstrapState: 'complete',
    bootstrapDegraded: false,
    version: '1.2.3',
    pid: 4242,
    sessions: 3,
    running: 2,
    monitors: 2,
    unmonitoredRunning: 0,
    wardenLastSweepSeconds: 12,
    wardenTimerArmed: true,
    eventLoopLagMs: 1.25,
    lastSelfCheckAt: '2026-07-31T00:00:00.000Z',
    wedgeCount: 0,
    scratchGcEnabled: true,
    scratchReclaimedSessions: 0,
    scratchReclaimedBytes: 0,
    bootstrapErrors: 0,
    time: '2026-07-31T00:00:01.000Z',
    ...overrides,
  });
}

export function daemonSnapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  const id = `sha256-${'a'.repeat(64)}`;
  return {
    id,
    daemon: { product: 'ferretry', name: 'fyd' },
    sourceBinary: '/opt/fy/bin/fyd',
    binaryPath: `${HOME}/.local/state/ferretry/daemon-snapshots/fyd/snapshots/${id}/fyd`,
    bytes: 1024,
    createdAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

/** Captured terminal output, in the order it was written. */
export class CapturedOutput implements IDaemonOutput {
  readonly lines: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.lines.push(`ok: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  error(message: string): void {
    this.lines.push(`err: ${message}`);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

/** One scripted answer per command, matched on the joined argv. */
export type CommandScript = ReadonlyArray<readonly [string, CommandOutcome]>;

export class FakeProcesses implements IDaemonProcessPort {
  readonly ran: string[] = [];
  readonly launched: DetachedLaunch[] = [];
  readonly signalled: Array<{ pid: number; signal: string }> = [];
  livePids = new Set<number>();
  nextPid = 9001;

  constructor(private readonly script: CommandScript = []) {}

  run(argv: readonly string[]): Promise<CommandOutcome> {
    const key = argv.join(' ');
    this.ran.push(key);
    const match = this.script.find(([pattern]) => key.includes(pattern));
    return Promise.resolve(match?.[1] ?? { code: 0, stdout: '', stderr: '' });
  }

  spawnDetached(launch: DetachedLaunch): Promise<DaemonStartHandle> {
    this.launched.push(launch);
    const pid = this.nextPid;
    this.livePids.add(pid);
    return Promise.resolve({ pid });
  }

  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signalled.push({ pid, signal });
    return this.livePids.delete(pid);
  }

  alive(pid: number): boolean {
    return this.livePids.has(pid);
  }
}

export class FakeFiles implements IServiceFilePort {
  readonly written = new Map<string, string>();
  readonly directories: string[] = [];
  readonly removed: string[] = [];
  present = new Set<string>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.present.has(path) || this.written.has(path));
  }

  writePrivate(path: string, contents: string): Promise<void> {
    this.written.set(path, contents);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.removed.push(path);
    this.written.delete(path);
    this.present.delete(path);
    return Promise.resolve();
  }

  ensureDirectory(path: string): Promise<void> {
    this.directories.push(path);
    return Promise.resolve();
  }
}

/** Records what would have been pinned, and can refuse the way a missing `nix-store` does. */
export class FakeNixGcRoot implements INixGcRootPort {
  /** Maps a path to what it really resolves to; anything absent resolves to itself. */
  readonly links = new Map<string, string>();
  readonly realPaths: string[] = [];
  readonly pinned: Array<{ storePath: string; rootPath: string }> = [];
  readonly released: string[] = [];
  failure: string | undefined;

  realPath(path: string): Promise<string> {
    this.realPaths.push(path);
    return Promise.resolve(this.links.get(path) ?? path);
  }

  pin(storePath: string, rootPath: string): Promise<string | undefined> {
    this.pinned.push({ storePath, rootPath });
    return Promise.resolve(this.failure);
  }

  release(rootPath: string): Promise<void> {
    this.released.push(rootPath);
    return Promise.resolve();
  }
}

/** Answers a scripted sequence of probes, repeating the last one forever. */
export class FakeHealth implements IDaemonHealthPort {
  calls = 0;

  constructor(private readonly answers: ReadonlyArray<HealthView | undefined>) {}

  probe(): Promise<HealthView | undefined> {
    const answer = this.answers[Math.min(this.calls, this.answers.length - 1)];
    this.calls += 1;
    return Promise.resolve(answer);
  }
}

export class FakeLogs implements IDaemonLogPort {
  readonly shown: Array<{ file: string; follow: boolean }> = [];

  constructor(
    private readonly present = true,
    private readonly code = 0,
  ) {}

  exists(): Promise<boolean> {
    return Promise.resolve(this.present);
  }

  show(logFile: string, follow: boolean): Promise<number> {
    this.shown.push({ file: logFile, follow });
    return Promise.resolve(this.code);
  }
}

export class FakeSnapshots implements IDaemonSnapshotPort {
  readonly calls: string[] = [];
  currentAnswer: DaemonSnapshot | undefined = daemonSnapshot();
  buildAnswer: DaemonSnapshotBuild = { ...daemonSnapshot(), created: true };
  listAnswer: readonly DaemonSnapshot[] = [daemonSnapshot()];
  currentError: Error | undefined;

  build(): Promise<DaemonSnapshotBuild> {
    this.calls.push('build');
    return Promise.resolve(this.buildAnswer);
  }

  promote(id: string): Promise<DaemonSnapshot> {
    this.calls.push(`promote:${id}`);
    const snapshot = this.listAnswer.find(candidate => candidate.id === id) ?? { ...this.buildAnswer, id };
    this.currentAnswer = snapshot;
    return Promise.resolve(snapshot);
  }

  current(): Promise<DaemonSnapshot | undefined> {
    this.calls.push('current');
    return this.currentError === undefined ? Promise.resolve(this.currentAnswer) : Promise.reject(this.currentError);
  }

  list(): Promise<readonly DaemonSnapshot[]> {
    this.calls.push('list');
    return Promise.resolve(this.listAnswer);
  }
}

/** A clock that advances by a fixed step every time it is read, so waits terminate. */
export class SteppingClock implements IClockPort {
  readonly slept: number[] = [];
  private current = 0;

  constructor(private readonly stepMs = 100) {}

  now(): number {
    const value = this.current;
    this.current += this.stepMs;
    return value;
  }

  sleep(milliseconds: number): Promise<void> {
    this.slept.push(milliseconds);
    return Promise.resolve();
  }
}

/** A supervisor whose every answer is scripted, for controller tests. */
export class FakeSupervisor implements IServiceDefinitionSupervisor {
  readonly calls: string[] = [];
  readonly stops: StopRequest[] = [];
  startHandle: DaemonStartHandle = { pid: 777 };
  installedAnswer = true;
  reports: DaemonSupervisorReport[] = [];
  installError: Error | undefined;
  definitionPath = '/tmp/fy-home/.config/systemd/user/fyd.service';

  constructor(
    readonly manager: 'systemd' | 'launchd' | 'direct',
    private readonly fallback: DaemonSupervisorReport,
  ) {}

  installed(): Promise<boolean> {
    this.calls.push('installed');
    return Promise.resolve(this.installedAnswer);
  }

  install(): Promise<void> {
    this.calls.push('install');
    return this.installError === undefined ? Promise.resolve() : Promise.reject(this.installError);
  }

  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    this.calls.push('refresh');
    return Promise.resolve();
  }

  start(): Promise<DaemonStartHandle> {
    this.calls.push('start');
    return Promise.resolve(this.startHandle);
  }

  stop(request: StopRequest): Promise<void> {
    this.calls.push(request.escalate ? 'stop:escalate' : 'stop');
    this.stops.push(request);
    return Promise.resolve();
  }

  inspect(handle?: DaemonStartHandle): Promise<DaemonSupervisorReport> {
    this.calls.push(handle?.pid === undefined ? 'inspect' : `inspect:${String(handle.pid)}`);
    return Promise.resolve(this.reports.shift() ?? this.fallback);
  }
}

export const runningReport: DaemonSupervisorReport = { manager: 'systemd', state: 'running', pid: 4242 };
export const stoppedReport: DaemonSupervisorReport = { manager: 'systemd', state: 'stopped' };
export const absentReport: DaemonSupervisorReport = { manager: 'direct', state: 'absent' };
export const failedReport: DaemonSupervisorReport = { manager: 'systemd', state: 'failed' };
