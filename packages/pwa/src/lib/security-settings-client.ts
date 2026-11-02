/**
 * THE BROWSER'S HALF OF ONE MACHINE'S SECURITY SETTINGS (`docs/design/zero-trust.md` B6).
 *
 * `GET /v1/security` reads them and `PATCH /v1/security` changes some. Nothing here asks for a passkey:
 * the carrier raises that prompt itself when the machine answers `grant_step_up_required` and sends the
 * change again once, so a refusal that reaches {@link securityFailureSentence} is one the person
 * dismissed or one the machine really made.
 *
 * Every failure becomes ONE plain sentence. No status, code or error name reaches the screen.
 */

import {
  type IFyApiClient,
  SECURITY_SETTING_BOUNDS,
  SECURITY_WIDEN_REFUSED_CODE,
  type SecurityNumberField,
  type SecuritySettingField,
  type SecuritySettingsChange,
  SecuritySettingsChangeSchema,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  SecuritySettingsViewSchema,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

export type NumericSecuritySetting = SecurityNumberField;

/** The only client capability this surface uses. */
export type SecuritySettingsClient = Pick<IFyApiClient, 'request'>;

/** The settings in force, where they came from, and whether this caller may loosen one. */
export async function fetchSecuritySettings(client: SecuritySettingsClient): Promise<SecuritySettingsView> {
  return await client.request('/v1/security', SecuritySettingsViewSchema, { method: 'GET' });
}

/** Changes some settings. Send only the field that changed: a request is judged field by field. */
export async function changeSecuritySettings(
  client: SecuritySettingsClient,
  patch: SecuritySettingsPatch,
): Promise<SecuritySettingsChange> {
  return await client.request('/v1/security', SecuritySettingsChangeSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** The line under an unlock prompt: how long the unlock lasts, in the machine's own number. */
export function unlockStaysSentence(hours: number): string {
  return `It stays unlocked on this device for ${describeSettingValue('unlockValidityHours', hours)}.`;
}

/**
 * The line under a step-up prompt: how long one confirmation covers changes, in the machine's own
 * `stepUpWindowMinutes` (0: every change asks, so this one covers only itself).
 */
export function stepUpStaysSentence(minutes: number): string {
  return minutes === 0
    ? 'This covers this change only. This machine asks again for the next one.'
    : `This covers changes on this machine for ${describeSettingValue('stepUpWindowMinutes', minutes)}, in this open copy of the app. Closing the page ends it.`;
}

/** The same line when the machine's number could not be read. */
export const UNLOCK_STAYS_FALLBACK = 'It stays unlocked on this device for a few hours, as this machine is set.';

/** What one setting is called, what it does, and the unit its number is in. */
export interface SecuritySettingCopy {
  readonly label: string;
  readonly explanation: string;
  /** `null` for the one setting that is a switch. */
  readonly unit: { readonly one: string; readonly many: string } | null;
  /**
   * A larger unit a whole multiple is said in instead — `168` hours reads as `7 days`. Absent for a
   * setting whose numbers stay readable in their own unit.
   */
  readonly larger?: { readonly per: number; readonly one: string; readonly many: string };
}

export const SECURITY_SETTING_COPY: Readonly<Record<SecuritySettingField, SecuritySettingCopy>> = {
  stepUpWindowMinutes: {
    label: 'A change confirmation lasts',
    explanation: 'How long one passkey confirmation covers changes on this machine. 0 asks every time.',
    unit: { one: 'minute', many: 'minutes' },
  },
  deviceKeyRotationDays: {
    label: 'Device key is replaced every',
    explanation: 'Once this long has passed, a device’s key is replaced at its next passkey confirmation.',
    unit: { one: 'day', many: 'days' },
  },
  unlockOnOpen: {
    label: 'Unlock with a passkey on opening',
    explanation: 'A device must unlock this machine with its passkey before it can do anything.',
    unit: null,
  },
  unlockValidityHours: {
    label: 'An unlock lasts',
    explanation: 'How long one unlock lasts for a device, across page loads.',
    unit: { one: 'hour', many: 'hours' },
    larger: { per: 24, one: 'day', many: 'days' },
  },
  stepUpOnActions: {
    label: 'Ask again for each change',
    explanation: 'Ask for a passkey again before changes, terminals and other sensitive acts, even while unlocked.',
    unit: null,
  },
  idleExpiryDays: {
    label: 'Unused devices stay paired for',
    explanation: 'A device nobody uses for this long is unpaired.',
    unit: { one: 'day', many: 'days' },
  },
};

/** The larger unit `value` is said in, or nothing when it is said in the setting's own unit. */
function largerUnitOf(field: NumericSecuritySetting, value: number): SecuritySettingCopy['larger'] {
  const larger = SECURITY_SETTING_COPY[field].larger;
  return larger !== undefined && value >= larger.per && value % larger.per === 0 ? larger : undefined;
}

/** `15 minutes`, `1 hour`, `7 days`: the value with its unit in the right number. */
export function describeSettingValue(field: NumericSecuritySetting, value: number): string {
  const larger = largerUnitOf(field, value);
  const count = larger === undefined ? value : value / larger.per;
  const unit = larger ?? SECURITY_SETTING_COPY[field].unit;
  return `${count} ${count === 1 ? unit?.one : unit?.many}`;
}

/** `Allowed: 0 to 60 minutes.`, or `Allowed: 1 hour to 7 days.` when the two ends are said in different units. */
export function boundsLabel(field: NumericSecuritySetting): string {
  const { min, max } = SECURITY_SETTING_BOUNDS[field];
  const sameUnit = largerUnitOf(field, min) === largerUnitOf(field, max);
  return `Allowed: ${sameUnit ? String(min) : describeSettingValue(field, min)} to ${describeSettingValue(field, max)}.`;
}

/**
 * The choices offered beside a number, so the common values are one press away. Every one is inside the
 * protocol's bounds; a value between them can still be typed.
 */
export const SECURITY_SETTING_PRESETS: Readonly<Partial<Record<NumericSecuritySetting, readonly number[]>>> = {
  unlockValidityHours: [1, 8, 24, 72, 168],
};

/** The one sentence for a change the caller may not make from here. */
export function widenAtMachineSentence(widenCommand: string): string {
  return `Loosening this can only be done at the machine: run ${widenCommand}.`;
}

/** The one sentence for a loosening this device may make, with a passkey proved for it. */
export const WIDEN_WITH_PASSKEY_SENTENCE = 'Raising this asks for your passkey, then takes effect at once.';

/** How many devices a shortened idle period will unpair, or nothing when it unpairs none. */
export function devicesExpiringSentence(count: number): string | null {
  if (count <= 0) return null;
  const devices = count === 1 ? '1 device' : `${count} devices`;
  return `This will unpair ${devices} that ${count === 1 ? 'has' : 'have'} not been used within the new period.`;
}

/** What a machine that could not read its own settings tells the person. */
export const DAMAGED_SETTINGS_SENTENCE =
  'This machine could not read its security settings and is using its strictest reading until they are fixed at the machine.';

export const SECURITY_LOAD_FAILURE =
  'This machine did not answer its security settings. Reload the page, or try again in a moment.';

/** The sentence for a number the person typed that no setting can hold, or `null` when it is fine. */
export function boundsSentence(field: NumericSecuritySetting, draft: string): string | null {
  const bounds = SECURITY_SETTING_BOUNDS[field];
  const value = Number(draft);
  if (draft.trim() !== '' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max) return null;
  return `Enter a whole number from ${bounds.min} to ${bounds.max}.`;
}

/** The new value of a numeric field, or `null` when what was typed is not a value this field can hold. */
export function parseSettingDraft(field: NumericSecuritySetting, draft: string): number | null {
  return boundsSentence(field, draft) === null ? Number(draft) : null;
}

/** The one sentence for a change that did not happen. */
export function securityFailureSentence(reason: unknown, widenCommand: string): string {
  if (reason instanceof FyHttpError) {
    if (reason.code === SECURITY_WIDEN_REFUSED_CODE) return widenAtMachineSentence(widenCommand);
    if (reason.code === STEP_UP_REQUIRED_CODE)
      return 'This change needs your passkey, and it was not confirmed. Nothing was changed.';
    if (reason.status === 503)
      return 'This machine could not read its security settings, so it cannot change them from here.';
    if (reason.status === 400) return 'This machine does not accept that value. Nothing was changed.';
  }
  return 'The setting was not changed. Try again.';
}
