import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../daemon/src/adapters/index.ts';
import { NixStoreGcRoot } from '../../../src/adapters/daemon/nix-gc-root.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileResetTrees } from '../../../src/adapters/daemon/reset-trees.ts';
import { FileRetiredArtifacts } from '../../../src/adapters/daemon/retired-artifacts.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { TmuxSessionTerminalServer } from '../../../src/adapters/daemon/session-terminals.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { DaemonController, type DaemonControllerDeps } from '../../../src/lib/daemon/controller.ts';
import { type DaemonLayout, resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import type {
  CommandOutcome,
  DaemonStartHandle,
  DetachedLaunch,
  IDaemonLifecycleClaim,
  IDaemonProcessPort,
} from '../../../src/lib/daemon/ports.ts';
import { DirectSupervisor, SystemdSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * `fy daemon reset`, end to end, and then `fy daemon start` on what it left behind.
 *
 * THE SECOND HALF IS THE POINT. Removing two directories is easy to get right and easy to prove; what
 * an owner actually needs is a machine that comes back, and that is a claim about the seam between two
 * packages with no compiler across it. So this drives the REAL controller over the REAL filesystem
 * adapters, and then hands the surviving directory to the daemon's own `DaemonStorageFactory` — the
 * same composition `packages/daemon/bin/fyd.ts` uses. A reset that left a subtly wrong home would boot
 * into `StateHomeLayoutError` here rather than in front of the person who ran it.
 *
 * This file and `fresh-home-bootstrap.test.ts` are the only places `packages/cli` reaches into
 * `packages/daemon`, and it stays confined to a test for the reason stated there: the two packages have
 * no dependency on each other and must not gain one, so this seam has no compiler to check it.
 */

const roots = new Set<string>();
const stores = new Set<DaemonStorage>();

/** A harmless executable to launch: this proves the client's filesystem effects, not the daemon's boot. */
const NOTHING = Bun.which('true') ?? '/bin/true';

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-reset-slate-'));
  roots.add(root);
  return root;
}

/** The layout `fy daemon …` resolves, with both roots inside one temporary directory. */
function layoutFor(root: string): DaemonLayout {
  return resolveDaemonLayout({
    platform: 'linux',
    homeDirectory: join(root, 'home'),
    stateHome: join(root, 'home', 'state'),
    configHome: join(root, 'home', 'config-home'),
    stateDirectory: join(root, 'home', 'client-state'),
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin:/bin',
  });
}

/** Exactly what `fy daemon start` does to the filesystem before the daemon is running. */
async function startThroughTheClient(layout: DaemonLayout): Promise<void> {
  const supervisor = new DirectSupervisor(
    layout,
    new BunDaemonProcess(),
    new FileServiceStore(),
    new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
  );
  const handle = await supervisor.start(NOTHING);
  if (handle.pid !== undefined) {
    try {
      process.kill(handle.pid, 'SIGKILL');
    } catch {
      // Already gone — `true` exits at once.
    }
  }
}

/** The daemon's own bootstrap, composed the way `packages/daemon/bin/fyd.ts` composes it. */
async function bootTheDaemon(stateHome: string): Promise<{ created: boolean }> {
  return (await openTheDaemon(stateHome)).layout;
}

/** The same boot, keeping the opened storage — which holds the home's lifetime lock until closed. */
async function openTheDaemon(stateHome: string): Promise<{ storage: DaemonStorage; layout: { created: boolean } }> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-08-19T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.add(opened.storage);
  return opened;
}

async function closeStores(): Promise<void> {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
}

/**
 * A full installation: a claimed and bootstrapped state home, plus the artifact tree an upgraded host
 * carries — a snapshot store sealed read-only, and a garbage-collection link into a store output.
 */
async function installation(layout: DaemonLayout): Promise<void> {
  await startThroughTheClient(layout);
  await bootTheDaemon(layout.stateHome);
  await closeStores();
  // Somebody's real data on the other end of a link inside the tree, and a
  // secret inside the home, so what a reset destroys is something this test can see going.
  await writeFile(join(layout.stateHome, 'state', 'secrets.json'), '{"ciphertext":"x"}');

  const snapshot = join(layout.legacySnapshotRoot, 'snapshots', `sha256-${'a'.repeat(64)}`);
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'fyd'), 'x'.repeat(1_000));
  await chmod(join(snapshot, 'fyd'), 0o555);
  await chmod(snapshot, 0o555);
}

/** Every collaborator the client actually ships, apart from the daemon's answer and the terminal. */
function deps(layout: DaemonLayout, out: string[], serving: HealthView | undefined): DaemonControllerDeps {
  return {
    layout,
    service: undefined,
    direct: new DirectSupervisor(
      layout,
      new BunDaemonProcess(),
      new FileServiceStore(),
      new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
    ),
    health: { probe: () => Promise.resolve(serving) },
    logs: { exists: () => Promise.resolve(false), show: () => Promise.resolve(0) },
    nix: new NixStoreGcRoot(new BunDaemonProcess()),
    lifecycle: {
      acquire: (): Promise<IDaemonLifecycleClaim> => Promise.resolve({ release: () => Promise.resolve(undefined) }),
    },
    installedDaemon: () => ({ path: NOTHING, source: 'PATH', version: '1.2.3' }),
    retired: new FileRetiredArtifacts(),
    resetTrees: new FileResetTrees(),
    // The daemon is down in every case here, so nothing is ever asked of this. That is the ordinary
    // situation for a reset: somebody is resetting a machine whose daemon will not serve.
    resetInventory: { count: () => Promise.resolve(undefined) },
    sessionTerminals: new TmuxSessionTerminalServer(new BunDaemonProcess()),
    claims: new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
    prompt: { ask: () => Promise.resolve('') },
    interactive: () => false,
    clientName: 'fy',
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    out: {
      success: message => out.push(message),
      warn: message => out.push(message),
      error: message => out.push(message),
      setExitCode: () => {},
    },
    setupNotice: { say: () => Promise.resolve() },
  };
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

async function entriesOf(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

afterEach(async () => {
  await closeStores();
  for (const root of roots) {
    // The fixtures seal directories read-only, so the tidy-up needs the same unsealing the subject does.
    await new FileRetiredArtifacts().retire(root);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('resetting an installation and starting again on the clean slate', () => {
  it('should remove BOTH roots of a real installation, including the sealed snapshot store', async () => {
    // Arrange — the exact state an upgraded host is in, and the exact mistake this verb exists to stop:
    // clearing the state home by hand and leaving the artifact tree, then running the pinned daemon
    // inside it.
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    should(await exists(join(layout.stateHome, 'state', 'secrets.json'))).be.true();
    should(await exists(layout.legacySnapshotRoot)).be.true();

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert — the home is back as a fresh install's first step leaves it: claimed, and nothing else.
    should(await entriesOf(layout.stateHome)).deepEqual(['layout-version']);
    should(await exists(layout.stateArtifactRoot)).be.false();
    should(out.join('\n')).containEql('removed 2 path(s)');
  });

  it('should leave a state home the daemon bootstraps exactly as it does on a fresh machine', async () => {
    // Arrange
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });

    // Act — `fy daemon start` on the clean slate, then the daemon's own boot into what it left.
    await startThroughTheClient(layout);
    const afterTheClient = await entriesOf(layout.stateHome);
    const opened = await bootTheDaemon(layout.stateHome);

    // Assert — byte for byte the shape `fresh-home-bootstrap.test.ts` pins for a machine that has never
    // run this. A reset that left an unclaimed home, or a stray entry the daemon's layout model has not
    // declared, would throw StateHomeLayoutError right here instead of in front of the owner.
    should(afterTheClient).deepEqual(['layout-version', 'logs']);
    should(opened.created).be.false();
    should(await readFile(join(layout.stateHome, 'layout-version'), 'utf8')).equal('2\n');
    should(await entriesOf(layout.stateHome)).deepEqual([
      'config',
      'daemon.lock',
      'fleet',
      'layout-version',
      'logs',
      'state',
    ]);
  });

  it('should leave no stored secret behind, so the machine comes back as a fresh install does', async () => {
    // Arrange
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);

    // Act
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });
    await startThroughTheClient(layout);
    await bootTheDaemon(layout.stateHome);

    // Assert
    should(await exists(join(layout.stateHome, 'state', 'secrets.json'))).be.false();
  });

  it('should never follow a link out of either root, whatever it points at', async () => {
    // Arrange — the artifact tree really does hold links into `/nix/store`, and FY_HOME may hold one of
    // its own. Following either would recursively delete data that is not this daemon's, and nothing in
    // the caller could undo it.
    const root = await createTemporaryRoot();
    const layout = layoutFor(root);
    await installation(layout);
    const precious = join(root, 'not-ours');
    await mkdir(join(precious, 'bin'), { recursive: true });
    await writeFile(join(precious, 'bin', 'fyd'), 'somebody elses executable');
    await mkdir(join(layout.stateArtifactRoot, 'nix'), { recursive: true });
    await symlink(precious, layout.nixGcRoot);
    await symlink(precious, join(layout.stateHome, 'fleet', 'homes'));

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert — both trees gone, both links gone, and every byte on the far side of them still there.
    should(await entriesOf(layout.stateHome)).deepEqual(['layout-version']);
    should(await exists(layout.nixGcRoot)).be.false();
    should(await readFile(join(precious, 'bin', 'fyd'), 'utf8')).equal('somebody elses executable');
    // And it was said out loud before anything was destroyed, so nobody had to trust it.
    should(out.join('\n')).containEql('NOTHING it points at is read, followed or removed');
  });

  it('should be safe to run twice, reporting plainly that only the empty claimed home was left', async () => {
    // Arrange — somebody who is not sure the first one worked runs it again.
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert — the first reset's re-claim is the one file the second finds, and it claims it again.
    should(out.join('\n')).containEql('removed 1 path(s), 1 files');
    should(out.join('\n')).containEql(`absent  ${layout.stateArtifactRoot}`);
    should(await entriesOf(layout.stateHome)).deepEqual(['layout-version']);
  });

  it('should refuse a reset whose state home resolves to the invoking home directory', async () => {
    // Arrange — `FY_HOME=$HOME`, which is a typo somebody will make, and the cost of not catching it is
    // every file that person owns. The refusal has to land before anything is measured, let alone
    // removed.
    const root = await createTemporaryRoot();
    const home = join(root, 'home');
    await mkdir(join(home, 'documents'), { recursive: true });
    await writeFile(join(home, 'documents', 'thesis.txt'), 'years of work');
    const layout = resolveDaemonLayout({
      platform: 'linux',
      homeDirectory: home,
      stateHome: home,
      configHome: join(home, 'config-home'),
      stateDirectory: join(home, 'client-state'),
      userId: 1000,
      daemonName: 'fyd',
      product: 'ferretry',
      searchPath: '/usr/bin:/bin',
    });

    // Act + Assert
    await should(new DaemonController(deps(layout, [], undefined)).reset({ yes: true })).be.rejectedWith(
      /resolves to the home directory itself/u,
    );
    should(await readFile(join(home, 'documents', 'thesis.txt'), 'utf8')).equal('years of work');
  });
});

/**
 * systemd, played by this test, and the daemon it supervises, played by the daemon's own storage.
 *
 * Every `systemctl` the client sends is answered here; everything else — the tmux a reset ends, the
 * `/proc` lookup that ties a pid to the home's lock — runs for real. "Starting" the unit opens the
 * daemon's storage IN THIS PROCESS, so the daemon's real layout decision runs on whatever the client
 * left, and this process genuinely holds the lifetime lock a reset checks before it stops anything.
 */
class PlayedSystemd implements IDaemonProcessPort {
  readonly commands: string[] = [];
  #serving: DaemonStorage | undefined;
  readonly #real = new BunDaemonProcess();

  constructor(private readonly stateHome: string) {}

  get serving(): boolean {
    return this.#serving !== undefined;
  }

  async run(argv: readonly string[]): Promise<CommandOutcome> {
    if (argv[0] !== 'systemctl') return await this.#real.run(argv);
    const verb = argv[2] ?? '';
    this.commands.push(argv.slice(2).join(' '));
    if (verb === 'restart' || verb === 'start') {
      await this.#stop();
      this.#serving = (await openTheDaemon(this.stateHome)).storage;
    }
    if (verb === 'stop' || (verb === 'disable' && argv.includes('--now'))) await this.#stop();
    if (verb === 'show') {
      const state = this.serving ? `active\nMainPID=${String(process.pid)}` : 'inactive';
      return { code: 0, stdout: `LoadState=loaded\nActiveState=${state}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async #stop(): Promise<void> {
    const serving = this.#serving;
    this.#serving = undefined;
    if (serving === undefined) return;
    stores.delete(serving);
    await serving.close();
  }

  spawnDetached(launch: DetachedLaunch): Promise<DaemonStartHandle> {
    return this.#real.spawnDetached(launch);
  }

  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    return this.#real.signal(pid, signal);
  }

  alive(pid: number): boolean {
    return this.#real.alive(pid);
  }

  holdsOpen(pid: number, path: string): Promise<boolean | undefined> {
    return this.#real.holdsOpen(pid, path);
  }
}

/** A health answer the protocol accepts, from the daemon this process is playing. */
function servingHealth(): HealthView {
  return {
    ok: true,
    bootstrapping: false,
    bootstrapState: 'complete',
    bootstrapDegraded: false,
    version: '1.2.3',
    pid: process.pid,
    sessions: 1,
    running: 1,
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
}

/** The controller `fy daemon …` builds on a systemd host, over the played manager. */
function supervised(layout: DaemonLayout, systemd: PlayedSystemd, out: string[]): DaemonController {
  const claims = new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt', {
    warn: message => out.push(message),
  });
  const files = new FileServiceStore();
  return new DaemonController({
    ...deps(layout, out, undefined),
    service: new SystemdSupervisor(layout, systemd, files, claims),
    direct: new DirectSupervisor(layout, systemd, files, claims),
    health: { probe: () => Promise.resolve(systemd.serving ? servingHealth() : undefined) },
    claims,
    // Real readiness and shutdown loops, against a clock that does not make the suite wait.
    clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
  });
}

/**
 * What a live agent does the moment its home is removed: the harness writes its own state again, and
 * \`mkdir -p\` recreates \`<FY_HOME>/fleet/…\` around it. This is the write that left the owner's home
 * all-Ferretry and unmarked, and \`fy daemon install\` refusing it.
 */
async function anAgentWritesItsHomeAgain(layout: DaemonLayout): Promise<string> {
  const agentHome = join(layout.stateHome, 'fleet', 'homes', 'claude-default');
  await mkdir(agentHome, { recursive: true });
  const written = join(agentHome, '.claude.json');
  await writeFile(written, '{"numStartups":42}');
  return written;
}

const TMUX = Bun.which('tmux');

/** A real session terminal server on the daemon's socket, running an agent that keeps writing. */
async function aLiveAgent(layout: DaemonLayout): Promise<number> {
  const tmux = TMUX ?? 'tmux';
  const agentHome = join(layout.stateHome, 'fleet', 'homes', 'claude-default');
  const loop = `while :; do mkdir -p '${agentHome}' && echo x >> '${agentHome}/history.jsonl'; sleep 0.05; done`;
  const started = Bun.spawnSync([
    tmux,
    '-f',
    '/dev/null',
    '-S',
    layout.sessionTerminalSocket,
    'new-session',
    '-d',
    '-s',
    'agent',
    `exec sh -c "${loop}"`,
  ]);
  if (started.exitCode !== 0) throw new Error(`tmux would not start: ${started.stderr.toString()}`);
  sockets.add(layout.sessionTerminalSocket);
  const shown = Bun.spawnSync([tmux, '-S', layout.sessionTerminalSocket, 'display-message', '-p', '#{pane_pid}']);
  return Number(shown.stdout.toString().trim());
}

const sockets = new Set<string>();

afterEach(() => {
  for (const socket of sockets) Bun.spawnSync([TMUX ?? 'tmux', '-S', socket, 'kill-server']);
  sockets.clear();
});

describe('installing again after a reset, in every order an owner runs it', () => {
  it('should install after install, then reset, even when an agent wrote into the home afterwards', async () => {
    // Arrange — the reported sequence's core: a supervised installation, reset, and a live agent's
    // first write landing in the removed home before the next install.
    const layout = layoutFor(await createTemporaryRoot());
    const systemd = new PlayedSystemd(layout.stateHome);
    const out: string[] = [];
    await supervised(layout, systemd, out).install();
    await supervised(layout, systemd, out).reset({ yes: true });
    const written = await anAgentWritesItsHomeAgain(layout);

    // Act
    await supervised(layout, systemd, out).install();

    // Assert — installed and serving, on a home the daemon booted into, and nothing had to be adopted.
    should(systemd.serving).be.true();
    should(systemd.commands).containEql('stop fyd.service');
    should(await readFile(join(layout.stateHome, 'layout-version'), 'utf8')).equal('2\n');
    should(await exists(written)).be.true();
    should(out.join('\n')).containEql(`claimed ${layout.stateHome} again, empty`);
    should(out.join('\n')).not.containEql('refusing');
  });

  it('should install after uninstall, then reset, which is the order the owner reported', async () => {
    // Arrange — uninstall first, so the reset runs with no service definition and nothing serving.
    const layout = layoutFor(await createTemporaryRoot());
    const systemd = new PlayedSystemd(layout.stateHome);
    const out: string[] = [];
    await supervised(layout, systemd, out).install();
    await supervised(layout, systemd, out).uninstall();
    should(systemd.serving).be.false();
    await supervised(layout, systemd, out).reset({ yes: true });
    await anAgentWritesItsHomeAgain(layout);

    // Act
    await supervised(layout, systemd, out).install();

    // Assert
    should(systemd.serving).be.true();
    should(await exists(layout.systemdUnitFile)).be.true();
    should(await readFile(join(layout.stateHome, 'layout-version'), 'utf8')).equal('2\n');
  });

  it('should install after a reset and a status in between', async () => {
    // Arrange — a read in the middle must create nothing and change nothing.
    const layout = layoutFor(await createTemporaryRoot());
    const systemd = new PlayedSystemd(layout.stateHome);
    const out: string[] = [];
    await supervised(layout, systemd, out).install();
    await supervised(layout, systemd, out).reset({ yes: true });
    await supervised(layout, systemd, out).status({});
    should(await entriesOf(layout.stateHome)).deepEqual(['layout-version']);

    // Act
    await supervised(layout, systemd, out).install();

    // Assert
    should(systemd.serving).be.true();
  });

  it('should adopt, and say so, a marker-less home an older reset left holding only empty directories', async () => {
    // Arrange — a home an earlier release's reset left behind: the agents' \`mkdir -p\` recreated the
    // scaffold, and nothing has been written into it yet.
    const layout = layoutFor(await createTemporaryRoot());
    await mkdir(join(layout.stateHome, 'fleet', 'homes', 'claude-default'), { recursive: true });
    await mkdir(join(layout.stateHome, 'logs'), { recursive: true });
    await writeFile(join(layout.stateHome, 'logs', 'fyd.log'), 'fyd stopping\n');
    const systemd = new PlayedSystemd(layout.stateHome);
    const out: string[] = [];

    // Act
    await supervised(layout, systemd, out).install();

    // Assert
    should(systemd.serving).be.true();
    should(out.join('\n')).containEql('held only empty Ferretry directories and logs (fleet, logs)');
  });

  it.skipIf(TMUX === null)('should end a live agent before it removes the home that agent writes into', async () => {
    // Arrange — a real tmux server on the daemon's socket, with an agent writing into its home.
    const layout = layoutFor(await createTemporaryRoot());
    const systemd = new PlayedSystemd(layout.stateHome);
    const out: string[] = [];
    await supervised(layout, systemd, out).install();
    const agent = await aLiveAgent(layout);
    await waitFor(() => systemd.alive(agent), 'the live agent to be running');

    // Act
    await supervised(layout, systemd, out).reset({ yes: true });

    // Assert — the agent is gone, the home is claimed, and the next install just works.
    await waitFor(() => !systemd.alive(agent), 'reset to have ended the live agent');
    should(out.join('\n')).containEql("ended every fyd session's running agent");
    should(await readFile(join(layout.stateHome, 'layout-version'), 'utf8')).equal('2\n');
    await supervised(layout, systemd, out).install();
    should(systemd.serving).be.true();
  });
});
