/**
 * MOVING A HALF-FINISHED SETUP TO THE OTHER DEVICE.
 *
 * First-time setup is the only route that spans two devices, and that span is the
 * whole reason it exists as its own answer. A phone cannot install a daemon, so
 * the daemon half has to travel to a computer; a computer that has just paired
 * itself has nothing left to do except offer the phone the same membership. Both
 * directions are real, and both of them fail in the same way if the hand-off is a
 * SENTENCE — "now open ferretry.dev on your other device" leaves the reader to
 * retype a URL and then answer the chooser again, on a device that has no idea
 * what the first one already decided.
 *
 * SO THE HAND-OFF CARRIES THE PLACE, NOT JUST THE PAGE. The link names the route
 * and the step the other device should open on, and the other device resumes
 * there instead of starting over. `docs/reference-standard.md` is the model: one
 * grammar, parsed once, proved before it is trusted.
 *
 * THE CARRIER IS DECIDED BY THE RECEIVER, AND THAT IS NOT AN OVERSIGHT.
 *
 * - To a phone it is a QR. The phone has a camera and the sending computer has a
 *   screen, so the phone reads it directly and nothing is typed.
 * - To a computer it is NOT a QR, because nothing on a desk points a camera at
 *   another screen — not a phone's, and not another computer's. It is a link to
 *   copy, share, or read out and type. A QR here would look like the same
 *   mechanism and be useless, which is worse than offering the honest one.
 *
 * NOTHING IDENTIFYING TRAVELS. The payload is a route, a step, and at most which
 * computer, who installs it and which carrier — five closed unions, all of them
 * already public constants in this bundle. No daemon address, no code, no token,
 * no name. A hand-off link is safe to photograph, and it has to be, because
 * photographing it is the point. A pairing code travels the OTHER way, from
 * `fy pair`, and never through here.
 */

import qrcode from 'qrcode-generator';
import type { DeviceKind } from './device-kind.ts';
import {
  type ConnectionMethodId,
  firstOnboardingStep,
  isConnectionMethodId,
  isDaemonRouteId,
  isOnboardingDoerId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isSetupTargetId,
  isStepOfRoute,
  isTargetPossible,
  type OnboardingDaemonRouteId,
  type OnboardingDoerId,
  type OnboardingJourney,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
  presumedTarget,
  type SetupTargetId,
} from './onboarding-model.ts';

/** The fragment key. Distinct from the `#v1;`/`#v2;` a pairing link uses — these are not the same claim. */
export const SETUP_HANDOFF_KEY = 'fy-setup';

/**
 * The payload grammar's version, so a future shape can be refused rather than misread.
 *
 * It moved from `v1` to `v2` when the daemon subflow gained its two answers. A
 * `v1` payload was three positional fields — version, route, step — and a route
 * plus a step is no longer enough to say what journey somebody meant: `install`
 * belongs to "this computer, by hand" and nothing in a `v1` link says so. Rather
 * than infer it, a `v1` link is refused, and its reader answers the entry question
 * once. These links are minutes-old artifacts of a setup in progress, so the cost
 * of refusing one is a tap; the cost of guessing is a journey nobody chose.
 */
export const SETUP_HANDOFF_VERSION = 'v2';

/** Where the other device should open, and what it should already have decided. */
export interface SetupHandoff {
  readonly route: OnboardingRouteId;
  readonly step: OnboardingStepId;
  /** Which computer runs the daemon. Only the daemon subflow has one. */
  readonly target?: SetupTargetId | undefined;
  /** Who installs it. Only the daemon subflow has one. */
  readonly doer?: OnboardingDoerId | undefined;
  readonly connection?: ConnectionMethodId | undefined;
}

/** The keys a payload may carry, so an unknown one is refused rather than ignored. */
const FIELDS = ['route', 'step', 'target', 'doer', 'connection'] as const;

/**
 * The payload, as it appears after the `=`.
 *
 * Semicolons rather than JSON: this is read aloud, typed by hand and printed
 * inside a QR whose size grows with every character, and a base64 blob is three
 * of those things done badly. NAMED rather than positional since `v2` — five
 * fields of which three are optional cannot be read by counting, and the reader
 * about to open this on their laptop can still see that it says `first-time`,
 * `this`, `self` and `install` and nothing else.
 */
export const encodeSetupHandoff = (handoff: SetupHandoff): string =>
  [
    SETUP_HANDOFF_VERSION,
    `route=${handoff.route}`,
    ...(handoff.target === undefined ? [] : [`target=${handoff.target}`]),
    ...(handoff.doer === undefined ? [] : [`doer=${handoff.doer}`]),
    `step=${handoff.step}`,
    ...(handoff.connection === undefined ? [] : [`connection=${handoff.connection}`]),
  ].join(';');

/** The named fields of a payload, or nothing if any token is not exactly one field. */
const payloadFields = (raw: string): Map<string, string> | undefined => {
  const [version, ...tokens] = raw.split(';');
  if (version !== SETUP_HANDOFF_VERSION) return undefined;
  const fields = new Map<string, string>();
  for (const token of tokens) {
    const at = token.indexOf('=');
    const key = at < 0 ? '' : token.slice(0, at);
    if (!FIELDS.some(known => known === key) || fields.has(key)) return undefined;
    fields.set(key, token.slice(at + 1));
  }
  return fields;
};

/**
 * A payload, or nothing — never a partial one.
 *
 * PARSE, DO NOT VALIDATE, and refuse rather than repair. A link whose step is not
 * a step, or whose version is not this one, is not a hand-off with a typo in it;
 * it is something else, and guessing which journey its author meant would land a
 * reader somewhere nobody chose. The entry chooser is always a correct answer here.
 *
 * A FIELD THAT COULD NOT MATTER IS A REFUSAL, not something to drop quietly. The
 * pairing entry has no target, no doer and no carrier, and a daemon living on
 * another machine has no carrier to choose here either — so a payload carrying one
 * of those was not produced by this page, and the honest reading of a payload
 * nobody here wrote is that it is not a hand-off.
 */
export const parseSetupHandoff = (raw: string | null | undefined): SetupHandoff | undefined => {
  if (!raw) return undefined;
  const fields = payloadFields(raw);
  if (fields === undefined) return undefined;
  const route = fields.get('route');
  const step = fields.get('step');
  if (!isOnboardingRouteId(route) || !isOnboardingStepId(step)) return undefined;
  const target = fields.get('target');
  const doer = fields.get('doer');
  const connection = fields.get('connection');
  if (target !== undefined && (!isSetupTargetId(target) || !isDaemonRouteId(route))) return undefined;
  if (doer !== undefined && (!isOnboardingDoerId(doer) || !isDaemonRouteId(route))) return undefined;
  if (connection !== undefined && (!isConnectionMethodId(connection) || target !== 'this')) return undefined;
  return {
    route,
    step,
    ...(target === undefined ? {} : { target }),
    ...(doer === undefined ? {} : { doer }),
    ...(connection === undefined ? {} : { connection }),
  };
};

/**
 * The hand-off carried by a URL's fragment, if it carries one.
 *
 * Reads the fragment as key/value pairs so a pairing fragment — which has no `=`
 * and means something entirely different — can never be mistaken for one of these.
 */
export const setupHandoffFromHref = (href: string): SetupHandoff | undefined => {
  let hash: string;
  try {
    hash = new URL(href).hash;
  } catch {
    return undefined;
  }
  if (!hash.startsWith('#')) return undefined;
  const found = new URLSearchParams(hash.slice(1)).get(SETUP_HANDOFF_KEY);
  return parseSetupHandoff(found);
};

/**
 * The link to put in front of the other device.
 *
 * Built from THIS page's own address rather than from a constant, because the
 * origin is a deployment fact — there is no hosted address baked into this
 * bundle, and there must not be. Query and fragment are dropped: whatever brought
 * this reader here is not what the other device should replay.
 */
export const setupHandoffUrl = (href: string, handoff: SetupHandoff): string => {
  const url = new URL('/setup', href);
  url.hash = `${SETUP_HANDOFF_KEY}=${encodeSetupHandoff(handoff)}`;
  return url.toString();
};

/**
 * The same link with the place stripped off — the one a human can retype.
 *
 * A reader who is copying this off a phone screen onto a laptop keyboard should
 * not have to transcribe `#fy-setup=v2;route=first-time;target=this;doer=self;step=install`
 * correctly, and they do not need to: the bare setup page asks the same question,
 * and answering it by hand costs two taps. Offered BESIDE the full link, never
 * instead of it.
 */
export const setupPageUrl = (href: string): string => new URL('/setup', href).toString();

/**
 * Where a hand-off actually lands, once the receiving device has had its say.
 *
 * THE SENDER KNOWS WHAT IT MEANT; ONLY THE RECEIVER KNOWS WHAT IT IS, and the two
 * disagreements this has to survive are not the same:
 *
 * - A LINK PROPOSING SOMETHING THE HARDWARE FORBIDS loses. A stale or hostile
 *   payload telling a phone that it runs the daemon proposes the one thing a phone
 *   can never do, so the phone keeps its own forced answer and lands on the screen
 *   that hands the daemon half to a computer. Refusing outright would drop
 *   somebody who is mid-setup back to the beginning over a field they never typed.
 * - A LINK THAT DOES NOT SAY ENOUGH ASKS. A payload with no doer names a journey
 *   whose steps are not decided yet, and inventing one would be exactly the
 *   damaged-state-as-empty-state mistake — so the reader is asked that question,
 *   with everything the link DID say already answered.
 */
export type SetupLanding =
  | { readonly kind: 'walk'; readonly journey: OnboardingJourney; readonly step: OnboardingStepId }
  | {
      readonly kind: 'ask';
      readonly question: 'target' | 'doer';
      readonly route: OnboardingDaemonRouteId;
      readonly target?: SetupTargetId | undefined;
    };

/** The journey a landing walks, opened at the proposed step when that step is really on it. */
const walkFrom = (journey: OnboardingJourney, device: DeviceKind, step: OnboardingStepId): SetupLanding => {
  const path: OnboardingPath = { ...journey, device };
  return { kind: 'walk', journey, step: isStepOfRoute(path, step) ? step : firstOnboardingStep(path) };
};

export const landSetupHandoff = (handoff: SetupHandoff, device: DeviceKind): SetupLanding => {
  const route = handoff.route;
  if (!isDaemonRouteId(route)) return walkFrom({ route }, device, handoff.step);
  const presumed = presumedTarget(route, device);
  /* The device's own answer wins whenever the proposed one is impossible here. */
  const target = handoff.target !== undefined && isTargetPossible(handoff.target, device) ? handoff.target : presumed;
  if (target === undefined) return { kind: 'ask', question: 'target', route };
  if (handoff.doer === undefined) return { kind: 'ask', question: 'doer', route, target };
  return walkFrom(
    {
      route,
      target,
      doer: handoff.doer,
      ...(handoff.connection === undefined || target !== 'this' ? {} : { connection: handoff.connection }),
    },
    device,
    handoff.step,
  );
};

/**
 * The QR, as a grid of dark/light modules.
 *
 * Returned as data rather than as markup so the component owns every pixel: the
 * library's own `createSvgTag` hardcodes black on white, which is a hole punched
 * through the dark theme, and an `<img>` of a data URL cannot inherit a token.
 * Error correction is `M` — the QR is read off a lit screen at arm's length, not
 * off a printed label under a forklift, and every level above `M` costs modules
 * that make the picture denser and therefore harder for a cheap camera.
 *
 * Type number 0 lets the library pick the smallest version the text fits in, so a
 * short link stays a coarse, easily-read QR instead of being padded into a fine one.
 */
export const qrModules = (text: string): readonly (readonly boolean[])[] => {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_row, row) =>
    Array.from({ length: size }, (_column, column) => code.isDark(row, column)),
  );
};
