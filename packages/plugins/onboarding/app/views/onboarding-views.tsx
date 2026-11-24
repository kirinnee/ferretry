/**
 * Onboarding's two screens. `onboarding` (path `/onboarding`) is DAEMON-LESS: the first run, drawn with no client
 * before any daemon is paired. `steps` is per machine: every step the plugins declared, each with the panels they
 * contributed to the `onboarding.step` slot (drawn by `./steps-screen.tsx`, re-exported here with the Setup settings
 * tab that opens it). The shell draws neither: it only sends a device with no daemon here.
 */

export { createStepsOpener } from './steps-opener.tsx';
export { createSetupTab, createStepsScreen } from './steps-screen.tsx';
export { createStepperPanel } from '../features/stepper/stepper-panel.tsx';
export { createSetupFlow } from '../features/setup-flow/setup-flow.tsx';
export { createAppearancePanel, createNamePanel } from '../features/setup-flow/shell-pages-panels.tsx';
export { createAgentsPanel } from '../features/agents/agents-panel.tsx';
export { createPermissionsPanel } from '../features/permissions/permissions-panel.tsx';

import type { DaemonlessPorts, DaemonlessScreenProps } from '@ferretry/app';
import { ActionRow, browserClipboardWriter, Button } from '@ferretry/app/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectDeviceKind } from '../device-kind.ts';
import { flowHrefAfterPairing, entryFromHref } from '../onboarding-entry.ts';
import { detectInstallChannel, type OnboardingRouteId } from '../onboarding-model.ts';
import { OnboardingPage } from '../onboarding-page.tsx';
import { OnboardingProgressStore } from '../onboarding-progress.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback, settleHostedRelay } from '../hosted-relay-state.ts';
import {
  browserPairTripStorage,
  clearPairTrip,
  hasNewPairing,
  type PairTripStorage,
  pairingMarks,
  readPairTrip,
  rememberPairTrip,
} from '../pair-trip.ts';
import { setupHandoffFromHref } from '../setup-handoff.ts';
import type { SetupSharePort } from '../setup-handoff-panel.tsx';

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
 * What the first run remembers across its trip to `/pair`: which pairings it held when it left. In memory (one
 * per route) and, beside the place the journey keeps, in this browser's storage (`../pair-trip.ts`), so a reload on the
 * pairing page does not forget it. It never holds a code (the pairing page takes its own from the address).
 */
interface PairTrip {
  baseline: readonly string[] | undefined;
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
 * what to do and opens `/pair`, Access's own page, asking it to come back to `/onboarding`. The pairings held when
 * the person left are kept (memory and storage); on coming back, a pairing that was not among them — a new machine, a
 * machine paired again, or one that took the place of another at the limit — finishes the step and the journey goes
 * on to its next stage. A pairing seen while the step stays open (another tab: the one `fy pair --open` opens) does the
 * same, because the shell adopts the list another tab wrote. No code passes through this component — the pairing page
 * takes its own from the address.
 */
function PairingHandoff({
  ports,
  navigate,
  onPaired,
  trip,
  progress,
  storage,
}: {
  readonly progress: OnboardingProgressStore;
  readonly storage: PairTripStorage | undefined;
  readonly ports: DaemonlessPorts;
  readonly navigate: DaemonlessScreenProps['navigate'];
  readonly onPaired: () => void;
  readonly trip: PairTrip;
}): ReactNode {
  const known = useRef(
    new Set(trip.baseline ?? readPairTrip(storage) ?? pairingMarks(ports.daemons.snapshot().daemons)),
  );
  useEffect(() => {
    // The trip is over once the step is on the glass again: a later visit to this step starts from the list as it is.
    trip.baseline = undefined;
    clearPairTrip(storage);
    const look = (): void => {
      const { daemons } = ports.daemons.snapshot();
      if (hasNewPairing(daemons, known.current)) onPaired();
      known.current = new Set(pairingMarks(daemons));
    };
    look();
    return ports.daemons.subscribe(look);
  }, [ports, onPaired, trip, storage]);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-onboarding-pairing="">
      <p className="m-0 text-cell text-muted">
        Open the pairing page, then scan the code <code>fy pair</code> shows, or paste the link it prints.
      </p>
      <ActionRow
        primary={
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              trip.baseline = pairingMarks(ports.daemons.snapshot().daemons);
              rememberPairTrip(trip.baseline, storage);
              // The place is kept before leaving (a hand-off arrival is otherwise never written), so the return finds it.
              progress.remember();
              navigate(PAIR_AND_RETURN);
            }}
            data-onboarding-open-pair=""
          >
            Open the pairing page
          </Button>
        }
      />
    </div>
  );
}

/** `/onboarding`: the first-run page, wired to this device and to the paired list. */
export function createOnboardingRoute(ports: DaemonlessPorts) {
  const trip: PairTrip = { baseline: undefined };
  return function OnboardingRoute({ navigate, location }: DaemonlessScreenProps) {
    const device = useMemo(() => detectDeviceKind(navigator), []);
    // A hand-off carries a place (route and step) from another device: never a code or a credential.
    const [handoff] = useState(() => setupHandoffFromHref(location()));
    // `/onboarding?journey=pair|add-daemon` (the app's own links) opens that journey without the start screen.
    const [entry] = useState(() => entryFromHref(location()));
    const [progress] = useState(
      () =>
        new OnboardingProgressStore({
          device,
          ...(handoff === undefined ? {} : { handoff }),
          ...(entry === undefined ? {} : { entry }),
        }),
    );
    const channel = useMemo(() => detectInstallChannel(navigator.userAgent), []);
    const write = useMemo(() => browserClipboardWriter(), []);
    const href = useMemo(() => location().replace(/#.*$/u, ''), [location]);
    const share = useMemo(() => browserSetupShare(), []);
    const tripStorage = useMemo(() => browserPairTripStorage(), []);
    const [fallback, setFallback] = useState<HostedRelayFallback>(CHECKING_HOSTED_RELAY);
    useEffect(() => {
      // The shell hands over what Connections already read: one answer, once (`settleHostedRelay` never rejects).
      void settleHostedRelay(ports.hostedRelay).then(setFallback);
    }, []);
    /*
     * THE DAEMON ANSWERED: this half is over. The machine that was just paired is the selected one (pairing selects it), so
     * the setup flow opens on it, on the half the journey asked for. The place is forgotten without redrawing the screen the
     * person is leaving, so there is no frame of the start screen between the two pages.
     */
    const handOff = useCallback(
      (route: OnboardingRouteId) => {
        const { selected: chosen, daemons } = ports.daemons.snapshot();
        const daemon = chosen ?? daemons.at(-1)?.daemon ?? null;
        if (daemon === null) return;
        progress.finish();
        navigate(flowHrefAfterPairing(daemon, route));
      },
      [navigate, progress],
    );
    return (
      <OnboardingPage
        progress={progress}
        write={write}
        channel={channel}
        fallback={fallback}
        href={href}
        share={share}
        onHandOff={handOff}
        renderPairing={({ onPaired }) => (
          <PairingHandoff
            ports={ports}
            navigate={navigate}
            onPaired={onPaired}
            trip={trip}
            progress={progress}
            storage={tripStorage}
          />
        )}
      />
    );
  };
}
