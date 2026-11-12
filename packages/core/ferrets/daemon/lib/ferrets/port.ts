import { ApiError } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import {
  LaunchOriginSchema,
  type FerretId,
  FerretIdSchema,
  type FerretsApi,
  type FerretSummary,
  type MoveFailure,
  type StartFailure,
  type StartRequest,
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

/**
 * Who a move may say moved the ferret: `owner`, `warden` (the Warden's alone, checked apart), or `session:` and a ferret
 * id's grammar (`FerretIdSchema`), which is how the route spells a calling ferret.
 */
const SESSION_MOVER = 'session:';
const isMover = (movedBy: unknown): boolean =>
  typeof movedBy === 'string' &&
  (movedBy === 'owner' ||
    movedBy === 'warden' ||
    (movedBy.startsWith(SESSION_MOVER) && FerretIdSchema.safeParse(movedBy.slice(SESSION_MOVER.length)).success));
const NOT_A_MOVER = 'a move names who moved it as owner, session:<ferret id> or warden';

const NO_ORIGIN = 'a launch must say who it is for: its origin is missing or not one of person, daemon or agent';
const NOT_THE_WARDEN = 'only the Warden is recorded as the Warden';
const NOT_THE_WARDEN_LABEL = 'only the Warden starts a ferret under its own label';
const NOT_THE_WARDEN_PARENT = 'only the Warden names a parent in its own tree';

/**
 * Whether a start under `ferret` would put the new ferret in the Warden's tree. It does when the parent's registry
 * label trims to the Warden's, or its summary says it descends from it, or the session documents say so: the same source
 * and rule the start's stamp uses (the registry summary does not carry the stamp). Fails closed: a parent that cannot
 * be read, is unknown, or whose documents cannot be read counts as in the tree.
 */
async function inWardenTree(service: FerretsService, ferret: FerretId): Promise<boolean> {
  const parent = await service.get(ferret).catch(() => undefined);
  if (parent === undefined) return true;
  if (parent.label?.trim() === WARDEN_LABEL || parent.provenance?.wardenLineage === true) return true;
  try {
    return await service.inWardenLineage(ferret);
  } catch {
    return true;
  }
}

/**
 * What one plugin holds under `ferrets`: an explicit object naming each member of {@link FerretsApi}, each forwarding
 * only the parameters the port declares, built for that consumer (`perNeeder`) from its manifest id. The id is the
 * kernel's, so what a consumer CLAIMS about who acts is checked against who it is:
 *
 * - `resume` / `move` with `actor: 'warden'` (or a move `movedBy: 'warden'`), and a start `by: 'warden'`, only from the
 *   Warden; a start `by: 'pack'` only from Packs and `by: 'board'` only from Board. Refused with a sentence, nothing
 *   resumed, moved or started.
 * - a consumer's `label` and `parent` are both checked: a start under the Warden's own label (`options.label`), and a
 *   start whose `parent` is in the Warden's tree (a parent in it gives the new ferret its lineage and so its label),
 *   only from the Warden. Any other parent is admitted: a lead starts its helpers through the port (parity J-0057).
 *   A parent is in the Warden's tree when its registry label trims to the Warden's label, or the session documents
 *   say so (`FerretSessionPort.inWardenLineage`, the same source and rule the start's stamp uses); a parent that cannot
 *   be read, or whose documents cannot, is refused (fail closed), and nothing is started. With the session port
 *   unbound no stamp is written, so the label check is all there is to make.
 *   Every start the port lets through for a consumer other than the Warden is handed to the service as admitted outside
 *   the Warden's tree, and the spawn stamp refuses it if lineage resolves true after all (the checks here and the stamp
 *   read the ancestry separately).
 * - a move's `movedBy` is `owner`, `warden` (the Warden's alone) or `session:<ferret id>`; any other spelling is refused
 *   with a fixed sentence, nothing moved.
 * - `systemCallsign` draws only the prefix of the consumer's own kind (`ApiError` 403 otherwise, in a sentence that does
 *   not quote the prefix asked for).
 *
 * `start` and `move` read the caller's request once and forward a rebuilt copy, never the caller's own object.
 *
 * Whatever else the service has — a stop's end `cause`, a move's `replaceLiveTerminal` and `target`, a route's
 * `confirmRestore`, `revokeToken`, `rename`, the launch and its tokens — is for this plugin's own callers and is not
 * reachable here at runtime, not just refused by the types. `resume` forwards only `automatic`, an `actor` of
 * `warden` (the Warden's alone) or `peer` (attribution only), `decided` and `onCarried`. `effectiveLimits` is served: it
 * answers `limits.yaml` as in effect, read fresh on every call.
 */
export function ferretsPort(service: FerretsService, consumer: string): FerretsApi {
  const warden = consumer === WARDEN_PLUGIN;
  const refused = (reason: string): Result<never, { readonly code: 'refused'; readonly reason: string }> =>
    err({ code: 'refused', reason });
  return {
    effectiveLimits: () => service.effectiveLimits(),
    get: ferret => service.get(ferret),
    list: filter => service.list(filter),
    mayTouch: (caller, target) => service.mayTouch(caller, target),
    children: ferret => service.children(ferret),
    harnesses: () => service.harnesses(),
    start: async (asked, askedOrigin): Promise<Result<FerretId, StartFailure>> => {
      // Fail closed: a launch whose origin was not stated (a plugin's cast) is refused, never taken as a person's. The
      // origin is read ONCE into a fresh object, as the request is.
      const stated = LaunchOriginSchema.safeParse(askedOrigin);
      if (!stated.success) return refused(NO_ORIGIN);
      const origin = stated.data;
      // Read every member once into a fresh object: the checks and the service see the same values, so a getter cannot
      // answer one thing to the check and another to the service.
      // `options` is read ONCE into a local, and the copy is built from that local alone.
      const { options, ...rest } = asked;
      const request: StartRequest = {
        ...rest,
        ...(options === undefined ? {} : { options: { ...options } }),
      };
      const owner = START_BY_PLUGIN[request.by];
      if (owner !== undefined && owner !== consumer)
        return refused(
          `only ${owner === WARDEN_PLUGIN ? 'the Warden' : `the ${owner} plugin`} starts a ferret as ${request.by}`,
        );
      // The Warden's own label marks the Warden's tree (supervision skips it, Packs exempts it from the helper limits,
      // lineage marks it): only the Warden starts under it, the same rule the route applies.
      if (request.options?.label?.trim() === WARDEN_LABEL && !warden) return refused(NOT_THE_WARDEN_LABEL);
      // A parent in the Warden's tree gives the new ferret the Warden's lineage, and so its label: only the Warden
      // names one through the port. Any other parent is admitted (a lead starts its helpers). A parent that cannot be
      // read is refused, never assumed ordinary.
      if (request.parent !== undefined && !warden && (await inWardenTree(service, request.parent)))
        return refused(NOT_THE_WARDEN_PARENT);
      // Every start admitted here for a consumer other than the Warden is told to the service as outside the Warden's
      // tree, so the spawn stamp refuses if lineage resolves true after all (the checks above and the stamp read the
      // ancestry separately, and a resume of the parent can strengthen its stamp in between).
      return await service.start(request, origin, warden ? undefined : { notInWardenTree: true });
    },
    stop: (ferret, how, reason) => service.stop(ferret, how, reason),
    resume: async (ferret, message, options) => {
      // Read once, as the rest of the options are: the check and the forward see the same origin.
      const stated = LaunchOriginSchema.safeParse(options.origin);
      if (!stated.success) return refused(NO_ORIGIN);
      const origin = stated.data;
      // Read once: the check and the forward see the same value. `'warden'` is the Warden's alone; `'peer'` is
      // caller-stated attribution (it changes no policy), so any consumer may say it.
      const actor = options.actor;
      if (actor === 'warden' && !warden) return refused(NOT_THE_WARDEN);
      // Only what the port declares: automated recovery, the turn author's attribution, who must be told what the
      // resume decided, and who must be told what it typed for the message.
      const forwarded = {
        origin,
        ...(options.automatic === true ? { automatic: true } : {}),
        ...(actor === 'warden' || actor === 'peer' ? { actor } : {}),
        ...(options.decided === undefined ? {} : { decided: options.decided }),
        ...(options.onCarried === undefined ? {} : { onCarried: options.onCarried }),
      };
      return await service.resume(ferret, message, forwarded);
    },
    attach: async (ferret, handle, askedOrigin) => {
      // Fail closed, as start and resume do: an attach whose origin was not stated is refused.
      const stated = LaunchOriginSchema.safeParse(askedOrigin);
      if (!stated.success) return refused(NO_ORIGIN);
      return await service.attach(ferret, handle, stated.data);
    },
    handle: ferret => service.handle(ferret),
    workFolder: ferret => service.workFolder(ferret),
    sitrep: ferret => service.sitrep(ferret),
    summary: ferret => service.summary(ferret),
    managedWorktrees: () => service.managedWorktrees(),
    systemCallsign: async prefix => {
      if (CALLSIGN_PREFIX_OF[consumer] !== prefix)
        // A fixed sentence: the prefix is the caller's own text and is never quoted back.
        throw new ApiError(403, `the ${consumer} plugin may not draw that kind of callsign`, 'forbidden');
      return await service.systemCallsign(prefix);
    },
    agentControl: ferret => service.agentControl(ferret),
    harness: (ferret, caller) => service.harness(ferret, caller),
    turns: (ferret, caller) => service.turns(ferret, caller),
    prompt: (ferret, caller) => service.prompt(ferret, caller),
    move: async (ferret, runtime, asked, caller): Promise<Result<FerretSummary, MoveFailure>> => {
      const options = { ...asked };
      const stated = LaunchOriginSchema.safeParse(options.origin);
      if (!stated.success) return refused(NO_ORIGIN);
      if ((options.actor === 'warden' || options.movedBy === 'warden') && !warden) return refused(NOT_THE_WARDEN);
      // `movedBy` is journalled as the history's account of who moved the ferret, so it is one of the three spellings
      // the journal reads, never free text ('Warden', 'warden ', 'session:<anything>').
      if (options.movedBy !== undefined && !isMover(options.movedBy)) return refused(NOT_A_MOVER);
      return await service.move(ferret, runtime, { ...options, origin: stated.data }, caller);
    },
  };
}
