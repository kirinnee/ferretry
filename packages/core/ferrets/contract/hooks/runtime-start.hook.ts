import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { HarnessKeySchema } from '../ids.ts';
import type { RuntimeModelCatalog } from '../view/runtime-control.ts';

/** What a start needs of the runtime it names: the harness it runs and the login it spends. */
export type RuntimeStartResolution =
  | {
      readonly ok: true;
      readonly harness: z.infer<typeof HarnessKeySchema>;
      readonly login: string;
      /** The runtime is derived from its login (no runtime file holds the name), so the name follows whichever login now derives it. */
      readonly derived?: true;
    }
  | { readonly ok: false; readonly sentence: string };

/** Whether a login may be spent by a launch now: yes, or the plain sentence naming the login and why not. */
export type LoginStartResolution = { readonly ok: true } | { readonly ok: false; readonly sentence: string };

/** Runtimes' answer to "what does this runtime start with?" (`fy new --runtime`, the app's new-ferret). */
export interface RuntimeStartSource {
  /**
   * Whether the login NAMED (`--login`, or the one a stored record holds) may be spent now: a login that is switched off or
   * over its spend budget is refused here, so it can never be spent whether it is named directly or reached through a runtime.
   */
  login(login: string, harness?: string): Promise<LoginStartResolution>;
  /** The runtime NAMED `runtime`, resolved; or the plain sentence saying why it cannot serve a launch now. */
  resolve(runtime: string): Promise<RuntimeStartResolution>;
  /**
   * The machine's default runtime for new agents (the setting, else the machine's own fallback), or `undefined` when this
   * machine has none. A start that names no runtime, login or harness is a start on it (v4 parity), so it is recorded with
   * it and passes the SAME login gate. Optional: a source that does not say leaves such a start as it was.
   */
  defaultRuntime?(): Promise<string | undefined>;
  /**
   * Additive (c58-37, Move and handover): what the runtime NAMED serves, for planning the model a move or handover lands
   * on: its servable models (with each one's context window and reasoning efforts) and the default. It is the ONE
   * {@link RuntimeModelCatalog} the runtime control also reads (`contract/view/runtime-control.ts`), so there is no second
   * spelling of "what models a login serves". Read-only and values-free: no credential, no path. `undefined`: no such
   * runtime, or it cannot say. Absent: a move onto another runtime refuses with the sentence that it is not built yet.
   */
  catalog?(runtime: string): Promise<RuntimeModelCatalog | undefined>;
}

/** The one key `runtime.start` is provided under: a runtime has exactly one owner. */
export const RUNTIME_START_KEY = 'runtimes';

/**
 * How long Ferrets waits for Runtimes' `runtime.start` answer (`resolve` or `login`) before it refuses. A provide hook has
 * no kernel bound of its own (the decide hooks' is 200 ms, `defineHook`'s default, and not exported), and an answer reads
 * the login list, so this is longer than a decide's; it is still short enough that a resolver that never settles cannot
 * hold a ferret's lifecycle queue (a resume that waits on it holds up the stop behind it).
 */
export const RUNTIME_START_DEADLINE_MS = 5_000;

/**
 * Which harness and login a start that names a RUNTIME spends. On the security path: it decides which credential a
 * launch holds, so ONE named plugin provides it. Ferrets cannot reach Runtimes by port (Runtimes needs Ferrets), so it
 * asks through this hook; with no provider a start that names a runtime is refused rather than launched signed out.
 */
export const RuntimeStart = defineHook('runtime.start', {
  mode: 'provide',
  key: z.literal(RUNTIME_START_KEY),
  value: z.custom<RuntimeStartSource>(),
  takers: ['runtimes'],
});
