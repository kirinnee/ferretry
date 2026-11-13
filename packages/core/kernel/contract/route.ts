import type { z } from 'zod';
import type { ApiRequest, ApiResponse, RouteParameters } from './http.ts';
import type { CapabilityAxis, PolicyRef } from './policy.ts';

/**
 * The least credential class that may reach a route, weakest first (today's `CredentialMinimum`, unchanged):
 * `none` (no token; a `wardenRemedy` overrides it), `authenticated` (any credential this daemon issued, the warden
 * included), `operator` (admin token or a device acting as the operator; never the warden), `admin-token` (the host's
 * own admin token only).
 */
export type CredentialMinimum = 'none' | 'authenticated' | 'operator' | 'admin-token';

/** Whether a ferret may make this call (`any`) or only a person (`person`). Required, no default (today's `RouteCaller`). */
export type RouteCaller = 'person' | 'any';

/** Today's `CapabilityDemand`: the operator's narrower question, asked only after the others pass. */
export interface CapabilityDemand {
  readonly capability: PolicyRef<'capability'>;
  readonly axis: CapabilityAxis;
  /** Only takes away: grant and unlock still asked, never a per-act passkey. */
  readonly narrowing?: true;
}

/** One of the two required additions (§7.1): what this route records in the audit log, or a reviewed reason not to. */
export type AuditDeclaration = { readonly record: PolicyRef<'audit'> } | { readonly skip: string };

/**
 * The other required addition (§7.3): `secrets` when the body may show pane, page or vault-derived text (the body is
 * built inside one `Redaction.read` and the dispatcher attaches `late`), or a reviewed reason it cannot.
 */
export type GuardDeclaration = 'secrets' | { readonly none: string };

/** The least a router needs (today's `RoutePattern`, unchanged). */
export interface RoutePattern {
  /** Named composition exception: higher values precede specificity. */
  readonly precedence?: number;
  readonly method: string;
  /** Literal segments, `:name` captures and a trailing `*name` catch-all. */
  readonly path: string;
  /** Synchronous; false = not in the table for this request (answers as an unrouted path). */
  readonly available?: () => boolean;
}

/**
 * The descriptor every route, socket and agent tool carries: today's `ScopedRoute`, field for field, plus `audit`
 * and `guard` (§7.1). The fields answer independent questions on purpose; nothing is merged.
 */
export interface ScopedRoute extends RoutePattern {
  readonly minimum: CredentialMinimum;
  readonly caller: RouteCaller;
  /** A person route's pointer for a ferret, added to the owner-only refusal. */
  readonly ferretDoor?: string;
  /** Must have ARRIVED over a privileged carrier (the privileged local listener). */
  readonly privilegedOnly?: true;
  /** Served before the device has unlocked (first passkey, the unlock itself, the inventory read). */
  readonly unlockExempt?: true;
  /** Absent = ungoverned, not unguarded. */
  readonly capability?: CapabilityDemand;
  /** Ungoverned route with one governed act: the boundary derives `governance` for the handler. */
  readonly consultsGrants?: true;
  /** Absent = no warden may act here. Overrides `minimum: 'none'`. */
  readonly wardenRemedy?: PolicyRef<'remedy'>;
  readonly audit: AuditDeclaration;
  readonly guard: GuardDeclaration;
}

/** Today's `ApiRoute` fields beyond the scope, as declared (no handler). */
export interface RouteResponseFlags {
  /** May carry credentials, working-tree bytes, or a live feed whose value is freshness. */
  readonly noStore?: boolean;
  /** Opt-in, audited to hold no secret (BREACH). */
  readonly compress?: true;
}

/** What a manifest declares for one route: the full descriptor, no handler. */
export interface RouteDescriptor extends ScopedRoute, RouteResponseFlags {}

/**
 * What Gate puts on every admitted call. Empty here on purpose: the kernel carries it and never reads it. Gate's
 * contract fills it by declaration merging (`declare module '@ferretry/kernel/contract' { interface CallStanding
 * { … } }`) with today's `RouteContext` fields: `actor`, `credential`, `wardenRemedy`, `governance`, `presentation`,
 * `spendStepUp`, `spendFreshStepUp`, `claimFreshStepUp`, `claimStoredProof`. A handler cannot mint any of it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled by Gate's contract through declaration merging.
export interface CallStanding {}

/** The handler's context: the request, its raw params, and Gate's standing (today's `RouteContext`, §7.1). */
export type CallContext<Standing extends object = CallStanding> = {
  readonly request: ApiRequest;
  /** Path parameters, RAW. Decode with `decodeParameter`. */
  readonly params: RouteParameters;
} & Readonly<Standing>;

export type RouteHandler<Standing extends object = CallStanding> = (
  call: CallContext<Standing>,
) => Promise<ApiResponse>;

/** A mounted route: descriptor plus handler (today's `ApiRoute`). The kernel builds these from manifest + half. */
export interface ApiRoute<Standing extends object = CallStanding> extends RouteDescriptor {
  handle: RouteHandler<Standing>;
}

/**
 * A member route (today's `SharedRoute`, field for field; §7.1). A separate table, served only to a `member`
 * standing on a member session, never to a device.
 */
export interface MemberRouteDescriptor extends RoutePattern {
  /** `key`: the member's key alone (join, unlock, passkeys in the 10-minute window, R606); `unlocked`: an unlocked member session. */
  readonly member: 'key' | 'unlocked';
  /** Re-reads the member's grant for the catalog named in the path on every request (R617). */
  readonly catalog?: 'path';
  /** Member answers are no-store (R619). */
  readonly noStore: true;
  readonly audit: AuditDeclaration;
  readonly guard: GuardDeclaration;
  /** The body this route parses, when it takes one. Part of the member-surface hash (§9.6), so a change to it moves that hash. */
  readonly request?: z.ZodType;
  /** The body this route answers, when it has a schema. Part of the member-surface hash (§9.6). */
  readonly response?: z.ZodType;
}

/** Filled by Gate's contract like {@link CallStanding}: the member standing a member handler reads. */
// biome-ignore lint/suspicious/noEmptyInterface: filled by Gate's contract through declaration merging.
export interface MemberStanding {}

export type MemberCallContext<Standing extends object = MemberStanding> = {
  readonly request: ApiRequest;
  readonly params: RouteParameters;
} & Readonly<Standing>;

export type MemberRouteHandler<Standing extends object = MemberStanding> = (
  call: MemberCallContext<Standing>,
) => Promise<ApiResponse>;

export interface MemberRoute<Standing extends object = MemberStanding> extends MemberRouteDescriptor {
  handle: MemberRouteHandler<Standing>;
}

/** Splits `'GET /v1/board'` into method and path. Throws on a malformed key (manifests are checked at load). */
export function parseRouteKey(key: string): { readonly method: string; readonly path: string } {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*)$/.exec(key);
  if (match === null) throw new TypeError(`route key "${key}" is not "<METHOD> /path"`);
  return { method: match[1] as string, path: match[2] as string };
}
