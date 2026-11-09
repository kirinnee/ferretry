/**
 * Onboarding's two screens. `onboarding` (path `/onboarding`) is DAEMON-LESS: the first run, drawn with no client
 * before any daemon is paired. `steps` is per machine: every step the plugins declared, each with the panels they
 * contributed to the `onboarding.step` slot. The shell draws neither: it only sends a device with no daemon here.
 */

import {
  daemonHomeHref,
  daemonOfClient,
  type DaemonlessPorts,
  type DaemonlessScreenProps,
  PanelSlot,
} from '@ferretry/app';
import { browserClipboardWriter, Button } from '@ferretry/app/ui';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ONBOARDING_STEP_SLOT, type OnboardingView, stepSubject, type StepState } from '../../contract/index.ts';
import { detectDeviceKind } from '../device-kind.ts';
import { detectInstallChannel } from '../onboarding-model.ts';
import { OnboardingPage } from '../onboarding-page.tsx';
import { OnboardingProgressStore } from '../onboarding-progress.ts';
import { onboardingScreen } from '../onboarding-screen.ts';
import { CHECKING_HOSTED_RELAY } from '../pending-connections.ts';
import { setupHandoffFromHref } from '../setup-handoff.ts';
import type { SetupSharePort } from '../setup-handoff-panel.tsx';

/** Where Access draws its pairing screen: first contact with a daemon is Access's, never Onboarding's. */
export const PAIR_PATH = '/pair';

/** The OS share sheet, when this browser has one. Absent is the ordinary case. */
export const browserSetupShare = (
  host: { readonly share?: Navigator['share'] } = navigator,
): SetupSharePort | undefined => {
  const share = host.share;
  return typeof share === 'function' ? async payload => await share.call(navigator, payload) : undefined;
};

/**
 * The pairing step. Onboarding cannot draw Access's pairing screen (it imports nothing of Access), so the step says
 * what to do and opens `/pair`, Access's own page. A pairing is noticed here too: when the paired list gains a machine
 * the journey is finished. No code passes through this component — the pairing page takes its own from the address.
 */
function PairingHandoff({
  ports,
  navigate,
  onPaired,
}: {
  readonly ports: DaemonlessPorts;
  readonly navigate: DaemonlessScreenProps['navigate'];
  readonly onPaired: () => void;
}): ReactNode {
  const known = useRef(ports.daemons.snapshot().daemons.length);
  useEffect(
    () =>
      ports.daemons.subscribe(() => {
        const now = ports.daemons.snapshot().daemons.length;
        if (now > known.current) onPaired();
        known.current = now;
      }),
    [ports, onPaired],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-onboarding-pairing="">
      <p className="m-0 text-cell text-muted">
        Open the pairing page, then scan the code <code>fy pair</code> shows, or paste the link it prints.
      </p>
      <Button type="button" variant="primary" onClick={() => navigate(PAIR_PATH)} data-onboarding-open-pair="">
        Open the pairing page
      </Button>
    </div>
  );
}

/** `/onboarding`: the first-run page, wired to this device and to the paired list. */
export function createOnboardingRoute(ports: DaemonlessPorts) {
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
      if (selected !== null) navigate(`${daemonHomeHref(selected)}/onboarding/steps`);
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
        renderPairing={({ onPaired }) => <PairingHandoff ports={ports} navigate={navigate} onPaired={onPaired} />}
      />
    );
  };
}

const STATE_LABEL: Readonly<Record<StepState, string>> = {
  pending: 'Not looked at yet',
  found: 'Already set up',
  later: 'Left for later',
  done: 'Done',
  skipped: 'Skipped',
};

/** Reads the steps now and again whenever any step changes anywhere. */
function useOnboardingView(client: PluginClient): OnboardingView | null {
  const screen = useMemo(() => onboardingScreen(client), [client]);
  const [view, setView] = useState<OnboardingView | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      screen.load().then(
        next => {
          if (live) setView(next);
        },
        () => undefined,
      );
    };
    load();
    const stop = screen.subscribe(load);
    return () => {
      live = false;
      stop();
    };
  }, [screen]);
  return view;
}

/** `/d/<machine>/onboarding/steps`: every declared step, with the panels the plugins contributed to it. */
export function createStepsScreen(client: PluginClient) {
  const screen = onboardingScreen(client);
  return function StepsScreen(_props: ScreenProps): ReactNode {
    const daemon = daemonOfClient(client);
    const view = useOnboardingView(client);
    const answer = useCallback((plugin: string, step: string, state: Exclude<StepState, 'pending'>) => {
      void screen.answer(plugin, step, { state }).catch(() => undefined);
    }, []);
    if (daemon === undefined || view === null)
      return (
        <p role="status" className="m-0 p-4 text-cell text-muted">
          Loading the setup steps…
        </p>
      );
    return (
      <section className="mx-auto flex w-full max-w-[560px] flex-col gap-3 p-3" data-onboarding-steps="">
        <h1 className="m-0 text-title font-semibold">Set up this machine</h1>
        {view.steps.length === 0 ? (
          <p className="m-0 text-cell text-muted" data-onboarding-no-steps="">
            Nothing needs setting up here.
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {view.steps.map(step => (
              <li
                key={`${step.plugin}.${step.id}`}
                className="kt-panel flex flex-col gap-2 p-3"
                data-step={stepSubject(step.plugin, step.id)}
              >
                <h2 className="m-0 text-cell font-semibold">
                  {step.title} <span className="text-meta font-normal text-muted">{STATE_LABEL[step.state]}</span>
                </h2>
                <PanelSlot daemon={daemon} slot={ONBOARDING_STEP_SLOT} subject={stepSubject(step.plugin, step.id)} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => answer(step.plugin, step.id, 'done')}
                    data-step-done=""
                  >
                    Done
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => answer(step.plugin, step.id, 'later')}
                    data-step-later=""
                  >
                    Later
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => answer(step.plugin, step.id, 'skipped')}
                    data-step-skip=""
                  >
                    Skip
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <a href={daemonHomeHref(daemon)} className="text-cell" data-onboarding-open-machine="">
          Open this machine
        </a>
      </section>
    );
  };
}
