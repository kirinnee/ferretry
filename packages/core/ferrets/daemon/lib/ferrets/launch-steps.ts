/**
 * What a launch asks of the features around it, kept in lists a feature adds to (`f.launch.*` on `FerretsContext`) so a
 * new per-ferret variable is ONE feature file and touches no `service.ts`, `session-files.ts`, `index.ts` or port.
 * Daemon-internal on purpose: a contract slot would make the window in which a launch runs a permanent plugin API.
 *
 * The STORES half lives here (U6c): one declared pane variable each. The guards half (checks around the pane) joins this
 * file in U6b.
 */
import type { FencedPath, FerretId } from '../../../contract/index.ts';

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
}

/** What a feature is handed to add to the lists, at registration only. */
export interface LaunchStepRegistrar {
  paneVariable(store: SessionStore): void;
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
  private isSealed = false;

  sealed(): boolean {
    return this.isSealed;
  }

  stores(): readonly SessionStore[] {
    return this.held;
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
