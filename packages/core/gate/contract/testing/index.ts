/**
 * `@ferretry/core-gate/contract/testing` (§7.8): Gate's fakes and conformance suites. Access and Catalogs run their
 * `credentials` and `step-up` values through the suites below; the fakes pass the same suites (tests/unit).
 */
import { describe, expect, test } from 'bun:test';
import {
  type Admission,
  type AdmissionDecision,
  type AdmissionInput,
  type ApiRequest,
  arrivedPrivileged,
  type CallStanding,
  errorResponse,
  type FerretId,
  type HolderId,
  type MemberStanding,
  type PolicyRef,
  type ScopedRoute,
  type SessionId,
  type SessionPrincipal,
} from '@ferretry/kernel/contract';
import { addDuration, type Instant, instantFromEpochMs, minutes } from '@ferretry/std';
import type { AuditDraft } from '../audit.ts';
import type {
  BearerDigest,
  CredentialProvider,
  DeviceHolderStanding,
  FerretBearerDirectory,
  HolderStanding,
  PasskeyDescriptor,
  StepUpCeremony,
  StepUpVerified,
  StepUpWitness,
} from '../credentials.ts';
import { asksStepUpPerAction, DEFAULT_GATE_CONFIG, type GateConfig } from '../gate-config.ts';
import {
  type CapabilityGrants,
  coreCapabilityName,
  FULL_DEVICE_GRANTS,
  grantRefusalCode,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  STEP_UP_REQUIRED_CODE,
  STEP_UP_USE_CAPABILITIES,
} from '../policy.ts';
import type { GateApi } from '../port.ts';
import { callerIsAgent, deviceActor, ferretActor, wardenActor } from '../standing.ts';

/** 2026-11-07T12:00:00Z. */
export const T0: Instant = instantFromEpochMs(1_794_052_800_000);
export const holder = (id: string): HolderId => id as HolderId;

// ─── fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An in-memory device provider: enrol, revoke, narrow, unlock. Generation bumps on every change. */
export class FakeDeviceProvider implements CredentialProvider<DeviceHolderStanding> {
  #generation = 0;
  readonly #holders = new Map<string, DeviceHolderStanding | 'revoked'>();

  enrol(id: HolderId, grants: CapabilityGrants = FULL_DEVICE_GRANTS, unlockedUntil?: Instant): void {
    this.#holders.set(id, {
      kind: 'device',
      holder: id,
      grants,
      ...(unlockedUntil === undefined ? {} : { unlockedUntil }),
    });
    this.#generation += 1;
  }
  revoke(id: HolderId): void {
    this.#holders.set(id, 'revoked');
    this.#generation += 1;
  }
  narrow(id: HolderId, grants: CapabilityGrants): void {
    const current = this.#holders.get(id);
    if (current === undefined || current === 'revoked') return;
    this.#holders.set(id, { ...current, grants });
    this.#generation += 1;
  }
  unlock(id: HolderId, until: Instant): void {
    const current = this.#holders.get(id);
    if (current === undefined || current === 'revoked') return;
    this.#holders.set(id, { ...current, unlockedUntil: until });
    this.#generation += 1;
  }
  standing(id: HolderId): DeviceHolderStanding | 'unknown' | 'revoked' {
    return this.#holders.get(id) ?? 'unknown';
  }
  generation(): number {
    return this.#generation;
  }
}

/** A witness that verifies an assertion whose signature is `ok-<holder>` for an enrolled holder. Never a real key. */
export class FakeStepUpWitness implements StepUpWitness {
  readonly #passkeys = new Map<string, readonly PasskeyDescriptor[]>();

  register(id: HolderId, credentialId = `cred${id.replaceAll(/[^A-Za-z0-9]/gu, '')}`): void {
    this.#passkeys.set(id, [{ type: 'public-key', id: credentialId }]);
  }
  passkeys(id: HolderId): readonly PasskeyDescriptor[] | 'unknown' {
    return this.#passkeys.get(id) ?? 'unknown';
  }
  async verify(
    ceremony: StepUpCeremony,
  ): Promise<StepUpVerified | { readonly refused: 'not-verified' | 'no-passkey' }> {
    const known = this.#passkeys.get(ceremony.holder);
    if (known === undefined) return { refused: 'no-passkey' };
    const ownKey = known.some(key => key.id === ceremony.assertion.credentialId);
    if (!ownKey || ceremony.assertion.signature !== `ok-${ceremony.holder}`.replaceAll(/[^A-Za-z0-9_-]/gu, ''))
      return { refused: 'not-verified' };
    return {
      holder: ceremony.holder,
      ...(ceremony.act === undefined ? {} : { act: ceremony.act }),
      ...(ceremony.subject === undefined ? {} : { subject: ceremony.subject }),
      provedAt: ceremony.now,
    };
  }
}

/** The signature `FakeStepUpWitness` accepts for a holder (base64url-safe). */
export const fakeSignature = (id: HolderId): string => `ok-${id}`.replaceAll(/[^A-Za-z0-9_-]/gu, '');

/** A ferret bearer directory over digests. */
export class FakeFerretBearers implements FerretBearerDirectory {
  #generation = 0;
  readonly #byDigest = new Map<string, FerretId>();
  issue(digest: string, ferret: FerretId): void {
    this.#byDigest.set(digest, ferret);
    this.#generation += 1;
  }
  revoke(digest: string): void {
    this.#byDigest.delete(digest);
    this.#generation += 1;
  }
  ferretFor(digest: BearerDigest): FerretId | undefined {
    return this.#byDigest.get(digest);
  }
  generation(): number {
    return this.#generation;
  }
}

/** Gate's port as a recorder: every audit draft, and a settable policy (`undefined` = undetermined). */
export class FakeGate implements GateApi {
  readonly audits: AuditDraft[] = [];
  #policy: GateConfig | undefined = DEFAULT_GATE_CONFIG;
  async audit(draft: AuditDraft): Promise<void> {
    this.audits.push(draft);
  }
  policy(): GateConfig | undefined {
    return this.#policy;
  }
  setPolicy(policy: GateConfig | undefined): void {
    this.#policy = policy;
  }
}

// ─── standings for handler tests ──────────────────────────────────────────────────────────────────────────────────

const noStepUp = {
  claimFreshStepUp: (() => false) as CallStanding['claimFreshStepUp'],
  claimStoredProof: () => undefined,
};

/** The owner at the machine: the admin token, local, ungoverned. */
export function ownerStanding(client: 'ui' | 'cli' = 'cli'): CallStanding {
  const actor = client === 'cli' ? 'admin-cli' : 'admin-ui';
  return {
    actor,
    credential: { kind: 'authenticated', tokenClass: 'admin' },
    presentation: { local: true, adminToken: true, actor, stepUp: false },
    governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) },
    spendStepUp: () => undefined,
    spendFreshStepUp: () => undefined,
    ...noStepUp,
  };
}

/** A ferret's own `fys_` token. */
export function ferretStanding(ferret: FerretId): CallStanding {
  const actor = ferretActor(ferret);
  return {
    actor,
    credential: { kind: 'authenticated', tokenClass: 'ferret', ferret },
    presentation: { local: true, adminToken: false, actor, stepUp: false },
    ...noStepUp,
  };
}

/** A paired device on a sealed session, with its effective grants. */
export function deviceStanding(
  device: string,
  grants: CapabilityGrants = FULL_DEVICE_GRANTS,
  stepUp = false,
): CallStanding {
  const principal: SessionPrincipal = {
    kind: 'device',
    holder: device as HolderId,
    session: `s-${device}` as SessionId,
    leaseUntil: addDuration(T0, minutes(15)),
  };
  const actor = deviceActor(device);
  return {
    actor,
    credential: { kind: 'authenticated', tokenClass: 'device', principal },
    presentation: { local: false, adminToken: false, actor, stepUp, deviceGrants: grants },
    spendStepUp: () => undefined,
    spendFreshStepUp: () => undefined,
    ...noStepUp,
  };
}

/** The warden token, acting for one warden ferret. */
export function wardenStanding(warden: FerretId, remedy?: PolicyRef<'remedy'>, target?: FerretId): CallStanding {
  const actor = wardenActor(warden);
  return {
    actor,
    credential: { kind: 'authenticated', tokenClass: 'warden' },
    presentation: { local: false, adminToken: false, actor, stepUp: false },
    ...(remedy === undefined || target === undefined
      ? {}
      : { wardenRemedy: { remedy, targetFerret: target, wardenId: warden, assignmentStartedAt: T0 } }),
    ...noStepUp,
  };
}

// ─── conformance suites ───────────────────────────────────────────────────────────────────────────────────────────

/** What a `credentials` provider under test must let the suite do. */
export interface CredentialProviderSubject<S extends HolderStanding = HolderStanding> {
  readonly provider: CredentialProvider<S>;
  /** Enrols a fresh holder the provider will answer for; returns its id. */
  enrol(): HolderId | Promise<HolderId>;
  revoke(id: HolderId): void | Promise<void>;
  /** Narrows the holder's grants (devices) or catalogs (members). */
  narrow?(id: HolderId): void | Promise<void>;
}

const SECRET_FIELD = /token|digest|secret|password|key$/iu;

/**
 * The `credentials` conformance suite (§4.13, §7.1): synchronous and memory-only, `unknown` for a holder it never
 * enrolled, `revoked` after a revoke, generation bumps on revoke and narrowing, and no secret-shaped field.
 */
export function credentialProviderConformance<S extends HolderStanding>(
  name: string,
  make: () => CredentialProviderSubject<S> | Promise<CredentialProviderSubject<S>>,
): void {
  describe(`credentials conformance: ${name}`, () => {
    test('a holder it never enrolled is unknown', async () => {
      const subject = await make();
      expect(subject.provider.standing(holder('never-enrolled'), T0)).toBe('unknown');
    });
    test('standing is synchronous and names the holder', async () => {
      const subject = await make();
      const id = await subject.enrol();
      const standing = subject.provider.standing(id, T0);
      expect(standing instanceof Promise).toBe(false);
      expect(typeof standing === 'object' && standing.holder).toBe(id);
    });
    test('a standing carries no token, digest or key', async () => {
      const subject = await make();
      const standing = subject.provider.standing(await subject.enrol(), T0);
      if (typeof standing !== 'object') throw new Error('expected a standing');
      for (const field of Object.keys(standing)) expect(SECRET_FIELD.test(field)).toBe(false);
    });
    test('a revoke reads as revoked and bumps the generation', async () => {
      const subject = await make();
      const id = await subject.enrol();
      const before = subject.provider.generation();
      await subject.revoke(id);
      expect(subject.provider.standing(id, T0)).toBe('revoked');
      expect(subject.provider.generation()).toBeGreaterThan(before);
    });
    test('a narrowing bumps the generation', async () => {
      const subject = await make();
      if (subject.narrow === undefined) return;
      const id = await subject.enrol();
      const before = subject.provider.generation();
      await subject.narrow(id);
      expect(subject.provider.generation()).toBeGreaterThan(before);
    });
  });
}

export interface StepUpWitnessSubject {
  readonly witness: StepUpWitness;
  /** Enrols a holder with one passkey; returns it and an assertion that verifies for it. */
  enrol(): Promise<{ readonly holder: HolderId; readonly good: StepUpCeremony['assertion'] }>;
}

/** The `step-up` conformance suite: unknown holders, a bad assertion refused, a good one bound to the act asked. */
export function stepUpWitnessConformance(
  name: string,
  make: () => StepUpWitnessSubject | Promise<StepUpWitnessSubject>,
): void {
  const challenge = new Uint8Array([1, 2, 3, 4]);
  describe(`step-up conformance: ${name}`, () => {
    test('a holder it never enrolled has no passkeys to offer', async () => {
      const subject = await make();
      expect(subject.witness.passkeys(holder('never-enrolled'), 'https://app.example.test')).toBe('unknown');
    });
    test('an assertion that does not check out is refused', async () => {
      const subject = await make();
      const { holder: id, good } = await subject.enrol();
      const answer = await subject.witness.verify({
        holder: id,
        origin: 'https://app.example.test',
        challenge,
        assertion: { ...good, signature: 'forged' },
        now: T0,
      });
      expect('refused' in answer).toBe(true);
    });
    test('a verified ceremony is bound to the holder, the act and the subject asked', async () => {
      const subject = await make();
      const { holder: id, good } = await subject.enrol();
      const act = 'add-2fa-key' as never;
      const answer = await subject.witness.verify({
        holder: id,
        origin: 'https://app.example.test',
        challenge,
        assertion: good,
        act,
        subject: 'st_0123456789abcdef01234567',
        now: T0,
      });
      expect(answer).toMatchObject({ holder: id, act, subject: 'st_0123456789abcdef01234567' });
    });
  });
}

// ─── a stand-in admission ─────────────────────────────────────────────────────────────────────────────────────────

/** Today's `meetsMinimum`, verbatim in meaning. */
function meetsMinimum(credential: CallStanding['credential'], minimum: ScopedRoute['minimum']): boolean {
  switch (minimum) {
    case 'none':
    case 'authenticated':
      return true;
    case 'operator':
      return credential?.tokenClass !== 'warden';
    case 'admin-token':
      return credential?.tokenClass === 'admin';
  }
}

/**
 * A stand-in `Admission` for test hosts and handler tests, in today's boundary order: person-or-ferret, credential
 * minimum, privileged arrival, capability (daemon-wide ∧ device, with today's step-up rule), warden remedy. The
 * standing comes from `standingFor` (a test decides who is calling); it is NOT Gate: no bearer is checked, no unlock,
 * no stream re-admission. The real Gate passes `@ferretry/kernel/testing`'s descriptor suites; this does not claim to.
 */
export class StandInAdmission implements Admission {
  constructor(
    private readonly standingFor: (request: ApiRequest) => CallStanding | undefined,
    private readonly policy: () => GateConfig | undefined = () => DEFAULT_GATE_CONFIG,
  ) {}

  admit(input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }): AdmissionDecision {
    const { descriptor, request } = input;
    const standing = this.standingFor(request);
    if (standing === undefined)
      return descriptor.minimum === 'none' && descriptor.wardenRemedy === undefined
        ? { outcome: 'admitted', standing: {} }
        : { outcome: 'refused', response: errorResponse(401, 'this call needs a credential', 'unauthorized') };
    if (descriptor.caller === 'person' && callerIsAgent(standing.credential, standing.actor))
      return {
        outcome: 'refused',
        response: errorResponse(403, ownerOnlyWords(`may use ${request.method} ${request.path}`), OWNER_ONLY_CODE),
      };
    const admin = standing.credential?.tokenClass === 'admin';
    if (
      !meetsMinimum(standing.credential, descriptor.minimum) ||
      (descriptor.privilegedOnly === true && !arrivedPrivileged(request, admin))
    )
      return {
        outcome: 'refused',
        response: errorResponse(
          403,
          `the presented credential may not use ${request.method} ${request.path}`,
          'forbidden',
        ),
      };
    const demand = descriptor.capability;
    // Ungoverned: the admin token on the host, and a ferret's own token (today's `loopback` presentation).
    if (demand !== undefined && standing.presentation?.local !== true) {
      const name = coreCapabilityName(demand.capability);
      const policy = this.policy();
      const device = standing.presentation?.deviceGrants;
      const daemonWide = name === undefined || policy === undefined ? undefined : policy.grants[name];
      const own = name === undefined || device === undefined || device === null ? undefined : device[name];
      const refusal =
        daemonWide === undefined || device === null
          ? 'undetermined'
          : !daemonWide.use || (demand.axis === 'configure' && !daemonWide.configure)
            ? 'not-granted'
            : own !== undefined && (!own.use || (demand.axis === 'configure' && !own.configure))
              ? 'device-not-granted'
              : undefined;
      if (refusal !== undefined)
        return { outcome: 'refused', response: errorResponse(403, refusal, grantRefusalCode(refusal)) };
      const needsStepUp =
        demand.narrowing !== true &&
        (demand.axis === 'configure' || (name !== undefined && STEP_UP_USE_CAPABILITIES.includes(name)));
      if (
        needsStepUp &&
        standing.presentation?.stepUp !== true &&
        (policy === undefined || asksStepUpPerAction(policy.security))
      )
        return {
          outcome: 'refused',
          response: errorResponse(403, 'needs a passkey confirmation', STEP_UP_REQUIRED_CODE),
        };
    }
    return { outcome: 'admitted', standing };
  }

  admitMember(): AdmissionDecision<MemberStanding> {
    return {
      outcome: 'refused',
      response: errorResponse(403, 'the stand-in admission serves no member routes', 'forbidden'),
    };
  }

  readmit(): boolean {
    return true;
  }
}
