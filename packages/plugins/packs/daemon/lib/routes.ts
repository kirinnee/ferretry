import { isFerretCall, ferretOf } from '@ferretry/core-gate/contract';
import { ApiError, decodeParameter, jsonResponse, parseBody, type RouteHandler } from '@ferretry/kernel/contract';
import type { Log, Redaction } from '@ferretry/kernel/contract';
import {
  FerretPackPatchSchema,
  FerretResultSchema,
  type FerretPackPatchResult,
  type FerretResult,
  PackCleanUpJobResultSchema,
  PackCleanUpRequestSchema,
  PackCleanUpStartSchema,
  PackInventorySchema,
  PackRecommendationSchema,
  PackRecommendRequestSchema,
  PackRoutingAcceptRequestSchema,
  PackRoutingWriteResultSchema,
  PackTableSchema,
  type PackTable,
  PackViewSchema,
  type PackCleanUpJobResult,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  type PackInventory,
  type PackRecommendation,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  type PackView,
  type RoutingUndo,
  type PackCleanUpStatus,
} from '../../contract/index.ts';

/**
 * PACK MODE'S ROUTES (docs/pack-mode.md): the settings page's view, a recommendation, a finished ferret's result, a
 * lead's pack table and one ferret's own switch. Today's `pack` mount, handler for handler, less the helper start:
 * `fy new` is Ferrets' verb now, so Packs answers no start route.
 *
 * CLEAN UP, the routing prompt's generator: the inventory is a `fleet.use` read; starting a clean-up ferret, accepting
 * and undoing are a PERSON's acts — a ferret's own credential is refused, so no agent spends a model run or rewrites the
 * prompt unasked.
 */
export interface PackSubsystem {
  readonly service: {
    view(): Promise<Omit<PackView, 'undo' | 'cleanUp'>>;
    recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation>;
    inventory(): Promise<PackInventory>;
  };
  readonly routing: {
    readonly cleanUp: {
      status(): Promise<PackCleanUpStatus>;
      start(request: PackCleanUpRequest): Promise<PackCleanUpStart>;
      job(id: string): Promise<PackCleanUpJobResult | undefined>;
    };
    readonly file: {
      undoable(): Promise<RoutingUndo | undefined>;
      accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult>;
      undo(): Promise<PackRoutingWriteResult>;
    };
  };
  /** `undefined` when there is no such ferret. The summary is already masked; a masking failure throws. */
  result(ferret: string): Promise<FerretResult | undefined>;
  /** `caller` is the asking ferret, derived from its credential; absent for a person. */
  table(ferret: string, caller?: string): Promise<PackTable | undefined>;
  /** `undefined` when there is no such ferret. */
  setSwitch(ferret: string, enabled: boolean): Promise<FerretPackPatchResult | undefined>;
}

type Call = Parameters<RouteHandler>[0];

/** Refuses a ferret's own credential: only a person (at the machine, or a paired device) does these. */
function personOnly(call: Call, act: string): void {
  if (isFerretCall(call)) throw new ApiError(403, `only a person can ${act}; ask the owner`, 'forbidden');
}

function ferretParameter(call: Call): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
}

/**
 * What a person or a ferret is told when a read FAILED for a reason no handler named (a provider that threw, a document
 * that did not parse). The cause goes to the daemon log, whole; the answer says what could not be read and where the
 * cause is, and quotes none of it (a cause can carry anything a provider said).
 */
const UNREADABLE =
  'Pack mode could not read what it needs from this machine just now. The cause is in the daemon log; try again in a moment.';

/** A refusal a handler named keeps its own status; anything else is logged and answered as {@link UNREADABLE}, never a bare 500. */
function explained(log: Log, route: string, handler: RouteHandler): RouteHandler {
  return async call => {
    try {
      return await handler(call);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      log.error(`${route} failed: ${error instanceof Error ? error.message : String(error)}`, { route });
      throw new ApiError(503, UNREADABLE, 'pack_unavailable');
    }
  };
}

/** `noStore` throughout: every answer is decided on live facts or a live ferret. */
export function packRoutes(subsystem: PackSubsystem, redaction: Redaction, log: Log) {
  const routes = {
    'GET /v1/pack': (async () => {
      const [base, undo, cleanUp] = await Promise.all([
        subsystem.service.view(),
        subsystem.routing.file.undoable(),
        subsystem.routing.cleanUp.status(),
      ]);
      return jsonResponse(PackViewSchema.parse({ ...base, ...(undo === undefined ? {} : { undo }), cleanUp }));
    }) satisfies RouteHandler,
    'GET /v1/pack/inventory': (async () =>
      jsonResponse(PackInventorySchema.parse(await subsystem.service.inventory()))) satisfies RouteHandler,
    'POST /v1/pack/routing/clean-up': (async call => {
      personOnly(call, 'start a routing prompt clean-up');
      const request = await parseBody(call.request, PackCleanUpRequestSchema);
      const started = await subsystem.routing.cleanUp.start(request);
      return jsonResponse(PackCleanUpStartSchema.parse(started), started.outcome === 'started' ? 201 : 200);
    }) satisfies RouteHandler,
    'GET /v1/pack/routing/jobs/:jobId': (async call => {
      const id = decodeParameter(call.params.get('jobId') ?? '');
      const found =
        id === undefined || id === '' ? undefined : await subsystem.routing.cleanUp.job(id).catch(() => undefined);
      if (found === undefined) throw new ApiError(404, 'no such routing prompt clean-up', 'not-found');
      const { suggestion } = found;
      if (suggestion === undefined) return jsonResponse(PackCleanUpJobResultSchema.parse(found));
      // The rewrite was masked before it was kept (the daemon half's result read); it is masked again as it is served,
      // inside this route's one `Redaction.read`, so a secret the vault learned since is not shown either.
      return await redaction.read(scope =>
        jsonResponse(
          PackCleanUpJobResultSchema.parse({
            ...found,
            suggestion: { ...suggestion, before: scope.text(suggestion.before), after: scope.text(suggestion.after) },
          }),
        ),
      );
    }) satisfies RouteHandler,
    'POST /v1/pack/routing/accept': (async call => {
      personOnly(call, 'accept a cleaned-up routing prompt');
      const request = await parseBody(call.request, PackRoutingAcceptRequestSchema);
      return jsonResponse(PackRoutingWriteResultSchema.parse(await subsystem.routing.file.accept(request)));
    }) satisfies RouteHandler,
    'POST /v1/pack/routing/undo': (async call => {
      personOnly(call, 'undo an accepted routing prompt');
      return jsonResponse(PackRoutingWriteResultSchema.parse(await subsystem.routing.file.undo()));
    }) satisfies RouteHandler,
    'POST /v1/pack/recommend': (async call => {
      const request = await parseBody(call.request, PackRecommendRequestSchema);
      return jsonResponse(PackRecommendationSchema.parse(await subsystem.service.recommend(request)));
    }) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/result': (async call => {
      const id = ferretParameter(call);
      // `result` masks the summary inside its one `Redaction.read`, and withholds it (503) when that fails.
      const found = await subsystem.result(id);
      if (found === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(FerretResultSchema.parse(found));
    }) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/pack': (async call => {
      const id = ferretParameter(call);
      // The table's excerpts are masked WHOLE before they are cut, inside the table's one `Redaction.read`; masking the
      // cut line here would miss a secret that straddles the cut.
      const found = await subsystem.table(id, ferretOf(call));
      if (found === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(PackTableSchema.parse(found));
    }) satisfies RouteHandler,
    'PATCH /v1/ferrets/:ferretId/pack': (async call => {
      const id = ferretParameter(call);
      const request = await parseBody(call.request, FerretPackPatchSchema);
      const done = await subsystem.setSwitch(id, request.enabled);
      if (done === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(done);
    }) satisfies RouteHandler,
  };
  return Object.fromEntries(
    Object.entries(routes).map(([route, handler]) => [route, explained(log, route, handler)]),
  ) as typeof routes;
}
