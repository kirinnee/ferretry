/**
 * FIRST RUN, AS A STEPPER: one stage visible, four in the track.
 *
 * A cold visitor has installed nothing, so a "Connect a daemon" screen with a
 * QR button asks them to do something they cannot do yet. This screen instead
 * walks the actual journey — install, start the daemon, pair, done — and puts
 * exactly one of those on the glass at a time.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE PAGE CANNOT SEE THE TERMINAL. It is static, public, and has no way to
 *    know whether `fy` installed or the daemon came up. So `Next` is never
 *    blocked and no control claims a check it did not make; an honest "when
 *    that finishes, continue" beats a spinner that is lying.
 * 2. LOSING SOMEONE'S PLACE IS THE CHEAPEST WAY TO FEEL BROKEN. Setup happens
 *    across a browser and a terminal, with minutes or hours in between, so the
 *    step is persisted (`OnboardingProgressStore`) and any step already reached
 *    stays one tap away.
 *
 * Layout note: nothing here sizes itself against the viewport. The stepper
 * renders inside the shell's existing `kt-shell` scroller, which is already
 * driven by `--app-h` from `useAppViewport`; a `100dvh` in this file would be a
 * second, competing answer to the same question when the keyboard opens.
 */

import { ArrowLeft, ArrowRight, Check, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useKeyboardOpen } from '../../hooks/use-keyboard-open.ts';
import { type ClipboardWriter, CommandBlock, CopyButton } from './copy-button.tsx';
import { OnboardingBrand } from './onboarding-brand.tsx';
import {
  AGENT_SETUP_PROMPT,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  type OnboardingStepId,
  type OnboardingStepStatus,
  onboardingStep,
  onboardingStepIndex,
  onboardingStepStatus,
  PAIR_COMMAND,
  previousOnboardingStep,
  VERIFY_COMMAND,
} from './onboarding-model.ts';
import type { OnboardingProgressStore } from './onboarding-progress.ts';

const SHELL =
  'mx-auto flex min-h-full w-full max-w-[560px] flex-col gap-4 py-6 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-10';

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
        and the standing explanation are stateless chrome with no focus, no
        overlay and no state to lose. The track, the active stage and its
        actions must all survive an open keyboard.
      */}
      <header className="min-w-0" data-kb-hide>
        <OnboardingBrand />
        <h1 id="onboarding-title" className="mb-1 mt-2 font-display text-display font-bold tracking-display text-fg">
          Set up Ferretry
        </h1>
        <p className="m-0 text-ui leading-base text-muted">
          Ferretry runs on your own machine, and this page is only a window onto it.
        </p>
      </header>

      <OnboardingTrack current={current} furthest={furthest} onJump={goTo} />

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="onboarding-step-title">
        <div className="min-w-0">
          <p className="m-0 text-meta font-semibold uppercase tracking-label text-faint">
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
          <p className="m-0 mt-1 text-ui leading-base text-muted">{step.summary}</p>
        </div>

        {current === 'install' && <InstallStage write={write} channel={channel} />}
        {current === 'daemon' && <DaemonStage write={write} />}
        {current === 'pair' && <PairStage write={write} pairing={renderPairing({ onPaired: () => goTo('done') })} />}
        {current === 'done' && (
          <DoneStage fleetReady={fleetReady} onOpenFleet={onOpenFleet} onBackToPairing={() => goTo('pair')} />
        )}
      </section>

      {current !== 'done' && (
        <div className="mt-auto flex min-w-0 flex-col gap-2">
          <p className="m-0 text-meta leading-base text-faint">{ADVANCE_NOTE[current]}</p>
          <div className="flex flex-wrap items-center gap-2">
            {current !== 'install' && (
              <button
                type="button"
                className="kt-btn min-h-[44px]"
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
                className="kt-btn ml-auto min-h-[44px]"
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
 * The pair step deliberately promises nothing: it is the one stage this page
 * can actually verify, so it waits for the daemon rather than for a click.
 */
const ADVANCE_NOTE: Record<Exclude<OnboardingStepId, 'done'>, string> = {
  install: 'This page cannot see your terminal, so nothing here waits on it. Continue when the install finishes.',
  daemon: 'Still nothing this page can check. Continue once the daemon reports that it is serving.',
  pair: 'This step finishes itself: the moment the daemon answers, you are set up.',
};

const STATUS_WORD: Record<OnboardingStepStatus, string> = {
  completed: 'completed, go back to it',
  current: 'current step',
  upcoming: 'not reached yet',
};

const TRACK_ITEM =
  'flex min-h-[44px] w-full min-w-0 flex-col items-center justify-center gap-1 rounded-control border px-1 py-1 text-center';

const TRACK_TONE: Record<OnboardingStepStatus, string> = {
  completed: 'border-border-strong bg-surface-2 text-fg hover:border-accent hover:text-accent',
  current: 'border-accent bg-accent-bg font-semibold text-fg',
  upcoming: 'border-dashed border-border bg-transparent text-faint',
};

interface OnboardingTrackProps {
  readonly current: OnboardingStepId;
  readonly furthest: OnboardingStepId;
  readonly onJump: (id: OnboardingStepId) => void;
}

/**
 * The numbered track: a real ordered list, because that is what it is.
 *
 * State is never carried by colour alone — a completed step swaps its number
 * for a tick, the current one is the only solid border and is marked
 * `aria-current="step"`, and an unreached one is dashed. Each item also spells
 * its state out for a reader who hears the list rather than seeing it.
 */
function OnboardingTrack({ current, furthest, onJump }: OnboardingTrackProps) {
  return (
    <ol className="m-0 flex list-none items-stretch gap-1 p-0" aria-label="Setup steps">
      {ONBOARDING_STEPS.map((step, index) => {
        const status = onboardingStepStatus(step.id, current, furthest);
        const body = (
          <>
            <span className="flex h-5 w-5 items-center justify-center text-meta font-semibold" aria-hidden="true">
              {status === 'completed' ? <Check size={14} strokeWidth={3} /> : index + 1}
            </span>
            <span className="w-full truncate text-meta">{step.short}</span>
            <span className="sr-only">{STATUS_WORD[status]}</span>
          </>
        );
        return (
          <li key={step.id} className="min-w-0 flex-1">
            {status === 'completed' ? (
              <button
                type="button"
                className={`${TRACK_ITEM} ${TRACK_TONE.completed} focus-visible:outline-focus focus-visible:outline-offset-focus`}
                onClick={() => onJump(step.id)}
                data-onboarding-jump={step.id}
              >
                {body}
              </button>
            ) : (
              <span
                className={`${TRACK_ITEM} ${TRACK_TONE[status]}`}
                aria-current={status === 'current' ? 'step' : undefined}
                data-onboarding-track={status}
              >
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const CHANNEL_BUTTON =
  'min-h-[44px] rounded-control border px-control-x text-ui focus-visible:outline-focus focus-visible:outline-offset-focus';

function InstallStage({ write, channel }: { readonly write: ClipboardWriter; readonly channel: InstallChannelId }) {
  const [selected, setSelected] = useState<InstallChannelId>(channel);
  const active = installChannel(selected);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/*
        A row of buttons that swaps what is shown below it. `role="toolbar"`
        rather than a tablist: there is no tab panel per option, and rather than
        a bare labelled div, which is not a nameable element.
      */}
      <div role="toolbar" aria-label="Install method" className="flex flex-wrap gap-1">
        {INSTALL_CHANNELS.map(option => (
          <button
            key={option.id}
            type="button"
            className={`${CHANNEL_BUTTON} ${option.id === selected ? 'border-accent bg-accent-bg font-semibold text-fg' : 'border-border bg-surface-2 text-muted'}`}
            aria-pressed={option.id === selected}
            onClick={() => setSelected(option.id)}
            data-onboarding-channel={option.id}
          >
            {option.label}
          </button>
        ))}
      </div>

      {active.blocks.map(block => (
        <CommandBlock key={block} command={block} copyLabel="Copy command" write={write} />
      ))}

      <p className="m-0 text-ui leading-base text-muted">Then check that it landed:</p>
      <CommandBlock command={VERIFY_COMMAND} copyLabel="Copy check" write={write} />

      <div className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-2">
        <p className="m-0 text-ui font-semibold text-fg">Or have an AI agent do it</p>
        <p className="m-0 text-meta leading-base text-muted">
          Paste this into an agent with a terminal on that machine. It is generic setup text — it says nothing about
          you, this browser, or any daemon.
        </p>
        <CopyButton text={AGENT_SETUP_PROMPT} label="Copy setup prompt" write={write} />
      </div>
    </div>
  );
}

function DaemonStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CommandBlock command={DAEMON_START_COMMAND} copyLabel="Copy start command" write={write} />
      <p className="m-0 text-ui leading-base text-muted">Then ask it whether it is actually up:</p>
      <CommandBlock command={DAEMON_STATUS_COMMAND} copyLabel="Copy status command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        A healthy daemon prints <code className="font-mono text-fg">{DAEMON_SERVING_OUTPUT}</code>. Leave it running: it
        is what your agents run inside.
      </p>
    </div>
  );
}

function PairStage({ write, pairing }: { readonly write: ClipboardWriter; readonly pairing: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CommandBlock command={PAIR_COMMAND} copyLabel="Copy pair command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        It prints a QR code and a link. Both work once, and only for about two minutes.
      </p>
      <div className="min-w-0" data-onboarding-pairing="">
        {pairing}
      </div>
    </div>
  );
}

interface DoneStageProps {
  readonly fleetReady: boolean;
  readonly onOpenFleet: () => void;
  readonly onBackToPairing: () => void;
}

function DoneStage({ fleetReady, onOpenFleet, onBackToPairing }: DoneStageProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-ui leading-base text-muted">
        <li>Start and watch sessions that run on your own machine.</li>
        <li>Come back to this tab any time — this browser remembers the pairing.</li>
        <li>Pair another machine later; each one keeps its own separate data.</li>
      </ul>
      {fleetReady ? (
        <button
          type="button"
          className="kt-btn min-h-[56px] w-full text-title"
          data-variant="primary"
          onClick={onOpenFleet}
          data-onboarding-open-fleet=""
        >
          Open my fleet
          <ExternalLink size={16} aria-hidden="true" />
        </button>
      ) : (
        <>
          <p className="m-0 text-ui leading-base text-warn" role="status">
            Nothing is paired in this browser yet, so there is no fleet to open.
          </p>
          <button
            type="button"
            className="kt-btn min-h-[56px] w-full text-title"
            data-variant="primary"
            onClick={onBackToPairing}
            data-onboarding-open-fleet=""
          >
            Back to pairing
          </button>
        </>
      )}
    </div>
  );
}
