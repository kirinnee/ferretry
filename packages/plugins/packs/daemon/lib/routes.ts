import { isFerretCall, ferretOf } from '@ferretry/core-gate/contract';
import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { Redaction } from '@ferretry/kernel/contract';
import type { ZodType } from 'zod';
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

async function parseBody<T>(call: Call, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await call.request.text();
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'the request body is not what this route takes', 'invalid_body');
  return parsed.data;
}

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

/** `noStore` throughout: every answer is decided on live facts or a live ferret. */
export function packRoutes(subsystem: PackSubsystem, redaction: Redaction) {
  return {
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
      const request = await parseBody(call, PackCleanUpRequestSchema);
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
      const request = await parseBody(call, PackRoutingAcceptRequestSchema);
      return jsonResponse(PackRoutingWriteResultSchema.parse(await subsystem.routing.file.accept(request)));
    }) satisfies RouteHandler,
    'POST /v1/pack/routing/undo': (async call => {
      personOnly(call, 'undo an accepted routing prompt');
      return jsonResponse(PackRoutingWriteResultSchema.parse(await subsystem.routing.file.undo()));
    }) satisfies RouteHandler,
    'POST /v1/pack/recommend': (async call => {
      const request = await parseBody(call, PackRecommendRequestSchema);
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
      const request = await parseBody(call, FerretPackPatchSchema);
      const done = await subsystem.setSwitch(id, request.enabled);
      if (done === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(done);
    }) satisfies RouteHandler,
  };
}
