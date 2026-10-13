import { describe, it } from 'bun:test';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_RUNTIME_IDS,
  type FleetLayout,
  materialiseFleet,
  parseAccountModel,
  SharedHistoryMigration,
} from '@ferretry/fleet';
import { FileFleetProvisioner, FileSharedHistoryFileSystem } from '@ferretry/fleet/adapters';
import should from 'should';
import { ManifestAccountInventory } from '../../../src/adapters/core/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  accountLaunchability,
  createFoundationPaths,
  type ExecutableResolverPort,
  NO_HARNESS_DECLARATIONS,
  readHarnessPreflight,
  resolveStateHome,
} from '../../../src/lib/index.ts';

/**
 * THE TEST THAT WAS MISSING.
 *
 * Both halves of this system had tests. The fleet proved it wrote a manifest; the daemon proved it
 * could read one. Each owned its own fixture, so the two shapes drifted apart and nothing failed:
 * the released daemon reported "the fleet manifest publishes no account for either" about a file
 * `fy fleet ls` listed a provisioned, available account from.
 *
 * So this test owns neither shape. It runs the REAL account-model apply — `materialiseFleet` deciding
 * and the real provisioner writing — over a real state home, and then points the REAL daemon inventory
 * at the file that run produced. Nothing here writes a manifest, and nothing here describes one, which
 * is the only arrangement in which the two cannot disagree while both pass.
 */

const RUNTIME_ID = '00000000-0000-4000-8000-0000000000c1';

/** One Claude runtime on a Ferretry-kept login, with the one model its profile names. */
const MODEL = parseAccountModel({
  version: 2,
  credentials: { 'claude-primary': { harness: 'claude', store: 'ferretry' } },
  components: { modelSets: { claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } } },
  profiles: { default: { layers: ['modelSets/claude'] } },
  runtimes: { 'claude-primary': { credential: 'claude-primary', profile: 'default' } },
});

/** This host, as the daemon asks about it: can it run the exact file the manifest publishes? */
const thisHost: ExecutableResolverPort = {
  resolve: name => Bun.which(name) ?? undefined,
  runnable: path => {
    try {
      accessSync(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The fleet's directories, derived from the DAEMON's own paths.
 *
 * Spelled from `FoundationPaths` rather than invented, so a manifest written here lands exactly
 * where the daemon looks — the second half of the agreement, and one an assertion below states
 * outright rather than trusting.
 */
function layoutFor(home: string): FleetLayout {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return {
    stateHome: paths.home,
    userHome: home,
    fleetDirectory: paths.fleet,
    binDirectory: join(paths.fleet, 'bin'),
    homesDirectory: join(paths.fleet, 'homes'),
    assetsDirectory: join(paths.fleet, 'assets'),
    manifestPath: paths.fleetManifest,
    defaultHomeDirectories: { claude: join(home, '.claude'), codex: join(home, '.codex') },
  };
}

/** `fleet apply`, through the code it runs: plan the account model, then write the plan. */
async function provision(home: string): Promise<{ readonly manifestPath: string }> {
  const layout = layoutFor(home);
  const plan = materialiseFleet({
    model: MODEL,
    layout,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => RUNTIME_ID,
    generatedAt: '2027-01-15T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: join(home, 'no-such-fy'),
    acceptsAutoPermissionMode: true,
  });
  const roots = [layout.stateHome, home];
  await new FileFleetProvisioner(roots, new SharedHistoryMigration(new FileSharedHistoryFileSystem(roots))).apply(plan);
  return { manifestPath: plan.manifestPath };
}

/** A temporary home, canonical so a path compared against it is not `/var` against `/private/var`. */
async function temporaryHome(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), 'ferretry-agreement-')));
}

describe('fleet apply and the daemon inventory', () => {
  it('should let the daemon read the runtime a real apply published', async () => {
    // Arrange
    const home = await temporaryHome();
    try {
      const { manifestPath } = await provision(home);
      const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));

      // Act — the daemon's own reader, over the file the provisioner just wrote
      const accounts = await new ManifestAccountInventory(new StateFileSystem(paths), paths.fleetManifest).accounts();

      // Assert — the writer and the reader agree on the path and on the shape
      should(paths.fleetManifest).equal(manifestPath);
      should(accounts).have.length(1);
      should(accounts[0]?.agent).equal('claude-primary');
      should(accounts[0]?.kind).equal('claude');
      should(accounts[0]?.available).be.true();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('should call that runtime launchable through the executable wrapper the apply wrote', async () => {
    // Arrange
    const home = await temporaryHome();
    try {
      await provision(home);
      const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
      const accounts = await new ManifestAccountInventory(new StateFileSystem(paths), paths.fleetManifest).accounts();

      // Act — nothing is added to PATH, deliberately: a service-managed daemon has no fleet PATH,
      // and the wrapper this apply wrote is still perfectly runnable at the path it published.
      const launchability = accountLaunchability(accounts[0] as (typeof accounts)[number], thisHost);
      const preflight = readHarnessPreflight(accounts, thisHost, NO_HARNESS_DECLARATIONS);

      // Assert — this is the owner's report: `fyd --check` said no wrapper was launchable
      should(launchability.kind).equal('launchable');
      should(launchability).have.property('executable', join(paths.fleet, 'bin', 'claude-primary'));
      should(thisHost.runnable(join(paths.fleet, 'bin', 'claude-primary'))).be.true();
      should(preflight.ready).be.true();
      should(preflight.harnesses[0]?.launchable).eql(['claude-primary']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
