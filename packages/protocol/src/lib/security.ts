import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * ONE MACHINE'S SECURITY SETTINGS, ON THE WIRE (`docs/design/zero-trust.md` B6).
 *
 * A handful of knobs the owner may tighten or loosen per machine, each with a default and hard bounds.
 * A value outside the bounds is refused, never clamped: a request that asked for 120 days and silently
 * got 90 would leave its sender believing something false about the machine.
 *
 * WHICH DIRECTION IS NARROWER is a fact both ends need — the daemon to decide, the app to say before
 * anybody presses a button that a change can only be made at the machine — so it is written once here.
 * Narrowing is allowed from a paired device with a passkey confirmation; widening only at the machine.
 */

export const SECURITY_SETTING_FIELDS = [
  'stepUpWindowMinutes',
  'deviceKeyRotationDays',
  'presenceOnOpen',
  'presenceValidityHours',
  'idleExpiryDays',
] as const;
export type SecuritySettingField = (typeof SECURITY_SETTING_FIELDS)[number];

/** The bounds of every numeric setting, inclusive. */
export const SECURITY_SETTING_BOUNDS = {
  stepUpWindowMinutes: { min: 0, max: 60 },
  deviceKeyRotationDays: { min: 7, max: 90 },
  presenceValidityHours: { min: 1, max: 24 },
  idleExpiryDays: { min: 1, max: 90 },
} as const;

const bounded = (field: keyof typeof SECURITY_SETTING_BOUNDS) =>
  z.number().int().min(SECURITY_SETTING_BOUNDS[field].min).max(SECURITY_SETTING_BOUNDS[field].max);

export const SecuritySettingsSchema = z.strictObject({
  /** How long one passkey confirmation covers the acts that need one. `0` asks every time. */
  stepUpWindowMinutes: bounded('stepUpWindowMinutes'),
  /** How often a device's key is replaced, at its next passkey confirmation once the period is over. */
  deviceKeyRotationDays: bounded('deviceKeyRotationDays'),
  /** Whether opening the app needs a passkey confirmation before it shows anything. */
  presenceOnOpen: z.boolean(),
  /** How long one confirmation on opening lasts, for that device, across page loads. */
  presenceValidityHours: bounded('presenceValidityHours'),
  /** How long a device nobody uses stays paired. */
  idleExpiryDays: bounded('idleExpiryDays'),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  stepUpWindowMinutes: 15,
  deviceKeyRotationDays: 30,
  presenceOnOpen: false,
  presenceValidityHours: 8,
  idleExpiryDays: 30,
};

/** A change to some of the settings. An empty change is refused: it would audit nothing happening. */
export const SecuritySettingsPatchSchema = SecuritySettingsSchema.partial().refine(
  patch => Object.keys(patch).length > 0,
  'name at least one setting to change',
);
export type SecuritySettingsPatch = z.infer<typeof SecuritySettingsPatchSchema>;

/**
 * Whether moving one setting from `from` to `to` LOOSENS the machine.
 *
 * A smaller window or period is tighter; opening the app behind a passkey is tighter than not. An
 * unchanged value widens nothing.
 */
export function widensSecurity<F extends SecuritySettingField>(
  field: F,
  from: SecuritySettings[F],
  to: SecuritySettings[F],
): boolean {
  if (field === 'presenceOnOpen') return from === true && to === false;
  return (to as number) > (from as number);
}

/** Where the settings came from: the owner's document, the defaults, or the fail-closed reading. */
export const SECURITY_SETTINGS_SOURCES = ['document', 'defaults', 'damaged'] as const;
export const SecuritySettingsSourceSchema = z.enum(SECURITY_SETTINGS_SOURCES);
export type SecuritySettingsSource = z.infer<typeof SecuritySettingsSourceSchema>;

/** What a reader is shown: the settings in force, where they came from, and who may loosen them. */
export const SecuritySettingsViewSchema = z.strictObject({
  settings: SecuritySettingsSchema,
  source: SecuritySettingsSourceSchema,
  /** Whether THIS caller may loosen a setting. Tightening needs a passkey confirmation from a device. */
  mayWiden: z.boolean(),
  /** The one command that loosens a setting at the machine, for a caller that may not. */
  widenCommand: z.string().min(1).max(200),
  updatedAt: InstantSchema.optional(),
});
export type SecuritySettingsView = z.infer<typeof SecuritySettingsViewSchema>;

/** The refusal a remote widen gets. Its message names the command to run at the machine. */
export const SECURITY_WIDEN_REFUSED_CODE = 'security_widen_at_machine' as const;
