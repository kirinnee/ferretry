/**
 * FIRST RUN, AS A STEPPER: one stage visible, four in the track.
 *
 * A cold visitor has installed nothing, so a "Connect a daemon" screen with a
 * QR button asks them to do something they cannot do yet. This screen instead
 * walks the actual journey — install, start the daemon, pair, done — and puts
 * exactly one of those on the glass at a time.
 *
 * THREE RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE PAGE CANNOT SEE THE TERMINAL. It is static, public, and has no way to
 *    know whether `fy` installed or the daemon came up. So `Next` is never
 *    blocked and no control claims a check it did not make; an honest "when
 *    that finishes, continue" beats a spinner that is lying.
 * 2. LOSING SOMEONE'S PLACE IS THE CHEAPEST WAY TO FEEL BROKEN. Setup happens
 *    across a browser and a terminal, with minutes or hours in between, so the
 *    step is persisted (`OnboardingProgressStore`) and any step already reached
 *    stays one tap away.
 * 3. ONE LOUD CONTROL PER STEP. Everything a reader can do is not equally
 *    important, and a screen where four controls shout is a screen with no next
 *    action. `Next` is the only filled button; back, copy and the disclosures
 *    are quiet until wanted. This is an accessibility property, not a taste one.
 *
 * WHAT LIVES ELSEWHERE. The stages are in `onboarding-stages.tsx`, the track in
 * `onboarding-track.tsx`, the picture of the arrangement in `setup-diagram.tsx`.
 * This file owns only the frame: which stage is on the glass, where focus goes
 * when that changes, and how the screen behaves under a software keyboard.
 *
 * Layout note: nothing here sizes itself against the viewport. The stepper
 * renders inside the shell's existing `kt-shell` scroller, which is already
 * driven by `--app-h` from `useAppViewport`; a `100dvh` in this file would be a
 * second, competing answer to the same question when the keyboard opens.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';

import { useKeyboardOpen } from '../../hooks/use-keyboard-open.ts';
import type { ClipboardWriter } from './copy-button.tsx';
import { OnboardingBrand } from './onboarding-brand.tsx';
import {
  type InstallChannelId,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  type OnboardingStepId,
  onboardingStep,
  onboardingStepIndex,
  previousOnboardingStep,
} from './onboarding-model.ts';
import type { OnboardingProgressStore } from './onboarding-progress.ts';
import { DaemonStage, DoneStage, InstallStage, PairStage } from './onboarding-stages.tsx';
import { OnboardingTrack } from './onboarding-track.tsx';
import { SetupDiagram } from './setup-diagram.tsx';

const SHELL =
  'mx-auto flex min-h-full w-full max-w-[560px] flex-col gap-3 py-5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-8';

export interface OnboardingPairingHost {
  /** The daemon answered and this browser is paired; the arc is finished. */
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
 * Waits for the shell's keyboard-sized layout, then keeps its focused control
 * in view. Exported as the narrow effect seam so its geometry can be exercised
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
  const { current, furthest } = useSyncExternalStore(progress.subscribe, progress.snapshot);
  const step = onboardingStep(current);
  const position = onboardingStepIndex(current);
  const goTo = (id: OnboardingStepId): void => {
    progress.goTo(id);
  };

  /*
   * FOCUS FOLLOWS A REAL STEP CHANGE, NOT THE FIRST PAINT.
   *
   * Swapping the stage is a navigation with no page load behind it: the control
   * that was pressed unmounts, focus falls back to `<body>`, and a reader
   * restarts from the top of the document. Moving focus to the new heading
   * restores what a real navigation would have given. The previous step is
   * seeded during render rather than latched in an effect, because StrictMode
   * replays mount effects and an effect-owned latch mistakes that replay for a
   * navigation — stealing focus from whatever the browser had already placed.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(current);
  useEffect(() => {
    if (previousStep.current === current) return;
    previousStep.current = current;
    heading.current?.focus();
  }, [current]);

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
      data-onboarding-step={current}
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
          your machine does the work, this page is a window onto it.
        */}
        <SetupDiagram step={current} />
      </header>

      <OnboardingTrack current={current} furthest={furthest} onJump={goTo} />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-step-title">
        <div className="min-w-0">
          <p className="m-0 text-2xs font-semibold uppercase tracking-label text-faint">
            Step {position + 1} of {ONBOARDING_STEP_COUNT}
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

        {current === 'install' && <InstallStage write={write} channel={channel} />}
        {current === 'daemon' && <DaemonStage write={write} />}
        {current === 'pair' && <PairStage write={write} pairing={renderPairing({ onPaired: () => goTo('done') })} />}
        {current === 'done' && (
          <DoneStage fleetReady={fleetReady} onOpenFleet={onOpenFleet} onBackToPairing={() => goTo('pair')} />
        )}
      </section>

      {current !== 'done' && (
        <div className="mt-auto flex min-w-0 flex-col gap-1 pt-2">
          <p className="m-0 text-2xs leading-base text-faint">{ADVANCE_NOTE[current]}</p>
          <div className="flex min-w-0 items-center gap-2">
            {current !== 'install' && (
              <button
                type="button"
                className="kt-btn min-h-[44px]"
                data-variant="ghost"
                onClick={() => goTo(previousOnboardingStep(current))}
                data-onboarding-back=""
              >
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </button>
            )}
            {/*
              NEXT EXISTS ONLY WHERE THE PAGE CANNOT CHECK.
              Install and Start-the-daemon happen in a terminal this page will
              never see, so blocking on them would block forever. Pairing is the
              opposite: the daemon answers, in this tab, and that answer is the
              only thing that may declare the arc finished. A Next button here
              would manufacture a "you are set up" for a browser that is paired
              with nothing.
            */}
            {current !== 'pair' && (
              <button
                type="button"
                className="kt-btn ml-auto min-h-[44px] flex-1"
                data-variant="primary"
                onClick={() => goTo(nextOnboardingStep(current))}
                data-onboarding-next=""
              >
                Next
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
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
  pair: 'This step finishes itself when the daemon answers.',
};
