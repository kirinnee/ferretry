/**
 * R2 (M-1): a diamond of `profile/<base>` layers must not hang the daemon on ANY public path that reads a profile's stack.
 * Any agent can write `profiles/*.yaml`, so 42 small files (a lattice of 2^20 paths) is an input, not a thought experiment.
 *
 * The catalogue service is built over fakes of its ports (as `catalog-service-paths.test.ts` does) with the lattice as
 * its model, and each path that expands bases is timed against a deadline: the catalogue's `components()` (every
 * profile for every component), `profiles()`, `previewProfile`, a proposed change (`resolveProfile` for every runtime,
 * what every apply does) and `republish`. The runtimes port's own `layers()`, `profiles()` and `changeProfileLayers`
 * on the same lattice are in `profile-layers.test.ts`.
 */
import { describe, it } from 'bun:test';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { unavailableCatalogDeps } from '../../../daemon/lib/service/assembly.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../../daemon/lib/service/catalog-service.ts';

const NOW = 1_794_052_800_000;
const DEPTH = 20;
/** Reading every path would take minutes; a pure answer takes milliseconds. */
const DEADLINE_MS = 1000;

/** Two profiles per level, each naming BOTH profiles of the next level and one item of its own: 2^depth paths. */
function latticeDocument(depth: number) {
  const profiles: Record<string, { layers: string[] }> = {};
  const mcp: Record<string, { command: string }> = {};
  for (let level = 0; level <= depth; level++)
    for (const side of ['a', 'b']) {
      const name = `${side}${String(level)}`;
      mcp[name] = { command: 'srv-bin' };
      profiles[name] = {
        layers:
          level === depth
            ? [`mcp/${name}`]
            : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, `mcp/${name}`],
      };
    }
  return {
    version: 1,
    credentials: { 'claude-you': { harness: 'claude', store: 'ferretry' } },
    components: { mcp },
    profiles,
    runtimes: {
      work: { credential: 'claude-you', profile: 'a0', agent: true },
      second: { credential: 'claude-you', profile: 'b1', agent: true },
    },
  };
}

const LAYOUT = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
} as const;

function world() {
  const model = parseAccountModel(latticeDocument(DEPTH));
  const logins = fakeLogins([sampleLogin('claude-you')]);
  const changes = fakeLoginChanges();
  const base = unavailableCatalogDeps(() => NOW, logins, changes);
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => ({
      format: 'present',
      model,
      revision: 'rev-1',
      unreadable: [],
      stoodInLogins: [],
      documents: () => [],
    }),
    readAsset: async () => undefined,
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/claude',
    credentials: logins,
    loginChanges: changes,
    configWriter: { write: async () => undefined },
    layout: LAYOUT,
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    modelCatalogs: async () => ({ catalogs: {}, presets: [] }),
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async plan => ({
        accountCount: plan.manifest.accounts.length,
        operationCount: plan.operations.length,
        manifestPath: '/fy/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
      }),
    },
  };
  return new FleetCatalogService(deps);
}

/** How long `act` takes to settle, and what it settled with. */
async function timed<T>(act: () => Promise<T>): Promise<{ readonly took: number; readonly value: T }> {
  const started = performance.now();
  const value = await act();
  return { took: performance.now() - started, value };
}

describe('R2 a 20-deep diamond of profile bases answers at once through every public path (M-1)', () => {
  it('R2 should read the model itself inside the deadline', () => {
    // Act
    const started = performance.now();
    parseAccountModel(latticeDocument(DEPTH));

    // Assert
    should(performance.now() - started).be.below(DEADLINE_MS);
  });

  it('R2 should list the components, with who uses each, inside the deadline', async () => {
    // Arrange
    const service = world();

    // Act
    const { took, value } = await timed(async () => await service.components());

    // Assert — every item is used by the profiles that reach it: a0's item by a0 alone, a1's by a0 and the profiles above.
    const mcp = value.kinds.find(group => group.kind === 'mcp');
    should(mcp?.components.length).equal(42);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should list the profiles inside the deadline', async () => {
    // Arrange
    const service = world();

    // Act
    const { took, value } = await timed(async () => await service.profiles());

    // Assert
    should(value.profiles.length).equal(42);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should preview a profile draft that names the lattice inside the deadline', async () => {
    // Arrange
    const service = world();

    // Act
    const { took, value } = await timed(
      async () => await service.previewProfile({ layers: ['profile/a0', 'mcp/b0'], editing: undefined }),
    );

    // Assert
    should(value.refusal).be.undefined();
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should propose a change, which resolves every runtime’s profile as an apply does, inside the deadline', async () => {
    // Arrange
    const service = world();

    // Act
    const { took, value } = await timed(
      async () => await service.propose({ kind: 'runtime.rename', name: 'second', to: 'renamed' }),
    );

    // Assert
    should(value).not.be.undefined();
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should republish inside the deadline', async () => {
    // Arrange
    const service = world();

    // Act
    const { took, value } = await timed(async () => await service.republish());

    // Assert
    should(value).equal('applied');
    should(took).be.below(DEADLINE_MS);
  });
});
