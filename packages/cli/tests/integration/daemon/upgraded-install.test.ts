import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView } from '@ferretry/protocol';
import should from 'should';
import { NixStoreGcRoot } from '../../../src/adapters/daemon/nix-gc-root.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileRetiredArtifacts } from '../../../src/adapters/daemon/retired-artifacts.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { DaemonController, type DaemonControllerDeps } from '../../../src/lib/daemon/controller.ts';
import { type DaemonLayout, resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import type {
  CommandOutcome,
  DaemonStartHandle,
  DaemonSupervisorReport,
  IClockPort,
  IDaemonLifecycleClaim,
  IDaemonOutput,
  IDaemonProcessPort,
  IServiceDefinitionSupervisor,
} from '../../../src/lib/daemon/ports.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';

/**
 * A host upgraded FROM the release that kept a daemon snapshot store, against a real filesystem.
 *
 * The unit tier proves the controller's decisions against fakes. This one proves the effects nothing
 * but a real filesystem can: the store an earlier release sealed read-only actually disappears, its
 * per-snapshot Nix roots actually go with it, the daemon actually launches from the executable this
 * host has installed, and none of that touches what a garbage-collection root pointed at.
 *
 * `nix-store` is scripted rather than run, for the same reason the root adapter's own suite scripts
 * it: invoking the real one would register a garbage-collection root in `/nix/var/nix/gcroots/auto`
 * on whatever machine ran the suite.
 */

const roots = new Set<string>();

/** A harmless executable to launch: `true` writes nothing and exits at once. */
const NOTHING = Bun.which('true') ?? '/bin/true';

/** A health view the protocol schema accepts, so nothing is asserted against an invented shape. */
const SERVING = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '1.2.3',
  pid: 4242,
  sessions: 0,
  running: 0,
  monitors: 0,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: 1,
  wardenTimerArmed: true,
  eventLoopLagMs: 0,
  lastSelfCheckAt: '2026-08-04T12:00:00.000Z',
  wedgeCount: 0,
  scratchGcEnabled: true,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-08-04T12:00:01.000Z',
} as HealthView;

class CapturedOutput implements IDaemonOutput {
  readonly lines: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.lines.push(message);
  }

  error(message: string): void {
    this.lines.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

/** Answers every command as an absent `nix-store`, and records that nothing else was attempted. */
class ScriptedProcesses implements IDaemonProcessPort {
  readonly ran: string[][] = [];

  run(argv: readonly string[]): Promise<CommandOutcome> {
    this.ran.push([...argv]);
    return Promise.resolve({ code: 127, stdout: '', stderr: 'nix-store: not found' });
  }

  spawnDetached(): Promise<never> {
    return Promise.reject(new Error('the supervisor under test spawns through its own adapter'));
  }

  signal(): boolean {
    return false;
  }

  alive(): boolean {
    return false;
  }
}

class ImmediateClock implements IClockPort {
  private current = 0;

  now(): number {
    this.current += 10;
    return this.current;
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** A service manager whose every answer is scripted, so `uninstall` can complete off a Linux host. */
class StubService implements IServiceDefinitionSupervisor {
  readonly manager = 'systemd' as const;
  readonly calls: string[] = [];

  constructor(readonly definitionPath: string) {}

  installed(): Promise<boolean> {
    return Promise.resolve(true);
  }

  install(): Promise<void> {
    this.calls.push('install');
    return Promise.resolve();
  }

  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    return Promise.resolve();
  }

  start(): Promise<DaemonStartHandle> {
    this.calls.push('start');
    return Promise.resolve({});
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  inspect(): Promise<DaemonSupervisorReport> {
    return Promise.resolve({ manager: 'systemd', state: 'absent' });
  }
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-upgraded-'));
  roots.add(root);
  return root;
}

function layoutFor(root: string): DaemonLayout {
  return resolveDaemonLayout({
    // A host with no service manager, so `start` reaches the direct supervisor's real filesystem work.
    platform: 'freebsd',
    homeDirectory: root,
    stateHome: join(root, 'state'),
    configHome: join(root, 'config-home'),
    stateDirectory: join(root, 'cli-state'),
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin:/bin',
  });
}

/**
 * The exact durable state the retired release left: sealed snapshots, a promoted pointer, and one
 * garbage-collection root per snapshot, each pointing outside anything of ours.
 */
async function populateRetiredStore(layout: DaemonLayout, target: string): Promise<void> {
  const ids = [`sha256-${'a'.repeat(64)}`, `sha256-${'b'.repeat(64)}`];
  await mkdir(join(layout.legacySnapshotRoot, 'staging'), { recursive: true });
  await writeFile(join(layout.legacySnapshotRoot, 'promoted'), '1\n');
  await symlink(join('snapshots', ids[0] ?? '', 'fyd'), join(layout.legacySnapshotRoot, 'current'));
  for (const id of ids) {
    const directory = join(layout.legacySnapshotRoot, 'snapshots', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'fyd'), 'a copy of the daemon');
    await writeFile(join(directory, 'manifest.json'), '{}');
    await chmod(join(directory, 'fyd'), 0o555);
    await chmod(directory, 0o555);
  }
  await mkdir(layout.legacySnapshotGcRootDirectory, { recursive: true });
  for (const id of ids) await symlink(target, join(layout.legacySnapshotGcRootDirectory, id));
}

/** Every collaborator the CLI actually ships, apart from the daemon's answer, the clock and the terminal. */
function deps(
  layout: DaemonLayout,
  out: CapturedOutput,
  serving: ReadonlyArray<HealthView | undefined>,
): DaemonControllerDeps {
  let probe = 0;
  return {
    layout,
    service: undefined,
    direct: new DirectSupervisor(
      layout,
      new BunDaemonProcess(),
      new FileServiceStore(),
      new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
    ),
    health: { probe: () => Promise.resolve(serving[Math.min(probe++, serving.length - 1)]) },
    logs: { exists: () => Promise.resolve(false), show: () => Promise.resolve(0) },
    nix: new NixStoreGcRoot(new ScriptedProcesses()),
    lifecycle: {
      acquire: (): Promise<IDaemonLifecycleClaim> => Promise.resolve({ release: () => Promise.resolve(undefined) }),
    },
    installedDaemon: () => ({ path: NOTHING, source: 'PATH', version: '1.2.3' }),
    retired: new FileRetiredArtifacts(),
    clock: new ImmediateClock(),
    out,
    firstPassword: { offer: () => Promise.resolve() },
  };
}

async function entriesOf(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  return await readdir(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
  );
}

afterEach(async () => {
  for (const root of roots) {
    // The fixtures seal directories read-only, so the tidy-up needs the same unsealing the subject does.
    await new FileRetiredArtifacts().retire(root);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('a host upgraded from the daemon snapshot store', () => {
  it('should start from the installed daemon and retire the store it used to launch from', async () => {
    // Arrange — a populated, sealed store and its roots, exactly as the retired release left them.
    const root = await createTemporaryRoot();
    const layout = layoutFor(root);
    const target = join(root, 'pretend-store-output');
    await mkdir(target, { recursive: true });
    await populateRetiredStore(layout, target);
    const out = new CapturedOutput();

    // Act
    await new DaemonController(deps(layout, out, [undefined, SERVING])).start();

    // Assert — the daemon came up from the installed executable, the store and its roots are gone,
    // the reclaimed disk is stated, and what those roots pointed AT is untouched.
    should(out.text).containEql('fyd ready (pid 4242)');
    should(out.text).containEql('removed the retired fyd snapshot store');
    should(await exists(layout.legacySnapshotRoot)).be.false();
    should(await exists(layout.legacySnapshotGcRootDirectory)).be.false();
    should(await exists(target)).be.true();
    should(await entriesOf(layout.stateHome)).deepEqual(['layout-version', 'logs']);
  });

  it('should retire it on uninstall too, so removing Ferretry does not leave 100MB behind', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const layout = layoutFor(root);
    const target = join(root, 'pretend-store-output');
    await mkdir(target, { recursive: true });
    await populateRetiredStore(layout, target);
    const out = new CapturedOutput();
    const service = new StubService(join(root, 'config-home', 'systemd', 'user', 'fyd.service'));

    // Act
    await new DaemonController({ ...deps(layout, out, [undefined]), service }).uninstall();

    // Assert
    should(service.calls).deepEqual(['uninstall']);
    should(out.text).containEql('user service removed');
    should(out.text).containEql('removed the retired fyd snapshot store');
    should(await exists(layout.legacySnapshotRoot)).be.false();
    should(await exists(layout.legacySnapshotGcRootDirectory)).be.false();
  });

  it('should say nothing and remove nothing on a host that never had one', async () => {
    // Arrange — the ordinary fresh install, which must not narrate a cleanup that did not happen.
    const root = await createTemporaryRoot();
    const layout = layoutFor(root);
    const out = new CapturedOutput();

    // Act
    await new DaemonController(deps(layout, out, [undefined, SERVING])).start();

    // Assert — nothing of the retired shape is created, and no cleanup is narrated. The pin notice
    // is machine-dependent, because `true` itself comes from the Nix store on a NixOS host.
    should(out.text).containEql('fyd ready (pid 4242)');
    should(out.text).not.containEql('removed the retired');
    should(out.text).not.containEql('could not remove');
    should(await exists(layout.legacySnapshotRoot)).be.false();
    should(await exists(layout.legacySnapshotGcRootDirectory)).be.false();
    should(await entriesOf(join(root, 'cli-state', 'ferretry'))).not.containEql('daemon-snapshots');
  });
});
