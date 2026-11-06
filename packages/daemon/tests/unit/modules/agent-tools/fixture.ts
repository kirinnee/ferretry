import { StateFileSystem } from '../../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import {
  createFoundationPaths,
  resolveStateHome,
  type AuditLog,
  type SecretRedactor,
  type TerminalSubsystem,
} from '../../../../src/lib/index.ts';
import type { BrowserMountedSubsystem } from '../../../../src/lib/runtime/mounts/browser-login.ts';
import { type BuiltModule, lateBound, type ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import {
  type AgentToolsNeeds,
  type AgentToolsProvides,
  agentToolsModule,
} from '../../../../bin/modules/agent-tools.ts';

/**
 * THE `agentTools` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `agentToolsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home nothing was ever written to, a
 * storage that holds no session, and terminals, a browser, a vault and an input bridge that nothing here asks anything
 * of.
 *
 * Unlike a pure module, this one starts the browser-upload sweep while it is built, as in production: an unreferenced
 * interval and a 30-second timeout. CI runs every non-PWA unit test in ONE process and a leftover timer breaks
 * `unit-determinism.test.ts`, so the build runs with the timer globals swapped for ones that start nothing (the
 * module reads `setInterval` and `setTimeout` at call time). Built ONCE and shared, because the surface tests ask for
 * the module on every dispatcher they create.
 */

/** A state home that does not exist: every pin list reads as absent. */
const FIXTURE_HOME = '/nonexistent/agent-tools-fixture-state-home';

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function agentToolsNeedsForTest(): AgentToolsNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    stateFiles: new StateFileSystem(paths),
    storage: {
      listSessions: () => [],
      findSession: () => undefined,
      append: NOT_EXERCISED('a session append'),
      replay: NOT_EXERCISED('a journal replay'),
      readConfig: NOT_EXERCISED('a config read'),
      readState: NOT_EXERCISED('a state read'),
      configWrites: () => 0,
    } as unknown as DaemonStorage,
    clock: { now: () => '1970-01-01T00:00:00.000Z' },
    clientName: 'fy',
    terminals: {} as unknown as TerminalSubsystem,
    browser: {} as unknown as BrowserMountedSubsystem,
    audit: { record: NOT_EXERCISED('an audit record') } as unknown as AuditLog,
    policy: { allowed: NOT_EXERCISED('the agent-control policy') } as unknown as AgentToolsNeeds['policy'],
    input: {} as unknown as AgentToolsNeeds['input'],
    phoneApprovals: {} as unknown as AgentToolsNeeds['phoneApprovals'],
    scrub: (_sessionId, text) => text,
    quarantinedUntil: () => undefined,
    redactor: { batch: NOT_EXERCISED('the vault redactor') } as unknown as Pick<SecretRedactor, 'batch'>,
    copy: {} as unknown as AgentToolsNeeds['copy'],
    plans: {} as unknown as AgentToolsNeeds['plans'],
    copyPages: {} as unknown as AgentToolsNeeds['copyPages'],
    accounts: { list: NOT_EXERCISED('the account directory') } as unknown as AgentToolsNeeds['accounts'],
    signInChoice: {} as unknown as AgentToolsNeeds['signInChoice'],
    recipes: {} as unknown as AgentToolsNeeds['recipes'],
    ruleSuggestions: {} as unknown as AgentToolsNeeds['ruleSuggestions'],
    loginActs: {} as unknown as AgentToolsNeeds['loginActs'],
    typedIdentities: {} as unknown as AgentToolsNeeds['typedIdentities'],
    folderOf: async () => undefined,
    attachments: { download: NOT_EXERCISED('an attachment download') } as unknown as AgentToolsNeeds['attachments'],
    stateHomeKeys: [],
    activities: undefined,
    pinnedSessions: lateBound(),
  };
}

const LIFECYCLE_FOR_TEST: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** Builds the module with the timer globals swapped for ones that start nothing, restoring them whatever happens. */
function buildAgentToolsWithoutTimers(needs: AgentToolsNeeds): BuiltModule<AgentToolsProvides> {
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const inert = { unref: () => inert, ref: () => inert } as const;
  globalThis.setInterval = (() => inert) as unknown as typeof setInterval;
  globalThis.setTimeout = (() => inert) as unknown as typeof setTimeout;
  try {
    return agentToolsModule.build(needs, undefined, LIFECYCLE_FOR_TEST);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
  }
}

let built: BuiltModule<AgentToolsProvides> | undefined;

/** The module as production builds it, over the fixture's inputs, with the upload sweep's timers never started. */
export function builtAgentTools(): BuiltModule<AgentToolsProvides> {
  built ??= buildAgentToolsWithoutTimers(agentToolsNeedsForTest());
  return built;
}
