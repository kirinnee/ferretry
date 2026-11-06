import {
  createMcpFoundations,
  type McpFoundationsNeeds,
  type McpNeeds,
  type McpProvides,
  mcpModule,
} from '../../../../bin/modules/mcp.ts';
import { StateFileSystem } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `mcp` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `createMcpFoundations(needs)` and `mcpModule.build(needs, seams, lifecycle)` over test inputs, so the route
 * snapshot and the contract checks consume what production builds. Only the INPUTS are doubles: a state home that does
 * not exist, no runtimes, no folders and no secrets, none of which anything here asks anything of. Building starts
 * nothing — the sign-in has no timer and every service is inert until a request — so there is no timer or async work to
 * leave behind in the shared unit process.
 */

/** A state home that does not exist: every document reads as absent. */
const FIXTURE_HOME = '/nonexistent/mcp-fixture-state-home';

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `buildWorld` hands the sign-in half, over doubles. */
function foundationsNeeds(): McpFoundationsNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    stateFiles: new StateFileSystem(paths),
    configFiles: { inEffect: NOT_EXERCISED('the configuration files'), load: NOT_EXERCISED('the configuration files') },
    configLocations: {
      configDirectory: `${FIXTURE_HOME}/config`,
      fleetDirectory: `${FIXTURE_HOME}/fleet`,
    },
    accounts: { accounts: async () => [] },
    millisecondClock: { now: () => 0 },
    secretDirectory: {
      list: NOT_EXERCISED('a secret listing'),
      put: NOT_EXERCISED('a secret write'),
      remove: NOT_EXERCISED('a secret removal'),
    },
    secretVault: { values: async () => new Map() },
    secretCipher: {
      algorithm: 'fixture',
      seal: NOT_EXERCISED('a seal'),
      openAll: NOT_EXERCISED('an open'),
    },
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
  };
}

/** The inputs `fyd.ts` hands the module, over doubles. */
function mcpNeeds(): McpNeeds {
  return {
    foundations: createMcpFoundations(foundationsNeeds()),
    sessions: { get: async () => undefined, list: async () => [] },
    catalogs: { projects: async () => [] },
    worktrees: { list: async () => ({ worktrees: [] }) },
    fleetCatalog: {
      runtimes: NOT_EXERCISED('the fleet catalogue'),
      profiles: NOT_EXERCISED('the fleet catalogue'),
      components: NOT_EXERCISED('the fleet catalogue'),
      propose: NOT_EXERCISED('the fleet catalogue'),
      apply: NOT_EXERCISED('the fleet catalogue'),
    },
    launchEnvironment: { forWrapper: async () => ({}) },
    secretVault: { values: async () => new Map() },
    redactor: { redact: async text => text },
    clock: { now: () => 0 },
    environment: {},
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtMcp(): BuiltModule<McpProvides> {
  return mcpModule.build(mcpNeeds(), undefined, LIFECYCLE);
}
