import type { Standing } from './inventory.ts';

/**
 * What a blocked package shows (§9.6, §5.2): ONE line in its tab, screens and panels for that daemon. The direction
 * comes from the release versions (`GET /v1/health` against the version this app was built from): app newer, the
 * daemon needs an update; daemon newer, the app needs a reload. Equal versions with different hashes (two builds of
 * one version) read as "reload", which is the cheap remedy.
 */

/** The command a person runs to update a daemon; the `fy` binary name is single-sourced and this is owner text. */
export const UPDATE_DAEMON_COMMAND = 'fy update';

/** -1, 0, 1 by semver core (`5.0.0`); a pre-release or build suffix is ignored. Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): readonly number[] => {
    const core = /^(\d+)\.(\d+)\.(\d+)/u.exec(v.trim());
    return core === null ? [-1, -1, -1] : [Number(core[1]), Number(core[2]), Number(core[3])];
  };
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? -1;
    const r = right[i] ?? -1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export type Remedy = 'update-daemon' | 'reload-app';

/**
 * Said full-screen when the daemon answered the plugin list but what came back was not a plugin list, or the read failed
 * on the way (a carrier that dropped, a daemon still starting). It is NOT the "reload" sentence: reloading the app does
 * not mend a read that failed, and the app reads again by itself until it works.
 */
export const UNREADABLE_INVENTORY_SENTENCE = `Could not read what this daemon offers. Trying again — if this stays, check that the machine is running and reachable.`;

export function remedyFor(appVersion: string, daemonVersion: string | undefined): Remedy {
  if (daemonVersion === undefined) return 'reload-app';
  return compareVersions(appVersion, daemonVersion) > 0 ? 'update-daemon' : 'reload-app';
}

/** The full-screen sentence for a protocol or core mismatch. */
export function wholeDaemonSentence(remedy: Remedy): string {
  return remedy === 'update-daemon'
    ? `This daemon needs an update: run \`${UPDATE_DAEMON_COMMAND}\` on that machine.`
    : 'Reload to get the new app.';
}

/**
 * Said when a session ended with the device-refused close (`4403`): the machine no longer accepts this browser, or the
 * carrier said so. Nothing is deleted — the key and the pairing stay — and pairing again is the repair (S12).
 */
export const DEVICE_NOT_ACCEPTED_SENTENCE =
  'This machine no longer accepts this browser — it was removed, or went unused for too long. Pair it again to keep using it.';

/** The one line for a blocked package, or `undefined` when it is allowed. */
export function blockedLine(
  title: string,
  standing: Standing,
  remedy: Remedy,
  titleOf: (id: string) => string,
): string | undefined {
  if (standing.state === 'allowed') return undefined;
  switch (standing.reason) {
    case 'unread':
      return `Checking what this daemon offers…`;
    case 'missing':
      return `${title} is not available to this device on this daemon.`;
    case 'off':
      return `${title} is off on this daemon.`;
    case 'unreadable':
      return `This daemon's plugin list could not be read, so ${title} stays paused.`;
    case 'core':
      return wholeDaemonSentence(remedy);
    case 'different': {
      const base =
        remedy === 'update-daemon'
          ? `Update this daemon to use ${title}: \`${UPDATE_DAEMON_COMMAND}\`.`
          : `Reload the app to use ${title}.`;
      if (standing.via === undefined) return base;
      const via = titleOf(standing.via);
      return remedy === 'update-daemon'
        ? `${title} needs ${via}, which needs an update: \`${UPDATE_DAEMON_COMMAND}\`.`
        : `${title} needs ${via}, which needs a reload of the app.`;
    }
  }
}
