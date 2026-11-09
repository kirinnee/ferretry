/**
 * Onboarding's two screens. `onboarding` (path `/onboarding`) is DAEMON-LESS: the first run, drawn with no client
 * before any daemon is paired. `steps` is per machine: every step the plugins declared, each with the panels they
 * contributed to the `onboarding.step` slot (drawn by `./steps-screen.tsx`, re-exported here with the Setup settings
 * tab that opens it). The shell draws neither: it only sends a device with no daemon here.
 */

export { createStepsOpener } from './steps-opener.tsx';
export { createSetupTab, createStepsScreen } from './steps-screen.tsx';

import { type DaemonlessPorts, type DaemonlessScreenProps } from '@ferretry/app';
import { browserClipboardWriter, Button } from '@ferretry/app/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { detectDeviceKind } from '../device-kind.ts';
import { detectInstallChannel } from '../onboarding-model.ts';
import { OnboardingPage } from '../onboarding-page.tsx';
import { OnboardingProgressStore } from '../onboarding-progress.ts';
import { CHECKING_HOSTED_RELAY } from '../pending-connections.ts';
import { setupHandoffFromHref } from '../setup-handoff.ts';
import type { SetupSharePort } from '../setup-handoff-panel.tsx';
import { stepsHref } from './steps-screen.tsx';

/** Where Access draws its pairing screen: first contact with a daemon is Access's, never Onboarding's. */
export const PAIR_PATH = '/pair';

/** The first run's own address: where a pairing from the first run asks to land (a plain path, never a code). */
export const ONBOARDING_PATH = '/onboarding';

/**
 * What the first run opens to pair: Access's page, asked to come back HERE once a machine is paired, so the person
 * returns to the journey (the "it worked" stage and Open your fleet) rather than being sent to a machine's home.
 */
export const PAIR_AND_RETURN = `${PAIR_PATH}?return=${encodeURIComponent(ONBOARDING_PATH)}`;

/**
 * What the first run remembers across its trip to `/pair`: how many machines were paired when it left. In memory, one
 * per route, gone on a reload; it never holds a code (the pairing page takes its own from the address).
 */
interface PairTrip {
  baseline: number | undefined;
}

/** The OS share sheet, when this browser has one. Absent is the ordinary case. */
export const browserSetupShare = (
  host: { readonly share?: Navigator['share'] } = navigator,
): SetupSharePort | undefined => {
  const share = host.share;
  return typeof share === 'function' ? async payload => await share.call(navigator, payload) : undefined;
};

/**
 * The pairing step. Onboarding cannot draw Access's pairing screen (it imports nothing of Access), so the step says
 * what to do and opens `/pair`, Access's own page, asking it to come back to `/onboarding`. The count of machines when
 * the person left is kept (in memory); on coming back, a machine more than that finishes the step and the journey goes
 * on to its next stage. A pairing seen while the step stays open (another tab) does the same. No code passes through
 * this component — the pairing page takes its own from the address.
 */
function PairingHandoff({
  ports,
  navigate,
  onPaired,
  trip,
  progress,
}: {
  readonly progress: OnboardingProgressStore;
  readonly ports: DaemonlessPorts;
  readonly navigate: DaemonlessScreenProps['navigate'];
  readonly onPaired: () => void;
  readonly trip: PairTrip;
}): ReactNode {
  const known = useRef(trip.baseline ?? ports.daemons.snapshot().daemons.length);
  useEffect(() => {
    // The trip is over once the step is on the glass again: a later visit to this step starts from the list as it is.
    trip.baseline = undefined;
    const look = (): void => {
      const now = ports.daemons.snapshot().daemons.length;
      if (now > known.current) onPaired();
      known.current = now;
    };
    look();
    return ports.daemons.subscribe(look);
  }, [ports, onPaired, trip]);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-onboarding-pairing="">
      <p className="m-0 text-cell text-muted">
        Open the pairing page, then scan the code <code>fy pair</code> shows, or paste the link it prints.
      </p>
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          trip.baseline = ports.daemons.snapshot().daemons.length;
          // The place is kept before leaving (a hand-off arrival is otherwise never written), so the return finds it.
          progress.remember();
          navigate(PAIR_AND_RETURN);
        }}
        data-onboarding-open-pair=""
      >
        Open the pairing page
      </Button>
    </div>
  );
}

/** `/onboarding`: the first-run page, wired to this device and to the paired list. */
export function createOnboardingRoute(ports: DaemonlessPorts) {
  const trip: PairTrip = { baseline: undefined };
  return function OnboardingRoute({ navigate, location }: DaemonlessScreenProps) {
    const paired = useSyncExternalStore(ports.daemons.subscribe, ports.daemons.snapshot, ports.daemons.snapshot);
    const device = useMemo(() => detectDeviceKind(navigator), []);
    // A hand-off carries a place (route and step) from another device: never a code or a credential.
    const [handoff] = useState(() => setupHandoffFromHref(location()));
    const [progress] = useState(
      () =>
        new OnboardingProgressStore({
          device,
          paired: paired.daemons.length > 0,
          ...(handoff === undefined ? {} : { handoff }),
        }),
    );
    const channel = useMemo(() => detectInstallChannel(navigator.userAgent), []);
    const write = useMemo(() => browserClipboardWriter(), []);
    const href = useMemo(() => location().replace(/#.*$/u, ''), [location]);
    const share = useMemo(() => browserSetupShare(), []);
    const selected = paired.selected;
    const openFleet = useCallback(() => {
      if (selected !== null) navigate(stepsHref(selected));
    }, [navigate, selected]);
    return (
      <OnboardingPage
        progress={progress}
        write={write}
        channel={channel}
        fleetReady={selected !== null}
        fallback={CHECKING_HOSTED_RELAY}
        href={href}
        share={share}
        onOpenFleet={openFleet}
        renderPairing={({ onPaired }) => (
          <PairingHandoff ports={ports} navigate={navigate} onPaired={onPaired} trip={trip} progress={progress} />
        )}
      />
    );
  };
}
