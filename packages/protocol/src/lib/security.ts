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
 * Narrowing is allowed from a paired device with a passkey confirmation; widening only at the machine,
 * except the few {@link SECURITY_PASSKEY_WIDEN_FIELDS} a device may raise with a passkey proved for it.
 */

export const SECURITY_SETTING_FIELDS = [
  'unlockOnOpen',
  'unlockValidityHours',
  'stepUpOnActions',
  'stepUpWindowMinutes',
  'deviceKeyRotationDays',
  'idleExpiryDays',
] as const;
export type SecuritySettingField = (typeof SECURITY_SETTING_FIELDS)[number];

/** The settings that are on or off rather than a number. Turning one ON tightens the machine. */
export const SECURITY_SWITCH_FIELDS = ['unlockOnOpen', 'stepUpOnActions'] as const;
export type SecuritySwitchField = (typeof SECURITY_SWITCH_FIELDS)[number];
/** The settings that are a bounded whole number. */
export type SecurityNumberField = Exclude<SecuritySettingField, SecuritySwitchField>;

/** Whether a setting is on or off rather than a number. */
export const isSecuritySwitch = (field: SecuritySettingField): field is SecuritySwitchField =>
  (SECURITY_SWITCH_FIELDS as readonly string[]).includes(field);

/** The bounds of every numeric setting, inclusive. */
export const SECURITY_SETTING_BOUNDS = {
  stepUpWindowMinutes: { min: 0, max: 60 },
  deviceKeyRotationDays: { min: 7, max: 90 },
  unlockValidityHours: { min: 1, max: 168 },
  idleExpiryDays: { min: 1, max: 90 },
} as const;

const bounded = (field: keyof typeof SECURITY_SETTING_BOUNDS) =>
  z.number().int().min(SECURITY_SETTING_BOUNDS[field].min).max(SECURITY_SETTING_BOUNDS[field].max);

export const SecuritySettingsSchema = z.strictObject({
  /**
   * Whether a device must UNLOCK this machine with a passkey before it can do anything at all. On by
   * default: one unlock, and the device may do anything its grants allow for the validity period.
   */
  unlockOnOpen: z.boolean(),
  /** How long one unlock lasts, for that device, across page loads. */
  unlockValidityHours: bounded('unlockValidityHours'),
  /**
   * Whether the acts that need a step-up ask for a passkey AGAIN inside an unlock. Off by default: the
   * unlock covers them. A machine with the unlock turned off always asks per act, whatever this says.
   */
  stepUpOnActions: z.boolean(),
  /** How long one per-act confirmation covers the acts that need one, when asked. `0` asks every time. */
  stepUpWindowMinutes: bounded('stepUpWindowMinutes'),
  /** How often a device's key is replaced, at its next passkey confirmation once the period is over. */
  deviceKeyRotationDays: bounded('deviceKeyRotationDays'),
  /** How long a device nobody uses stays paired. */
  idleExpiryDays: bounded('idleExpiryDays'),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/** The default of the `stepUpWindowMinutes` setting: the one place its number is written (`STEP_UP_TTL_SECONDS` is this in seconds). */
export const STEP_UP_DEFAULT_WINDOW_MINUTES = 15 as const;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  unlockOnOpen: true,
  unlockValidityHours: 8,
  stepUpOnActions: false,
  stepUpWindowMinutes: STEP_UP_DEFAULT_WINDOW_MINUTES,
  deviceKeyRotationDays: 30,
  idleExpiryDays: 30,
};

/**
 * Whether an act that needs a step-up must ask for one of its own, on top of the unlock: when the
 * owner asked for it, or when there is no unlock to cover it.
 */
export const asksStepUpPerAction = (settings: SecuritySettings): boolean =>
  settings.stepUpOnActions || !settings.unlockOnOpen;

/** A change to some of the settings. An empty change is refused: it would audit nothing happening. */
export const SecuritySettingsPatchSchema = SecuritySettingsSchema.partial().refine(
  patch => Object.keys(patch).length > 0,
  'name at least one setting to change',
);
export type SecuritySettingsPatch = z.infer<typeof SecuritySettingsPatchSchema>;

/**
 * Whether moving one setting from `from` to `to` LOOSENS the machine.
 *
 * A smaller window or period is tighter; an unlock on opening, and a confirmation per act inside it, are
 * tighter than none. An unchanged value widens nothing.
 */
export function widensSecurity<F extends SecuritySettingField>(
  field: F,
  from: SecuritySettings[F],
  to: SecuritySettings[F],
): boolean {
  if (isSecuritySwitch(field)) return from === true && to === false;
  return (to as number) > (from as number);
}

/**
 * The settings a paired device MAY loosen, with a passkey proved for that one change (owner decision
 * 2026-10-21, `STEP_UP_ACTS.loosenSecurity`). Every other field still loosens only at the machine.
 *
 * Only how long an unlock lasts: raising it asks the person less often, and every unlock it stretches
 * was itself a passkey. Turning the unlock or the per-act confirmation OFF, a longer key or a longer idle
 * period are a different kind of loosening, and stay at the machine.
 */
export const SECURITY_PASSKEY_WIDEN_FIELDS = ['unlockValidityHours'] as const satisfies readonly SecuritySettingField[];

/** Whether a paired device may loosen this setting with a passkey proved for that one change. */
export const widensWithPasskey = (field: SecuritySettingField): boolean =>
  (SECURITY_PASSKEY_WIDEN_FIELDS as readonly string[]).includes(field);

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

/**
 * What a change answers: the settings now in force, and how many paired devices the new idle period
 * will unpair at the next check because nobody has used them for longer than it. `0` for a change that
 * did not shorten it.
 */
export const SecuritySettingsChangeSchema = z.strictObject({
  view: SecuritySettingsViewSchema,
  devicesExpiring: z.number().int().min(0),
});
export type SecuritySettingsChange = z.infer<typeof SecuritySettingsChangeSchema>;

/**
 * The refusal every request from a device gets while this machine wants a passkey on opening and the
 * device has not given one inside the validity period (`unlockOnOpen`). `401`, because the device is
 * paired and its session is sound: what is missing is the person.
 */
export const UNLOCK_REQUIRED_CODE = 'unlock_required' as const;

/**
 * A verified unlock: when it lapses for this DEVICE, across page loads. `keyRotated` is present exactly
 * when the unlock carried a key rotation and the daemon now holds the new key — the unlock is the first
 * passkey ceremony an overdue device meets, so it is where the key is replaced.
 */
export const UnlockGrantedSchema = z.strictObject({
  unlockedUntil: InstantSchema,
  keyRotated: z.literal(true).optional(),
});
export type UnlockGranted = z.infer<typeof UnlockGrantedSchema>;
