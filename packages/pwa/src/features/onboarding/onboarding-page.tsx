/**
 * FIRST RUN: what the reader has, which computer runs the daemon, and who installs it.
 *
 * THE ENTRY IS NOT A QUESTION ABOUT THIS DEVICE. It asks what the reader HAS —
 * nothing yet, a link, or a fleet they are adding to — because that is the only
 * thing this page cannot see. Two of those three answers lead into the SAME
 * subflow: get a daemon running.
 *
 * THAT SUBFLOW ASKS TWO THINGS, AND ONE OF THEM DISAPPEARS ON A PHONE.
 *
 * - WHICH COMPUTER runs the daemon. A daemon needs a terminal, so a phone can
 *   never be it and is never asked; a computer starting from scratch is assumed to
 *   mean itself, with the assumption stated and escapable.
 * - WHO INSTALLS IT — an agent, or the reader. Always asked, because an agent has
 *   the terminal and needs one prompt while a reader needs every command.
 *
 * "ANOTHER COMPUTER, MYSELF" OWNS ONE SCREEN AND TEACHES NOTHING. It says to open
 * this page over there, and that computer walks this same subflow answering "this
 * one". Installation is therefore taught in exactly one place, always about the
 * machine the reader is sitting at.
 *
 * FOUR RULES SHAPE EVERYTHING HERE.
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
 * 4. THE DEVICE IS OBSERVED, NEVER ASKED. `progress.device` is the one reading,
 *    taken once at hydration, and every helper here derives its steps from the
 *    PATH — the journey plus the device — rather than from the entry alone. A page
 *    that could render a journey without knowing the device would eventually
 *    render the wrong one, silently.
 *
 * WHAT LIVES ELSEWHERE. The entry is `onboarding-chooser.tsx`, the two questions
 * are `onboarding-target-chooser.tsx` and `onboarding-doer-chooser.tsx`, the
 * stages are `onboarding-stages.tsx`, the track is `onboarding-track.tsx`, the
 * picture of the arrangement is `setup-diagram.tsx`. This file owns only the
 * frame: which screen is on the glass, where focus goes when that changes, and how
 * the screen behaves under a software keyboard.
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
import { activeCarrierStatus, carrierDisclosure, type HostedRelayFallback } from './hosted-relay.ts';
import { OnboardingBrand } from './onboarding-brand.tsx';
import { OnboardingChooser } from './onboarding-chooser.tsx';
import { OnboardingConnectionChooser } from './onboarding-connection-chooser.tsx';
import { OnboardingDoerChooser } from './onboarding-doer-chooser.tsx';
import {
  type ConnectionMethodId,
  handoffTarget,
  type InstallChannelId,
  isLastOnboardingStep,
  journeyLabel,
  nextOnboardingStep,
  type OnboardingDoerId,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  pairingOnboardingStep,
  pathConnection,
  previousOnboardingStep,
  questionBehindDoer,
  questionBehindRoute,
  type SetupTargetId,
  targetBasis,
} from './onboarding-model.ts';
import type { OnboardingProgressStore, OnboardingWalking } from './onboarding-progress.ts';
import {
  AgentPairStage,
  AgentsStage,
  BriefStage,
  DaemonStage,
  DoneStage,
  ElsewhereStage,
  HandoffStage,
  InstallStage,
  LocalStage,
  PairStage,
  RelayAllowStage,
  RelayDeployStage,
  RelayFingerprintStage,
  RelaySourceStage,
  ScanStage,
} from './onboarding-stages.tsx';
import { OnboardingTargetChooser } from './onboarding-target-chooser.tsx';
import { OnboardingTrack } from './onboarding-track.tsx';
import { SetupDiagram } from './setup-diagram.tsx';
import { setupHandoffUrl, setupPageUrl } from './setup-handoff.ts';
import { SetupHandoffPanel, type SetupSharePort } from './setup-handoff-panel.tsx';

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
  /**
   * The carrier a paired connection is actually using.
   *
   * Optional, and defaulted from `activeCarrierStatus` rather than from a caller:
   * the composition root used to pass the literal 'Direct', which was a claim
   * nothing had measured. A host may still override it — the review harness does
   * — but nobody has to invent one to render this screen.
   */
  readonly connectionStatus?: string | null;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback: HostedRelayFallback;
  /**
   * This page's own address, from which a hand-off link is built.
   *
   * Passed in rather than read from `window`, because the origin is a deployment
   * fact and there is no hosted address baked into this bundle — and because a
   * component that reaches for `location` cannot be rendered by a test or by the
   * screenshot harness without a browser agreeing to it first.
   */
  readonly href: string;
  /** The OS share sheet, when this browser has one. Absent is the ordinary case. */
  readonly share?: SetupSharePort | undefined;
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
  connectionStatus = null,
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
      data-onboarding-route={at.stage === 'walk' ? at.route : 'none'}
      data-onboarding-device={device}
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
          from both questions on purpose — their job is to be answered, and a
          diagram of a journey nobody has chosen yet is decoration.
        */}
        {at.stage === 'walk' ? <SetupDiagram step={at.current} /> : null}
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
          fleetReady={fleetReady}
          connectionStatus={connectionStatus}
          fallback={fallback}
          href={href}
          share={share}
          onGoTo={step => {
            progress.goTo(step);
          }}
          onChooseConnection={connection => {
            progress.chooseConnection(connection);
          }}
          onChooseRoute={route => {
            progress.choose(route);
          }}
          onChooseDoer={doer => {
            progress.switchDoer(doer);
          }}
          onChooseTarget={target => {
            progress.chooseTarget(target);
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
  readonly onOpenFleet: () => void;
  readonly fleetReady: boolean;
  readonly connectionStatus: string | null;
  readonly fallback: HostedRelayFallback;
  readonly href: string;
  readonly share: SetupSharePort | undefined;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onChooseConnection: (connection: ConnectionMethodId) => void;
  /** Switch to a different ENTRY without going back through the question. */
  readonly onChooseRoute: (route: OnboardingRouteId) => void;
  /** Change who installs it, from a step rather than from the question. */
  readonly onChooseDoer: (doer: OnboardingDoerId) => void;
  /** Change which computer runs it, from a step rather than from the question. */
  readonly onChooseTarget: (target: SetupTargetId) => void;
  /** Back out of the journey entirely, to the question that opened it. */
  readonly onLeaveRoute: () => void;
}

/**
 * One journey being walked: its track, its current stage, and the way onward.
 *
 * The TRACK IS HIDDEN on a two-step journey. A rail reading "Pair · Done" tells
 * somebody who arrived holding a link nothing they did not know, and it costs
 * them a row of a 390px screen to say it.
 */
function RouteFlow({
  at,
  path,
  heading,
  write,
  channel,
  renderPairing,
  onOpenFleet,
  fleetReady,
  connectionStatus,
  fallback,
  href,
  share,
  onGoTo,
  onChooseConnection,
  onChooseRoute,
  onChooseDoer,
  onChooseTarget,
  onLeaveRoute,
}: RouteFlowProps) {
  const step = onboardingStep(at.current);
  const count = onboardingStepCount(path);
  const position = onboardingStepIndex(path, at.current);
  const first = position === 0;
  const last = isLastOnboardingStep(path, at.current);
  /*
   * PAIRING ADVANCES ALONG THE JOURNEY, IT DOES NOT JUMP TO THE END.
   *
   * This used to go straight to `done`, which quietly deleted the one step that
   * makes first-time setup on the daemon's own machine more than the others in
   * sequence: the step AFTER pairing is the offer to add the reader's phone, and
   * a hardcoded `done` meant nobody ever saw it. Every other journey has nothing
   * between pairing and the end, so they are unaffected — which is the point of
   * asking the journey rather than naming a step.
   */
  const pairing = renderPairing({ onPaired: () => onGoTo(nextOnboardingStep(path, at.current)) });
  /*
   * THE HAND-OFF IS BUILT ONCE, HERE, AND HANDED DOWN AS A NODE.
   *
   * Two stages need it — "open Ferretry on that computer" and "add your phone" —
   * and both need the same link built from the same place. A stage that built its
   * own would be a second opinion about what the other device should resume as,
   * and the two would diverge the first time either journey changed.
   */
  const away = handoffTarget(path);
  const handoff = (
    <SetupHandoffPanel
      url={setupHandoffUrl(href, { ...away.journey, step: away.step })}
      plainUrl={setupPageUrl(href)}
      receiver={away.receiver}
      write={write}
      share={share}
      label={
        away.receiver === 'computer'
          ? 'Link carrying this setup to a computer'
          : 'QR code carrying this setup to your phone'
      }
    />
  );
  return (
    <>
      {count > 2 && <OnboardingTrack path={path} current={at.current} furthest={at.furthest} onJump={onGoTo} />}

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-step-title">
        <div className="min-w-0">
          {/*
            THE SUBFLOW'S NAME, NOT THE ENTRY'S. Two entries walk the identical
            list of steps, and a header reading "I have a link or QR · step 1 of 3"
            describes what the reader was holding rather than what they are doing.
          */}
          <p className="m-0 text-2xs font-semibold uppercase tracking-label text-faint">
            {journeyLabel(path)} · step {position + 1} of {count}
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
          path={path}
          write={write}
          channel={channel}
          pairing={pairing}
          handoff={handoff}
          fleetReady={fleetReady}
          connectionStatus={connectionStatus}
          fallback={fallback}
          onOpenFleet={onOpenFleet}
          onGoTo={onGoTo}
          onChooseConnection={onChooseConnection}
          onChooseRoute={onChooseRoute}
          onChooseDoer={onChooseDoer}
          onChooseTarget={onChooseTarget}
          href={href}
          share={share}
        />
      </section>

      {at.current === 'done' ? null : (
        <div className="mt-auto flex min-w-0 flex-col gap-1 pt-2">
          <p className="m-0 text-2xs leading-base text-faint">{ADVANCE_NOTE[at.current]}</p>
          <div className="flex min-w-0 items-center gap-2">
            {/*
              BACK ALWAYS GOES SOMEWHERE, AND SAYS WHERE. On the first step of a
              journey the place behind it is the question that opened THAT journey
              — who installs it for every daemon journey, and the entry itself for
              the pairing one, which is opened without either question being asked.
              Picking the wrong answer is a thing a chooser must survive, and a
              Back that lands on a question the reader never answered does not help
              them survive it.
            */}
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-variant="ghost"
              onClick={first ? onLeaveRoute : () => onGoTo(previousOnboardingStep(path, at.current))}
              data-onboarding-back={first ? questionBehindRoute(at.route) : 'step'}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back
            </button>
            {/*
              NEXT EXISTS ONLY WHERE THE PAGE CANNOT CHECK.
              Install, the daemon, an agent's whole working session and `fy pair`
              happen on a machine this page will never see, so blocking on them
              would block forever. Pairing is the opposite: the daemon answers, in
              this tab, and that answer is the only thing that may declare the
              journey finished. A Next button on a pairing step would manufacture
              a "you are set up" for a browser that is paired with nothing — and on
              the LAST step of a route it would advance to itself, which reads as a
              page that is stuck.
            */}
            {at.current !== 'scan' &&
              at.current !== 'agent-pair' &&
              at.current !== 'connect' &&
              at.current !== 'local' &&
              !last && (
                <button
                  type="button"
                  className="kt-btn ml-auto min-h-[44px] flex-1"
                  data-variant="primary"
                  onClick={() => onGoTo(nextOnboardingStep(path, at.current))}
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
  readonly path: OnboardingPath;
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  readonly pairing: ReactNode;
  readonly handoff: ReactNode;
  readonly fleetReady: boolean;
  readonly connectionStatus: string | null;
  readonly fallback: HostedRelayFallback;
  readonly onOpenFleet: () => void;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onChooseConnection: (connection: ConnectionMethodId) => void;
  readonly onChooseRoute: (route: OnboardingRouteId) => void;
  readonly onChooseDoer: (doer: OnboardingDoerId) => void;
  readonly onChooseTarget: (target: SetupTargetId) => void;
  readonly href: string;
  readonly share: SetupSharePort | undefined;
}

/**
 * The step's body, and the ONE place a journey changes what a step means.
 *
 * `scan` is shared by every journey that ends with a fresh pairing code from
 * somewhere else. `local` is the one that does NOT need one, because the daemon
 * and this browser are the same machine.
 *
 * THE MACHINE IS PASSED, NEVER GUESSED. Two stages read differently depending on
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
  fleetReady,
  connectionStatus,
  fallback,
  onOpenFleet,
  onGoTo,
  onChooseConnection,
  onChooseRoute,
  onChooseDoer,
  onChooseTarget,
  href,
  share,
}: StageProps) {
  /*
   * THE PAIRING JOURNEY REACHES NONE OF THE STAGES THAT READ THESE — it has no
   * `brief`, no `agent-pair` and no `install` — but the switch below is over steps
   * rather than over journeys, so the type cannot say so. The stand-in is the
   * CONSERVATIVE answer rather than a plausible one: "another computer" never
   * claims the daemon is on this machine, so nothing can end up telling a reader
   * they are already paired in a tab that does not exist.
   */
  const daemon = path.route === 'add-client' ? undefined : path;
  const target: SetupTargetId = daemon?.target ?? 'other';
  const assumed = daemon !== undefined && targetBasis(daemon.route, daemon.device) === 'assumed';
  switch (at.current) {
    case 'brief':
      return <BriefStage write={write} target={target} plainUrl={setupPageUrl(href)} share={share} />;
    case 'agent-pair':
      return <AgentPairStage pairing={pairing} target={target} />;
    case 'install':
      return (
        <InstallStage
          write={write}
          channel={channel}
          onAgentInstead={() => onChooseDoer('agent')}
          /*
            OFFERED ONLY WHERE "THIS COMPUTER" WAS ASSUMED RATHER THAN CHOSEN. A
            reader who picked this machine on the question one Back away needs no
            escape hatch from their own answer, and a control that undoes a
            deliberate choice reads as the page doubting them.
          */
          {...(assumed ? { onOtherMachine: () => onChooseTarget('other') } : {})}
        />
      );
    case 'agents':
      return <AgentsStage write={write} />;
    case 'daemon':
      return <DaemonStage write={write} />;
    case 'connect':
      return <OnboardingConnectionChooser onChoose={onChooseConnection} fallback={fallback} />;
    case 'relay-fingerprint':
      return <RelayFingerprintStage write={write} />;
    case 'relay-source':
      return <RelaySourceStage write={write} />;
    case 'relay-allow':
      return <RelayAllowStage />;
    case 'relay-deploy':
      return <RelayDeployStage write={write} />;
    case 'local':
      return <LocalStage write={write} pairing={pairing} />;
    case 'elsewhere':
      return <ElsewhereStage handoff={handoff} onAddAsClient={() => onChooseRoute('add-client')} />;
    case 'handoff':
      return <HandoffStage handoff={handoff} />;
    case 'pair':
      return <PairStage write={write} />;
    case 'scan':
      return <ScanStage pairing={pairing} />;
    case 'done':
      return (
        <DoneStage
          fleetReady={fleetReady}
          /*
            THE CARRIER IN USE, DERIVED RATHER THAN ASSERTED. A host may still
            override it; nobody has to invent one. The default names the carrier
            the app actually dials and, for a reader who chose a relay, says
            plainly that their choice is not yet what carries the connection.
          */
          connectionStatus={fleetReady ? (connectionStatus ?? activeCarrierStatus(pathConnection(path))) : null}
          /*
            AND WHAT THE FALLBACK WOULD SEE. The carrier in use is only half the
            disclosure; the other half is about a third party the reader chose
            screens ago and has not been reminded of since.
          */
          fallbackDisclosure={fleetReady ? carrierDisclosure(pathConnection(path)) : null}
          onOpenFleet={onOpenFleet}
          /*
            THE PAIRING STEP OF THIS JOURNEY, WHICHEVER ONE THAT IS. It used to be
            a two-way guess between `scan` and `local`, which was wrong for the
            agent answer — whose pairing step is `agent-pair` — and would be wrong
            again for the next journey added. The model owns the answer.
          */
          onBackToPairing={() => onGoTo(pairingOnboardingStep(path))}
        />
      );
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
  brief: 'Nothing here watches your agent. Continue when it says it has finished.',
  'agent-pair': 'This step finishes itself when the daemon answers. Nothing here is waiting on you.',
  install: 'This page cannot see your terminal. Continue when the install finishes.',
  agents: 'This page cannot see which of them you have, or whether you are signed in. Continue once one runs.',
  daemon: 'Nothing here waits on it. Continue once it reports that it is serving.',
  connect: 'Choose the route that matches this machine. Direct is still preferred whenever it is reachable.',
  'relay-fingerprint': 'This page cannot see your terminal. Continue once you have copied the fingerprint.',
  'relay-source': 'This page cannot see your terminal. Continue once the checkout is ready.',
  'relay-allow': 'This page cannot read your configuration. Continue once the fingerprint is listed.',
  'relay-deploy': 'This page cannot see the deployment. Continue once it finishes.',
  local: 'This step finishes itself when the daemon answers. Nothing here is waiting on a scan.',
  elsewhere: 'Nothing here waits on that computer. Continue when its daemon is running.',
  handoff: 'Optional, and nothing waits on it. Skip it and add a device whenever you like.',
  pair: 'This page cannot see your terminal. Continue once the QR code or link is on your computer.',
  scan: 'This step finishes itself when the daemon answers.',
};
