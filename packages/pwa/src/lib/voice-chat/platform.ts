/**
 * WHERE A PAGE MAY NOT OPEN THE MICROPHONE BY ITSELF. iOS Safari only starts audio capture from a tap, so
 * after a reply has been read Live cannot count on reopening the microphone alone there: it shows a one-tap
 * "Listen" instead. This is a CAUTIOUS GUESS from the user agent — unproven on a real iPhone (see
 * docs/voice.md › Live voice › Proving it on an iPhone) — and a wrong "no" is covered anyway: a refused
 * automatic reopen falls back to the same "Listen" (`live-machine.ts`).
 *
 * Total: any shape of `navigator`, or none, gives a boolean.
 */

export interface PlatformLike {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

export function needsTapToListen(nav: PlatformLike | undefined | null): boolean {
  if (nav === undefined || nav === null) return false;
  const agent = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  if (/iPhone|iPad|iPod/u.test(agent)) return true;
  // An iPad asking for the desktop site calls itself a Mac, but a Mac has no touch screen.
  return nav.platform === 'MacIntel' && typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1;
}
