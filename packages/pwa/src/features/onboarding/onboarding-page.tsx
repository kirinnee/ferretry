/**
 * FIRST RUN: one question, then one of three different journeys.
 *
 * A cold visitor has installed nothing, so a "Connect a daemon" screen with a QR
 * button asks them to do something they cannot do yet. But a visitor whose phone
 * just scanned a QR has the opposite problem: an install step asks them to do
 * something they do not need. So this screen asks WHICH OF THOSE THEY ARE first,
 * and each answer walks its own list of steps — not one stepper with steps hidden
 * inside it, which is how you get two readers out of three following
 * instructions that are not theirs.
 *
 * THREE RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE PAGE CANNOT SEE THE TERMINAL. It is static, public, and has no way to
 *    know whether `fy` installed or the daemon came up. So `Next` is never
 *    blocked and no control claims a check it did not make; an honest "when that
 *    finishes, continue" beats a spinner that is lying.
 * 2. LOSING SOMEONE'S PLACE IS THE CHEAPEST WAY TO FEEL BROKEN. Setup happens
 *    across a browser and a terminal, with minutes or hours in between, so the
 *    route AND the step are persisted (`OnboardingProgressStore`) and any step
 *    already reached stays one tap away.
 * 3. ONE LOUD CONTROL PER STEP. Everything a reader can do is not equally
 *    important, and a screen where four controls shout is a screen with no next
 *    action. `Next` is the only filled button; back, copy and the disclosures are
 *    quiet until wanted. This is an accessibility property, not a taste one.
 *
 * WHAT LIVES ELSEWHERE. The question is `onboarding-chooser.tsx`, the stages are
 * `onboarding-stages.tsx`, the track is `onboarding-track.tsx`, the picture of
 * the arrangement is `setup-diagram.tsx`. This file owns only the frame: which
 * screen is on the glass, where focus goes when that changes, and how the screen
 * behaves under a software keyboard.
 *
 * Layout note: nothing here sizes itself against the viewport. It renders inside
 * the shell's existing `kt-shell` scroller, which is already driven by `--app-h`
 * from `useAppViewport`; a `100dvh` in this file would be a second, competing
 * answer to the same question when the keyboard opens.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef, useSyncExternalStore } from 'react';

import { useKeyboardOpen } from '../../hooks/use-keyboard-open.ts';
import type { ClipboardWriter } from './copy-button.tsx';
import { OnboardingBrand } from './onboarding-brand.tsx';
import { OnboardingChooser } from './onboarding-chooser.tsx';
import { OnboardingConnectionChooser } from './onboarding-connection-chooser.tsx';
import {
  type ConnectionMethodId,
  type InstallChannelId,
  nextOnboardingStep,
  type OnboardingStepId,
  onboardingRoute,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  previousOnboardingStep,
} from './onboarding-model.ts';
import type { OnboardingProgressStore, OnboardingWalking } from './onboarding-progress.ts';
import {
  BriefStage,
  DaemonStage,
  DoneStage,
  InstallStage,
  PairStage,
  RelayAllowStage,
  RelayDeployStage,
  RelayFingerprintStage,
  RelaySourceStage,
  ScanStage,
} from './onboarding-stages.tsx';
import { OnboardingTrack } from './onboarding-track.tsx';
import { SetupDiagram } from './setup-diagram.tsx';

const SHELL =
  'mx-auto flex min-h-full w-full max-w-[560px] flex-col gap-3 py-5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-8';

export interface OnboardingPairingHost {
  /** The daemon answered and this browser is paired; the journey is finished. */
  readonly onPaired: () => void;
}

export interface OnboardingPageProps {
  readonly progress: OnboardingProgressStore;
  readonly write: ClipboardWriter;
  /** The install route to show first. A guess; every other route stays one tap away. */
  readonly channel: InstallChannelId;
  /** The real pairing screen, wired by the composition root. */
  readonly renderPairing: (host: OnboardingPairingHost) => ReactNode;
  readonly onOpenFleet: () => void;
  /** Whether there is a paired daemon for the final action to open. */
  readonly fleetReady: boolean;
}

/**
 * Waits for the shell's keyboard-sized layout, then keeps its focused control in
 * view. Exported as the narrow effect seam so its geometry can be exercised
 * without making unrelated DOM suites race over the process-wide `<html>`
 * keyboard attribute.
 */
export const scheduleFocusedOnboardingControl = (root: HTMLElement | null): (() => void) | undefined => {
  const view = root?.ownerDocument.defaultView;
  if (root === null || view === null || view === undefined) return undefined;
  const frame = view.requestAnimationFrame(() => {
    const focused = root.ownerDocument.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) {
      focused.scrollIntoView({ block: 'center' });
    }
  });
  return () => view.cancelAnimationFrame(frame);
};

export function OnboardingPage({
  progress,
  write,
  channel,
  renderPairing,
  onOpenFleet,
  fleetReady,
}: OnboardingPageProps) {
  const at = useSyncExternalStore(progress.subscribe, progress.snapshot);
  /* One key for "which screen is on the glass", chooser included, so focus can follow it. */
  const screen = at.stage === 'choose' ? 'choose' : at.current;

  /*
   * FOCUS FOLLOWS A REAL SCREEN CHANGE, NOT THE FIRST PAINT.
   *
   * Swapping the stage is a navigation with no page load behind it: the control
   * that was pressed unmounts, focus falls back to `<body>`, and a reader
   * restarts from the top of the document. Moving focus to the new heading
   * restores what a real navigation would have given. The previous screen is
   * seeded during render rather than latched in an effect, because StrictMode
   * replays mount effects and an effect-owned latch mistakes that replay for a
   * navigation — stealing focus from whatever the browser had already placed.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  const previousScreen = useRef(screen);
  useEffect(() => {
    if (previousScreen.current === screen) return;
    previousScreen.current = screen;
    heading.current?.focus();
  }, [screen]);

  /*
   * A KEYBOARD MUST NOT SWALLOW THE FIELD IT BELONGS TO.
   *
   * The pairing link is near the bottom of a stage that is taller than a phone,
   * so the keyboard opening leaves the reader typing into something they cannot
   * see. `useKeyboardOpen` observes the SAME `data-keyboard` attribute the
   * stylesheet keys off — no second measurement of the viewport — and once it
   * flips, whatever is focused inside this screen is scrolled back into the
   * shell's own scroller. `block: 'center'` rather than 'nearest' so the label
   * and any error under the field come with it, and no smooth scrolling, which
   * is both pointless here and unwelcome under reduced motion.
   */
  const root = useRef<HTMLElement>(null);
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (!keyboardOpen) return;
    /*
     * ONE FRAME LATER, ON PURPOSE. The attribute is written in the same commit
     * that shortens the shell, so scrolling immediately measures the layout the
     * keyboard has not shrunk yet, concludes the field is already visible, and
     * does nothing — leaving the reader typing below the fold. Waiting for the
     * next frame measures the geometry they can actually see.
     */
    return scheduleFocusedOnboardingControl(root.current);
  }, [keyboardOpen]);

  return (
    <main
      ref={root}
      className={SHELL}
      aria-labelledby="onboarding-title"
      data-onboarding="setup"
      data-onboarding-screen={screen}
      data-onboarding-route={at.stage === 'choose' ? 'none' : at.route}
    >
      {/*
        `data-kb-hide` is legal here and nowhere else on this screen: the brand
        and the diagram are stateless chrome with no focus, no overlay and no
        state to lose. The track, the active stage and its actions must all
        survive an open keyboard.
      */}
      <header className="flex min-w-0 flex-col gap-2" data-kb-hide>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <h1 id="onboarding-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
            Set up Ferretry
          </h1>
          <OnboardingBrand />
        </div>
        {/*
          The picture replaces the paragraph that used to say the same thing:
          your machine does the work, this page is a window onto it. It is absent
          from the chooser on purpose — that screen's job is three answers, and a
          diagram of a journey nobody has chosen yet is decoration.
        */}
        {at.stage === 'choose' ? null : <SetupDiagram step={at.current} />}
      </header>

      {at.stage === 'choose' ? (
        <OnboardingChooser
          onChoose={route => {
            progress.choose(route);
          }}
        />
      ) : (
        <RouteFlow
          at={at}
          heading={heading}
          write={write}
          channel={channel}
          renderPairing={renderPairing}
          onOpenFleet={onOpenFleet}
          fleetReady={fleetReady}
          onGoTo={step => {
            progress.goTo(step);
          }}
          onChooseConnection={connection => {
            progress.chooseConnection(connection);
          }}
          onLeaveRoute={() => {
            progress.backToChooser();
          }}
        />
      )}
    </main>
  );
}

interface RouteFlowProps {
  readonly at: OnboardingWalking;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  readonly renderPairing: (host: OnboardingPairingHost) => ReactNode;
  readonly onOpenFleet: () => void;
  readonly fleetReady: boolean;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onChooseConnection: (connection: ConnectionMethodId) => void;
  /** Back out of the route entirely, to the question. */
  readonly onLeaveRoute: () => void;
}

/**
 * One route being walked: its track, its current stage, and the way onward.
 *
 * The TRACK IS HIDDEN on a two-step route. A rail reading "Pair · Done" tells
 * somebody who arrived holding a link nothing they did not know, and it costs
 * them a row of a 390px screen to say it.
 */
function RouteFlow({
  at,
  heading,
  write,
  channel,
  renderPairing,
  onOpenFleet,
  fleetReady,
  onGoTo,
  onChooseConnection,
  onLeaveRoute,
}: RouteFlowProps) {
  const route = onboardingRoute(at.route);
  const step = onboardingStep(at.current);
  const count = onboardingStepCount(at.route, at.connection);
  const position = onboardingStepIndex(at.route, at.current, at.connection);
  const first = position === 0;
  const pairing = renderPairing({ onPaired: () => onGoTo('done') });
  return (
    <>
      {count > 2 && (
        <OnboardingTrack
          route={at.route}
          connection={at.connection}
          current={at.current}
          furthest={at.furthest}
          onJump={onGoTo}
        />
      )}

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-step-title">
        <div className="min-w-0">
          <p className="m-0 text-2xs font-semibold uppercase tracking-label text-faint">
            {route.title} · step {position + 1} of {count}
          </p>
          <h2
            id="onboarding-step-title"
            ref={heading}
            tabIndex={-1}
            className="m-0 font-display text-title font-bold tracking-display text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
          >
            {step.title}
          </h2>
          <p className="m-0 text-meta leading-base text-muted">{step.summary}</p>
        </div>

        <Stage
          at={at}
          write={write}
          channel={channel}
          pairing={pairing}
          fleetReady={fleetReady}
          onOpenFleet={onOpenFleet}
          onGoTo={onGoTo}
          onChooseConnection={onChooseConnection}
        />
      </section>

      {at.current === 'done' ? null : (
        <div className="mt-auto flex min-w-0 flex-col gap-1 pt-2">
          <p className="m-0 text-2xs leading-base text-faint">{ADVANCE_NOTE[at.current]}</p>
          <div className="flex min-w-0 items-center gap-2">
            {/*
              BACK ALWAYS GOES SOMEWHERE. On the first step of a route the place
              behind it is the question itself, which is the one screen a reader
              needs when they picked the wrong answer — and picking the wrong
              answer is a thing a three-way choice must survive.
            */}
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-variant="ghost"
              onClick={first ? onLeaveRoute : () => onGoTo(previousOnboardingStep(at.route, at.current, at.connection))}
              data-onboarding-back={first ? 'chooser' : 'step'}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back
            </button>
            {/*
              NEXT EXISTS ONLY WHERE THE PAGE CANNOT CHECK.
              Install, the daemon and `fy pair` happen in a terminal
              this page will never see, so blocking on them would block forever.
              Pairing is the opposite: the daemon answers, in this tab, and that
              answer is the only thing that may declare the journey finished. A
              Next button here would manufacture a "you are set up" for a browser
              that is paired with nothing.
            */}
            {at.current !== 'scan' && at.current !== 'connect' && (
              <button
                type="button"
                className="kt-btn ml-auto min-h-[44px] flex-1"
                data-variant="primary"
                onClick={() => onGoTo(nextOnboardingStep(at.route, at.current, at.connection))}
                data-onboarding-next=""
              >
                Next
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface StageProps {
  readonly at: OnboardingWalking;
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  readonly pairing: ReactNode;
  readonly fleetReady: boolean;
  readonly onOpenFleet: () => void;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onChooseConnection: (connection: ConnectionMethodId) => void;
}

/**
 * The step's body, and the ONE place a route changes what a step means.
 *
 * `scan` is shared by every route that has a fresh pairing code. The command is
 * always its own preceding step, except for "I have a link", where somebody
 * else already ran it on the computer that produced the code.
 */
function Stage({ at, write, channel, pairing, fleetReady, onOpenFleet, onGoTo, onChooseConnection }: StageProps) {
  switch (at.current) {
    case 'install':
      return <InstallStage write={write} channel={channel} />;
    case 'daemon':
      return <DaemonStage write={write} />;
    case 'connect':
      return <OnboardingConnectionChooser onChoose={onChooseConnection} />;
    case 'relay-fingerprint':
      return <RelayFingerprintStage write={write} />;
    case 'relay-source':
      return <RelaySourceStage write={write} />;
    case 'relay-allow':
      return <RelayAllowStage />;
    case 'relay-deploy':
      return <RelayDeployStage write={write} />;
    case 'brief':
      return <BriefStage write={write} />;
    case 'pair':
      return <PairStage write={write} />;
    case 'scan':
      return <ScanStage pairing={pairing} />;
    case 'done':
      return <DoneStage fleetReady={fleetReady} onOpenFleet={onOpenFleet} onBackToPairing={() => onGoTo('scan')} />;
  }
}

/**
 * What the reader is told about moving on, per step.
 *
 * One line each, in the smallest type on the screen, because this is a caveat
 * rather than an instruction — but still present, because the alternative is a
 * page that quietly implies it checked something it cannot see. The pair step
 * deliberately promises nothing: it is the one stage this page can actually
 * verify, so it waits for the daemon rather than for a click.
 */
const ADVANCE_NOTE: Record<Exclude<OnboardingStepId, 'done'>, string> = {
  install: 'This page cannot see your terminal. Continue when the install finishes.',
  daemon: 'Nothing here waits on it. Continue once it reports that it is serving.',
  connect: 'Choose the route that matches this machine. Direct is still preferred whenever it is reachable.',
  'relay-fingerprint': 'This page cannot see your terminal. Continue once you have copied the fingerprint.',
  'relay-source': 'This page cannot see your terminal. Continue once the checkout is ready.',
  'relay-allow': 'This page cannot read your configuration. Continue once the fingerprint is listed.',
  'relay-deploy': 'This page cannot see the deployment. Continue once it finishes.',
  brief: 'This page cannot see your agent. Continue when it shows you a QR or a link.',
  pair: 'This page cannot see your terminal. Continue once the QR code or link is on your computer.',
  scan: 'This step finishes itself when the daemon answers.',
};
