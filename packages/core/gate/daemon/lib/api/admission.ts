import {
  type Actor,
  type Admission,
  type AdmissionDecision,
  type AdmissionInput,
  type ApiRequest,
  type ApiResponse,
  arrivedLocal,
  arrivedOnHost,
  arrivedPrivileged,
  type CallStanding,
  type ConfigAccessJudgement,
  type ConfigAccessVerdict,
  type ConfigWriteJudgement,
  errorResponse,
  headerValue,
  type InventoryEntry,
  type InventorySurfaces,
  jsonResponse,
  type MemberStanding,
  type PluginInventory,
  PROTOCOL,
  type RecordedCall,
  type RouteParameters,
  type ScopedRoute,
  type SessionPrincipal,
} from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  type ApiActor,
  type AuditDraft,
  AUDIT_KINDS,
  type CallerGovernance,
  type CapabilityPresentation,
  type ClaimFreshStepUp,
  type ClaimStoredProof,
  type CredentialProvider,
  callerIsAgent,
  type DeviceHolderStanding,
  type EveryCallerStepUpAct,
  type FerretBearerDirectory,
  type GateConfig,
  grantRefusalCode,
  type InventoryViewer,
  type MachineSkippableStepUpAct,
  type MemberHolderStanding,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  type PluginSurfaces,
  projectInventory,
  STEP_UP_REQUIRED_CODE,
  STEP_UP_SUBJECTS,
  type StepUpAct,
  type StepUpRequiredBody,
  type StepUpSubject,
  type StepUpSubjectOf,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
  type StoredProofStepUpAct,
  type TokenClass,
  UNLOCK_REQUIRED_CODE,
  type WardenRemedyAuthorizer,
  type WardenRemedyDecision,
  type WardenRemedyGrant,
} from '../../../contract/index.ts';
import { recordedCallDraft } from '../audit/recorder.ts';
import { judgeLooseningWrite } from '../policy/config-judge.ts';
import { judgeConfigAccess } from '../policy/config-access.ts';
import type { FailClosedStepUps } from '../step-up/witness.ts';
import { resolveApiActor } from './actor.ts';
import {
  type Authentication,
  authenticate,
  bearerToken,
  type FerretTokenRefusal,
  type GateTokens,
} from './authentication.ts';
import { type CapabilityGuard, grantGuard, intersectGrants } from './capability.ts';

/** The pane's own ferret id, so an in-pane caller on the admin token is attributed to itself (today's header name). */
export const SESSION_ID_HEADER = 'x-ferretry-session-id';
/** Client self-identification (`cli`), which is what tells `admin-cli` from `admin-ui`. */
export const CLIENT_HEADER = 'x-ferretry-client';
/**
 * The per-assignment capability a warden presents to exercise a remedy. IT REFINES, IT NEVER ESTABLISHES: what makes a
 * caller a warden is the token it authenticated with, and nothing else.
 */
const WARDEN_CAPABILITY_HEADER = 'x-fy-warden-capability';

/** Everything admission reads, each a live answer asked per call; none of it comes from the request body. */
export interface GateAdmissionDeps {
  /** The host's tokens; `undefined` until they are loaded, which refuses every bearer (fail closed). */
  readonly tokens: () => GateTokens | undefined;
  /** `bearers:ferret`, or `undefined` while Ferrets is off: no ferret token authenticates. */
  readonly ferrets: () => FerretBearerDirectory | undefined;
  /** `credentials:device` / `credentials:member`, or `undefined` while the taking plugin is off (R605). */
  readonly devices: () => CredentialProvider<DeviceHolderStanding> | undefined;
  readonly members: () => CredentialProvider<MemberHolderStanding> | undefined;
  /** `gate.yaml` in effect, or `undefined` when undetermined (every governed caller is refused). */
  readonly policy: () => GateConfig | undefined;
  /**
   * The warden-remedy authorizer. No hook supplies one in the frozen contract yet, so it is absent and every remedy
   * route refuses a warden `warden_remedy_unwired` — today's answer for a table served without one.
   */
  readonly remedies?: () => WardenRemedyAuthorizer | undefined;
  /** `step-up:device` (Access), read live and fail closed: no provider holds nothing and must unlock. */
  readonly stepUps: FailClosedStepUps;
  readonly now: () => Instant;
  /** Told about a refused ferret token (`ferret.credential-refused`). Never throws into the call. */
  readonly refused: (draft: AuditDraft) => void;
  /** Where a descriptor-declared record of an admitted call goes (`recorded`). */
  readonly recorded?: (draft: AuditDraft) => void;
  /** The kind of a config file named by its path under `config/` (the plugin that declares it), for a record. */
  readonly configKind?: (path: string) => string | undefined;
  /** The binary's name, for refusal sentences that name a command. */
  readonly clientName: string;
}

/** Whether a route is served before authentication is attempted — the public shortcut (today's `servedPublicly`). */
const servedPublicly = (route: ScopedRoute): boolean =>
  route.minimum === 'none' && route.wardenRemedy === undefined && route.caller === 'any';

/** Today's `meetsMinimum`. */
function meetsMinimum(tokenClass: TokenClass, minimum: ScopedRoute['minimum']): boolean {
  switch (minimum) {
    case 'none':
    case 'authenticated':
      return true;
    case 'operator':
      return tokenClass !== 'warden';
    case 'admin-token':
      return tokenClass === 'admin';
  }
}

const refused = (response: ApiResponse): AdmissionDecision<never> => ({ outcome: 'refused', response });

const forbidden = (request: ApiRequest, words = 'the request may not use'): AdmissionDecision<never> =>
  refused(errorResponse(403, `${words} ${request.method} ${request.path}`, 'forbidden'));

/** The one refusal a call of a kind no provider answers for gets (R605, G140): the same words as a stranger's. */
const UNAUTHORIZED = (): ApiResponse => errorResponse(401, 'unauthorized', 'unauthorized');

/** Who an act runs as, stamped from the credential (§4.7): a plugin cannot choose it. */
function actOf(authentication: Authentication, actor: ApiActor | undefined): Actor {
  if (authentication.kind === 'anonymous') return 'owner-viewer';
  if (authentication.tokenClass === 'warden') return 'warden';
  if (callerIsAgent(authentication, actor)) return 'ferret';
  return actor === 'admin-cli' ? 'owner-tools' : 'owner-viewer';
}

/** What a device's provider says about the principal right now. */
type DeviceAnswer =
  | { readonly kind: 'device'; readonly standing: DeviceHolderStanding }
  | { readonly kind: 'undetermined' }
  | { readonly kind: 'refused' };

/**
 * Gate's admission (§7.1): today's `authorizeRequest`, step for step, on the kernel's request. THE ORDER IS
 * STRUCTURAL: there is no branch below that produces `admitted` for a call an earlier step refused.
 *
 * 1. a member principal is refused here (its own table admits it);
 * 2. the public shortcut, for a route that asks nothing (privileged arrival still enforced);
 * 3. authenticate: the kernel's principal for a device, the bearer by hash for admin, warden and ferret;
 * 4. a ferret token naming another ferret in the header is `401 session_mismatch`, audited;
 * 5. derive the actor from the token class alone;
 * 6. a person route refuses every agent (`403 owner_only`), before the minimum;
 * 7. the credential minimum and `privilegedOnly`;
 * 8. the unlock, for a proved device off the host;
 * 9. the operator's grant (daemon-wide ∧ device), which can only take away;
 * 10. the warden remedy, asked only of a caller the token class proved to be a warden.
 */
export class GateAdmission implements Admission {
  readonly #guard: CapabilityGuard;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly deps: GateAdmissionDeps) {
    this.#guard = grantGuard(() => deps.policy()?.grants, deps.clientName);
  }

  admit(input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }): AdmissionDecision {
    return this.#authorize(input.descriptor, input.request, input.params, input.table);
  }

  readmit(request: ApiRequest, descriptor: ScopedRoute): boolean {
    // No path parameters on a re-ask: only a warden remedy reads them, and readmit re-asks the descriptor, not one call.
    return this.#authorize(descriptor, request, new Map()).outcome === 'admitted';
  }

  /** The kernel's watch (G149): told on every policy generation change so open streams are re-asked at once. */
  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The policy in effect moved: tell every watcher. A watcher that throws never stops the others. */
  policyChanged(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // The host's re-ask is its own; a failing listener does not hide the change from the next.
      }
    }
  }

  /**
   * Told by the kernel once per call after the handler of a descriptor that says `audit: { record }`, with the final
   * status and the answer as built (today's audited-route decorator, `recorder.ts`). Never the request body. AN AUDIT
   * WRITE NEVER DECIDES AN OUTCOME: it is fired and forgotten, and its failure is the audit log's to report.
   */
  recorded(call: RecordedCall): void {
    try {
      const draft = recordedCallDraft(call, {
        ...(this.deps.configKind === undefined ? {} : { configKind: this.deps.configKind }),
      });
      if (draft !== undefined) this.deps.recorded?.(draft);
    } catch {
      // The audit log reports its own failures; the answer is already decided.
    }
  }

  /** The kernel's config routes, asked per file: today's grants by file kind (`policy/config-access.ts`). */
  judgeConfigAccess(input: ConfigAccessJudgement): ConfigAccessVerdict {
    return judgeConfigAccess(input);
  }

  /**
   * A plugin's own loosening config write (`kernel.config.write`/`remove`): today's held-loosening rule. A secret add
   * (`ConfigPort.writeAsCaller`) is judged from the standing as it is NOW, not as it was at admission: the work a call
   * spawns can write long after the call ended, so a device revoked, locked, or stripped of a grant since holds.
   */
  judgeConfigWrite(input: ConfigWriteJudgement): 'apply' | 'hold' {
    if (input.secretAdd !== true) return judgeLooseningWrite(input);
    return judgeLooseningWrite({ ...input, standing: this.#liveStanding(input.standing) });
  }

  /**
   * The call's standing re-read from the providers now (devices, step-ups, the policy), keeping the claim functions the
   * admission minted so one proof is still one act. `undefined` (the judge then holds) for a device its provider no
   * longer holds or cannot place, one that must unlock again, or a standing this admission did not mint.
   */
  #liveStanding(standing: CallStanding | undefined): CallStanding | undefined {
    const presentation = standing?.presentation;
    if (standing === undefined || presentation === undefined) return undefined;
    // A route that asked for no grant standing (no capability, no `consultsGrants`) has none to read: undetermined.
    if (standing.governance === undefined) return standing;
    const credential = standing.credential;
    if (credential?.kind !== 'authenticated' || credential.tokenClass !== 'device')
      return { ...standing, governance: this.#guard.governance(presentation) };
    const principal = credential.principal;
    const answer = this.#device(principal);
    if (answer.kind !== 'device') return undefined;
    const subject: StepUpSubject = { deviceId: principal.holder, appSession: principal.session };
    const policy = this.deps.policy();
    const unlocked = answer.standing.unlockedUntil !== undefined && answer.standing.unlockedUntil > this.deps.now();
    if (
      ((policy === undefined || policy.security.unlockOnOpen) && !unlocked) ||
      this.deps.stepUps.unlockRequired(subject)
    )
      return undefined;
    const live: CapabilityPresentation = {
      ...presentation,
      stepUp: this.deps.stepUps.held(subject),
      freshStepUp: this.deps.stepUps.freshlyHeld(subject),
      deviceGrants: answer.standing.grants,
    };
    return { ...standing, presentation: live, governance: this.#guard.governance(live) };
  }

  admitMember(input: AdmissionInput & { readonly table: 'member' }): AdmissionDecision<MemberStanding> {
    const principal = input.request.principal;
    if (principal?.kind !== 'member') return forbidden(input.request);
    const provider = this.deps.members();
    let standing: MemberHolderStanding | 'unknown' | 'revoked';
    try {
      standing = provider === undefined ? 'revoked' : provider.standing(principal.holder, this.deps.now());
    } catch {
      standing = 'revoked';
    }
    if (typeof standing !== 'object') return refused(UNAUTHORIZED());
    const descriptor = input.descriptor;
    if (descriptor.member === 'unlocked') {
      const until = standing.unlockedUntil;
      if (until === undefined || until <= this.deps.now())
        // R617: a locked member is 403 member_locked (a gone key was 401 above).
        return refused(errorResponse(403, 'unlock this catalog with your passkey first', 'member_locked'));
    }
    if (descriptor.catalog === 'path') {
      const catalog = input.params.get('catalogId') ?? input.params.get('catalog');
      // R617: a catalog this member was not given reads as absent.
      if (catalog === undefined || !standing.catalogs.includes(catalog))
        return refused(errorResponse(404, 'there is no such catalog', 'not_found'));
    }
    return {
      outcome: 'admitted',
      standing: {
        principal: principal as SessionPrincipal & { readonly kind: 'member' },
        member: standing,
        session: principal.session,
      },
      actor: 'owner-viewer',
    };
  }

  inventory(
    request: ApiRequest,
    entries: readonly InventoryEntry[],
    surfaces: InventorySurfaces,
  ): readonly InventoryEntry[] {
    return this.project(request, { protocol: PROTOCOL, plugins: [...entries] }, surfaces).plugins;
  }

  /** §9.6: the inventory as this caller may see it. A refused caller sees nothing. */
  project(request: ApiRequest, inventory: PluginInventory, surfaces: PluginSurfaces): PluginInventory {
    const projection = projectInventory(inventory, this.#viewerOf(request), surfaces);
    return projection.outcome === 'shown' ? projection.inventory : { protocol: PROTOCOL, plugins: [] };
  }

  #viewerOf(request: ApiRequest): InventoryViewer {
    if (request.principal?.kind === 'member') return { kind: 'member' };
    const authentication = this.#authenticate(request);
    if (authentication.kind === 'anonymous') return { kind: 'none' };
    switch (authentication.tokenClass) {
      case 'admin':
        return arrivedOnHost(request, true) ? { kind: 'owner' } : this.#governedViewer();
      case 'ferret':
        return { kind: 'ferret' };
      case 'warden':
        return { kind: 'warden' };
      case 'device': {
        const answer = this.#device(authentication.principal);
        const daemonWide = this.deps.policy()?.grants;
        if (answer.kind !== 'device' || daemonWide === undefined) return { kind: 'none' };
        return { kind: 'device', grants: intersectGrants(daemonWide, answer.standing.grants) };
      }
    }
  }

  /** The admin token off the host is governed by the daemon-wide half alone. */
  #governedViewer(): InventoryViewer {
    const daemonWide = this.deps.policy()?.grants;
    return daemonWide === undefined ? { kind: 'none' } : { kind: 'device', grants: daemonWide };
  }

  #device(principal: SessionPrincipal): DeviceAnswer {
    const provider = this.deps.devices();
    if (provider === undefined) return { kind: 'refused' };
    try {
      const standing = provider.standing(principal.holder, this.deps.now());
      if (standing === 'revoked') return { kind: 'refused' };
      if (standing === 'unknown') return { kind: 'undetermined' };
      return { kind: 'device', standing };
    } catch {
      return { kind: 'refused' };
    }
  }

  #authenticate(request: ApiRequest): Authentication {
    const principal = request.principal;
    if (principal !== undefined) {
      // A DEVICE IS WHOEVER ITS SESSION PROVED, while its provider still holds it. A session's call carries no
      // `authorization` of its own, so there is no second credential to disagree with it.
      if (principal.kind !== 'device') return { kind: 'anonymous' };
      return this.#device(principal).kind === 'refused'
        ? { kind: 'anonymous' }
        : { kind: 'authenticated', tokenClass: 'device', principal };
    }
    const bearer = bearerToken(headerValue(request, 'authorization'));
    const authentication = authenticate(this.deps.tokens(), this.deps.ferrets(), {
      ...(bearer === undefined ? {} : { bearer }),
      privilegedLocal: request.arrival.kind === 'local' && request.arrival.privileged,
    });
    // A warden token is honoured off this host only when `gate.yaml` says a remote warden is (G103).
    if (
      authentication.kind === 'authenticated' &&
      authentication.tokenClass === 'warden' &&
      !arrivedLocal(request) &&
      this.deps.policy()?.warden.remote !== true
    )
      return { kind: 'anonymous' };
    return authentication;
  }

  #authorize(
    descriptor: ScopedRoute,
    request: ApiRequest,
    params: RouteParameters,
    table?: 'route' | 'socket' | 'tool',
  ): AdmissionDecision {
    // A MEMBER IS REFUSED BY THE MAIN TABLE BEFORE ANYTHING ELSE, the public shortcut included.
    if (request.principal?.kind === 'member') return forbidden(request);
    if (servedPublicly(descriptor)) {
      if (descriptor.privilegedOnly === true && !(request.arrival.kind === 'local' && request.arrival.privileged))
        return forbidden(request);
      return { outcome: 'admitted', standing: {}, actor: 'owner-viewer' };
    }

    const authentication = this.#authenticate(request);
    if (authentication.kind === 'anonymous') return refused(UNAUTHORIZED());

    // A FERRET TOKEN NAMES ITS OWN FERRET, so a header naming any other one is a forged attribution.
    if (authentication.tokenClass === 'ferret') {
      const claimed = headerValue(request, SESSION_ID_HEADER)?.trim() ?? '';
      if (claimed !== '' && claimed !== authentication.ferret) {
        this.#refusedFerret({
          reason: 'session_mismatch',
          ferret: authentication.ferret,
          route: `${request.method} ${request.path}`,
        });
        return refused(
          errorResponse(
            401,
            `this ferret token names its own ferret, and ${SESSION_ID_HEADER} names a different one; drop the header — the daemon reads who you are from the token`,
            'session_mismatch',
          ),
        );
      }
    }

    // THE AGENT TOOL DOOR ACTS ONLY FOR THE FERRET ITS OWN TOKEN NAMES (S61, R-0246): the tool table is that door's, and
    // there a header cannot choose who the caller is, whatever other credential carries it.
    if (
      table === 'tool' &&
      authentication.tokenClass !== 'ferret' &&
      (headerValue(request, SESSION_ID_HEADER)?.trim() ?? '') !== ''
    )
      return refused(
        errorResponse(
          403,
          `the agent tools act for the ferret whose own token is presented; ${SESSION_ID_HEADER} cannot name one for any other credential`,
          'session_header_refused',
        ),
      );

    const actor = resolveApiActor({
      tokenClass: authentication.tokenClass,
      ...(authentication.tokenClass === 'device' ? { holder: authentication.principal.holder } : {}),
      ...(authentication.tokenClass === 'ferret'
        ? { ferret: authentication.ferret }
        : { ferret: headerValue(request, SESSION_ID_HEADER) }),
      client: headerValue(request, CLIENT_HEADER),
    });

    // A PERSON-ONLY ROUTE REFUSES AN AGENT HERE, before the minimum, any handler or any read of the body (G11).
    if (descriptor.caller !== 'any' && callerIsAgent(authentication, actor))
      return refused(
        errorResponse(
          403,
          `${ownerOnlyWords(`may use ${request.method} ${request.path}`)}${descriptor.ferretDoor === undefined ? '' : `; ${descriptor.ferretDoor}`}`,
          OWNER_ONLY_CODE,
        ),
      );

    // The OWNER is the host's admin token through the local listener, never a local peer on its own (G18).
    const admin = authentication.tokenClass === 'admin';
    const onHost = arrivedOnHost(request, admin);
    if (
      !meetsMinimum(authentication.tokenClass, descriptor.minimum) ||
      (descriptor.privilegedOnly === true && !arrivedPrivileged(request, admin))
    )
      return forbidden(request, 'the presented credential may not use');

    // THE PROVED DEVICE, as its provider answers for it now. A device whose record is gone is undetermined (G140).
    let device: DeviceHolderStanding | undefined;
    if (authentication.tokenClass === 'device') {
      const answer = this.#device(authentication.principal);
      if (answer.kind === 'refused') return refused(UNAUTHORIZED());
      if (answer.kind === 'undetermined')
        return refused(
          errorResponse(
            403,
            `this daemon cannot say what this device may do, so it is refusing; run \`${this.deps.clientName} device list\` on the host to see it`,
            grantRefusalCode('undetermined'),
          ),
        );
      device = answer.standing;
    }
    const policy = this.deps.policy();
    const subject: StepUpSubject | undefined =
      authentication.tokenClass === 'device'
        ? { deviceId: authentication.principal.holder, appSession: authentication.principal.session }
        : undefined;
    const now = this.deps.now();
    const unlocked = device?.unlockedUntil !== undefined && device.unlockedUntil > now;

    // A MACHINE THAT WANTS A PERSON ON OPENING serves a device nothing until one has confirmed (G74, R253).
    // An undetermined policy asks the stricter way.
    if (
      device !== undefined &&
      !onHost &&
      descriptor.unlockExempt !== true &&
      subject !== undefined &&
      (((policy === undefined || policy.security.unlockOnOpen) && !unlocked) ||
        this.deps.stepUps.unlockRequired(subject))
    )
      return refused(
        errorResponse(
          401,
          'this machine asks you to confirm it is you with a passkey before it shows anything',
          UNLOCK_REQUIRED_CODE,
        ),
      );

    // The witness answers whether this copy of the app holds a step-up: the unlock stands in for it unless the owner
    // asked for one per act (G47, G79). The SESSION's proven device, never a header's claim.
    const stepUp = subject !== undefined && this.deps.stepUps.held(subject);
    const presentation: CapabilityPresentation = {
      // The CARRIER's proof, never a header's. A ferret's own token is on the host too, and is looked up only for a
      // call on the privileged local listener, so grants never govern it.
      local: onHost || authentication.tokenClass === 'ferret',
      adminToken: admin,
      actor,
      stepUp,
      freshStepUp: subject !== undefined && this.deps.stepUps.freshlyHeld(subject),
      ...(device === undefined ? {} : { deviceGrants: device.grants }),
    };

    const demand = descriptor.capability;
    let governance: CallerGovernance | undefined;
    if (demand !== undefined) {
      const decision = this.#guard.decide(demand, presentation);
      if (!decision.allowed) {
        const message = this.#guard.explain(demand, decision.refusal);
        return refused(
          decision.refusal === 'step-up-required'
            ? jsonResponse(
                {
                  error: message,
                  code: STEP_UP_REQUIRED_CODE,
                  demand: { capability: demand.capability, axis: demand.axis },
                } as unknown as StepUpRequiredBody,
                403,
              )
            : errorResponse(403, message, grantRefusalCode(decision.refusal)),
        );
      }
      // A step-up the machine wants asked every time is good for this one act (G97): spent at the decision.
      if (decision.steppedUp === true && subject !== undefined) this.deps.stepUps.spend(subject);
      governance = this.#guard.governance(presentation);
    } else if (descriptor.consultsGrants === true) {
      governance = this.#guard.governance(presentation);
    }

    const remedy = this.#wardenRemedy(descriptor, authentication, request, params, actor);
    if (remedy.kind === 'refused') return refused(remedy.response);

    const standing: CallStanding = {
      actor,
      credential: authentication,
      ...(remedy.kind === 'granted' ? { wardenRemedy: remedy.grant } : {}),
      ...(governance === undefined ? {} : { governance }),
      presentation,
      spendStepUp: () => {
        if (subject !== undefined) this.deps.stepUps.spend(subject);
      },
      spendFreshStepUp: () => {
        if (subject !== undefined) this.deps.stepUps.spendFresh(subject);
      },
      claimFreshStepUp: this.#claimFresh(subject),
      claimStoredProof: this.#claimStored(subject),
    };
    return { outcome: 'admitted', standing, actor: actOf(authentication, actor) };
  }

  /** A route's claim on the caller's fresh proof: a caller with no proved device holds none and is answered `false`. */
  #claimFresh(subject: StepUpSubject | undefined): ClaimFreshStepUp {
    const registry = this.deps.stepUps;
    return ((act?: StepUpAct, bound?: string): boolean => {
      if (subject === undefined) return false;
      if (act !== undefined && !stepUpSkippableAtMachine(act))
        return (
          bound !== undefined &&
          bound !== '' &&
          !stepUpKeepsProof(act) &&
          registry.claimFresh(subject, act as Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>, bound)
        );
      return registry.claimFresh(subject, act as MachineSkippableStepUpAct | undefined);
    }) as ClaimFreshStepUp;
  }

  /** A route's claim on the caller's KEPT proof: only a stored-proof act, with its own kind of stage. */
  #claimStored(subject: StepUpSubject | undefined): ClaimStoredProof {
    const registry = this.deps.stepUps;
    return ((act: StoredProofStepUpAct, stage: string, expectedChallenge: Uint8Array) => {
      if (subject === undefined || !stepUpKeepsProof(act)) return undefined;
      const parsed = STEP_UP_SUBJECTS[act as string as 'approve-sign-in-rule'].safeParse(stage);
      if (!parsed.success || !(expectedChallenge instanceof Uint8Array)) return undefined;
      return registry.claimStoredProof(
        subject,
        act,
        parsed.data as StepUpSubjectOf<StoredProofStepUpAct>,
        expectedChallenge,
      );
    }) as ClaimStoredProof;
  }

  #refusedFerret(refusal: FerretTokenRefusal): void {
    try {
      this.deps.refused({
        event: AUDIT_KINDS['ferret.credential-refused'],
        actor: { kind: 'host' },
        subject: refusal.ferret,
        outcome: 'refused',
        detail: { reason: refusal.reason, route: refusal.route.slice(0, 160) },
      });
    } catch {
      // The audit log reports its own failures; a refusal is answered either way.
    }
  }

  /**
   * The ADMINISTRATOR's answer, asked last and only of a warden (today's `wardenRemedyOutcome`, verbatim in order).
   * The token class decides who is subject to this question; the header can neither promote a caller into it nor
   * excuse one out of the checks above it.
   */
  #wardenRemedy(
    route: ScopedRoute,
    authentication: Authentication,
    request: ApiRequest,
    params: RouteParameters,
    actor: ApiActor,
  ): WardenRemedyOutcome {
    if (authentication.kind !== 'authenticated' || authentication.tokenClass !== 'warden') return { kind: 'absent' };
    const capability = headerValue(request, WARDEN_CAPABILITY_HEADER)?.trim() ?? '';
    const declared = route.wardenRemedy;
    if (declared === undefined) {
      if (capability === '') return { kind: 'absent' };
      return remedyRefusal(
        `${request.method} ${request.path} declares no warden remedy, so a warden capability cannot authorize it; drop ${WARDEN_CAPABILITY_HEADER} and use a credential that may reach this route on its own`,
        'warden_remedy_undeclared',
      );
    }
    const remedy = declared.trim();
    if (remedy === '')
      return remedyRefusal(
        `${request.method} ${request.path} declares a blank warden remedy, so this daemon cannot say what a warden would be doing here and is refusing; the route must name the remedy it means`,
        'warden_remedy_invalid',
      );
    if (capability === '')
      return remedyRefusal(
        `a warden may ${remedy} here only by presenting the capability of the assignment it was given, in ${WARDEN_CAPABILITY_HEADER}`,
        'warden_capability_required',
      );
    const remedies = this.deps.remedies?.();
    if (remedies === undefined)
      return remedyRefusal(
        `this daemon was built with no warden remedy authorizer, so it cannot say whether a warden may ${remedy} here and is refusing; the route declares a remedy and the boundary serving it must be wired with one`,
        'warden_remedy_unwired',
      );
    let decision: WardenRemedyDecision | undefined;
    try {
      decision = remedies.decide({ remedy: declared, params, capability, actor });
    } catch {
      decision = undefined;
    }
    if (decision === undefined || (!decision.allowed && decision.refusal.trim() === '') || unusable(decision, remedy))
      return remedyRefusal(
        `this daemon reached no decision about whether a warden may ${remedy} here, so it is refusing; an administrator must allow this remedy for the assignment that was given`,
        'warden_remedy_undetermined',
      );
    return decision.allowed
      ? { kind: 'granted', grant: decision.grant }
      : remedyRefusal(decision.refusal.trim(), 'warden_remedy_refused');
  }
}

type WardenRemedyOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'granted'; readonly grant: WardenRemedyGrant }
  | { readonly kind: 'refused'; readonly response: ApiResponse };

const remedyRefusal = (message: string, code: string): WardenRemedyOutcome => ({
  kind: 'refused',
  response: errorResponse(403, message, code),
});

/** An allowance too damaged to act on: a blank field, or a remedy that disagrees with the route's. */
function unusable(decision: WardenRemedyDecision, remedy: string): boolean {
  if (!decision.allowed) return false;
  const { grant } = decision;
  return (
    grant.remedy !== remedy ||
    (grant.targetFerret as string).trim() === '' ||
    (grant.wardenId as string).trim() === '' ||
    (grant.assignmentStartedAt as string).trim() === ''
  );
}
