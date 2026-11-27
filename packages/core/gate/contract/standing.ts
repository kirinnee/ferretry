import type {
  CapabilityDemand,
  FerretId,
  HolderId,
  PolicyRef,
  RouteParameters,
  SessionId,
  SessionPrincipal,
} from '@ferretry/kernel/contract';
import { CONNECTOR_GRANT_PATTERN } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type {
  CapabilityGrants,
  EveryCallerStepUpAct,
  GrantRefusal,
  MachineSkippableStepUpAct,
  StepUpSubjectOf,
  StoredProofStepUpAct,
} from './policy.ts';

/**
 * The standing Gate puts on every admitted call: today's `RouteContext` fields (packages/daemon/src/lib/api/route.ts,
 * capability.ts, actor.ts, authentication.ts), field for field, with three renames to the words of §1: `session`
 * (a ferret's bearer) is `ferret`, `loopback` is `local`, and a device is the kernel-stamped `SessionPrincipal`
 * rather than a bearer. A handler cannot mint any of it (§7.1).
 */

// ─── actor ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The server-derived name of a caller, for attribution only, never for a decision (today's `ApiActor`): `admin-ui`,
 * `admin-cli`, `ferret:<id>`, `warden:<id>`, `warden`, `device:<id>`, `device`.
 */
export type ApiActor = string;

export const FERRET_ACTOR_PREFIX = 'ferret:';
export const WARDEN_ACTOR_PREFIX = 'warden:';
export const DEVICE_ACTOR_PREFIX = 'device:';
export const CONNECTOR_ACTOR_PREFIX = 'connector:';
export const connectorActor = (grant: string): `connector:${string}` => `${CONNECTOR_ACTOR_PREFIX}${grant}`;

export const ferretActor = (ferret: string): `ferret:${string}` => `${FERRET_ACTOR_PREFIX}${ferret}`;
export const wardenActor = (ferret: string): `warden:${string}` => `${WARDEN_ACTOR_PREFIX}${ferret}`;
export const deviceActor = (device: string): `device:${string}` => `${DEVICE_ACTOR_PREFIX}${device}`;

export interface ParsedActor {
  readonly kind: string;
  readonly id?: string;
  readonly raw: string;
}

/** Today's `parseActor`. */
export function parseActor(source: string): ParsedActor {
  const separator = source.indexOf(':');
  if (separator === -1) return { kind: source, raw: source };
  return { kind: source.slice(0, separator), id: source.slice(separator + 1), raw: source };
}

/** The owner's own app, `fy`, or an approved connector grant; attribution, never a host-arrival proof. */
export function isHumanAdminActor(actor: ApiActor | undefined): boolean {
  const { kind, id } = parseActor(actor ?? '');
  return (
    kind === 'admin-ui' || kind === 'admin-cli' || (kind === 'connector' && CONNECTOR_GRANT_PATTERN.test(id ?? ''))
  );
}

// ─── credential ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The bearer classes Gate checks by hash, plus the device principal the kernel stamped (§7.1). */
export type TokenClass = 'admin' | 'warden' | 'ferret' | 'device' | 'connector';

/** WHICH credential authenticated the call (today's `AuthenticatedCredential`). Never a token or a digest. */
export type AuthenticatedCredential =
  | { readonly kind: 'authenticated'; readonly tokenClass: 'admin' | 'warden' }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'connector'; readonly grant: string }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'ferret'; readonly ferret: FerretId }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'device'; readonly principal: SessionPrincipal };

/** A ferret's own bearer: `fys_` and 43 base64url characters (today's `isSessionCredential`, the only shape kept). */
export const FERRET_TOKEN_PREFIX = 'fys_';
export const isFerretToken = (bearer: string | undefined): bearer is string =>
  bearer !== undefined && /^fys_[A-Za-z0-9_-]{43}$/u.test(bearer);

/**
 * Today's `callerIsAgent`: ONE predicate decides person-or-ferret. A ferret's token and the warden are agents; a
 * device is a person; the admin token is a person only when no ferret is named behind it.
 */
export function callerIsAgent(credential: AuthenticatedCredential | undefined, actor: ApiActor | undefined): boolean {
  if (credential === undefined) return false;
  switch (credential.tokenClass) {
    case 'ferret':
    case 'warden':
      return true;
    case 'device':
    case 'connector':
      return false;
    case 'admin':
      return !isHumanAdminActor(actor);
  }
}

// ─── governance ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Today's `GrantDecision`. */
export interface GrantDecision {
  readonly allowed: boolean;
  readonly refusal: GrantRefusal;
  readonly steppedUp?: true;
}

/** Where this caller stands relative to the owner's grants (today's `CallerGovernance`). */
export interface CallerGovernance {
  readonly governed: boolean;
  decide(demand: CapabilityDemand): GrantDecision;
  /** A grant generation moved: re-ask this caller's extra demands. Cancel when the caller ends. */
  watch?(listener: () => void): () => void;
}

/** The facts the grant layer reads about this caller (today's `CapabilityPresentation`). */
export interface CapabilityPresentation {
  /** Stamped only from the kernel's delegated arrival; never from a bearer or a header. */
  readonly connector?: { readonly route: string };
  /** Today's `loopback`: arrived on the host with the admin token, or a ferret's own token. Carrier-proved only. */
  readonly local: boolean;
  readonly adminToken: boolean;
  readonly actor: ApiActor;
  readonly stepUp: boolean;
  readonly freshStepUp?: boolean;
  /**
   * Whether the owner asked for a passkey on every act (`stepUpOnActions`, or an undetermined policy that asks the
   * stricter way). When `false`, a plain `use` demand needs no step-up of its own, so a READ (list, status, stream
   * open) never asks for one on a machine whose owner turned both switches off. `configure` is unaffected. Absent
   * means "asks", so a presentation built without it keeps today's answer.
   */
  readonly useAsksStepUp?: boolean;
  /** The proved device's own half; `null` when its provider could not say (undetermined). */
  readonly deviceGrants?: CapabilityGrants | null;
}

// ─── warden remedy ────────────────────────────────────────────────────────────────────────────────────────────────

/** A warden's proven authority to exercise one remedy on one ferret (today's `WardenRemedyGrant`). */
export interface WardenRemedyGrant {
  readonly remedy: PolicyRef<'remedy'>;
  /** Today's `targetSessionId`: the ferret this authority is over, read from the path. */
  readonly targetFerret: FerretId;
  /** WHICH warden, resolved from the presented capability, never from a header. */
  readonly wardenId: FerretId;
  readonly assignmentStartedAt: Instant;
}

/** What the remedy authorizer is given: four fields, and the count is the contract (today's presentation). */
export interface WardenRemedyPresentation {
  readonly remedy: PolicyRef<'remedy'>;
  readonly params: RouteParameters;
  readonly capability: string;
  readonly actor: ApiActor;
}

export type WardenRemedyDecision =
  | { readonly allowed: true; readonly grant: WardenRemedyGrant }
  | { readonly allowed: false; readonly refusal: string };

/** Synchronous; answers `undefined` when its snapshot is absent or a refresh failed (read as a refusal). */
export interface WardenRemedyAuthorizer {
  decide(presentation: WardenRemedyPresentation): WardenRemedyDecision | undefined;
}

// ─── step-up claims ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a kept step-up proof holds: the device and the assertion bytes as signed (today's `StoredStepUpProof`). */
export interface StoredStepUpProof {
  readonly deviceId: string;
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
}

/**
 * Takes a FRESH proof at admission (today's `ClaimFreshStepUp`). A machine-skippable act is asked the short way; an
 * every-caller act must name its one subject, so `claimFreshStepUp('add-2fa-key')` does not compile, and a stored-proof
 * act is claimed only through {@link ClaimStoredProof}.
 */
export interface ClaimFreshStepUp {
  (act?: MachineSkippableStepUpAct): boolean;
  <A extends Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>>(act: A, subject: StepUpSubjectOf<A>): boolean;
}

/** Takes the KEPT proof of a stored-proof act, bound to exactly `subject` and the challenge re-derived from the bytes. */
export type ClaimStoredProof = <A extends StoredProofStepUpAct>(
  act: A,
  subject: StepUpSubjectOf<A>,
  expectedChallenge: Uint8Array,
) => StoredStepUpProof | undefined;

// ─── member standing ──────────────────────────────────────────────────────────────────────────────────────────────

/** A member as its provider answers for it right now (Catalogs' `credentials:member`). */
export interface MemberHolderStanding {
  readonly kind: 'member';
  readonly holder: HolderId;
  /** The catalogs shared with this member (ids). A `catalog: 'path'` route re-reads it per request (R617). */
  readonly catalogs: readonly string[];
  readonly unlockedUntil?: Instant;
}

// ─── the merge ────────────────────────────────────────────────────────────────────────────────────────────────────

declare module '@ferretry/kernel/contract' {
  /** Gate's standing on every admitted call (today's `RouteContext` fields, all server-derived). */
  interface CallStanding {
    /** Absent on a `minimum: 'none'` route. */
    readonly actor?: ApiActor;
    readonly credential?: AuthenticatedCredential;
    /** Present only when the remedy authorizer allowed this warden here. */
    readonly wardenRemedy?: WardenRemedyGrant;
    /** Present exactly on routes with `capability` or `consultsGrants`. */
    readonly governance?: CallerGovernance;
    readonly presentation?: CapabilityPresentation;
    readonly spendStepUp?: () => void;
    /** Atomically checks and spends this call's step-up; configured reusable windows remain reusable. */
    readonly claimStepUp?: () => boolean;
    readonly spendFreshStepUp?: () => void;
    readonly claimFreshStepUp?: ClaimFreshStepUp;
    readonly claimStoredProof?: ClaimStoredProof;
  }
  /** Gate's standing on every admitted member call (today's `SharedRouteContext` fields). */
  interface MemberStanding {
    readonly principal: SessionPrincipal & { readonly kind: 'member' };
    /** The member as its provider answers for it NOW (today's `access`). */
    readonly member: MemberHolderStanding;
    /** Today's `sessionId`: the session carrying the call, which a route may ask to have spared. */
    readonly session: SessionId;
  }
}

/** Whether a call is a ferret's (today's `isAgentCaller`). */
export const isFerretCall = (call: { readonly credential?: AuthenticatedCredential; readonly actor?: ApiActor }) =>
  callerIsAgent(call.credential, call.actor);

/** The ferret behind a call, when it is one (today's `agentSessionOf`). */
export function ferretOf(call: {
  readonly credential?: AuthenticatedCredential;
  readonly actor?: ApiActor;
}): FerretId | undefined {
  if (call.credential?.tokenClass === 'ferret') return call.credential.ferret;
  if (!isFerretCall(call)) return undefined;
  const actor = parseActor(call.actor ?? '');
  return actor.kind === 'ferret' && actor.id !== undefined && actor.id !== '' ? (actor.id as FerretId) : undefined;
}
