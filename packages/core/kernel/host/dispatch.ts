import type { Admission, AdmissionDecision, OutputGuard } from '../contract/bound.ts';
import { WITHHELD_SENTENCE } from '../contract/bound.ts';
import type { Actor } from '../contract/act.ts';
import type {
  ApiRequest,
  ApiResponse,
  PlainApiResponse,
  PublishedApiResponse,
  RouteParameters,
} from '../contract/http.ts';
import { errorResponse } from '../contract/http.ts';
import type { PluginId } from '../contract/ids.ts';
import type {
  CallContext,
  MemberRouteDescriptor,
  MemberCallContext,
  MemberRouteHandler,
  RouteDescriptor,
  RouteHandler,
  ScopedRoute,
} from '../contract/route.ts';
import type { SocketAccept, SocketDescriptor, SocketUpgradeDecision } from '../contract/socket.ts';
import { SOCKET_CLOSES } from '../contract/socket.ts';
import { DEFAULT_ACTOR, runInCall } from './call-scope.ts';
import {
  failureResponse,
  isPublishedResponse,
  methodNotAllowedResponse,
  noStore,
  pluginFailedResponse,
  publishResponse,
  skeletonResponse,
  storeDamagedResponse,
  unknownRouteResponse,
  withVersion,
} from './responses.ts';
import { orderRoutesBySpecificity, Router } from './router.ts';

/** How one plugin is serving right now. Read on every call, so a failure or damage after mount is honoured. */
export type Serving =
  | { readonly kind: 'serving' }
  | { readonly kind: 'skeleton' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'damaged'; readonly files: readonly string[] };

export interface Owner {
  readonly plugin: PluginId;
  readonly title: string;
  serving(): Serving;
}

export interface MountedRoute extends RouteDescriptor {
  readonly owner: Owner;
  readonly handle?: RouteHandler;
}

export interface MountedSocket extends SocketDescriptor {
  readonly owner: Owner;
  readonly accept?: SocketAccept;
}

export interface MountedMemberRoute extends MemberRouteDescriptor {
  readonly owner: Owner;
  readonly handle?: MemberRouteHandler;
}

export interface DispatchBindings {
  /** Bound after build (§7.6 step 5). Undefined = fail closed for everything but `minimum: 'none'` without a remedy. */
  admission(): Admission | undefined;
  /** Undefined, a throw or a damaged Vault: a `guard: 'secrets'` body is withheld. */
  outputGuard(): OutputGuard | undefined;
  readonly version: string;
}

/**
 * What admission is asked about a path no route claims, so an unauthenticated caller cannot map the private surface
 * by watching 404 turn into 405 (today's order: unknown-route answers only after authentication succeeds).
 */
const UNROUTED: Omit<ScopedRoute, 'method' | 'path'> = Object.freeze({
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'an unrouted path records nothing' },
  guard: { none: 'an unrouted answer names only the method and path the caller sent' },
});

const ADMISSION_UNAVAILABLE = (): PlainApiResponse =>
  errorResponse(503, 'The daemon cannot check who is calling right now, so it refuses.', 'admission_unavailable');

/** A route `minimum: 'none'` without a warden remedy is the only thing served while admission is missing (§7.1). */
const servableWithoutAdmission = (descriptor: ScopedRoute): boolean =>
  descriptor.minimum === 'none' && descriptor.wardenRemedy === undefined;

/** The withheld answer `late` chooses when a hold began after the body was built (§7.3). */
const withheld = (): PlainApiResponse => errorResponse(409, WITHHELD_SENTENCE, 'withheld');

function admit(
  bindings: DispatchBindings,
  table: 'route' | 'socket' | 'tool',
  descriptor: ScopedRoute,
  request: ApiRequest,
  params: ReadonlyMap<string, string>,
): AdmissionDecision {
  const admission = bindings.admission();
  if (admission === undefined) {
    return servableWithoutAdmission(descriptor)
      ? { outcome: 'admitted', standing: {}, actor: DEFAULT_ACTOR }
      : { outcome: 'refused', response: ADMISSION_UNAVAILABLE() };
  }
  try {
    const decision = admission.admit({ table, descriptor, request, params });
    if (decision === undefined || decision === null) return { outcome: 'refused', response: ADMISSION_UNAVAILABLE() };
    return decision;
  } catch {
    return { outcome: 'refused', response: ADMISSION_UNAVAILABLE() };
  }
}

/** The refusal for a plugin that is not serving, or undefined when it is. */
export function notServing(owner: Owner): PlainApiResponse | undefined {
  const serving = owner.serving();
  switch (serving.kind) {
    case 'serving':
      return undefined;
    case 'skeleton':
      return skeletonResponse(owner.title);
    case 'failed':
      return pluginFailedResponse(owner.title);
    case 'damaged':
      return storeDamagedResponse(owner.title, serving.files);
  }
}

/**
 * Runs one admitted handler and attaches the final check (§7.3). For a `guard: 'secrets'` route the stamp is taken
 * before the body is built, and the `late` the dispatcher attaches only CHOOSES, synchronously, between the
 * already-masked body and the fixed withheld sentence, from `OutputGuard` state: no await, no vault, no masking.
 */
async function run(
  bindings: DispatchBindings,
  descriptor: RouteDescriptor | MemberRouteDescriptor,
  build: () => Promise<ApiResponse>,
  owner?: Owner,
): Promise<ApiResponse> {
  const policy = <R extends ApiResponse>(response: R): R =>
    withVersion(descriptor.noStore === true ? noStore(response) : response, bindings.version);
  const guarded = descriptor.guard === 'secrets';
  const guard = guarded ? bindings.outputGuard() : undefined;
  let stamp: ReturnType<OutputGuard['stamp']> | undefined;
  if (guarded) {
    try {
      stamp = guard?.stamp();
    } catch {
      stamp = undefined;
    }
    if (stamp === undefined) return policy(withheld());
  }
  let built: ApiResponse;
  try {
    built = await build();
  } catch (error) {
    built = failureResponse(error);
  }
  const showable = (): boolean => {
    if (!guarded) return true;
    try {
      return guard !== undefined && stamp !== undefined && guard.stillShowable(stamp) === true;
    } catch {
      return false;
    }
  };
  const spell = built.late;
  if (spell === undefined && !guarded && owner === undefined) return policy(built);
  // Spelled again after the handler's last await; every carrier calls it (`finalised`) last, synchronously.
  let cached: { readonly source: PublishedApiResponse; readonly answer: PublishedApiResponse } | undefined;
  let prepared: PublishedApiResponse | undefined;
  const last = (): PlainApiResponse | PublishedApiResponse => {
    const refusal = owner === undefined ? undefined : notServing(owner);
    if (refusal !== undefined) return policy(refusal);
    if (!showable()) return policy(withheld());
    if (spell === undefined) {
      prepared ??= publishResponse(policy(built));
      return prepared;
    }
    try {
      const next = spell();
      const unavailable = owner === undefined ? undefined : notServing(owner);
      if (unavailable !== undefined) return policy(unavailable);
      if (!showable()) return policy(withheld());
      if (!isPublishedResponse(next)) return policy(next);
      if (cached?.source !== next) cached = { source: next, answer: publishResponse(policy(next)) };
      return cached.answer;
    } catch (error) {
      return policy(showable() ? failureResponse(error) : withheld());
    }
  };
  return { ...last(), late: last };
}

/**
 * The kernel's dispatcher: lookup by specificity, Admission BEFORE every handler (also before the 404/405 answer),
 * then the plugin's serving state, then the handler under the final check. A member principal is served only from
 * the member table; nothing else ever reaches it.
 */
export class Dispatcher {
  private readonly routes: Router<MountedRoute>;
  private readonly sockets: Router<MountedSocket>;
  private readonly members: Router<MountedMemberRoute>;
  private readonly streams = new Set<() => void>();

  constructor(
    private readonly bindings: DispatchBindings,
    tables: {
      readonly routes: readonly MountedRoute[];
      readonly sockets: readonly MountedSocket[];
      readonly memberRoutes: readonly MountedMemberRoute[];
    },
  ) {
    this.routes = new Router(orderRoutesBySpecificity(tables.routes));
    this.sockets = new Router(orderRoutesBySpecificity(tables.sockets));
    this.members = new Router(orderRoutesBySpecificity(tables.memberRoutes));
  }

  get table(): readonly MountedRoute[] {
    return this.routes.routes;
  }

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    if (request.principal?.kind === 'member') return await this.dispatchMember(request);
    const found = this.routes.lookup(request.method, request.path);
    if (found.kind !== 'matched') {
      const decision = admit(
        this.bindings,
        'route',
        { ...UNROUTED, method: request.method, path: request.path },
        request,
        new Map(),
      );
      if (decision.outcome === 'refused') return withVersion(decision.response, this.bindings.version);
      return withVersion(
        found.kind === 'method-not-allowed'
          ? methodNotAllowedResponse(request.method, request.path, found.allowed)
          : unknownRouteResponse(request.method, request.path),
        this.bindings.version,
      );
    }
    request.onRoute?.(found.route.path);
    const decision = admit(this.bindings, 'route', found.route, request, found.params);
    if (decision.outcome === 'refused') return withVersion(decision.response, this.bindings.version);
    const refusal = notServing(found.route.owner);
    const handle = found.route.handle;
    if (refusal !== undefined || handle === undefined)
      return withVersion(refusal ?? skeletonResponse(found.route.owner.title), this.bindings.version);
    const call = { request, params: found.params, ...decision.standing } as CallContext;
    const response = await runInCall({ actor: decision.actor }, () =>
      run(this.bindings, found.route, () => handle(call), found.route.owner),
    );
    this.recorded({
      table: 'route',
      descriptor: found.route,
      request,
      params: found.params,
      decision,
      status: response.status,
      response,
    });
    return response;
  }

  /** Tells Gate about one audited call after its handler settled (`Admission.recorded`); never changes the answer. */
  private recorded(input: {
    readonly table: 'route' | 'socket' | 'member';
    readonly descriptor: (RouteDescriptor | MemberRouteDescriptor) & { readonly audit: RouteDescriptor['audit'] };
    readonly request: ApiRequest;
    readonly params: RouteParameters;
    readonly decision: { readonly standing: object; readonly actor: Actor };
    readonly status: number;
    readonly response?: ApiResponse;
  }): void {
    if (!('record' in input.descriptor.audit)) return;
    try {
      this.bindings.admission()?.recorded?.({
        table: input.table,
        descriptor: input.descriptor as ScopedRoute,
        request: input.request,
        params: input.params,
        standing: input.decision.standing,
        actor: input.decision.actor,
        ...(input.request.principal === undefined ? {} : { principal: input.request.principal }),
        status: input.status,
        ...(input.response === undefined ? {} : { response: input.response }),
      });
    } catch {
      // The record is Gate's; the answer stands.
    }
  }

  private async dispatchMember(request: ApiRequest): Promise<ApiResponse> {
    const found = this.members.lookup(request.method, request.path);
    const admission = this.bindings.admission();
    if (found.kind !== 'matched' || admission === undefined)
      return withVersion(
        found.kind === 'matched'
          ? ADMISSION_UNAVAILABLE()
          : errorResponse(403, 'A member session reaches only the shared catalog routes.', 'member_only'),
        this.bindings.version,
      );
    let decision: AdmissionDecision<object>;
    try {
      decision = admission.admitMember({ table: 'member', descriptor: found.route, request, params: found.params });
    } catch {
      decision = { outcome: 'refused', response: ADMISSION_UNAVAILABLE() };
    }
    if (decision.outcome === 'refused') return withVersion(decision.response, this.bindings.version);
    const refusal = notServing(found.route.owner);
    const handle = found.route.handle;
    if (refusal !== undefined || handle === undefined)
      return withVersion(refusal ?? skeletonResponse(found.route.owner.title), this.bindings.version);
    const call = { request, params: found.params, ...decision.standing } as MemberCallContext;
    const response = await runInCall({ actor: decision.actor }, () =>
      run(this.bindings, found.route, () => handle(call), found.route.owner),
    );
    this.recorded({
      table: 'member',
      descriptor: found.route,
      request,
      params: found.params,
      decision,
      status: response.status,
      response,
    });
    return response;
  }

  /** The socket upgrade: the same admission, asked before `accept`. `unclaimed` lets the caller serve plain HTTP. */
  async upgrade(request: ApiRequest): Promise<SocketUpgradeDecision> {
    const found = this.sockets.lookup(request.method, request.path);
    if (found.kind !== 'matched') return { outcome: 'unclaimed' };
    const decision = admit(this.bindings, 'socket', found.route, request, found.params);
    if (decision.outcome === 'refused') return { outcome: 'refused', response: decision.response };
    const refusal = notServing(found.route.owner);
    const accept = found.route.accept;
    if (refusal !== undefined || accept === undefined)
      return { outcome: 'refused', response: refusal ?? skeletonResponse(found.route.owner.title) };
    const call = { request, params: found.params, ...decision.standing } as CallContext;
    try {
      const attach = await runInCall({ actor: decision.actor }, () => accept(call));
      this.recorded({ table: 'socket', descriptor: found.route, request, params: found.params, decision, status: 101 });
      return {
        outcome: 'accepted',
        attach: async downstream => {
          let closed = false;
          let handler: import('../contract/socket.ts').SocketHandler | undefined;
          const end = (): void => {
            if (closed) return;
            closed = true;
            this.streams.delete(recheck);
            downstream.close(SOCKET_CLOSES.unauthorized.code, SOCKET_CLOSES.unauthorized.reason);
            handler?.close(SOCKET_CLOSES.unauthorized);
          };
          const allowed = (): boolean => !closed && this.reauthorize(request);
          const recheck = (): void => {
            if (!allowed()) end();
          };
          this.streams.add(recheck);
          recheck();
          if (closed) throw new Error('this stream is no longer admitted');
          try {
            handler = await attach({
              send: (frame, permit) => {
                if (!allowed()) {
                  end();
                  return undefined;
                }
                return downstream.send(frame, () => allowed() && (permit === undefined || permit() === true));
              },
              close: (code, reason) => {
                closed = true;
                this.streams.delete(recheck);
                downstream.close(code, reason);
              },
              bufferedBytes: () => downstream.bufferedBytes(),
            });
            if (closed) {
              handler.close(SOCKET_CLOSES.unauthorized);
              throw new Error('this stream is no longer admitted');
            }
            if (!allowed()) {
              end();
              throw new Error('this stream is no longer admitted');
            }
            const attached = handler;
            return {
              open: async () => {
                recheck();
                if (!closed) await attached.open();
              },
              fromClient: frame => {
                recheck();
                if (!closed) attached.fromClient(frame);
              },
              close: ended => {
                closed = true;
                this.streams.delete(recheck);
                attached.close(ended);
              },
            };
          } catch (error) {
            this.streams.delete(recheck);
            end();
            throw error;
          }
        },
      };
    } catch (error) {
      const response = failureResponse(error);
      this.recorded({
        table: 'socket',
        descriptor: found.route,
        request,
        params: found.params,
        decision,
        status: response.status,
        response,
      });
      return { outcome: 'refused', response };
    }
  }

  /** A live serving-state transition re-admits every attached stream immediately (§7.1). */
  reauthorizeStreams(): void {
    for (const recheck of [...this.streams]) recheck();
  }

  /** The session layer's question about a stream already open: the same socket route, asked again (R217). */
  reauthorize(request: ApiRequest): boolean {
    const found = this.sockets.lookup(request.method, request.path);
    return (
      found.kind === 'matched' && notServing(found.route.owner) === undefined && this.readmit(request, found.route)
    );
  }

  /** Re-admits an open stream after a provider's generation moved (§7.1); false closes it `4401`. */
  readmit(request: ApiRequest, descriptor: ScopedRoute): boolean {
    try {
      return this.bindings.admission()?.readmit(request, descriptor) === true;
    } catch {
      return false;
    }
  }
}

export { admit as admitCall, run as runGuarded };
