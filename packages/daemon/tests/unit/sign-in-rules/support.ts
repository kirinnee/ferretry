import type {
  AccountId,
  AccountSummary,
  AuditActor,
  AuditDetail,
  LoginObserved,
  SignInId,
  SignInRuleDraft,
  SignInRuleStageId,
  SignInRulesDocument,
  SignInSummary,
  StoredStepUpProof,
  TwoFactorKeySummary,
} from '@ferretry/protocol';
import type { PasteRuleCaller } from '../../../src/lib/secure-copy/rules.ts';
import type { RuleListing, SignInRuleProofPort, SignInRuleStore } from '../../../src/lib/sign-in-rules/index.ts';
import { SignInRuleService } from '../../../src/lib/sign-in-rules/index.ts';

/** A standing-rule world over fakes: the store, the listing, the registry and the clock are the test's. */

export const NOW = Date.parse('2026-11-01T12:00:00.000Z');
export const DEVICE = `fy_device_id_${'a'.repeat(22)}`;
export const OTHER_DEVICE = `fy_device_id_${'b'.repeat(22)}`;
export const CREDENTIAL = 'Y3JlZGVudGlhbC0x';
export const KEY = `L${'A'.repeat(24)}`;
export const OTHER_KEY = `L${'B'.repeat(24)}`;
export const GITHUB = 'si_00000000000000a1' as SignInId;
export const SUDO = 'si_00000000000000a2' as SignInId;
export const VIA_GOOGLE = 'si_00000000000000a3' as SignInId;
export const UNTAPPED = 'si_00000000000000a4' as SignInId;
const IDENTITY = '0123456789abcdef';
export const USERNAME = 'kirin-UNIQUE-username';
export const T = '2026-10-01T00:00:00.000Z';

export const HOST_OWNER: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
export const deviceOwner = (deviceId = DEVICE): PasteRuleCaller => ({
  kind: 'owner',
  actor: { kind: 'device', deviceId },
});
export const AGENT: PasteRuleCaller = { kind: 'agent' };

const flag = (value: boolean, count: number) => ({ value, observedAt: T, count });

/** What the owner's own taps leave at a place: masked, moved on, tapped `taps` times in a row. */
export const tappedFact = (at: string, taps = 2, identity = IDENTITY): LoginObserved => ({
  at,
  surface: 'page',
  identity,
  since: T,
  masked: flag(true, taps),
  navigatedAway: flag(true, taps),
  tapped: flag(true, taps),
});

export const totpKey = (id: string, addedAt: string, verified?: boolean): TwoFactorKeySummary =>
  ({
    id,
    kind: 'totp',
    label: `key ${id}`,
    addedAt,
    automatic: true,
    params: { algorithm: 'SHA1', digits: 6, period: 30 },
    ...(verified === undefined ? {} : { verified: { worked: verified, at: T } }),
  }) as unknown as TwoFactorKeySummary;

export const account = (overrides: Partial<AccountSummary> = {}): AccountSummary =>
  ({
    id: 'GITHUB_WORK' as AccountId,
    label: 'GitHub work',
    username: USERNAME,
    fields: { password: true, totp: false },
    factors: [],
    signIns: [],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }) as unknown as AccountSummary;

export const signIn = (overrides: Partial<SignInSummary> = {}): SignInSummary =>
  ({
    id: GITHUB,
    account: 'GITHUB_WORK',
    place: { kind: 'site', domains: ['github.com'], match: [] },
    method: { kind: 'password' },
    observed: [tappedFact('github.com')],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }) as unknown as SignInSummary;

/** GitHub (eligible), sudo on kirin-box, a sign-in via Google, and one the owner never tapped in. */
export const listing = (): { accounts: AccountSummary[]; signIns: SignInSummary[]; keys: Map<string, string> } => ({
  accounts: [account(), account({ id: 'SUDO' as AccountId, label: 'sudo', username: undefined } as never)],
  signIns: [
    signIn(),
    signIn({
      id: SUDO,
      account: 'SUDO' as AccountId,
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
      observed: [{ ...tappedFact('sudo@kirin-box'), surface: 'terminal' }],
    } as never),
    signIn({ id: VIA_GOOGLE, method: { kind: 'google', via: 'GOOGLE' as AccountId } } as never),
    signIn({ id: UNTAPPED, place: { kind: 'site', domains: ['gitlab.com'], match: [] }, observed: [] } as never),
  ],
  keys: new Map([
    ['GITHUB_WORK', KEY],
    ['SUDO', OTHER_KEY],
  ]),
});

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * THE ASSERTION A PASSKEY WOULD MAKE over `challenge`, as the fake registry checks it: the "signature" is the challenge
 * itself, so evidence over other bytes never verifies, exactly the property the real signature gives.
 */
export const evidenceFor = (challenge: Uint8Array, deviceId = DEVICE): StoredStepUpProof => ({
  deviceId,
  credentialId: CREDENTIAL,
  clientDataJSON: b64(new TextEncoder().encode('client-data')),
  authenticatorData: b64(new TextEncoder().encode('authenticator-data')),
  signature: b64(challenge),
});

/** The registry: which devices hold which credential, and the offline check. */
export class FakeProofs implements SignInRuleProofPort {
  readonly held = new Set<string>([`${DEVICE}:${CREDENTIAL}`, `${OTHER_DEVICE}:${CREDENTIAL}`]);
  broken = false;
  checks = 0;

  async holds(deviceId: string, credentialId: string): Promise<boolean> {
    if (this.broken) throw new Error('the passkey registry cannot be read');
    return this.held.has(`${deviceId}:${credentialId}`);
  }

  async verify(proof: StoredStepUpProof, expectedChallenge: Uint8Array): Promise<boolean> {
    this.checks += 1;
    if (this.broken) throw new Error('the passkey registry cannot be read');
    return this.held.has(`${proof.deviceId}:${proof.credentialId}`) && proof.signature === b64(expectedChallenge);
  }
}

/** The rules file in memory: what was written, how often, and whether the next read or write fails. */
export class MemoryRuleStore implements SignInRuleStore {
  document: SignInRulesDocument | undefined;
  writes = 0;
  failWrites = false;
  damaged: string | undefined;
  readonly setAsides: string[] = [];

  async read(): Promise<SignInRulesDocument | undefined> {
    if (this.damaged !== undefined) throw new Error(`the document does not parse: ${this.damaged}`);
    return this.document === undefined ? undefined : structuredClone(this.document);
  }

  async write(document: SignInRulesDocument): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    this.writes += 1;
    this.damaged = undefined;
    this.document = structuredClone(document);
  }

  async setAside(stamp: string): Promise<void> {
    this.setAsides.push(stamp);
  }
}

interface AuditLine {
  readonly actor: AuditActor;
  readonly subject?: string | undefined;
  readonly outcome: string;
  readonly detail?: AuditDetail | undefined;
  readonly cause?: string | undefined;
}

export interface WorldOptions {
  readonly store?: MemoryRuleStore;
  readonly proofs?: FakeProofs;
  readonly passkeys?: boolean;
  /** Whether the device asking holds a passkey (`of`), when it differs from whether any device does. */
  readonly devicePasskeys?: boolean;
  readonly listing?: RuleListing;
  /** The device names, as pairing answers them; it may act on the service (an idle device revoked while it is read). */
  readonly label?: (deviceId: string, service: SignInRuleService) => Promise<string | undefined>;
  /** `false`: the service is handed back before it read its file, as at boot. */
  readonly load?: boolean;
  /** The stage's nonce, as the system CSPRNG would draw it; a test may hand a broken one. */
  readonly nonce?: () => string;
}

export async function world(options: WorldOptions = {}) {
  const clock = { now: NOW };
  const store = options.store ?? new MemoryRuleStore();
  const proofs = options.proofs ?? new FakeProofs();
  const audits: AuditLine[] = [];
  const warnings: string[] = [];
  const state = { listing: options.listing ?? (listing() as RuleListing), listingBroken: false };
  let ids = 0;
  const service = new SignInRuleService({
    store,
    accounts: {
      listing: async () => {
        if (state.listingBroken) throw new Error('the accounts cannot be read');
        return state.listing;
      },
    },
    proofs,
    passkeys: {
      any: async () => options.passkeys !== false,
      of: async () => (options.devicePasskeys ?? options.passkeys) !== false,
    },
    devices: {
      label: async deviceId =>
        options.label === undefined
          ? deviceId === DEVICE
            ? 'Pixel 9'
            : undefined
          : await options.label(deviceId, service),
    },
    audit: { record: async entry => void audits.push(entry) },
    clock: { now: () => clock.now },
    ids: {
      ruleId: () => `sr_${(++ids).toString(16).padStart(24, '0')}`,
      stageId: () => `srs_${(++ids).toString(16).padStart(24, '0')}` as SignInRuleStageId,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    },
    warn: message => void warnings.push(message),
  });
  if (options.load !== false) await service.load();
  return { service, store, proofs, audits, clock, state, warnings };
}

export type World = Awaited<ReturnType<typeof world>>;

export const DRAFT: SignInRuleDraft = { signIn: GITHUB, fields: ['username', 'password'] };

/** Stages a rule from `caller` and approves it with the passkey of `deviceId`, as the app would. */
export async function approved(
  w: World,
  draft: SignInRuleDraft = DRAFT,
  caller: PasteRuleCaller = deviceOwner(),
  deviceId = DEVICE,
) {
  const staged = await w.service.stage(caller, draft);
  if (caller.kind === 'owner' && caller.actor.kind === 'host') {
    w.service.confirmInApp(caller, staged.stage);
    await w.service.bind(deviceOwner(deviceId), staged.stage);
  }
  const challenge = w.service.challengeOf(staged.stage, deviceId);
  if (challenge === undefined) throw new Error('no challenge for that device');
  const committer = caller.kind === 'owner' && caller.actor.kind === 'host' ? deviceOwner(deviceId) : caller;
  const view = await w.service.commit(committer, staged.stage, expected =>
    Buffer.from(expected).equals(Buffer.from(challenge)) ? evidenceFor(challenge, deviceId) : undefined,
  );
  return { staged, view, challenge };
}

/** The audit actions written, in order. */
export const actions = (w: World): readonly unknown[] => w.audits.map(line => line.detail?.['action']);
