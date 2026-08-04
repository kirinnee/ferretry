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
 * THE TWO DIRECTIONS USE DIFFERENT CARRIERS, AND THAT IS NOT AN OVERSIGHT.
 *
 * - Computer → phone is a QR. The phone has a camera and the computer has a
 *   screen, so the phone reads the computer directly and nothing is typed.
 * - Phone → computer is NOT a QR, because a computer has no camera pointed at a
 *   phone. It is a link to copy, share, or read off the phone and type. The QR
 *   would look like the same mechanism and be useless, which is worse than
 *   offering the honest one.
 *
 * NOTHING IDENTIFYING TRAVELS. The payload is a route id, a step id and at most a
 * connection choice — three closed unions, all of them already public constants
 * in this bundle. No daemon address, no code, no token, no name. A hand-off link
 * is safe to photograph, and it has to be, because photographing it is the point.
 * A pairing code travels the OTHER way, from `fy pair`, and never through here.
 */

import qrcode from 'qrcode-generator';

import {
  type ConnectionMethodId,
  firstOnboardingStep,
  isConnectionMethodId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isStepOfRoute,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
} from './onboarding-model.ts';
import type { DeviceKind } from './device-kind.ts';

/** The fragment key. Distinct from the `#v1;` a pairing link uses — these are not the same claim. */
export const SETUP_HANDOFF_KEY = 'fy-setup';

/** The payload grammar's version, so a future shape can be refused rather than misread. */
export const SETUP_HANDOFF_VERSION = 'v1';

/** Where the other device should open, and what it should already have decided. */
export interface SetupHandoff {
  readonly route: OnboardingRouteId;
  readonly step: OnboardingStepId;
  readonly connection?: ConnectionMethodId | undefined;
}

/**
 * The payload, as it appears after the `=`.
 *
 * Semicolons rather than JSON: this is read aloud, typed by hand and printed
 * inside a QR whose size grows with every character, and a base64 blob is three
 * of those things done badly. It is also legible — somebody who is about to open
 * a link on their laptop can see that it says `first-time` and `install` and
 * nothing else.
 */
export const encodeSetupHandoff = (handoff: SetupHandoff): string =>
  [SETUP_HANDOFF_VERSION, handoff.route, handoff.step, ...(handoff.connection ? [handoff.connection] : [])].join(';');

/**
 * A payload, or nothing — never a partial one.
 *
 * PARSE, DO NOT VALIDATE, and refuse rather than repair. A link whose step is not
 * a step, or whose version is not this one, is not a hand-off with a typo in it;
 * it is something else, and guessing which route its author meant would land a
 * reader in a journey nobody chose. The chooser is always a correct answer here.
 */
export const parseSetupHandoff = (raw: string | null | undefined): SetupHandoff | undefined => {
  if (!raw) return undefined;
  const [version, route, step, connection, ...rest] = raw.split(';');
  if (version !== SETUP_HANDOFF_VERSION || rest.length > 0) return undefined;
  if (!isOnboardingRouteId(route) || !isOnboardingStepId(step)) return undefined;
  if (connection !== undefined && !isConnectionMethodId(connection)) return undefined;
  return { route, step, ...(connection === undefined ? {} : { connection }) };
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
 * not have to transcribe `#fy-setup=v1;first-time;install` correctly, and they do
 * not need to: the bare setup page asks the same question, and answering it by
 * hand costs one tap. Offered BESIDE the full link, never instead of it.
 */
export const setupPageUrl = (href: string): string => new URL('/setup', href).toString();

/**
 * Where a hand-off actually lands, once the receiving device has had its say.
 *
 * The sender knows what it meant; only the receiver knows what it is. A computer
 * handing `add-client` at `pair` to a phone is proposing a step that phone's route
 * really does have. A stale or hostile link proposing `install` to a phone is
 * proposing something a phone cannot do, and the honest landing is that route's
 * own first step — the reader still gets the route they were sent to, and never a
 * screen their device cannot act on.
 */
export const landSetupHandoff = (
  handoff: SetupHandoff,
  device: DeviceKind,
): { readonly path: OnboardingPath; readonly step: OnboardingStepId } => {
  const path: OnboardingPath = { route: handoff.route, device, connection: handoff.connection };
  return { path, step: isStepOfRoute(path, handoff.step) ? handoff.step : firstOnboardingStep(path) };
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
