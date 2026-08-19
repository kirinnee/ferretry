import { type HealthView, HealthViewSchema } from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../../../src/lib/daemon/binary';
import type { DaemonEnvironmentInput, DaemonLayout } from '../../../src/lib/daemon/layout';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout';
import type {
  CommandOutcome,
  DaemonLifecycleClaimRequest,
  DaemonStartHandle,
  DaemonSupervisorReport,
  DetachedLaunch,
  HeldGcRoot,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonProcessPort,
  INixGcRootPort,
  IRetiredArtifactPort,
  IServiceDefinitionSupervisor,
  IServiceFilePort,
  IStateHomeClaimPort,
  RetiredArtifactOutcome,
  StopRequest,
} from '../../../src/lib/daemon/ports';

/** A temp-shaped home that is never the real one; no test may resolve a live state home. */
export const HOME = '/tmp/fy-home';

export function environment(overrides: Partial<DaemonEnvironmentInput> = {}): DaemonEnvironmentInput {
  return {
    platform: 'linux',
    homeDirectory: HOME,
    userId: 1000,
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

/** The daemon a host has installed: ABSOLUTE, because a unit file cannot name anything else. */
export function installedDaemon(overrides: Partial<InstalledDaemonBinary> = {}): InstalledDaemonBinary {
  return { path: '/opt/fy/bin/fyd', source: 'PATH', version: '1.2.3', ...overrides };
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

/**
 * The first-password offer, recording whether it was made.
 *
 * It records rather than acts, because what the controller owes this collaborator is one call at one
 * moment: after a start has completed and never after any other verb. Whether the offer then ASKS
 * anybody anything is `FirstPasswordOffer`'s own decision and is proved in its own file.
 */
export class RecordingFirstPassword {
  offers = 0;

  /** The lifecycle lock's own trail, so a test can prove WHERE in the transaction this happened. */
  constructor(private readonly trail?: string[]) {}

  async offer(): Promise<void> {
    this.offers += 1;
    this.trail?.push('offer:first-password');
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

  /**
   * Every filesystem and claim effect, in the order they happened.
   *
   * Shared with `FakeStateHomeClaim` because the defect this guards is an ORDERING one: creating
   * `<state home>/logs` before the home is claimed is precisely what made a fresh install refuse to
   * boot, and two separate call logs cannot show which came first.
   */
  readonly trail: string[] = [];

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.present.has(path) || this.written.has(path));
  }

  writePrivate(path: string, contents: string): Promise<void> {
    this.written.set(path, contents);
    this.trail.push(`write:${path}`);
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
    this.trail.push(`mkdir:${path}`);
    return Promise.resolve();
  }
}

/** Records which home was claimed and when, against the same trail the filesystem writes to. */
export class FakeStateHomeClaim implements IStateHomeClaimPort {
  readonly claimed: string[] = [];
  /** Set to make the claim refuse, the way a foreign directory does. */
  refusal: Error | undefined;

  constructor(private readonly trail: string[] = []) {}

  claim(home: string): Promise<unknown> {
    this.claimed.push(home);
    this.trail.push(`claim:${home}`);
    return this.refusal === undefined ? Promise.resolve({ kind: 'claimed', home }) : Promise.reject(this.refusal);
  }
}

/** Records what would have been pinned, and can refuse the way a missing `nix-store` does. */
export class FakeNixGcRoot implements INixGcRootPort {
  /** Maps a path to what it really resolves to; anything absent resolves to itself. */
  readonly links = new Map<string, string>();
  readonly realPaths: string[] = [];
  readonly pinned: Array<{ storePath: string; rootPath: string }> = [];
  readonly released: string[] = [];
  /** Root entry names already in the root directory, as a real one would report them. */
  heldNames: readonly string[] = [];
  failure: string | undefined;
  afterRealPath: (() => void) | undefined;

  realPath(path: string): Promise<string> {
    this.realPaths.push(path);
    this.afterRealPath?.();
    return Promise.resolve(this.links.get(path) ?? path);
  }

  held(directory: string): Promise<readonly HeldGcRoot[]> {
    return Promise.resolve(this.heldNames.map(name => ({ name, path: `${directory}/${name}` })));
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

/**
 * Records the lifecycle claim a verb took, and the order it took and gave it up in.
 *
 * The trail is what proves serialization is a TRANSACTION rather than a decoration: the whole of a
 * verb's work has to sit between `acquire` and `release`, so an assertion on the order these entries
 * arrive in is an assertion that no root or definition write escaped the claim.
 */
export class FakeLifecycleLock implements IDaemonLifecycleLockPort {
  readonly trail: string[] = [];
  readonly requests: DaemonLifecycleClaimRequest[] = [];
  /** Exact claim paths released, so multi-claim tests can prove reverse-order cleanup. */
  readonly releasedPaths: string[] = [];
  /** Set to refuse the way a claim held by a live peer does. */
  refusal: Error | undefined;
  /** One-based acquisition number that refuses; defaults to the first request. */
  refusalAt = 1;
  /** Reported from `release`, the way an unremovable claim directory is. */
  residue: string | undefined;
  /** Announced through the caller's own notice, the way a contended first attempt does. */
  holder: string | undefined;

  acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim> {
    this.requests.push(request);
    if (this.refusal !== undefined && this.requests.length === this.refusalAt) return Promise.reject(this.refusal);
    this.trail.push(`acquire:${request.verb}`);
    if (this.holder !== undefined) request.waiting(this.holder);
    return Promise.resolve({
      release: () => {
        this.releasedPaths.push(request.lockPath);
        this.trail.push(`release:${request.verb}`);
        return Promise.resolve(this.residue);
      },
    });
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

/**
 * Records which retired artifact trees a verb asked to remove, and can answer for each of them.
 *
 * The DEFAULT is `absent`, because that is what every host gets that never ran the release with the
 * snapshot store: the ordinary path has to be the one that needs no arranging, or a test proves the
 * cleanup only in the world where there is something to clean.
 */
export class FakeRetiredArtifacts implements IRetiredArtifactPort {
  readonly retired: string[] = [];
  readonly answers = new Map<string, RetiredArtifactOutcome>();

  retire(path: string): Promise<RetiredArtifactOutcome> {
    this.retired.push(path);
    return Promise.resolve(this.answers.get(path) ?? { kind: 'absent' });
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
  readonly installedExecutables: string[] = [];
  readonly startedExecutables: string[] = [];
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

  install(executable: string): Promise<void> {
    this.calls.push('install');
    this.installedExecutables.push(executable);
    return this.installError === undefined ? Promise.resolve() : Promise.reject(this.installError);
  }

  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    return Promise.resolve();
  }

  start(executable: string): Promise<DaemonStartHandle> {
    this.calls.push('start');
    this.startedExecutables.push(executable);
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
