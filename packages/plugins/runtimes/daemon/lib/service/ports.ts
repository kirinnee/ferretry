/**
 * The seams the Runtimes services stand on. Each is a narrow interface: the services never touch a disk, a clock or
 * another plugin, they ask one of these, and `daemon/index.ts` builds the real answer from the kernel's ports.
 *
 * Three of them exist because the rebuild has not given plugins a way to do the thing yet:
 *
 *  - {@link RuntimeConfigWriter}: plugins have NO config write port (GAP(kernel)); only the kernel's host can write
 *    `config/**`. The apply pipeline is written against this interface and tested with a fake; the daemon wires
 *    {@link refusingConfigWriter} until the kernel offers a writer.
 *  - {@link LoginsReader}: the sign-in surface is Logins' (GAP(logins)). Runtimes may not import another plugin's
 *    contract, so what it needs from a login (its status word, its sign-out words) is the shape below.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { cap, type CallerGovernance } from '@ferretry/core-gate/contract';
import type { FleetDocumentWrite } from '../provisioning.ts';
import type { CredentialStatusWord, CredentialView } from '../../../contract/index.ts';

// ── config writes ────────────────────────────────────────────────────────────────────────────────

/**
 * Writes the configuration documents of ONE change: every document lands, or none does and this throws.
 *
 * GAP(kernel): there is no plugin config write port. Each document carries the revision it was composed against
 * (`expect`), which an implementation must check before it writes, and a document with `remove` set is deleted.
 */
export interface RuntimeConfigWriter {
  write(documents: readonly FleetDocumentWrite[]): Promise<void>;
}

/** A write the host refused, in words a person can act on. Nothing was written. */
export class RuntimeConfigRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigRefusal';
  }
}

/** The sentence a writer-less daemon refuses with. It names the state, not an internal. */
export const CONFIG_WRITE_UNAVAILABLE =
  'this version of Ferretry cannot change runtime, profile or model-set files from here yet; edit the file under config/ by hand and the change takes effect when it is saved';

/** The writer wired until the kernel offers one: it refuses every write with {@link CONFIG_WRITE_UNAVAILABLE}. */
// GAP(kernel): no plugin config write port.
export const refusingConfigWriter: RuntimeConfigWriter = {
  write: async documents => {
    if (documents.length === 0) return;
    throw new RuntimeConfigRefusal(CONFIG_WRITE_UNAVAILABLE);
  },
};

/** A settings file changed since it was read. GAP(kernel): the config layer's own conflict. */
export class ConfigWriteConflict extends Error {
  constructor(readonly path: string) {
    super(`${path} changed since it was read; read it again and redo the edit`);
    this.name = 'ConfigWriteConflict';
  }
}

/** A settings file that does not check. GAP(kernel): the config layer's own refusal. */
export class ConfigWriteInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigWriteInvalid';
  }
}

/**
 * Why this caller may not copy settings into `path`, in words: `undefined` when it may, or when it only needs a
 * passkey the apply asks for. A review shows what this machine's file holds, so the file is READ-checked too.
 * `warden.yaml` is the Warden's capability; every other file is the fleet's.
 */
// GAP(gate): the file-to-capability table is the config layer's (`config-files/file-grants.ts`).
export function configFileWriteRefusal(
  governance: CallerGovernance | undefined,
  path: string,
  stage: 'describe' | 'apply',
): string | undefined {
  if (governance === undefined) {
    return `this daemon could not check whether this caller may change ${path}, which is a daemon bug (update it: fy daemon update); nothing was changed`;
  }
  const capability = path === 'warden.yaml' ? 'warden' : 'fleet';
  const reading = governance.decide(cap(capability, 'use'));
  const writing = governance.decide(cap(capability, 'configure'));
  for (const [decision, what] of [
    [writing, 'change'],
    [reading, 'read'],
  ] as const) {
    if (decision.allowed) continue;
    if (decision.refusal === 'step-up-required') {
      if (stage === 'apply') return `changing ${path} from this device needs a passkey confirmation`;
      continue;
    }
    return `this device may not ${what} ${path}`;
  }
  return undefined;
}

// ── logins ───────────────────────────────────────────────────────────────────────────────────────

/** What a runtime change reads about one login. GAP(logins): the rest of a login's view is Logins' own. */
export interface LoginFacts {
  readonly id: string;
  /** The harness it drives. A login that drives both is listed once per harness by Logins; Runtimes reads the first. */
  readonly harness: HarnessKey;
  /** Switched off: a start on any runtime of this login refuses. */
  readonly disabled?: { readonly reason?: string; readonly until?: string };
  readonly email?: string;
  readonly status: { readonly word: CredentialStatusWord };
  readonly signOut: {
    readonly available: boolean;
    readonly sentence: string;
    readonly runtimesAffected: number;
    readonly signsOutTerminal: boolean;
  };
}

/** The logins on this machine. */
export interface LoginList {
  readonly logins: readonly LoginFacts[];
}

/** How a sign-out ended. `credential` is the login as Logins answers for it afterwards. */
export type LoginSignOutOutcome =
  | { readonly outcome: 'signed-out'; readonly credential: CredentialView }
  | { readonly outcome: 'sign-out-failed'; readonly reason: string; readonly credential: CredentialView };

/** A sign-out refused before anything happened. */
export class LoginRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginRefusal';
  }
}

/** The sign-in surface, as the catalogue needs it. GAP(logins). */
export interface LoginsReader {
  list(): Promise<LoginList>;
  signOut(id: string): Promise<LoginSignOutOutcome>;
}
