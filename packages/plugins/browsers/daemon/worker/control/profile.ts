export interface BrowserProfileLeaseRecord {
  readonly sessionId: string;
  readonly daemonPid: number;
  readonly chromePid?: number;
  readonly acquiredAt: string;
}

export interface BrowserProfileMetadata {
  readonly createdChromeVersion?: string;
  readonly createdAt?: string;
  readonly primedChromeVersion?: string;
  readonly primedAt?: string;
  readonly latestChromeVersion?: string;
  readonly latestAt?: string;
}

export type BrowserProfileBusyReason = 'lease' | 'chrome' | 'unknown';

export class BrowserProfileBusyError extends Error {
  constructor(
    readonly reason: BrowserProfileBusyReason,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserProfileBusyError';
  }
}

export interface BrowserProfileLease {
  readonly profile: string;
  readonly sessionId: string;
  readonly daemonPid: number;
  readonly acquiredAt: string;
  readonly recoveredDeadOwner: boolean;
  updateChromePid(chromePid?: number, chromeVersion?: string): Promise<void>;
  cleanupStaleChromeLocks(): Promise<readonly string[]>;
  markPrimed(chromeVersion: string): Promise<void>;
  release(): Promise<boolean>;
}

export interface BrowserProfilePort {
  /**
   * Takes the one shared profile. Acquisition is EXCLUSIVE per daemon and the session id is an owner
   * label, not a key: an extant lease blocks every later acquirer including the session already named
   * on it. That is what makes a retained lease a quarantine — when a browser's cleanup could not be
   * confirmed, the lease is deliberately kept, and it must then block the retry as firmly as it
   * blocks a stranger. Asking again never clears a retained lease: it is freed by its holder
   * releasing it, or reclaimed by a later daemon that re-derives the verdict from the pids the record
   * names — and only once those are confirmed gone, so a lease whose Chrome is still alive stays
   * refused across a restart.
   */
  acquire(options: { readonly sessionId: string; readonly chromeVersion?: string }): Promise<BrowserProfileLease>;
  isPrimed(): Promise<boolean>;
  assertChromeVersionCompatible(runningChromeVersion: string): Promise<void>;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseBrowserProfileLease(value: string): BrowserProfileLeaseRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<BrowserProfileLeaseRecord>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId || !isPositiveInteger(parsed.daemonPid))
      return undefined;
    if (parsed.chromePid !== undefined && !isPositiveInteger(parsed.chromePid)) return undefined;
    if (typeof parsed.acquiredAt !== 'string' || !Number.isFinite(Date.parse(parsed.acquiredAt))) return undefined;
    return {
      sessionId: parsed.sessionId,
      daemonPid: parsed.daemonPid,
      ...(parsed.chromePid === undefined ? {} : { chromePid: parsed.chromePid }),
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return undefined;
  }
}

function chromeMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/(?:^|\D)(\d{1,4})(?:\.\d+){0,3}(?:\D|$)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 0 ? major : undefined;
}

/** Returns -1 for a downgrade, 0 for equal majors, and 1 for an upgrade. */
export function compareChromeVersions(running: string, recorded: string): -1 | 0 | 1 | undefined {
  const runningMajor = chromeMajor(running);
  const recordedMajor = chromeMajor(recorded);
  if (runningMajor === undefined || recordedMajor === undefined) return undefined;
  return runningMajor === recordedMajor ? 0 : runningMajor < recordedMajor ? -1 : 1;
}

export function highestChromeVersion(metadata: BrowserProfileMetadata | undefined): string | undefined {
  let highest: { readonly version: string; readonly major: number } | undefined;
  for (const version of [
    metadata?.createdChromeVersion,
    metadata?.primedChromeVersion,
    metadata?.latestChromeVersion,
  ]) {
    const major = chromeMajor(version);
    if (version && major !== undefined && (!highest || major > highest.major)) highest = { version, major };
  }
  return highest?.version;
}

export function sameBrowserProfileLease(
  current: BrowserProfileLeaseRecord,
  expected: BrowserProfileLeaseRecord,
): boolean {
  return (
    current.sessionId === expected.sessionId &&
    current.daemonPid === expected.daemonPid &&
    current.acquiredAt === expected.acquiredAt
  );
}

export function isPrimedMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'string' &&
    record.version.trim().length > 0 &&
    typeof record.primedAt === 'string' &&
    Number.isFinite(Date.parse(record.primedAt))
  );
}

/**
 * Chrome's own preferences that keep the AGENT browser from saving or offering passwords
 * (docs/input-requests.md, "Pages"). The owner's values reach a page through the input bridge, and the
 * shared profile must never keep one: `credentials_enable_service` is "Offer to save passwords",
 * `credentials_enable_autosignin` is automatic sign-in with a saved one, and `profile.password_manager_enabled`
 * is the older switch for the same manager.
 */
export const PASSWORD_SAVING_OFF = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A profile's `Default/Preferences` with password saving forced off and everything else kept. `existing` is the
 * file's parsed JSON, or anything else when there is none or it does not parse: Chrome resets a preferences file
 * it cannot read, so a fresh one with only these switches loses nothing it would have kept.
 */
export function passwordSavingOff(existing: unknown): Record<string, unknown> {
  const preferences = isRecord(existing) ? existing : {};
  const profile = isRecord(preferences.profile) ? preferences.profile : {};
  return {
    ...preferences,
    credentials_enable_service: PASSWORD_SAVING_OFF.credentials_enable_service,
    credentials_enable_autosignin: PASSWORD_SAVING_OFF.credentials_enable_autosignin,
    profile: { ...profile, ...PASSWORD_SAVING_OFF.profile },
  };
}
