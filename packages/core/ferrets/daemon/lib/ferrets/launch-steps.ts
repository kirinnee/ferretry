/**
 * What a launch asks of the features around it, kept in lists a feature adds to (`f.launch.*` on `FerretsContext`) so a
 * new per-ferret variable is ONE feature file and touches no `service.ts`, `session-files.ts`, `index.ts` or port.
 * Daemon-internal on purpose: a contract slot would make the window in which a launch runs a permanent plugin API.
 *
 * Two lists: STORES (U6c), one declared pane variable each, and GUARDS (U6b), checks the lifecycle makes around every
 * pane it opens (the conversation lease is the built-in innermost one; see `conversation-lease-guard.ts`).
 */
import { err, ok, type Result } from '@ferretry/std';
import type { FencedPath, FerretId, FerretRecord, StartFailure } from '../../../contract/index.ts';

/** A guard's answer. It can never invent another failure code (no `harness_unavailable`, `login_unavailable`...). */
export type GuardVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: 'refused' | 'failed'; readonly reason: string };

/** Asked as the LAST step before the harness is asked to start: tokens issued, env resolved, folder re-verified. */
export interface GuardedLaunch {
  readonly record: Readonly<FerretRecord>;
  /** The conversation the launch WILL resume (after `hasConversation`); `undefined` = a new conversation. */
  readonly conversation: string | undefined;
}

/** Asked once the pane is open, BEFORE the launch-sections write and the record's `working` write. */
export interface OpenedLaunch {
  readonly record: Readonly<FerretRecord>;
  /** `started.harnessConversation ?? conversation`; `undefined` when the harness named none. */
  readonly conversation: string | undefined;
  readonly pid: number | undefined;
}

/**
 * A check the lifecycle makes around every pane it opens (start, resume, revive, restart, move, lifecycle launchHeld).
 * Runs on the ferret's serial lane: it must never `serial.run` the same ferret (deadlock). Must be restart-safe:
 * `released` frees from durable state by ferret id, never from memory kept since `beforePane`. Guards must not depend on
 * each other: registration order is the generator's (file name), which is accidental.
 */
export interface LaunchGuard {
  /** What this guard is called in a boot fault (a repeated id). Unique. */
  readonly id: string;
  readonly beforePane?: (launch: GuardedLaunch) => Promise<GuardVerdict>;
  /** A refusal here: the launch's EXISTING cleanup stops the pane; the runner releases nothing itself. */
  readonly paneOpened?: (launch: OpenedLaunch) => Promise<GuardVerdict>;
  /** The ferret settled `stopped` (after `endWait`). Called whether or not `beforePane` ran. Never fails a stop. */
  readonly released?: (ferret: FerretId) => Promise<void>;
}

/**
 * A per-ferret file or folder the pane is told about through ONE declared variable (`FY_QUESTION_FILE`, `FY_MEDIA_DIR`).
 * The store makes what it names if it is missing; the launch only learns the path.
 */
export interface SessionStore {
  /** What this store is called in a boot fault (a duplicate, a reserved variable). Unique. */
  readonly id: string;
  /** The ONE variable the pane is handed. `FY_*`, distinct from every other store's, never one of {@link RESERVED_PANE_VARIABLES}. */
  readonly variable: `FY_${string}`;
  /**
   * Where the pane's file or folder is, made if missing. A throw or `undefined`: the variable is not set and the launch
   * goes on, because a ferret without one of these is still a ferret (never a refusal).
   */
  readonly locate: (ferret: FerretId) => Promise<FencedPath | undefined>;
}

/** What the service reads: the lists a launch asks, and whether the features have finished adding to them. */
export interface LaunchSteps {
  /** `true` once boot has finished registering; a launch before that must not run on a half-filled list. */
  sealed(): boolean;
  /** The stores, in registration order. */
  stores(): readonly SessionStore[];
  /** The guards features registered, in registration order (the built-in lease guard is the service's, not listed). */
  guards(): readonly LaunchGuard[];
}

/** What a feature is handed to add to the lists, at registration only. */
export interface LaunchStepRegistrar {
  paneVariable(store: SessionStore): void;
  guard(guard: LaunchGuard): void;
}

/**
 * The variables the launch itself sets AFTER the parts and the login (the ferret's own id, bearer and mode, and whether
 * it is a helper). A store runs after them, so one that named any of these would overwrite a fact the record decided.
 */
export const RESERVED_PANE_VARIABLES: ReadonlySet<string> = new Set([
  'FY_SESSION_ID',
  'FY_SESSION_TOKEN',
  'FY_SESSION_MODE',
  'FY_SUB_FERRET',
]);

const PANE_VARIABLE = /^FY_[A-Z][A-Z0-9_]*$/;

/**
 * The lists, built before the features register and sealed right after. Every registration fault THROWS at boot, naming
 * the store: late registration (the list would change between launches), a repeated id, a repeated or reserved variable,
 * or a variable that is not an `FY_*` name.
 */
export class LaunchStepRegistry implements LaunchSteps, LaunchStepRegistrar {
  private readonly held: SessionStore[] = [];
  private readonly heldGuards: LaunchGuard[] = [];
  private isSealed = false;

  sealed(): boolean {
    return this.isSealed;
  }

  stores(): readonly SessionStore[] {
    return this.held;
  }

  guards(): readonly LaunchGuard[] {
    return this.heldGuards;
  }

  guard(guard: LaunchGuard): void {
    if (this.isSealed) throw new Error(`ferrets: the launch guard ${guard.id} was registered after boot finished`);
    if (this.heldGuards.some(held => held.id === guard.id))
      throw new Error(`ferrets: two launch guards are called ${guard.id}`);
    this.heldGuards.push(guard);
  }

  paneVariable(store: SessionStore): void {
    if (this.isSealed) throw new Error(`ferrets: the launch store ${store.id} was registered after boot finished`);
    if (!PANE_VARIABLE.test(store.variable))
      throw new Error(`ferrets: the launch store ${store.id} names ${store.variable}, which is not an FY_* variable`);
    if (RESERVED_PANE_VARIABLES.has(store.variable))
      throw new Error(`ferrets: the launch store ${store.id} names ${store.variable}, which a launch sets itself`);
    const sameId = this.held.find(held => held.id === store.id);
    if (sameId !== undefined) throw new Error(`ferrets: two launch stores are called ${store.id}`);
    const sameVariable = this.held.find(held => held.variable === store.variable);
    if (sameVariable !== undefined)
      throw new Error(`ferrets: the launch stores ${sameVariable.id} and ${store.id} both set ${store.variable}`);
    this.held.push(store);
  }

  /** Ends registration. Called once, by the composition, right after the features have registered. */
  seal(): void {
    this.isSealed = true;
  }
}

/**
 * The variable each store names for `ferret`, asked in registration order (so any side effect of locating, a folder made,
 * happens in that order). A store that throws or answers nothing sets no variable and never stops the rest.
 */
export async function paneVariables(
  stores: readonly SessionStore[],
  ferret: FerretId,
): Promise<Readonly<Record<string, string>>> {
  const variables: Record<string, string> = {};
  for (const store of stores) {
    const found = await store.locate(ferret).catch(() => undefined);
    if (found !== undefined) variables[store.variable] = found;
  }
  return variables;
}

/** Fixed sentences: a guard that throws is never quoted (its text could carry a path or a secret). */
export const GUARD_UNCHECKED = 'the ferret was not started: a check its launch needs could not be made';
export const GUARD_UNHELD = 'the ferret was stopped: a check its launch needs could not be kept';

const allowed = ok(undefined);

/** Runs one guard callback; a synchronous throw and a rejection both answer undefined (a callback may not be async). */
async function attempt<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

/**
 * Asks `guards` (outermost first) as the last step before the harness starts. The first refusal ends the walk: later
 * guards and the harness are never asked. A guard that throws refuses the launch with a fixed sentence (never launch
 * unchecked). Tokens are revoked and every guard's `released` runs through the launch's own abandon, not here.
 */
export async function beforePane(
  guards: readonly LaunchGuard[],
  launch: GuardedLaunch,
): Promise<Result<void, StartFailure>> {
  for (const guard of guards) {
    const ask = guard.beforePane;
    if (ask === undefined) continue;
    const verdict = await attempt(() => ask.call(guard, launch));
    if (verdict === undefined) return err({ code: 'failed', reason: GUARD_UNCHECKED });
    if (!verdict.allow) return err({ code: verdict.code, reason: verdict.reason });
  }
  return allowed;
}

/**
 * Asks `guards` (INNERMOST first, the reverse of `beforePane`) once the pane is open, so the conversation moves onto the
 * pane's pid before a slower feature guard runs. A refusal or throw is returned only: the launch's existing cleanup stops
 * the pane, and a stop that fails keeps the handle and the lease (nothing is released here).
 */
export async function paneOpened(
  guards: readonly LaunchGuard[],
  launch: OpenedLaunch,
): Promise<Result<void, StartFailure>> {
  for (const guard of [...guards].reverse()) {
    const ask = guard.paneOpened;
    if (ask === undefined) continue;
    const verdict = await attempt(() => ask.call(guard, launch));
    if (verdict === undefined) return err({ code: 'failed', reason: GUARD_UNHELD });
    if (!verdict.allow) return err({ code: verdict.code, reason: verdict.reason });
  }
  return allowed;
}

/** Frees what each guard holds for `ferret`, innermost first. One that throws never stops the rest or fails a stop. */
export async function released(guards: readonly LaunchGuard[], ferret: FerretId): Promise<void> {
  for (const guard of [...guards].reverse()) {
    const free = guard.released;
    if (free === undefined) continue;
    await attempt(() => free.call(guard, ferret));
  }
}
