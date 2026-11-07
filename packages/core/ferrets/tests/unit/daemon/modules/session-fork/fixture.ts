import type { SessionForkNeeds } from '../../../../../daemon/modules/session-fork.ts';
import { transferPorts } from '../../../../../daemon/modules/transfer.ts';

/**
 * THE `session-fork` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment.
 *
 * The REAL `sessionForkModule.build(needs, seams, lifecycle)` over test inputs, so the route and the contract checks
 * consume what production builds. Only the INPUTS are doubles, and every one of them REFUSES to be used: each port
 * answers any call with a throw naming it, because the build only captures its inputs and the fixture never sends a fork.
 * Building starts nothing — no timer, no file read, no async work — so there is nothing to leave behind in the shared unit
 * process.
 *
 * The transfer ports are the real factory of the real transfer module (pure construction over refusing ports).
 */

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-fork fixture`);
    },
  });
}

/** The inputs the host hands the module, over doubles. */
export function sessionForkNeedsForTest(overrides: Partial<SessionForkNeeds> = {}): SessionForkNeeds {
  return {
    state: refusing('state'),
    storage: refusing('storage'),
    sessionDirectory: refusing('sessionDirectory'),
    attachmentStore: refusing('attachmentStore'),
    transferPorts,
    attachments: refusing('attachments'),
    conversation: refusing('conversation'),
    redactor: refusing('redactor'),
    selection: refusing('selection'),
    gateway: refusing('gateway'),
    accounts: async () => {
      throw new Error('accounts is not exercised by the session-fork fixture');
    },
    planner: refusing('planner'),
    harness: refusing('harness'),
    catalog: refusing('catalog'),
    catalogs: refusing('catalogs'),
    harnessFacts: refusing('harnessFacts'),
    createLifecycle: () => {
      throw new Error('createLifecycle is not exercised by the session-fork fixture');
    },
    transcripts: refusing('transcripts'),
    environment: refusing('environment'),
    runtime: refusing('runtime'),
    view: async () => undefined,
    readableHandoffs: () => {
      throw new Error('readableHandoffs is not exercised by the session-fork fixture');
    },
    ids: refusing('ids'),
    clock: refusing('clock'),
    ...overrides,
  };
}
