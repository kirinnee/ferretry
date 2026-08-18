import { describe, it } from 'bun:test';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFleetScaffold,
  FleetPlan,
  type FleetLayout,
  type FleetScaffoldIds,
  FleetConfigSchema,
} from '@ferretry/fleet';
import { FileFleetProvisioner, FileFleetScaffolder } from '@ferretry/fleet/adapters';
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
 * So this test owns neither shape. It runs the REAL provisioner over a real state home and then
 * points the REAL daemon inventory at the file that run produced. Nothing here writes a manifest,
 * and nothing here describes one — which is the only arrangement in which the two cannot disagree
 * while both pass.
 *
 * It fails on `main`: the inventory answers an empty fleet for this exact file.
 */

const CONFIG = (kind: string, ids: FleetScaffoldIds): string => `agents:
  - name: primary
    kind: ${kind}
    auth: oauth
    routes:
      default:
        id: ${kind === 'claude' ? ids.claude : ids.codex}
        wrapper: ${kind}-primary
        home: ${kind}-primary
        displayName: ${kind} (primary)
        defaultModel: a-model
        models:
          - a-model
`;

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
function layoutFor(home: string): { readonly layout: FleetLayout; readonly manifestPath: string } {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return {
    manifestPath: paths.fleetManifest,
    layout: {
      stateHome: paths.home,
      userHome: home,
      fleetDirectory: paths.fleet,
      binDirectory: join(paths.fleet, 'bin'),
      homesDirectory: join(paths.fleet, 'homes'),
      assetsDirectory: join(paths.fleet, 'assets'),
      manifestPath: paths.fleetManifest,
      defaultHomeDirectories: { claude: join(home, '.claude'), codex: join(home, '.codex') },
    },
  };
}

/** `fy fleet init --first-account` then `fy fleet apply`, through the code both commands run. */
async function provision(home: string): Promise<{ readonly manifestPath: string }> {
  const { layout, manifestPath } = layoutFor(home);
  const ids: FleetScaffoldIds = {
    claude: '00000000-0000-4000-8000-0000000000c1',
    codex: '00000000-0000-4000-8000-0000000000c2',
  };
  const configPath = join(layout.fleetDirectory, 'config.yaml');
  await new FileFleetScaffolder([layout.stateHome, home]).scaffold(
    buildFleetScaffold({ layout, ids, configPath, firstAccount: 'claude' }),
  );
  // The starter template is the product's, not this test's: the account below is written over it in
  // the same shape `--first-account` produces, with a neutral model so no catalog is smuggled in.
  await Bun.write(configPath, CONFIG('claude', ids));
  const config = FleetConfigSchema.parse(Bun.YAML.parse(await Bun.file(configPath).text()));
  const plan = new FleetPlan().build(config, layout, '2027-01-15T08:00:00.000Z');
  await new FileFleetProvisioner([layout.stateHome, home]).apply(plan);
  return { manifestPath };
}

describe('fleet apply and the daemon inventory', () => {
  it('should let the daemon read the account a real apply published', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-agreement-'));
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

  it('should call that account launchable on the host the apply ran on', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-agreement-'));
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
      should(launchability)
        .have.property('executable')
        .match(/fleet\/bin\/claude-primary$/u);
      should(preflight.ready).be.true();
      should(preflight.harnesses[0]?.launchable).eql(['claude-primary']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
