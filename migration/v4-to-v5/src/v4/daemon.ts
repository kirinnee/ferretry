/**
 * v4's daemon documents (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `config/daemon.json`: `DaemonConfigDocumentSchema` (`packages/daemon/src/lib/runtime/config.ts:322`), STRICT at the
 *   top level, no version. v4 refused to boot on an unknown key or a wrong type, so this reader refuses the same
 *   things. The blocks this tool converts are re-declared here WITHOUT v4's defaults: whether the owner wrote a key is
 *   the fact the conversion needs (a default is v4's answer to silence, restated below where it matters).
 * - `state/security.json`: `{schemaVersion: 1, settings, updatedAt}` (`adapters/security/state-security-settings.ts`);
 *   a document that does not parse is read by v4 as its STRICTEST settings, never as the defaults.
 * - `config/routing.json`: `RoutingCatalogSchema` (`lib/core/catalog.ts:128`), operator-written, read-only by v4.
 * - `state/operator-password.json`: RETIRED in 4.291.5 (`bin/fyd.ts:13495` deletes it at boot). Only ever `lstat`ed.
 */
import { z } from 'zod';
import { V4_DAEMON_CONFIG } from './usage.ts';

export const V4_DAEMON_JSON = V4_DAEMON_CONFIG;
export const V4_ROUTING_JSON = 'config/routing.json';
export const V4_SECURITY_JSON = 'state/security.json';
export const V4_OPERATOR_PASSWORD = 'state/operator-password.json';

/** Every top-level key of v4's strict `DaemonConfigDocumentSchema`. */
export const V4_DAEMON_KEYS = [
  'host',
  'port',
  'publicUrl',
  'corsOrigins',
  'secretsFile',
  'healthIntervalSeconds',
  'transcriptReconcileSeconds',
  'sessionWorkers',
  'usage',
  'delivery',
  'catalogs',
  'housekeeping',
  'attention',
  'agenda',
  'relay',
  'webrtc',
  'carriers',
  'analyticsPricing',
  'analyticsPricingSources',
  'projectRoots',
  'terminals',
  'harness',
  'fleet',
  'accountModel',
  'secretEnvironment',
  'grants',
] as const;
export type V4DaemonKey = (typeof V4_DAEMON_KEYS)[number];

/** v4's capability set (`DAEMON_CAPABILITIES`, `packages/protocol`): the eight keys its strict `grants` block takes. */
export const V4_CAPABILITIES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
export type V4Capability = (typeof V4_CAPABILITIES)[number];
export interface V4Grant {
  readonly use: boolean;
  readonly configure: boolean;
}

/**
 * v4's answer when the owner wrote nothing for a capability or an axis: `DEFAULT_CAPABILITY_GRANTS`
 * (`packages/daemon/src/lib/grants/policy.ts`, 4.291.5), both axes on for all eight. Restated here, never imported.
 */
export const V4_DEFAULT_GRANTS: Readonly<Record<V4Capability, V4Grant>> = Object.freeze(
  Object.fromEntries(V4_CAPABILITIES.map(name => [name, { use: true, configure: true }])) as Record<
    V4Capability,
    V4Grant
  >,
);

/** v4's per-capability grant as written: `strictObject` with two optional booleans (the defaults are v4's, above). */
const V4WrittenGrant = z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() });
export const V4GrantsBlock = z.strictObject(
  Object.fromEntries(V4_CAPABILITIES.map(name => [name, V4WrittenGrant.optional()])) as Record<
    V4Capability,
    z.ZodOptional<typeof V4WrittenGrant>
  >,
);
export type V4GrantsBlock = z.infer<typeof V4GrantsBlock>;

/**
 * What v4 ENFORCED for each capability. `configure` implies `use` in v4's decision (`decideCapability` refuses every
 * demand of a capability whose `use` is off), so the effective `configure` is `use ∧ configure`. Carrying that, not the
 * literal, keeps the result no wider than v4 whatever v5's own reading of a `{use: false, configure: true}` pair is.
 */
export function v4EffectiveGrants(block: V4GrantsBlock | undefined): Record<V4Capability, V4Grant> {
  return Object.fromEntries(
    V4_CAPABILITIES.map(name => {
      const written = block?.[name];
      const use = written?.use ?? V4_DEFAULT_GRANTS[name].use;
      const configure = use && (written?.configure ?? V4_DEFAULT_GRANTS[name].configure);
      return [name, { use, configure }];
    }),
  ) as Record<V4Capability, V4Grant>;
}

// ─── carriers (`lib/runtime/carriers.ts`) ─────────────────────────────────────────────────────────────────────────

const Host = z.string().trim().min(1).max(255);
const Port = z.number().int().min(0).max(65_535);
const Reconnect = z.number().int().positive().max(3_600);

export const V4BindCarrier = z.strictObject({ kind: z.literal('bind'), host: Host, port: Port.optional() });
export const V4DiscoveredRelay = z.strictObject({
  kind: z.literal('relay'),
  source: z.literal('discovery'),
  enabled: z.boolean().optional(),
  reconnectSeconds: Reconnect.optional(),
});
export const V4ConfiguredRelay = z.strictObject({
  kind: z.literal('relay'),
  url: z.string(),
  enabled: z.boolean().optional(),
  reconnectSeconds: Reconnect.optional(),
});
export const V4TunnelCarrier = z.strictObject({
  kind: z.literal('tunnel'),
  source: z.literal('discovery'),
  enabled: z.boolean().optional(),
});
const V4CarrierEntry = z.union([V4BindCarrier, V4DiscoveredRelay, V4ConfiguredRelay, V4TunnelCarrier]);
export type V4CarrierEntry = z.infer<typeof V4CarrierEntry>;
export type V4RelayEntry = z.infer<typeof V4DiscoveredRelay> | z.infer<typeof V4ConfiguredRelay>;

/** v4's per-kind bounds (`MAX_BIND_CARRIERS` 1, `MAX_RELAY_CARRIERS` 4, `MAX_TUNNEL_CARRIERS` 1). */
const V4Carriers = z.array(V4CarrierEntry).superRefine((carriers, context) => {
  const count = (kind: V4CarrierEntry['kind']) => carriers.filter(entry => entry.kind === kind).length;
  if (count('bind') > 1) context.addIssue({ code: 'custom', message: 'more than one bind carrier' });
  if (count('relay') > 4) context.addIssue({ code: 'custom', message: 'more than four relay carriers' });
  if (count('tunnel') > 1) context.addIssue({ code: 'custom', message: 'more than one tunnel carrier' });
});

/** The legacy one-relay spelling (`DaemonRelayConfigSchema`). */
const V4LegacyRelay = z.strictObject({
  url: z.string(),
  enabled: z.boolean().optional(),
  reconnectSeconds: Reconnect.optional(),
});

const V4WebRtc = z.strictObject({
  enabled: z.boolean().optional(),
  iceServers: z.array(z.string()).max(4).optional(),
});

/** `HarnessDiscoveryDocumentSchema` (`lib/core/harness-readiness.ts:70`); v4's harness kinds are `claude`, `codex`. */
const DeclaredPath = z
  .string()
  .trim()
  .min(1)
  .refine(value => value.startsWith('/') || value === '~' || value.startsWith('~/'));
const V4Harness = z.strictObject({
  paths: z.strictObject({ claude: DeclaredPath.optional(), codex: DeclaredPath.optional() }).optional(),
  searchPaths: z.array(DeclaredPath).max(32).optional(),
});

/** `LegacyDaemonAttentionConfigSchema` / `DaemonAgendaConfigSchema`, without defaults. */
const V4AgendaWindow = z.strictObject({
  replySettleSeconds: z.number().int().min(1).max(3_600).optional(),
  replyMaxWaitSeconds: z.number().int().min(1).max(3_600).optional(),
  replyComposerWaitSeconds: z.number().int().min(10).max(86_400).optional(),
  replyReceiptSeconds: z.number().int().min(30).max(86_400).optional(),
  resurfaceAfterMinutes: z.number().int().min(1).max(10_080).optional(),
  deadlineWarnHours: z.number().min(0.25).max(168).optional(),
});
export type V4AgendaWindow = z.infer<typeof V4AgendaWindow>;

/** `catalogs` (`memberUnlockDays` 1–90, default 30; `linkStore` discovery | {url} | {enabled: false}). */
export const V4_MEMBER_UNLOCK_DAYS_DEFAULT = 30;
const V4Catalogs = z.strictObject({
  memberUnlockDays: z.number().int().min(1).max(90).optional(),
  linkStore: z
    .union([
      z.strictObject({ source: z.literal('discovery') }),
      z.strictObject({ url: z.string() }),
      z.strictObject({ enabled: z.literal(false) }),
    ])
    .optional(),
});

/**
 * The document as this tool reads it: v4's top-level key set, strict; the blocks the conversion reads are typed
 * (without defaults); every other key is v4's to have checked and is only named, never read, by the step.
 */
export const V4DaemonDocument = z.strictObject({
  host: Host.optional(),
  port: Port.optional(),
  publicUrl: z.unknown().optional(),
  corsOrigins: z.array(z.string()).max(32).optional(),
  secretsFile: z.unknown().optional(),
  healthIntervalSeconds: z.unknown().optional(),
  transcriptReconcileSeconds: z.unknown().optional(),
  sessionWorkers: z.unknown().optional(),
  usage: z.unknown().optional(),
  delivery: z.unknown().optional(),
  catalogs: V4Catalogs.optional(),
  housekeeping: z.unknown().optional(),
  attention: V4AgendaWindow.optional(),
  agenda: V4AgendaWindow.optional(),
  relay: V4LegacyRelay.optional(),
  webrtc: V4WebRtc.optional(),
  carriers: V4Carriers.optional(),
  analyticsPricing: z.unknown().optional(),
  analyticsPricingSources: z.unknown().optional(),
  projectRoots: z.unknown().optional(),
  terminals: z.strictObject({ shell: z.string().trim().min(1).max(512).optional() }).optional(),
  harness: V4Harness.optional(),
  fleet: z.unknown().optional(),
  accountModel: z.unknown().optional(),
  secretEnvironment: z.record(z.string(), z.string()).optional(),
  grants: V4GrantsBlock.optional(),
});
export type V4DaemonDocument = z.infer<typeof V4DaemonDocument>;

/** v4's `HOSTED_APP_ORIGIN`: the `corsOrigins` default. */
export const V4_HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';
/** v4's `LOOPBACK`: the `host` a document that names none binds. */
export const V4_LOOPBACK = '127.0.0.1';

/** The agenda reply window resolved key by key: `agenda` wins over the older `attention` (v4's own rule). */
export function v4AgendaWindow(document: V4DaemonDocument): V4AgendaWindow {
  return { ...document.attention, ...stripUndefined(document.agenda ?? {}) };
}
const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

// ─── security.json (`packages/protocol/src/lib/security.ts`) ──────────────────────────────────────────────────────

const bounded = (min: number, max: number) => z.number().int().min(min).max(max);
export const V4SecuritySettings = z.strictObject({
  unlockOnOpen: z.boolean(),
  unlockValidityHours: bounded(1, 168),
  stepUpOnActions: z.boolean(),
  stepUpWindowMinutes: bounded(0, 60),
  deviceKeyRotationDays: bounded(7, 90),
  idleExpiryDays: bounded(1, 90),
});
export type V4SecuritySettings = z.infer<typeof V4SecuritySettings>;
export const V4SecurityDocument = z.strictObject({
  schemaVersion: z.literal(1),
  settings: V4SecuritySettings,
  updatedAt: z.string(),
});

/** v4's `DEFAULT_SECURITY_SETTINGS`: what a machine with no `security.json` enforced. */
export const V4_DEFAULT_SECURITY: V4SecuritySettings = Object.freeze({
  unlockOnOpen: true,
  unlockValidityHours: 8,
  stepUpOnActions: false,
  stepUpWindowMinutes: 15,
  deviceKeyRotationDays: 30,
  idleExpiryDays: 30,
});
/** v4's `DAMAGED_SECURITY_SETTINGS` (`lib/security/service.ts:41`): what a machine with a damaged one enforced. */
export const V4_DAMAGED_SECURITY: V4SecuritySettings = Object.freeze({
  unlockOnOpen: true,
  unlockValidityHours: 1,
  stepUpOnActions: true,
  stepUpWindowMinutes: 0,
  deviceKeyRotationDays: 7,
  idleExpiryDays: 30,
});
