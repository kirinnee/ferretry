/**
 * WHERE A VISIT TO THE FIRST-RUN PAGE ASKS TO START, and where it sends the person when the daemon answers. Plain values,
 * so the page's address, the app's own links ("Pair a device", "Set up a new daemon" in the daemon list) and the hand-off
 * all say the same words.
 *
 * `/onboarding?journey=pair|add-daemon|first-time` opens that journey without the start screen (the person already said
 * which one by clicking the link). An unknown or missing word is no answer, never an error. The setup flow's own words for
 * the same three journeys are `first-time`, `pair` and `add-daemon` (`features/setup-flow/flow-href.ts`).
 */
import { setupFlowHref } from './features/setup-flow/flow-href.ts';
import type { OnboardingRouteId } from './onboarding-model.ts';
import type { SetupHandoff } from './setup-handoff.ts';

/** The start screen's three answers, by the word the address carries for each. */
const JOURNEY_WORDS: Readonly<Record<string, OnboardingRouteId>> = Object.freeze({
  'first-time': 'first-time',
  pair: 'add-client',
  'add-daemon': 'add-daemon',
});

/** The place an address asks to start on, or nothing when it asks for none. */
export const entryFromHref = (href: string): SetupHandoff | undefined => {
  let word: string | null;
  try {
    word = new URL(href).searchParams.get('journey');
  } catch {
    return undefined;
  }
  if (word === null || !Object.hasOwn(JOURNEY_WORDS, word)) return undefined;
  const route = JOURNEY_WORDS[word];
  if (route === undefined) return undefined;
  return { route, step: route === 'add-client' ? 'pair' : 'install' };
};

/**
 * The setup flow's address once the daemon has answered: the machine's own steps after First time and Set up a new
 * daemon, and this device's own after a Pair (a machine that was only paired is already set up).
 */
export const flowHrefAfterPairing = (daemon: string, route: OnboardingRouteId): string =>
  route === 'add-client'
    ? setupFlowHref(daemon, { phase: 'client', journey: 'pair' })
    : setupFlowHref(daemon, { phase: 'daemon', journey: route });
