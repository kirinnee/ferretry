import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFleetScaffold } from '@ferretry/fleet';
import { FileFleetScaffolder } from '@ferretry/fleet/adapters';
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
import { StateHomeLayoutError } from '../../../../daemon/src/lib/index.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { defaultConfigPath, resolveFleetLayout } from '../../../src/lib/fleet/layout.ts';
import { StateHomeClaimService, StateHomeClaimRefusedError } from '../../../src/lib/state-home/claim.ts';

/**
 * The reported P0, in the tier CI actually runs.
 *
 * THE JOURNEY IS THE TEST. `fy fleet init` wrote `<FY_HOME>/fleet/**` and claimed nothing, so the
 * daemon's next boot met a non-empty home with no marker — the one arrangement it must refuse,
 * because it cannot tell that shape apart from somebody else's directory. The refusal was permanent:
 * the only move the shipped product left an owner was to delete the installation they had just
 * provisioned. Run the two commands the other way round and everything worked, so whether a fresh
 * install came up at all depended on which one a person happened to type first.
 *
 * Neither package could catch this alone, and both had passing suites while it shipped. `decideLayout`
 * was always correct on the inputs it was given; the scaffolder always wrote the files it was asked
 * for. The defect lived in the order, and nothing ran the two in sequence — which is the same reason
 * the `logs/` instance and the daemon's own configuration-ordering instance shipped before it.
 *
 * So this uses both packages' REAL production classes, wired the way `bin/fy.ts` wires them, against
 * one temporary state home. THE MARKER IS NEVER HAND-WRITTEN: it exists only because the client's
 * production claim put it there, which is the whole claim under test. The sibling file
 * `fresh-home-bootstrap.test.ts` does the same for the log-directory writer and explains why this
 * tier rather than e2e — no CI job runs the e2e tier, so these carry the guard.
 */

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

async function createTemporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-claim-'));
  homes.add(root);
  return join(root, 'state');
}

/** The claim service exactly as the composition root builds it. */
function claims(): StateHomeClaimService {
  return new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt');
}

/**
 * `fy fleet init`, through its real production path.
 *
 * The claim runs before the scaffolder for the same reason `bin/fy.ts` puts it there: a scaffold has
 * no undo, so a home this client will not adopt must be left exactly as it was found.
 */
async function fleetInitThroughTheCli(stateHome: string): Promise<void> {
  const layout = resolveFleetLayout({ stateHome, userHome: '/home-must-not-be-used', product: 'ferretry' });
  await claims().claim(layout.stateHome);
  await new FileFleetScaffolder([layout.fleetDirectory]).scaffold(
    buildFleetScaffold({
      layout,
      configPath: defaultConfigPath(layout),
      ids: { claude: 'aaaaaaaa-0000-4000-8000-000000000001', codex: 'aaaaaaaa-0000-4000-8000-000000000002' },
      firstAccount: 'claude',
    }),
  );
}

/** The daemon's own bootstrap, composed the way `packages/daemon/bin/fyd.ts` composes it. */
async function bootTheDaemon(stateHome: string): Promise<{ created: boolean }> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-08-05T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.add(opened.storage);
  return opened.layout;
}

async function makeWritable(path: string): Promise<void> {
  const state = await lstat(path).catch(() => undefined);
  if (state === undefined || state.isSymbolicLink()) return;
  await chmod(path, state.isDirectory() ? 0o700 : 0o600);
  if (!state.isDirectory()) return;
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
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
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) {
    await makeWritable(home);
    await rm(home, { recursive: true, force: true });
  }
  homes.clear();
});

describe('provisioning a fleet and then booting the daemon, across the package seam', () => {
  it('should leave a state home the daemon boots from, in the order the reporter used', async () => {
    // Arrange — a machine that has never run this, and no state home at all.
    const stateHome = await createTemporaryHome();

    // Act — the client provisions first, which is the ordering that used to be fatal.
    await fleetInitThroughTheCli(stateHome);
    const afterTheCli = await entriesOf(stateHome);
    const layout = await bootTheDaemon(stateHome);

    // Assert — before the fix, `open()` threw StateHomeLayoutError here every single time. Asserting
    // the marker as well as the boot is what pins the regression: a boot alone passes for reasons
    // that have nothing to do with the claim.
    should(afterTheCli).containDeep(['fleet', 'layout-version']);
    should(await readFile(join(stateHome, 'layout-version'), 'utf8')).equal('1\n');
    should((await stat(join(stateHome, 'layout-version'))).mode & 0o777).equal(0o600);
    // The daemon ADOPTED the client's claim rather than initializing over it: the home was already
    // ours, so this is a `proceed`, not a fresh bootstrap.
    should(layout.created).be.false();
  });

  it('should have written the marker only because production code did, never a fixture', async () => {
    // Arrange — the same journey, asserting the negative the ask calls out: a hand-written marker
    // would make this whole file test nothing.
    const stateHome = await createTemporaryHome();
    await mkdir(stateHome, { recursive: true });
    should(await entriesOf(stateHome)).be.empty();

    // Act
    await fleetInitThroughTheCli(stateHome);

    // Assert
    should(await entriesOf(stateHome)).containEql('layout-version');
  });

  it('should refuse to provision into a directory Ferretry did not create', async () => {
    // Arrange — a person points FY_HOME at their documents. The guard must still bite, on the CLIENT
    // side now too: before this change `fy fleet init` cheerfully provisioned a fleet in here.
    const stateHome = await createTemporaryHome();
    await mkdir(join(stateHome, 'Documents'), { recursive: true });
    await writeFile(join(stateHome, 'notes.txt'), 'not a state home\n', 'utf8');

    // Act
    const failure = await fleetInitThroughTheCli(stateHome).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — refused, naming what it found, and having written nothing at all.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('Documents');
    should((failure as Error).message).containEql('notes.txt');
    should(await entriesOf(stateHome)).deepEqual(['Documents', 'notes.txt']);
  });

  it('should repair the home every existing owner already has, and then boot', async () => {
    // Arrange — the upgrade path, and it is not hypothetical: EVERY home provisioned by a release
    // before this one is in exactly this state. The fleet content is arranged by hand because that IS
    // the legacy arrangement; the marker is the one thing that may never be faked.
    const stateHome = await createTemporaryHome();
    await mkdir(join(stateHome, 'fleet', 'bin'), { recursive: true });
    await writeFile(join(stateHome, 'fleet', 'config.yaml'), 'version: 1\naccounts: []\n', 'utf8');

    // Act — the daemon refuses, and the refusal has to carry the way out.
    const refusal = await bootTheDaemon(stateHome).then(
      () => undefined,
      (error: unknown) => error,
    );
    const adoption = await claims().adopt(stateHome);
    const layout = await bootTheDaemon(stateHome);

    // Assert
    should(refusal).be.instanceOf(StateHomeLayoutError);
    should((refusal as Error).message).containEql('fy daemon adopt');
    should(adoption.kind).equal('adopted');
    should(layout.created).be.false();
  });

  it('should refuse to adopt a directory holding anything Ferretry does not write', async () => {
    // Arrange — the asymmetry argued in the adopt docblock is allowed to be broader than the daemon's
    // silent recovery, but it is NOT allowed to adopt a stranger's directory.
    const stateHome = await createTemporaryHome();
    await mkdir(join(stateHome, 'fleet'), { recursive: true });
    await writeFile(join(stateHome, 'thesis.tex'), '\\documentclass{article}\n', 'utf8');

    // Act
    const failure = await claims()
      .adopt(stateHome)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert — refused, naming the entry, and no marker written into somebody else's directory.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('thesis.tex');
    should(await entriesOf(stateHome)).deepEqual(['fleet', 'thesis.tex']);
  });

  it('should adopt idempotently, so running the repair twice is safe', async () => {
    // Arrange
    const stateHome = await createTemporaryHome();
    await fleetInitThroughTheCli(stateHome);

    // Act
    const again = await claims().adopt(stateHome);

    // Assert — a repair a person may have run once already must not become a second failure mode.
    should(again.kind).equal('already-claimed');
    should(await readFile(join(stateHome, 'layout-version'), 'utf8')).equal('1\n');
  });
});
