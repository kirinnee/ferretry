import type { Actor } from '../contract/act.ts';
import type { Admission, AdmissionDecision, OutputGuard } from '../contract/bound.ts';
import { WITHHELD_SENTENCE } from '../contract/bound.ts';
import type { ApiRequest, ApiResponse, PlainApiResponse, PublishedApiResponse } from '../contract/http.ts';
import { errorResponse } from '../contract/http.ts';
import type { PluginId } from '../contract/ids.ts';
import type {
  CallContext,
  MemberRouteDescriptor,
  MemberRouteHandler,
  RouteDescriptor,
  RouteHandler,
  ScopedRoute,
} from '../contract/route.ts';
import type { SocketAccept, SocketDescriptor, SocketUpgradeDecision } from '../contract/socket.ts';
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
      ? { outcome: 'admitted', standing: {} }
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
    return policy(failureResponse(error));
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
  if (spell === undefined && !guarded) return policy(built);
  // Spelled again after the handler's last await; every carrier calls it (`finalised`) last, synchronously.
  let cached: { readonly source: PublishedApiResponse; readonly answer: PublishedApiResponse } | undefined;
  const last = (): PlainApiResponse | PublishedApiResponse => {
    if (!showable()) return policy(withheld());
    if (spell === undefined) {
      const { late: _late, ...plain } = built;
      return policy(plain as PlainApiResponse);
    }
    try {
      const next = spell();
      if (!isPublishedResponse(next)) return policy(next);
      if (cached?.source !== next) cached = { source: next, answer: publishResponse(policy(next)) };
      return cached.answer;
    } catch (error) {
      return policy(failureResponse(error));
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

  constructor(
    private readonly bindings: DispatchBindings,
    tables: {
      readonly routes: readonly MountedRoute[];
      readonly sockets: readonly MountedSocket[];
      readonly memberRoutes: readonly MountedMemberRoute[];
    },
    private readonly actorOf: (request: ApiRequest, table: 'route' | 'socket' | 'tool') => Actor = () =>
      DEFAULT_ACTOR,
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
    return await runInCall({ actor: this.actorOf(request, 'route') }, () =>
      run(this.bindings, found.route, () => handle(call)),
    );
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
    const call = { request, params: found.params, ...decision.standing };
    return await runInCall({ actor: DEFAULT_ACTOR }, () => run(this.bindings, found.route, () => handle(call)));
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
      const attach = await runInCall({ actor: this.actorOf(request, 'socket') }, () => accept(call));
      return { outcome: 'accepted', attach };
    } catch (error) {
      return { outcome: 'refused', response: failureResponse(error) };
    }
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
