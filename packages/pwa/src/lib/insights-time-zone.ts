/**
 * THE TIME ZONE INSIGHTS COUNTS DAYS IN: one reader preference kept on this device.
 *
 * A session is stored as an instant; which day it belongs to is a fact about the reader's clock, so the
 * zone lives on the READER (this device), not on any row or any daemon (docs/standards/datetime: the zone
 * belongs to the owner, the instant is what is stored). The default is the device's own zone, resolved at
 * read time, so a phone that travels follows its owner without anyone touching a setting; a deliberate
 * choice (the owner's home zone, UTC) is remembered until it is changed back to "Device".
 *
 * The stored value is `device` or an IANA name (`Asia/Singapore`) — never an abbreviation or an offset,
 * which cannot say which side of a daylight-saving change a day falls on. Anything else in storage is the
 * default.
 */
import { devicePreference } from './device-preference.ts';

/** The sole browser-storage key for the Insights time zone. */
export const INSIGHTS_TIME_ZONE_KEY = 'fy-insights-time-zone-v1';

/** The stored choice that means "whatever this device's clock says". */
export const DEVICE_TIME_ZONE = 'device';

/** The zone this device's clock is set to, or UTC when the runtime will not say. */
export const deviceTimeZone = (): string => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Every IANA zone the runtime knows, UTC and this device's own always among them. */
export const knownTimeZones = (): readonly string[] => {
  let listed: readonly string[] = [];
  try {
    listed = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    listed = [];
  }
  return [...new Set(['UTC', deviceTimeZone(), ...listed])].sort((left, right) =>
    left === 'UTC' ? -1 : right === 'UTC' ? 1 : left.localeCompare(right),
  );
};

export const insightsTimeZonePreference = devicePreference<string>(
  INSIGHTS_TIME_ZONE_KEY,
  [DEVICE_TIME_ZONE, ...knownTimeZones()],
  DEVICE_TIME_ZONE,
);

export interface InsightsTimeZone {
  /** What the reader chose: `device` or an IANA zone. */
  readonly choice: string;
  /** The IANA zone days are counted in right now. */
  readonly zone: string;
  readonly setChoice: (choice: string) => void;
}

/** The zone a stored choice means on a device whose clock is in `device`. */
export const resolveInsightsTimeZone = (choice: string, device: string): string =>
  choice === DEVICE_TIME_ZONE ? device : choice;

/** The live Insights time zone; changing it re-renders every reader of it, in every tab. */
export const useInsightsTimeZone = (): InsightsTimeZone => {
  const choice = insightsTimeZonePreference.use();
  return {
    choice,
    zone: resolveInsightsTimeZone(choice, deviceTimeZone()),
    setChoice: insightsTimeZonePreference.write,
  };
};
