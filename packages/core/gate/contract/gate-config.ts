import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  CAPABILITY_NAMES,
  type CapabilityGrants,
  DEFAULT_CAPABILITY_GRANTS,
  ReadCapabilityGrantsSchema,
} from './policy.ts';

/**
 * `config/gate.yaml` (§7.1, §9.2): the daemon-wide half of the grants, the security settings and the remote warden.
 * Person-only and passkey-checked; a loosening edit is held for the owner. Access edits it from its settings screen
 * THROUGH Gate's config route, so the file is Gate's whatever plugin is on. The security settings are today's
 * `protocol/src/lib/security.ts`, field for field.
 */

// ─── security settings ────────────────────────────────────────────────────────────────────────────────────────────

export const SECURITY_SETTING_FIELDS = [
  'unlockOnOpen',
  'unlockValidityHours',
  'stepUpOnActions',
  'stepUpWindowMinutes',
  'deviceKeyRotationDays',
  'idleExpiryDays',
] as const;
export type SecuritySettingField = (typeof SECURITY_SETTING_FIELDS)[number];

export const SECURITY_SWITCH_FIELDS = ['unlockOnOpen', 'stepUpOnActions'] as const;
export type SecuritySwitchField = (typeof SECURITY_SWITCH_FIELDS)[number];
export const isSecuritySwitch = (field: SecuritySettingField): field is SecuritySwitchField =>
  (SECURITY_SWITCH_FIELDS as readonly string[]).includes(field);

export const SECURITY_SETTING_BOUNDS = {
  stepUpWindowMinutes: { min: 0, max: 60 },
  deviceKeyRotationDays: { min: 7, max: 90 },
  unlockValidityHours: { min: 1, max: 168 },
  idleExpiryDays: { min: 1, max: 90 },
} as const;

const bounded = (field: keyof typeof SECURITY_SETTING_BOUNDS) =>
  z.number().int().min(SECURITY_SETTING_BOUNDS[field].min).max(SECURITY_SETTING_BOUNDS[field].max);

export const SecuritySettingsSchema = z.strictObject({
  unlockOnOpen: z.boolean(),
  unlockValidityHours: bounded('unlockValidityHours'),
  stepUpOnActions: z.boolean(),
  stepUpWindowMinutes: bounded('stepUpWindowMinutes'),
  deviceKeyRotationDays: bounded('deviceKeyRotationDays'),
  idleExpiryDays: bounded('idleExpiryDays'),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

export const STEP_UP_DEFAULT_WINDOW_MINUTES = 15 as const;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = Object.freeze({
  unlockOnOpen: true,
  unlockValidityHours: 8,
  stepUpOnActions: false,
  stepUpWindowMinutes: STEP_UP_DEFAULT_WINDOW_MINUTES,
  deviceKeyRotationDays: 30,
  idleExpiryDays: 30,
});

/** With the unlock off, every governed act asks a step-up (G79). Today's `asksStepUpPerAction`. */
export const asksStepUpPerAction = (settings: SecuritySettings): boolean =>
  settings.stepUpOnActions || !settings.unlockOnOpen;

/** Whether moving one field from `from` to `to` loosens security (today's `widensSecurity`). */
export function widensSecurity<F extends SecuritySettingField>(
  field: F,
  from: SecuritySettings[F],
  to: SecuritySettings[F],
): boolean {
  if (isSecuritySwitch(field)) return from === true && to === false;
  return (to as number) > (from as number);
}

/** The fields a device may raise with a passkey, applied at once and journaled (today's list). */
export const SECURITY_PASSKEY_WIDEN_FIELDS = ['unlockValidityHours'] as const satisfies readonly SecuritySettingField[];
export const widensWithPasskey = (field: SecuritySettingField): boolean =>
  (SECURITY_PASSKEY_WIDEN_FIELDS as readonly string[]).includes(field);

export const SECURITY_WIDEN_REFUSED_CODE = 'security_widen_at_machine' as const;

export const SecuritySettingsPatchSchema = SecuritySettingsSchema.partial().refine(
  patch => Object.keys(patch).length > 0,
  'name at least one setting to change',
);
export type SecuritySettingsPatch = z.infer<typeof SecuritySettingsPatchSchema>;

export const SecuritySettingsViewSchema = z.strictObject({
  settings: SecuritySettingsSchema,
  source: z.enum(['document', 'defaults', 'damaged']),
  mayWiden: z.boolean(),
  widenCommand: z.string().min(1).max(200),
  updatedAt: InstantSchema.optional(),
});
export type SecuritySettingsView = z.infer<typeof SecuritySettingsViewSchema>;

/** The answer to an unlock (today's `UnlockGrantedSchema`). */
export const UnlockGrantedSchema = z.strictObject({
  unlockedUntil: InstantSchema,
  keyRotated: z.literal(true).optional(),
});

// ─── gate.yaml ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a remote warden may do: the daemon-wide half, never a step-up (a warden has no passkey). */
export const RemoteWardenSchema = z.strictObject({
  /** Whether a warden token is honoured off this host at all. Off by default. */
  remote: z.boolean(),
});
export type RemoteWarden = z.infer<typeof RemoteWardenSchema>;

export const GateConfigSchema = z.strictObject({
  /** The daemon-wide half: what any governed caller may do at most. A capability left out is not granted. */
  grants: ReadCapabilityGrantsSchema.default(DEFAULT_CAPABILITY_GRANTS),
  security: SecuritySettingsSchema.default(DEFAULT_SECURITY_SETTINGS),
  warden: RemoteWardenSchema.default({ remote: false }),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

export const DEFAULT_GATE_CONFIG: GateConfig = Object.freeze({
  grants: DEFAULT_CAPABILITY_GRANTS,
  security: DEFAULT_SECURITY_SETTINGS,
  warden: { remote: false },
});

/** Each axis that turned on, as a sentence. */
export function widenedGrants(before: CapabilityGrants, after: CapabilityGrants): readonly string[] {
  const widened: string[] = [];
  for (const name of CAPABILITY_NAMES) {
    if (!before[name].use && after[name].use) widened.push(`grants ${name}.use turned on`);
    if (!before[name].configure && after[name].configure) widened.push(`grants ${name}.configure turned on`);
  }
  return widened;
}

/** Which edits of `gate.yaml` loosen authority; those are held for the owner (§7.2). */
export function gateConfigLoosens(before: GateConfig | undefined, after: GateConfig): readonly string[] {
  const from = before ?? DEFAULT_GATE_CONFIG;
  const loosened = [...widenedGrants(from.grants, after.grants)];
  for (const field of SECURITY_SETTING_FIELDS)
    if (widensSecurity(field, from.security[field], after.security[field]))
      loosened.push(
        `security ${field} loosened from ${String(from.security[field])} to ${String(after.security[field])}`,
      );
  if (!from.warden.remote && after.warden.remote) loosened.push('a remote warden is now honoured');
  return loosened;
}

export const GateConfigFile = defineConfig({
  file: 'gate.yaml',
  schema: GateConfigSchema,
  axis: 'configure',
  loosens: gateConfigLoosens,
  personOnly: true,
});

// ─── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `state/gate/admin-token` (`0600`): minted, never configured; a raw token, never served. */
export const AdminTokenFile = defineState({
  name: 'admin-token',
  path: 'admin-token',
  store: 'secret',
  format: 1,
  mode: 0o600,
});

/** `state/gate/warden-token` (`0600`). */
export const WardenTokenFile = defineState({
  name: 'warden-token',
  path: 'warden-token',
  store: 'secret',
  format: 1,
  mode: 0o600,
});
