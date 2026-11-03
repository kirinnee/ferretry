/**
 * FIRST RUN: what the reader has, which computer runs the daemon, and who installs it.
 *
 * THE ENTRY IS NOT A QUESTION ABOUT THIS DEVICE. It asks what the reader HAS —
 * nothing yet, or a link — because that is the only thing this page cannot see.
 * ("One more computer for a fleet I already have" is a small link, not a card.)
 * Two of those answers lead into the SAME subflow: get a daemon running.
 *
 * THAT SUBFLOW ASKS TWO THINGS, AND ONE OF THEM DISAPPEARS ON A PHONE.
 *
 * - WHICH COMPUTER runs the daemon. A daemon needs a terminal, so a phone can
 *   never be it and is never asked; a computer starting from scratch is assumed to
 *   mean itself, with the assumption stated and escapable.
 * - WHO INSTALLS IT — an agent, or the reader. Always asked, because an agent has
 *   the terminal and needs one prompt while a reader needs every command.
 *
 * "ANOTHER COMPUTER, MYSELF" OWNS ONE PAGE AND TEACHES NOTHING. It hands over the
 * setup link, and that computer walks this same subflow answering "this one".
 * Installation is therefore taught in exactly one place, always about the machine
 * the reader is sitting at.
 *
 * FOUR RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE PAGE CANNOT SEE THE TERMINAL. It is static, public, and has no way to
 *    know whether \`fy\` installed or the daemon came up. So the one button on an
 *    install page is "I ran it" — the reader saying so — and no control claims a
 *    check it did not make.
 * 2. LOSING SOMEONE'S PLACE IS THE CHEAPEST WAY TO FEEL BROKEN. Setup happens
 *    across a browser and a terminal, with minutes or hours in between, so the
 *    route AND the step are persisted (\`OnboardingProgressStore\`).
 * 3. EVERY PAGE IS BACK, MAYBE SKIP, AND ONE PRIMARY ACTION. The primary IS the
 *    page's action, success moves on by itself, and a pairing surface under
 *    another primary is drawn quiet. This is an accessibility property, not a
 *    taste one.
 * 4. THE DEVICE IS OBSERVED, NEVER ASKED. \`progress.device\` is the one reading,
 *    taken once at hydration, and every helper here derives its steps from the
 *    PATH — the journey plus the device — rather than from the entry alone.
 *
 * THE DAEMON ANSWERING IS THE ONLY THING THAT FINISHES A PAIRING PAGE. Either the
 * embedded pairing surface pairs this browser, or the count of pairings rises
 * because \`fy pair --open\` paired it in another tab. Both end the page, once.
 *
 * Layout note: nothing here sizes itself against the viewport. It renders inside
 * the shell's existing \`kt-shell\` scroller, which is already driven by \`--app-h\`
 * from \`useAppViewport\`; a \`100dvh\` in this file would be a second, competing
 * answer to the same question when the keyboard opens.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useKeyboardOpen } from '../../hooks/use-keyboard-open.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { PairingStageKind } from '../pairing/pairing-screen.tsx';
import type { ClipboardWriter } from './copy-button.tsx';
import type { HostedRelayFallback } from './hosted-relay.ts';
import { OnboardingBrand } from './onboarding-brand.tsx';
import { OnboardingChooser } from './onboarding-chooser.tsx';
import { OnboardingDoerChooser } from './onboarding-doer-chooser.tsx';
import {
  handoffTarget,
  type InstallChannelId,
  isLastOnboardingStep,
  nextOnboardingStep,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  previousOnboardingStep,
  questionBehindDoer,
  questionBehindRoute,
  type SetupTargetId,
  targetBasis,
} from './onboarding-model.ts';
import type { OnboardingProgressStore, OnboardingWalking } from './onboarding-progress.ts';
import { BriefStage, ElsewhereStage, HandoffStage, InstallStage, LocalStage, PairStage } from './onboarding-stages.tsx';
import { OnboardingTargetChooser } from './onboarding-target-chooser.tsx';
import { setupHandoffUrl, setupPageUrl } from './setup-handoff.ts';
import { SetupHandoffPanel, type SetupSharePort } from './setup-handoff-panel.tsx';

const SHELL =
  'mx-auto flex min-h-full w-full max-w-[560px] flex-col gap-3 py-5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-8';

export interface OnboardingPairingHost {
  /**
   * The daemon answered and this browser is paired.
   *
   * The id is the daemon that was just paired, so the app opens THAT one rather
   * than whichever the snapshot says is selected a render later.
   */
  readonly onPaired: (daemonId?: DaemonId) => void;
  /**
   * The pairing screen is showing a failure whose sentence is the whole remedy (an older Ferretry on
   * one side, say), so this step stops adding advice about codes expiring or the step finishing itself.
   */
  readonly onStatedFailure: (stated: boolean) => void;
  /** Draw the scan and paste controls as secondary: another control on this page is the primary action. */
  readonly quiet: boolean;
  /**
   * The pairing screen moved to another stage of its arc. Past `browse` it draws its own primary
   * ("Pair this device", "Start over"), so the page demotes its own filled button.
   */
  readonly onStageChange: (stage: PairingStageKind) => void;
}

export interface OnboardingPageProps {
  readonly progress: OnboardingProgressStore;
  readonly write: ClipboardWriter;
  /** The install route to show first. A guess; every other route stays one tap away. */
  readonly channel: InstallChannelId;
  /** The real pairing screen, wired by the composition root. */
  readonly renderPairing: (host: OnboardingPairingHost) => ReactNode;
  /** Go into the app: at the daemon just paired when one is named, otherwise the selected one. */
  readonly onOpenFleet: (daemonId?: DaemonId) => void;
  /**
   * How many daemons this browser is paired with.
   *
   * A rise while a pairing page is showing is how a pairing that happened in
   * ANOTHER tab (\`fy pair --open\`) finishes this one. It is a count rather than a
   * flag because somebody adding a second computer is already paired with the
   * first, so "paired" never changes for them.
   */
  readonly pairings: number;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback: HostedRelayFallback;
  /**
   * This page's own address, from which a hand-off link is built.
   *
   * Passed in rather than read from \`window\`, because the origin is a deployment
   * fact and there is no hosted address baked into this bundle — and because a
   * component that reaches for \`location\` cannot be rendered by a test or by the
   * screenshot harness without a browser agreeing to it first.
   */
  readonly href: string;
  /** The OS share sheet, when this browser has one. Absent is the ordinary case. */
  readonly share?: SetupSharePort | undefined;
}

/**
 * Waits for the shell's keyboard-sized layout, then keeps its focused control in
 * view. Exported as the narrow effect seam so its geometry can be exercised
 * without making unrelated DOM suites race over the process-wide \`<html>\`
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
  pairings,
  fallback,
  href,
  share,
}: OnboardingPageProps) {
  const at = useSyncExternalStore(progress.subscribe, progress.snapshot);
  const device = progress.device;
  /* One key for "which screen is on the glass", both questions included, so focus can follow it. */
  const screen = at.stage === 'walk' ? at.current : at.stage;

  /*
   * FOCUS FOLLOWS A REAL SCREEN CHANGE, NOT THE FIRST PAINT.
   *
   * Swapping the stage is a navigation with no page load behind it: the control
   * that was pressed unmounts, focus falls back to \`<body>\`, and a reader
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
   * see. \`useKeyboardOpen\` observes the SAME \`data-keyboard\` attribute the
   * stylesheet keys off — no second measurement of the viewport — and once it
   * flips, whatever is focused inside this screen is scrolled back into the
   * shell's own scroller. \`block: 'center'\` rather than 'nearest' so the label
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
      data-onboarding-route={at.stage === 'walk' ? at.route : 'none'}
      data-onboarding-device={device}
    >
      {/*
        \`data-kb-hide\` is legal here and nowhere else on this screen: the brand is
        stateless chrome with no focus, no overlay and no state to lose. The active
        stage and its actions must all survive an open keyboard.
      */}
      <header className="flex min-w-0 flex-col gap-2" data-kb-hide>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <h1 id="onboarding-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
            Set up Ferretry
          </h1>
          <OnboardingBrand />
        </div>
      </header>

      {at.stage === 'entry' ? (
        <OnboardingChooser
          onChoose={route => {
            progress.choose(route);
          }}
        />
      ) : at.stage === 'target' ? (
        <OnboardingTargetChooser
          onChoose={target => {
            progress.chooseTarget(target, at.route);
          }}
          onBack={() => {
            progress.back();
          }}
        />
      ) : at.stage === 'doer' ? (
        <OnboardingDoerChooser
          target={at.target}
          basis={targetBasis(at.route, device)}
          behind={questionBehindDoer(at.route, device)}
          onChoose={doer => {
            progress.chooseDoer(doer);
          }}
          onBack={() => {
            progress.back();
          }}
          onChooseTarget={target => {
            progress.chooseTarget(target, at.route);
          }}
        />
      ) : (
        <RouteFlow
          at={at}
          path={progress.path(at)}
          heading={heading}
          write={write}
          channel={channel}
          renderPairing={renderPairing}
          onOpenFleet={onOpenFleet}
          pairings={pairings}
          fallback={fallback}
          href={href}
          share={share}
          onGoTo={step => {
            progress.goTo(step);
          }}
          onChooseRoute={route => {
            progress.choose(route);
          }}
          onLeaveRoute={() => {
            progress.leaveRoute();
          }}
        />
      )}
    </main>
  );
}

interface RouteFlowProps {
  readonly at: OnboardingWalking;
  /** The journey AND the device, which together decide which steps exist. */
  readonly path: OnboardingPath;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  readonly renderPairing: (host: OnboardingPairingHost) => ReactNode;
  readonly onOpenFleet: (daemonId?: DaemonId) => void;
  readonly pairings: number;
  readonly fallback: HostedRelayFallback;
  readonly href: string;
  readonly share: SetupSharePort | undefined;
  readonly onGoTo: (step: OnboardingStepId) => void;
  /** Switch to a different ENTRY without going back through the question. */
  readonly onChooseRoute: (route: OnboardingRouteId) => void;
  /** Back out of the journey entirely, to the question that opened it. */
  readonly onLeaveRoute: () => void;
}

/**
 * The pages that end when the daemon answers rather than when the reader presses
 * something. Every one of them has a pairing surface, or is waiting for one in
 * another tab.
 */
const WAITS_FOR_DAEMON: ReadonlySet<OnboardingStepId> = new Set(['brief', 'local', 'elsewhere', 'pair']);

/** Under another primary action, the pairing surface is a fallback and must not compete with it. */
const PAIRING_UNDER_A_PRIMARY: ReadonlySet<OnboardingStepId> = new Set(['brief', 'elsewhere']);

/**
 * One journey being walked: its current page, and the way onward.
 *
 * "STEP N OF M" IS ABSENT ON A ONE-PAGE JOURNEY. "Step 1 of 1" tells somebody who
 * arrived holding a link nothing they did not know.
 */
function RouteFlow({
  at,
  path,
  heading,
  write,
  channel,
  renderPairing,
  onOpenFleet,
  pairings,
  fallback,
  href,
  share,
  onGoTo,
  onChooseRoute,
  onLeaveRoute,
}: RouteFlowProps) {
  const step = onboardingStep(at.current);
  const count = onboardingStepCount(path);
  const position = onboardingStepIndex(path, at.current);
  const first = position === 0;
  const last = isLastOnboardingStep(path, at.current);

  /*
   * FINISHING A PAIRING PAGE HAPPENS ONCE, BY EITHER ROUTE.
   *
   * The embedded pairing surface reports it with the daemon's id, and a pairing
   * in another tab shows up as a rise in the count with none. Both could fire for
   * one pairing, and a second \`onOpenFleet\` would be a second navigation — so the
   * page remembers it has settled, and forgets when the reader moves.
   *
   * PAIRING ADVANCES ALONG THE JOURNEY, IT DOES NOT JUMP TO THE END: the page
   * after \`local\` is the offer to add the reader's phone, and a hardcoded exit
   * meant nobody ever saw it. The LAST page of any journey goes into the app.
   */
  const settled = useRef<OnboardingStepId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step is the trigger to forget a settled page
  useEffect(() => {
    settled.current = null;
  }, [at.current]);
  const settle = (daemonId?: DaemonId): void => {
    if (settled.current === at.current) return;
    settled.current = at.current;
    if (last) onOpenFleet(daemonId);
    else onGoTo(nextOnboardingStep(path, at.current));
  };
  const latestSettle = useRef(settle);
  latestSettle.current = settle;
  const knownPairings = useRef(pairings);
  useEffect(() => {
    const before = knownPairings.current;
    knownPairings.current = pairings;
    if (pairings > before && WAITS_FOR_DAEMON.has(at.current)) latestSettle.current();
  }, [pairings, at.current]);

  /*
   * THE PHONE OFFER ONLY MAKES SENSE ONCE SOMETHING IS PAIRED. A stored place on
   * it with nothing paired (a pairing removed since) is damaged state, not an
   * empty one, so the reader is put back one page rather than left on buttons
   * that open nothing.
   */
  const stranded = at.current === 'handoff' && pairings === 0;
  const back = previousOnboardingStep(path, at.current);
  useEffect(() => {
    if (stranded) onGoTo(back);
  }, [stranded, back, onGoTo]);

  // Kept per step, so a stated failure on one step never hides the advice of the next.
  const [statedAt, setStatedAt] = useState<OnboardingStepId | null>(null);
  const stated = statedAt === at.current;
  const onStatedFailure = useCallback((failed: boolean) => setStatedAt(failed ? at.current : null), [at.current]);
  /*
   * TWO PRIMARIES IS A PAGE WITH NO NEXT MOVE. The embedded pairing screen draws its own filled button
   * the moment it leaves its resting scan ("Pair this device" while confirming or retrying, "Start over"
   * on a failure), so the copy button above it steps down for as long as that lasts. Kept per step, so
   * a screen that was confirming on one page never demotes the next.
   */
  const [stageAt, setStageAt] = useState<{ readonly step: OnboardingStepId; readonly kind: PairingStageKind } | null>(
    null,
  );
  const onStageChange = useCallback((kind: PairingStageKind) => setStageAt({ step: at.current, kind }), [at.current]);
  const engaged = stageAt?.step === at.current && stageAt.kind !== 'browse';
  const pairing = renderPairing({
    onPaired: settle,
    onStatedFailure,
    onStageChange,
    quiet: PAIRING_UNDER_A_PRIMARY.has(at.current),
  });
  /*
   * THE HAND-OFF IS BUILT ONCE, HERE, AND HANDED DOWN AS A NODE.
   *
   * Two stages need it — "set it up on that computer" and "add your phone" — and
   * both need the same link built from the same place. A stage that built its own
   * would be a second opinion about what the other device should resume as.
   */
  const away = handoffTarget(path);
  const handoff = (
    <SetupHandoffPanel
      url={setupHandoffUrl(href, { ...away.journey, step: away.step })}
      plainUrl={setupPageUrl(href)}
      receiver={away.receiver}
      write={write}
      share={share}
      demoted={engaged}
      label={
        away.receiver === 'computer'
          ? 'Link carrying this setup to a computer'
          : 'QR code carrying this setup to your phone'
      }
    />
  );
  return (
    <>
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-step-title">
        <div className="min-w-0">
          {count > 1 && (
            <p className="m-0 text-2xs font-semibold text-faint" data-onboarding-step-count="">
              Step {position + 1} of {count}
            </p>
          )}
          <h2
            id="onboarding-step-title"
            ref={heading}
            tabIndex={-1}
            className="m-0 font-display text-title font-bold tracking-display text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
          >
            {step.title}
          </h2>
          {at.current === 'install' || at.current === 'handoff' ? (
            <p className="m-0 text-meta leading-base text-muted">{step.summary}</p>
          ) : null}
        </div>

        <Stage
          at={at}
          path={path}
          write={write}
          channel={channel}
          pairing={pairing}
          stated={stated}
          handoff={handoff}
          engaged={engaged}
          fallback={fallback}
          onGoTo={onGoTo}
          onChooseRoute={onChooseRoute}
          href={href}
          share={share}
        />
      </section>

      <div className="mt-auto flex min-w-0 items-center gap-2 pt-2">
        {/*
          BACK ALWAYS GOES SOMEWHERE, AND SAYS WHERE. On the first page of a
          journey the place behind it is the question that opened THAT journey —
          who installs it for every daemon journey, and the entry itself for the
          pairing one, which is opened without either question being asked.
          Picking the wrong answer is a thing a chooser must survive, and a Back
          that lands on a question the reader never answered does not help them
          survive it.
        */}
        <button
          type="button"
          className="kt-btn min-h-[44px]"
          data-variant="ghost"
          onClick={first ? onLeaveRoute : () => onGoTo(back)}
          data-onboarding-back={first ? questionBehindRoute(at.route) : 'step'}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        {/*
          A PRIMARY ONLY WHERE THE PAGE CANNOT CHECK. Installing happens on a
          machine this page will never see, so the reader saying "I ran it" is
          the only signal there is. Every pairing page is the opposite — the
          daemon answers, in this tab or another, and that answer is the only
          thing that may finish it — and a button there would manufacture a
          "you are set up" for a browser paired with nothing.
        */}
        {at.current === 'install' && (
          <button
            type="button"
            className="kt-btn ml-auto min-h-[44px] flex-1"
            data-variant="primary"
            onClick={() => onGoTo(nextOnboardingStep(path, at.current))}
            data-onboarding-next=""
          >
            I ran it
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
        {/*
          THE PHONE PAGE IS OPTIONAL AND THE END, so both buttons go into the app.
          They are not the same button: Skip is the reader declining, and "I
          scanned it" is the reader saying they did — the second is the primary
          because it is the page's action.
        */}
        {at.current === 'handoff' && (
          <>
            <button
              type="button"
              className="kt-btn ml-auto min-h-[44px]"
              data-variant="ghost"
              onClick={() => onOpenFleet()}
              data-onboarding-skip=""
            >
              Skip
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              onClick={() => onOpenFleet()}
              data-onboarding-next=""
            >
              I scanned it
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

interface StageProps {
  readonly at: OnboardingWalking;
  readonly path: OnboardingPath;
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  readonly pairing: ReactNode;
  readonly handoff: ReactNode;
  readonly fallback: HostedRelayFallback;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onChooseRoute: (route: OnboardingRouteId) => void;
  readonly href: string;
  readonly share: SetupSharePort | undefined;
  /** The pairing screen is past its resting scan and draws its own primary; see {@link OnboardingPairingHost}. */
  readonly engaged: boolean;
  /** The pairing screen shows a failure that already says its remedy; see {@link OnboardingPairingHost}. */
  readonly stated: boolean;
}

/**
 * The page's body, and the ONE place a journey changes what a page means.
 *
 * THE MACHINE IS PASSED, NEVER GUESSED. Two pages read differently depending on
 * which computer runs the daemon, and both of them used to infer it from the
 * DEVICE — a computer reading this page was assumed to be the daemon's own. That
 * was a guess standing in for an answer the reader had already given, and it was
 * wrong for everybody setting up a second machine from their laptop.
 */
function Stage({
  at,
  path,
  write,
  channel,
  pairing,
  handoff,
  fallback,
  onChooseRoute,
  href,
  share,
  engaged,
  stated,
}: StageProps) {
  /*
   * THE PAIRING JOURNEY REACHES NONE OF THE STAGE THAT READS THIS — it has no
   * \`brief\` — but the switch below is over steps rather than
   * over journeys, so the type cannot say so. The stand-in is the CONSERVATIVE
   * answer rather than a plausible one: "another computer" never claims the
   * daemon is on this machine, so nothing can end up telling a reader they are
   * already paired in a tab that does not exist.
   */
  const daemon = path.route === 'add-client' ? undefined : path;
  const target: SetupTargetId = daemon?.target ?? 'other';
  switch (at.current) {
    case 'brief':
      return (
        <BriefStage
          write={write}
          target={target}
          plainUrl={setupPageUrl(href)}
          share={share}
          pairing={pairing}
          stated={stated}
          engaged={engaged}
        />
      );
    case 'install':
      return <InstallStage write={write} channel={channel} />;
    case 'local':
      return <LocalStage write={write} pairing={pairing} fallback={fallback} stated={stated} />;
    case 'elsewhere':
      return (
        <ElsewhereStage
          handoff={handoff}
          pairing={pairing}
          stated={stated}
          onAddAsClient={() => onChooseRoute('add-client')}
        />
      );
    case 'handoff':
      return <HandoffStage handoff={handoff} />;
    case 'pair':
      return <PairStage pairing={pairing} stated={stated} />;
  }
}
