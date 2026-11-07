import { type CapabilityAxis, type PolicyRef, policyRef } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * Gate's policy vocabulary (§7.1). The kernel carries `PolicyRef`s and never interprets them; this file is where the
 * core names live. A plugin adds its own entries (a capability per tool, a remedy per warden action, an audit kind)
 * through its own contract with `policyRef`, reviewed with that plugin. Copied from today's
 * `protocol/src/lib/grants.ts` and `step-up.ts`, field for field, with the names turned into refs.
 */

// ─── capabilities ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The capabilities the operator is asked about (today's `DAEMON_CAPABILITIES`, unchanged and in order). */
export const CAPABILITY_NAMES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** A capability ref whose literal name is kept, so a lookup in a grant set is typed. */
export type CapabilityRef<N extends CapabilityName = CapabilityName> = PolicyRef<'capability'> & N;

const capability = <const N extends CapabilityName>(name: N): CapabilityRef<N> =>
  policyRef('capability', name) as CapabilityRef<N>;

/** The core capability refs a descriptor's `capability.capability` names. */
export const CAPABILITIES = {
  fleet: capability('fleet'),
  terminal: capability('terminal'),
  browser: capability('browser'),
  filesystem: capability('filesystem'),
  warden: capability('warden'),
  pairing: capability('pairing'),
  secrets: capability('secrets'),
  sharing: capability('sharing'),
} as const satisfies { readonly [K in CapabilityName]: CapabilityRef<K> };

export const CapabilityNameSchema = z.enum(CAPABILITY_NAMES);


/** The core capability a ref names, or `undefined` for one Gate does not know (fail closed: `undetermined`). */
export function coreCapabilityName(ref: PolicyRef<'capability'>): CapabilityName | undefined {
  return (CAPABILITY_NAMES as readonly string[]).includes(ref) ? (ref as string as CapabilityName) : undefined;
}

export const CAPABILITY_AXES = ['use', 'configure'] as const satisfies readonly CapabilityAxis[];
export const CapabilityAxisSchema = z.enum(CAPABILITY_AXES);

/** One capability's two axes (today's `CapabilityGrant`). */
export const CapabilityGrantSchema = z.strictObject({ use: z.boolean(), configure: z.boolean() });
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/** A full grant set: every capability named, nothing else (today's `CapabilityGrantsSchema`). */
export const CapabilityGrantsSchema = z.strictObject(
  Object.fromEntries(CAPABILITY_NAMES.map(name => [name, CapabilityGrantSchema])) as {
    readonly [K in CapabilityName]: typeof CapabilityGrantSchema;
  },
);
export type CapabilityGrants = z.infer<typeof CapabilityGrantsSchema>;

/**
 * A grant set as STORED: a capability the document does not name reads as not granted (today's
 * `ReadCapabilityGrantsSchema`), so a file written before a capability existed never grants it by silence.
 */
export const ReadCapabilityGrantsSchema = z.preprocess(raw => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const given = raw as Record<string, unknown>;
  return Object.fromEntries(
    CAPABILITY_NAMES.map(name => [name, name in given ? given[name] : { use: false, configure: false }]),
  );
}, CapabilityGrantsSchema);

const grantsWhere = (grant: (name: CapabilityName) => CapabilityGrant): CapabilityGrants =>
  Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map(name => [name, grant(name)])) as CapabilityGrants);

/** Today's daemon-wide default: everything granted; the owner narrows (docs/grants.md, permissive by default). */
export const DEFAULT_CAPABILITY_GRANTS: CapabilityGrants = grantsWhere(() => ({ use: true, configure: true }));
/** A limited device: the fleet to use, nothing else (today's `LIMITED_DEVICE_GRANTS`). */
export const LIMITED_DEVICE_GRANTS: CapabilityGrants = grantsWhere(name => ({
  use: name === 'fleet',
  configure: false,
}));
/** A device with everything (today's `FULL_DEVICE_GRANTS`). */
export const FULL_DEVICE_GRANTS: CapabilityGrants = grantsWhere(() => ({ use: true, configure: true }));

/** Why a governed call was refused, as one closed set (today's `GRANT_REFUSALS`). */
export const GRANT_REFUSALS = [
  'granted',
  'not-granted',
  'device-not-granted',
  'step-up-required',
  'undetermined',
] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];
export const GrantRefusalSchema = z.enum(GRANT_REFUSALS);

/** `grant_not_granted`, `grant_device_not_granted`, … (today's `grantRefusalCode`). */
export function grantRefusalCode(refusal: GrantRefusal): string {
  return `grant_${refusal.replaceAll('-', '_')}`;
}

/** Today's `capabilityNoun`: what the owner reads in a refusal sentence. */
export const CAPABILITY_NOUNS: Readonly<Record<CapabilityName, string>> = {
  fleet: 'the agent fleet',
  terminal: 'session terminals',
  browser: 'the browser',
  filesystem: 'the project filesystem',
  warden: 'fleet supervision',
  pairing: 'device pairing',
  secrets: 'the secret store',
  sharing: 'catalog sharing',
};

/** The `use` capabilities that ask a step-up when governed (today's `STEP_UP_USE_CAPABILITIES`). */
export const STEP_UP_USE_CAPABILITIES: readonly CapabilityName[] = ['terminal', 'browser', 'pairing', 'secrets', 'sharing'];

// ─── remedies and audit kinds ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A warden remedy (today's `WardenRemedyName`). No core route declares one today; the Warden plugin's contract mints
 * its own with `remedyRef`. Absent on a route means no warden may act there.
 */
export const remedyRef = (name: string): PolicyRef<'remedy'> => policyRef('remedy', name);

/** The audit kinds today's audit log records (today's `AUDIT_EVENTS`, in order). */
export const AUDIT_KIND_NAMES = [
  'device.paired',
  'device.revoked',
  'device.expired',
  'pairing.code-minted',
  'pairing.refused',
  'session.opened',
  'step-up.succeeded',
  'step-up.failed',
  'passkey.registered',
  'terminal.opened',
  'terminal.closed',
  'terminal.input',
  'fleet.configured',
  'grants.changed',
  'secrets.used',
  'secrets.changed',
  'catalog.changed',
  'catalog.exported',
  'catalog.share.minted',
  'catalog.share.ended',
  'catalog.member.joined',
  'catalog.member.passkey-added',
  'catalog.member.unlocked',
  'catalog.member.join-refused',
  'catalog.member.join-proved',
  'catalog.member.join-proof-refused',
  'catalog.member.new-passkey-used',
  'catalog.share.new-passkey-marked',
  'catalog.share.new-passkey-cleared',
  'catalog.member.revoked',
  'catalog.member.key-removed',
  'catalog.member.catalog-removed',
  'catalog.member.renamed',
  'catalog.share.cross-member',
  'catalog.link.minted',
  'catalog.link.copied',
  'catalog.link.ended',
  'catalog.link.moved',
  'catalog.link.changed',
  'catalog.link.revived',
  'security.changed',
  'device.key-rotated',
  'pairing.code-revoked',
  'push.changed',
  'warden.configured',
  'warden.ran',
  'browser.opened',
  'browser.proxy-tested',
  'worktree.removed',
  'agent.prompted',
  'agent.tool',
  'surface.control',
  'input.requested',
  'input.delivered',
  'input.refused',
  'input.rebound',
  'input.expired',
  'input.cancelled',
  'input.quarantine_ended',
  'input.quarantine_revealed',
  'link.opened',
  'ferret.credential-refused',
  'ferret.credential-revoked',
  'phone-approval.raised',
  'phone-approval.refused',
  'phone-approval.settled',
] as const;
export type AuditKindName = (typeof AUDIT_KIND_NAMES)[number];
export type AuditKindRef<N extends string = AuditKindName> = PolicyRef<'audit'> & N;

/** Mints an audit kind ref; a plugin's contract uses it for kinds it adds. */
export const auditKind = <const N extends string>(name: N): AuditKindRef<N> => policyRef('audit', name) as AuditKindRef<N>;

/** Every core audit kind as a ref, keyed by its name: `AUDIT_KINDS['device.paired']`. */
export const AUDIT_KINDS: { readonly [K in AuditKindName]: AuditKindRef<K> } = Object.freeze(
  Object.fromEntries(AUDIT_KIND_NAMES.map(name => [name, auditKind(name)])),
) as { readonly [K in AuditKindName]: AuditKindRef<K> };

/** The kinds kept past rotation (today's `AUDIT_KEPT_EVENTS`). */
export const AUDIT_KEPT_KINDS: readonly AuditKindName[] = [
  'device.paired',
  'device.revoked',
  'device.expired',
  'device.key-rotated',
  'passkey.registered',
  'grants.changed',
  'secrets.changed',
  'catalog.changed',
  'catalog.exported',
  'catalog.share.minted',
  'catalog.share.ended',
  'catalog.member.joined',
  'catalog.member.passkey-added',
  'catalog.member.join-proved',
  'catalog.member.new-passkey-used',
  'catalog.share.new-passkey-marked',
  'catalog.share.new-passkey-cleared',
  'catalog.member.revoked',
  'catalog.member.key-removed',
  'catalog.member.catalog-removed',
  'catalog.share.cross-member',
  'catalog.link.minted',
  'catalog.link.copied',
  'catalog.link.ended',
  'catalog.link.moved',
  'catalog.link.changed',
  'security.changed',
  'warden.configured',
];

// ─── step-up acts (closed lists) ──────────────────────────────────────────────────────────────────────────────────

export const STEP_UP_ACT_NAMES = [
  'add-device',
  'widen-device',
  'enable-agent-control',
  'loosen-config',
  'clone-secrets',
  'loosen-security',
  'catalog-install',
  'share-catalog',
  'share-link',
  'add-2fa-key',
  'allow-profile-targets',
  'approve-task-plan',
  'approve-sign-in-rule',
  'resume-cut-off',
  'approve-paste-rule',
] as const;
export type StepUpActName = (typeof STEP_UP_ACT_NAMES)[number];

/** A step-up act ref with its literal kept: `'add-2fa-key'` alone is not one, so a claim cannot be asked by string. */
export type StepUpActRef<N extends StepUpActName = StepUpActName> = PolicyRef<'step-up-act'> & N;

const act = <const N extends StepUpActName>(name: N): StepUpActRef<N> => policyRef('step-up-act', name) as StepUpActRef<N>;

/**
 * The acts that add access or run someone else's code, each wanting a passkey proved for it alone (today's
 * `STEP_UP_ACTS`, same keys, same meanings; see docs/grants.md and docs/design/zero-trust.md).
 */
export const STEP_UP_ACTS = {
  addDevice: act('add-device'),
  widenDevice: act('widen-device'),
  enableAgentControl: act('enable-agent-control'),
  loosenConfig: act('loosen-config'),
  cloneSecrets: act('clone-secrets'),
  loosenSecurity: act('loosen-security'),
  catalogInstall: act('catalog-install'),
  shareCatalog: act('share-catalog'),
  shareLink: act('share-link'),
  addTwoFactorKey: act('add-2fa-key'),
  allowProfileTargets: act('allow-profile-targets'),
  approveTaskPlan: act('approve-task-plan'),
  approveSignInRule: act('approve-sign-in-rule'),
  resumeCutOff: act('resume-cut-off'),
  approvePasteRule: act('approve-paste-rule'),
} as const;
export type StepUpAct = (typeof STEP_UP_ACTS)[keyof typeof STEP_UP_ACTS];

export const StepUpActSchema = z
  .enum(STEP_UP_ACT_NAMES)
  .transform(name => policyRef('step-up-act', name) as StepUpAct);

/**
 * THE ACTS ASKED OF EVERY CALLER, the machine itself included (today's `STEP_UP_ACTS_EVERY_CALLER`): no governed or
 * local check skips them, and each proof is bound to one staged subject.
 */
export const STEP_UP_ACTS_EVERY_CALLER = [
  STEP_UP_ACTS.addTwoFactorKey,
  STEP_UP_ACTS.approveTaskPlan,
  STEP_UP_ACTS.approveSignInRule,
  STEP_UP_ACTS.approvePasteRule,
  STEP_UP_ACTS.allowProfileTargets,
] as const;
export type EveryCallerStepUpAct = (typeof STEP_UP_ACTS_EVERY_CALLER)[number];
/** An act the machine itself (its admin token, local) is never asked to prove. */
export type MachineSkippableStepUpAct = Exclude<StepUpAct, EveryCallerStepUpAct>;

/** THE ACTS WHOSE PROOF IS KEPT (today's `STEP_UP_ACTS_STORED_PROOF`): only a standing sign-in rule. */
export const STEP_UP_ACTS_STORED_PROOF = [STEP_UP_ACTS.approveSignInRule] as const;
export type StoredProofStepUpAct = (typeof STEP_UP_ACTS_STORED_PROOF)[number];

export const stepUpSkippableAtMachine = (a: StepUpAct): a is MachineSkippableStepUpAct =>
  !(STEP_UP_ACTS_EVERY_CALLER as readonly StepUpAct[]).includes(a);
export const stepUpKeepsProof = (a: StepUpAct): a is StoredProofStepUpAct =>
  (STEP_UP_ACTS_STORED_PROOF as readonly StepUpAct[]).includes(a);

const stage = <const P extends string>(prefix: P, words: string) =>
  z.custom<`${P}_${string}`>(
    value => typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{24}$`, 'u').test(value),
    `a staged ${words} is ${prefix}_ and 24 hex digits`,
  );

/** The staged subjects every-caller acts are bound to (today's stage id schemas, same prefixes). */
export const TwoFactorStageIdSchema = stage('st', '2FA key');
export const TaskPlanStageIdSchema = stage('tps', 'task-plan approval');
export const SignInRuleStageIdSchema = stage('srs', 'standing rule');
export const PasteRuleStageIdSchema = stage('prs', 'paste rule');

/** Today's `STEP_UP_SUBJECTS`: one kind of stage per every-caller act. */
export const STEP_UP_SUBJECTS = {
  'add-2fa-key': TwoFactorStageIdSchema,
  'approve-task-plan': TaskPlanStageIdSchema,
  'approve-sign-in-rule': SignInRuleStageIdSchema,
  'approve-paste-rule': PasteRuleStageIdSchema,
  'allow-profile-targets': PasteRuleStageIdSchema,
} as const;
type SubjectSchemas = typeof STEP_UP_SUBJECTS;
/** The stage id an every-caller act's proof is bound to. */
export type StepUpSubjectOf<A extends EveryCallerStepUpAct> = A extends StepUpActRef<infer N>
  ? N extends keyof SubjectSchemas
    ? z.infer<SubjectSchemas[N]>
    : never
  : never;

/** The error code a governed route answers when it needs a step-up this caller does not hold. */
export const STEP_UP_REQUIRED_CODE = 'grant_step_up_required' as const;
/** The error code when the unlock is on and this holder has not unlocked. */
export const UNLOCK_REQUIRED_CODE = 'unlock_required' as const;
/** A person route refused to a ferret (`403 owner_only`). */
export const OWNER_ONLY_CODE = 'owner_only' as const;
/** Today's `ownerOnlyWords`. */
export const ownerOnlyWords = (doing: string): string => `only a person ${doing}; a ferret asks the owner instead`;

/** Why a ceremony was refused (today's `STEP_UP_REFUSALS`). */
export const STEP_UP_REFUSALS = [
  'not-a-device',
  'origin-not-allowed',
  'registration-closed',
  'too-many-passkeys',
  'no-passkey',
  'not-verified',
  'rotation-required',
  'not-at-machine',
  'unknown-device',
] as const;
export type StepUpRefusal = (typeof STEP_UP_REFUSALS)[number];
export const stepUpRefusalCode = (refusal: StepUpRefusal): string => `step_up_${refusal.replaceAll('-', '_')}`;

/** The demand that needed the step-up: a closed pair plus the one act (today's `StepUpDemandSchema`). */
export const StepUpDemandSchema = z.strictObject({
  capability: CapabilityNameSchema,
  axis: CapabilityAxisSchema,
  act: z.enum(STEP_UP_ACT_NAMES).optional(),
});
export type StepUpDemand = z.infer<typeof StepUpDemandSchema>;

/** The `403 grant_step_up_required` body (today's `StepUpRequiredBodySchema`). */
export const StepUpRequiredBodySchema = z.strictObject({
  error: z.string().min(1),
  code: z.literal(STEP_UP_REQUIRED_CODE),
  demand: StepUpDemandSchema,
});
export type StepUpRequiredBody = z.infer<typeof StepUpRequiredBodySchema>;
