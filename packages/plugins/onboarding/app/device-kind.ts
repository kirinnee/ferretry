/**
 * WHAT IS THIS DEVICE? — the one question first-run must never ask out loud.
 *
 * Ferretry has exactly two roles. A DAEMON is a machine that runs agents, and it
 * needs a terminal. A CLIENT is a browser that watches one, and it needs only a
 * browser. One machine can be both, which is the ordinary desktop case.
 *
 * A phone has no terminal, so it can never be a daemon. That is not a preference
 * to be offered and then refused three screens later — it is a fact about the
 * hardware the reader is holding, and the page can see it. Asking "is this a
 * computer?" of something that is demonstrably a phone is the same failure as a
 * cookie banner asking permission it already has.
 *
 * WHAT THIS IS NOT. It is not a capability test, and nothing here decides whether
 * a connection will work. It decides which of three answers a chooser may offer,
 * and every answer it withholds stays reachable through the answer it keeps —
 * a misread device costs a reader one extra tap, never a dead end.
 *
 * THE UNKNOWN CASE IS `desktop`, ON PURPOSE. The two mistakes are not symmetric.
 * Calling a phone a desktop shows install commands to somebody who cannot run
 * them — visibly wrong, and one tap from the route they wanted. Calling a desktop
 * a phone HIDES the daemon route from the only device that can host one, which is
 * the main path of the whole product. So an unrecognised user agent is treated as
 * the machine that can do more, and the phone-shaped claim is the one that has to
 * be positively evidenced.
 */

/** The two shapes of device this page treats differently. */
export type DeviceKind = 'mobile' | 'desktop';

/**
 * What a browser will say about itself.
 *
 * A record rather than a `Navigator`, because two of the three fields are needed
 * only to catch iPadOS and neither suite nor harness should have to forge a
 * whole navigator to say "this is an iPad".
 */
export interface DeviceEvidence {
  readonly userAgent?: string | undefined;
  /** iPadOS reports a desktop Safari user agent; only this separates it from a Mac. */
  readonly maxTouchPoints?: number | undefined;
  /** `navigator.platform` — deprecated, still the only iPad tell that ships. */
  readonly platform?: string | undefined;
}

/** Phones and small tablets announce themselves; every one of these is terminal-less. */
const MOBILE_MARKERS: readonly string[] = Object.freeze([
  'iphone',
  'ipod',
  'ipad',
  'android',
  'windows phone',
  'blackberry',
  'opera mini',
  'iemobile',
  'silk',
]);

/**
 * An Android with `mobile` in the string is a phone; without it, a tablet.
 *
 * Both are counted as mobile here because neither has a terminal a reader can
 * paste an install command into, which is the only distinction this module makes.
 */
const isMobileUserAgent = (agent: string): boolean => MOBILE_MARKERS.some(marker => agent.includes(marker));

/**
 * An iPad pretending to be a Mac.
 *
 * Since iPadOS 13 the user agent is `Macintosh; Intel Mac OS X`, identical to a
 * desktop Safari's, and `navigator.platform` is `MacIntel` on both. The one
 * difference is touch: a Mac reports zero touch points, an iPad reports five.
 * The test is deliberately confined to Apple desktop strings — a touchscreen
 * Windows laptop reports touch points too and is a perfectly good daemon host.
 */
const isDesktopClassIpad = (agent: string, platform: string, maxTouchPoints: number): boolean =>
  maxTouchPoints > 1 && (platform === 'macintel' || agent.includes('macintosh'));

/**
 * The device kind, from what the browser will admit to.
 *
 * Total: no input can fail, and the absent-evidence answer is `desktop` for the
 * reason the module comment gives.
 */
export const detectDeviceKind = (evidence: DeviceEvidence = {}): DeviceKind => {
  const agent = (evidence.userAgent ?? '').toLowerCase();
  const platform = (evidence.platform ?? '').toLowerCase();
  const touch = evidence.maxTouchPoints ?? 0;
  if (isMobileUserAgent(agent)) return 'mobile';
  if (isDesktopClassIpad(agent, platform, touch)) return 'mobile';
  return 'desktop';
};
