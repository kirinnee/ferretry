import { ApiError } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import type {
  FerretId,
  FerretsApi,
  FerretSummary,
  MoveFailure,
  StartFailure,
  StartRequest,
} from '../../../contract/index.ts';
import { WARDEN_LABEL } from '../session/peers/warden-lifecycle.ts';
import type { FerretsService } from './service.ts';

/** The plugin that may speak as Ferretry's Warden through this port. */
const WARDEN_PLUGIN = 'warden';

/**
 * Which `systemCallsign` prefix each plugin may draw from, by its manifest id: the Warden's investigators, the Learning
 * miner (`lessons`) and Pack clean-up (`packs`). A pair not here is refused.
 */
const CALLSIGN_PREFIX_OF: Readonly<Record<string, 'warden' | 'learning' | 'pack'>> = {
  warden: 'warden',
  lessons: 'learning',
  packs: 'pack',
};

/** Which plugin may ask for a start `by` a part of Ferretry; `owner` and `ferret` are a consumer acting for its own caller. */
const START_BY_PLUGIN: Readonly<Partial<Record<StartRequest['by'], string>>> = {
  warden: WARDEN_PLUGIN,
  pack: 'packs',
  board: 'board',
};

const NOT_THE_WARDEN = 'only the Warden is recorded as the Warden';
const NOT_THE_WARDEN_LABEL = 'only the Warden starts a ferret under its own label';
const NOT_THE_WARDEN_PARENT = 'only the Warden names a parent for a ferret it starts';

/**
 * What one plugin holds under `ferrets`: an explicit object naming each member of {@link FerretsApi}, each forwarding
 * only the parameters the port declares, built for that consumer (`perNeeder`) from its manifest id. The id is the
 * kernel's, so what a consumer CLAIMS about who acts is checked against who it is:
 *
 * - `resume` / `move` with `actor: 'warden'` (or a move `movedBy: 'warden'`), and a start `by: 'warden'`, only from the
 *   Warden; a start `by: 'pack'` only from Packs and `by: 'board'` only from Board. Refused with a sentence, nothing
 *   resumed, moved or started.
 * - a consumer's `label` and `parent` are both checked: a start under the Warden's own label (`options.label`), and a
 *   start with any `parent` (a parent in the Warden's tree gives the new ferret its lineage and so its label), only
 *   from the Warden.
 * - `systemCallsign` draws only the prefix of the consumer's own kind (`ApiError` 403 otherwise).
 *
 * `start` and `move` read the caller's request once and forward a rebuilt copy, never the caller's own object.
 *
 * Whatever else the service has — a stop's end `cause`, a move's `replaceLiveTerminal` and `target`, a route's
 * `confirmRestore`, `revokeToken`, `rename`, the launch and its tokens — is for this plugin's own callers and is not
 * reachable here at runtime, not just refused by the types. `resume` forwards only `automatic`, an `actor` of
 * `warden` (the Warden's alone) or `peer` (attribution only), `decided` and `onCarried`. `effectiveLimits` is optional
 * on the port and the service has none, so it is absent.
 */
export function ferretsPort(service: FerretsService, consumer: string): FerretsApi {
  const warden = consumer === WARDEN_PLUGIN;
  const refused = (reason: string): Result<never, { readonly code: 'refused'; readonly reason: string }> =>
    err({ code: 'refused', reason });
  return {
    get: ferret => service.get(ferret),
    list: filter => service.list(filter),
    mayTouch: (caller, target) => service.mayTouch(caller, target),
    children: ferret => service.children(ferret),
    harnesses: () => service.harnesses(),
    start: async (asked): Promise<Result<FerretId, StartFailure>> => {
      // Read every member once into a fresh object: the checks and the service see the same values, so a getter cannot
      // answer one thing to the check and another to the service.
      const request: StartRequest = {
        ...asked,
        ...(asked.options === undefined ? {} : { options: { ...asked.options } }),
      };
      const owner = START_BY_PLUGIN[request.by];
      if (owner !== undefined && owner !== consumer)
        return refused(
          `only ${owner === WARDEN_PLUGIN ? 'the Warden' : `the ${owner} plugin`} starts a ferret as ${request.by}`,
        );
      // The Warden's own label marks the Warden's tree (supervision skips it, Packs exempts it from the helper limits,
      // lineage marks it): only the Warden starts under it, the same rule the route applies.
      if (request.options?.label?.trim() === WARDEN_LABEL && !warden) return refused(NOT_THE_WARDEN_LABEL);
      // A parent in the Warden's tree gives the new ferret the Warden's lineage, and so its label: only the Warden names
      // a parent through the port (the route forces an agent's parent to itself).
      if (request.parent !== undefined && !warden) return refused(NOT_THE_WARDEN_PARENT);
      return await service.start(request);
    },
    stop: (ferret, how, reason) => service.stop(ferret, how, reason),
    resume: async (ferret, message, options) => {
      // Read once: the check and the forward see the same value. `'warden'` is the Warden's alone; `'peer'` is
      // caller-stated attribution (it changes no policy), so any consumer may say it.
      const actor = options?.actor;
      if (actor === 'warden' && !warden) return refused(NOT_THE_WARDEN);
      // Only what the port declares: automated recovery, the turn author's attribution, who must be told what the
      // resume decided, and who must be told what it typed for the message.
      const forwarded = {
        ...(options?.automatic === true ? { automatic: true } : {}),
        ...(actor === 'warden' || actor === 'peer' ? { actor } : {}),
        ...(options?.decided === undefined ? {} : { decided: options.decided }),
        ...(options?.onCarried === undefined ? {} : { onCarried: options.onCarried }),
      };
      return await service.resume(ferret, message, Object.keys(forwarded).length === 0 ? undefined : forwarded);
    },
    attach: (ferret, handle) => service.attach(ferret, handle),
    handle: ferret => service.handle(ferret),
    workFolder: ferret => service.workFolder(ferret),
    sitrep: ferret => service.sitrep(ferret),
    summary: ferret => service.summary(ferret),
    managedWorktrees: () => service.managedWorktrees(),
    systemCallsign: async prefix => {
      if (CALLSIGN_PREFIX_OF[consumer] !== prefix)
        throw new ApiError(403, `the ${consumer} plugin may not draw a ${prefix} callsign`, 'forbidden');
      return await service.systemCallsign(prefix);
    },
    agentControl: ferret => service.agentControl(ferret),
    harness: (ferret, caller) => service.harness(ferret, caller),
    turns: (ferret, caller) => service.turns(ferret, caller),
    prompt: (ferret, caller) => service.prompt(ferret, caller),
    move: async (ferret, runtime, asked, caller): Promise<Result<FerretSummary, MoveFailure>> => {
      const options = asked === undefined ? undefined : { ...asked };
      if ((options?.actor === 'warden' || options?.movedBy === 'warden') && !warden) return refused(NOT_THE_WARDEN);
      return await service.move(ferret, runtime, options, caller);
    },
  };
}
