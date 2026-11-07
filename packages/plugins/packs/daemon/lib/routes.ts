import { isFerretCall, ferretOf } from '@ferretry/core-gate/contract';
import { ApiError, arrivedLocal, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
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
  PackNewOutcomeSchema,
  PackNewRequestSchema,
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
  type PackNewOutcome,
  type PackNewRequest,
  type PackRecommendation,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  type PackView,
  type RoutingUndo,
  type PackCleanUpStatus,
} from '../../contract/index.ts';

/**
 * PACK MODE'S ROUTES (docs/pack-mode.md): the settings page's view, a recommendation, a helper start, a finished
 * ferret's result, a lead's pack table and one ferret's own switch. Today's `pack` mount, handler for handler.
 *
 * A start is the ferret start's own posture, and the start's limits apply to it inside Ferrets. A folder chosen by a
 * caller off this machine would be terminal access, so only a caller that ARRIVED at the machine may name one; anyone
 * else's helper runs in its parent's folder.
 *
 * CLEAN UP, the routing prompt's generator: the inventory is a `fleet.use` read; starting a clean-up ferret, accepting
 * and undoing are a PERSON's acts — a ferret's own credential is refused, so no agent spends a model run or rewrites the
 * prompt unasked.
 */
export interface PackSubsystem {
  readonly service: {
    view(): Promise<Omit<PackView, 'undo' | 'cleanUp'>>;
    recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation>;
    newChild(request: PackNewRequest, caller: { readonly agent: boolean }): Promise<PackNewOutcome>;
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
  /** `undefined` when there is no such ferret. */
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

/**
 * WHO A NEW FERRET'S PARENT IS, for any caller that names a ferret's credential: that ferret, always
 * (docs/pack-mode.md § Parent and child). A `parent` naming another ferret is refused `403 parent_mismatch`, and an
 * absent `parent` is filled in from the caller's credential, so a ferret can never start a parent-less, top-level helper.
 */
export function lineageOf<T extends { readonly parent?: string | undefined }>(call: Call, request: T): T {
  const own = ferretOf(call);
  if (own === undefined) return request;
  if (request.parent !== undefined && request.parent !== own)
    throw new ApiError(
      403,
      'a ferret starts ferrets only as its own children; leave the parent out, the daemon reads it from your credential',
      'parent_mismatch',
    );
  return { ...request, parent: own };
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
      return jsonResponse(PackCleanUpJobResultSchema.parse(found));
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
    'POST /v1/pack/new': (async call => {
      const request = lineageOf(call, await parseBody(call, PackNewRequestSchema));
      if (request.cwd !== undefined && !arrivedLocal(call.request))
        throw new ApiError(
          403,
          "a helper's folder may be chosen only at this machine; leave --cwd out to run it in its parent's folder",
          'not-granted',
        );
      const outcome = await subsystem.service.newChild(request, { agent: isFerretCall(call) });
      return jsonResponse(PackNewOutcomeSchema.parse(outcome), outcome.outcome === 'started' ? 201 : 200);
    }) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/result': (async call => {
      const id = ferretParameter(call);
      return await redaction.read(async scope => {
        const found = await subsystem.result(id);
        if (found === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
        return jsonResponse(
          FerretResultSchema.parse({
            ...found,
            ...(found.summary === undefined ? {} : { summary: scope.text(found.summary) }),
          }),
        );
      });
    }) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/pack': (async call => {
      const id = ferretParameter(call);
      return await redaction.read(async scope => {
        const found = await subsystem.table(id, ferretOf(call));
        if (found === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
        return jsonResponse(
          PackTableSchema.parse({
            ...found,
            rows: found.rows.map(row =>
              row.last === undefined ? row : { ...row, last: { ...row.last, text: scope.text(row.last.text) } },
            ),
          }),
        );
      });
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
