import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import {
  EphemeralValues,
  QuarantineRegistry,
  type AgendaReplyBatcher,
  type AgendaService,
  type AuditLog,
  type LoginDirectory,
  type LoginFactSink,
  type PageInputHost,
  type SecretStoreDirectory,
  type TerminalRuntimePort,
  type TmuxCommandPort,
} from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import {
  type InputRequestsNeeds,
  type InputRequestsProvides,
  inputRequestsModule,
} from '../../../../bin/modules/input-requests.ts';

/**
 * THE `inputRequests` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `inputRequestsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a storage that holds no session, an agenda, a
 * vault and a browser that nothing here asks anything of.
 *
 * Unlike a pure module, this one starts the phone-approvals restore while it is built, as in production (over a storage
 * with no session, so it finishes in a few microtasks and touches nothing). The sweep's interval and the input-requests
 * restore start only from `startInputHousekeeping`, which this fixture never calls, so the build leaves no timer in the
 * shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover timer breaks
 * `unit-determinism.test.ts`). Built ONCE and shared, because the surface tests ask for the module on every dispatcher
 * they create.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
export function inputRequestsNeedsForTest(): InputRequestsNeeds {
  return {
    storage: {
      listSessions: () => [],
      findSession: () => undefined,
      append: NOT_EXERCISED('a session append'),
      readState: NOT_EXERCISED('a state read'),
      replay: NOT_EXERCISED('a journal replay'),
    } as unknown as DaemonStorage,
    terminals: { list: NOT_EXERCISED('the terminal runtime') } as unknown as TerminalRuntimePort,
    tmux: {} as unknown as TmuxCommandPort,
    agenda: {} as unknown as AgendaService,
    agentReplies: { add: NOT_EXERCISED('an agent reply') } as unknown as AgendaReplyBatcher,
    audit: { record: NOT_EXERCISED('an audit record') } as unknown as AuditLog,
    values: new EphemeralValues({ now: () => 0 }),
    quarantine: new QuarantineRegistry({ now: () => 0 }),
    redact: async text => text,
    loginDirectory: {} as unknown as LoginDirectory,
    loginVault: { fill: NOT_EXERCISED('a login fill') } as unknown as InputRequestsNeeds['loginVault'],
    choice: {} as unknown as InputRequestsNeeds['choice'],
    pages: {} as unknown as PageInputHost,
    sealed: {} as unknown as InputRequestsNeeds['sealed'],
    rules: {} as unknown as InputRequestsNeeds['rules'],
    secretStore: {} as unknown as SecretStoreDirectory,
    loginFacts: {} as unknown as LoginFactSink,
    approvalPush: { push: NOT_EXERCISED('a phone approval push') } as unknown as InputRequestsNeeds['approvalPush'],
    activities: undefined,
  };
}

export const LIFECYCLE_FOR_TEST: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

let built: BuiltModule<InputRequestsProvides> | undefined;

/** The module as production builds it, over the fixture's inputs, with the sweep's interval never started. */
export function builtInputRequests(): BuiltModule<InputRequestsProvides> {
  if (built === undefined) {
    built = inputRequestsModule.build(inputRequestsNeedsForTest(), undefined, LIFECYCLE_FOR_TEST);
  }
  return built;
}
