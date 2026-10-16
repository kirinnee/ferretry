/**
 * New machine setup — onboarding v2 (spec R4, R6; build plan P9; the approved mock's "New machine
 * setup").
 *
 * A PROGRESS RAIL, NOT A FORCED STEPPER. The steps are listed down the left on a desktop and across the
 * top on a phone; any of them opens with one tap, every one has Skip, and Done lists what was set and
 * what was skipped with a "Set up later" link to the Settings panel that owns it. The rules — which
 * step is next, what Skip marks, where "later" is — are `onboarding-model.ts`; each step's body reuses
 * its Settings surface (`onboarding-steps.tsx`).
 *
 * NOTHING IS HELD BACK FOR A LAST STEP. Each step saves through its own surface when the person saves
 * it there, so leaving ("Finish later") never loses what was already set, and the rail's place is kept
 * in this browser (`setup-progress.ts`) to resume.
 */

import { LearningConfigSchema, WardenConfigViewSchema } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { PairingClientFactory } from '../../settings/add-device-settings.tsx';
import { readSpeedups } from '../../speedups/speedups-api.ts';
import { jevKeyStatus } from '../../warden/warden-config-card.tsx';
import { wardenSummary } from '../../warden/warden-settings-model.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import {
  backOnboardingStep,
  chooseOnboardingStart,
  continueOnboarding,
  goToOnboardingStep,
  type MachineSetupProgress,
  type MachineSetupStepId,
  markOnboardingStep,
  ONBOARDING_START,
  ONBOARDING_STEPS,
  type OnboardingDoneFacts,
  onboardingDoneRows,
  onboardingRailMarker,
  onboardingSetCount,
  onboardingStepLabel,
  skipOnboardingStep,
} from './onboarding-model.ts';
import {
  OnboardingControlsStep,
  OnboardingDoneStep,
  OnboardingLearningStep,
  OnboardingLoginsStep,
  OnboardingPairStep,
  OnboardingSpeedupsStep,
  OnboardingStartStep,
  OnboardingVoiceStep,
  OnboardingWardenStep,
  type VoiceCleanupPort,
} from './onboarding-steps.tsx';
import type { FirstRunProgressPort, MachineSetupProgressPort } from './setup-progress.ts';

export interface MachineOnboardingProps extends MachineTabProps {
  /** Every OTHER machine this browser has paired, for Start from › Clone. */
  readonly sources: readonly DaemonConnectionRecord[];
  /** Where the rail's place is kept; absent when this browser has no storage. */
  readonly progress?: MachineSetupProgressPort;
  /** The Logins step's own progress (the Claude Code and Codex check). */
  readonly firstRunProgress?: FirstRunProgressPort;
  /** Finish setup: the person is done here. */
  readonly onFinish: () => void;
  /** Finish later: leave now, the place kept. */
  readonly onLeave: () => void;
  /** Go to an address in the app (Done's "Set up later" links). */
  readonly onNavigate: (to: string) => void;
  /**
   * THE VOICE ENGINE SEAM: Parakeet's install and the engine choice, supplied by the Parakeet engine
   * once it is in this build. Without it the Voice step names the engine this device uses today.
   */
  readonly voiceEngine?: React.ReactNode;
  /** This device's dictation settings, for the Voice step's clean-up choice. */
  readonly voiceCleanup?: VoiceCleanupPort;
  /** The harness and tests hand in a pairing client, so no capture ever holds a real code. */
  readonly createPairingClient?: PairingClientFactory;
}

/** What Done can say about each step, read from the machine when Done opens. */
function useDoneFacts(tab: MachineTabProps, active: boolean, clonedFrom: string | undefined): OnboardingDoneFacts {
  const { connection, createClient } = tab;
  const [facts, setFacts] = useState<OnboardingDoneFacts>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      const client = await createClient(connection).catch(() => null);
      if (client === null) return;
      const [speedups, warden, learning] = await Promise.all([
        readSpeedups(client).catch(() => null),
        client.request('/v1/warden/config', WardenConfigViewSchema).catch(() => null),
        client.request('/v1/learning/config', LearningConfigSchema).catch(() => null),
      ]);
      if (!live) return;
      const jev = jevKeyStatus(speedups).state === 'set';
      setFacts({
        ...(speedups === null
          ? {}
          : { keys: Object.fromEntries(speedups.providers.map(provider => [provider.label, provider.set])) }),
        ...(warden === null ? {} : { warden: wardenSummary(warden.config, jev) }),
        ...(learning === null ? {} : { passiveDefault: learning.passiveDefault }),
      });
    })();
    return () => {
      live = false;
    };
  }, [active, connection, createClient]);
  return clonedFrom === undefined ? facts : { ...facts, clonedFrom };
}

export function MachineOnboarding(props: MachineOnboardingProps) {
  const {
    sources,
    progress: store,
    firstRunProgress,
    onFinish,
    onLeave,
    onNavigate,
    voiceEngine,
    voiceCleanup,
    createPairingClient,
    ...tab
  } = props;
  const { connection, machineName } = tab;
  const [progress, setProgress] = useState<MachineSetupProgress>(() => store?.saved ?? ONBOARDING_START);
  const [clonedFrom, setClonedFrom] = useState<string | undefined>(undefined);
  const at = progress.at;
  const titleRef = useRef<HTMLHeadingElement>(null);

  // KEEP the place on every move, so Finish later is never losing.
  const save = store?.save;
  useEffect(() => {
    save?.(progress);
  }, [progress, save]);

  // A new step is a new page: the reader starts at its title — but not on arrival, where the page's own
  // first focus is the browser's. On a phone the rail is a strip, so it scrolls the open step into view.
  const shownStep = useRef(at);
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const current = strip.current?.querySelector<HTMLElement>('[aria-current="step"]');
    if (strip.current && current) strip.current.scrollLeft = Math.max(current.offsetLeft - 48, 0);
    if (shownStep.current === at) return;
    shownStep.current = at;
    titleRef.current?.focus({ preventScroll: true });
  }, [at]);

  const move = useCallback((next: (current: MachineSetupProgress) => MachineSetupProgress) => setProgress(next), []);
  const facts = useDoneFacts(tab, at === 'done', clonedFrom);
  const rows = onboardingDoneRows(progress, facts, connection.daemonId, machineName);

  const finish = (): void => {
    save?.(null);
    onFinish();
  };

  const body = (step: MachineSetupStepId) => {
    switch (step) {
      case 'pair':
        return (
          <OnboardingPairStep
            connection={connection}
            machineName={machineName}
            {...(createPairingClient === undefined ? {} : { createPairingClient })}
          />
        );
      case 'start':
        return (
          <OnboardingStartStep
            start={progress.start}
            onStart={start => move(current => chooseOnboardingStart(current, start))}
            sources={sources}
            tab={tab}
            onCopied={setClonedFrom}
            onCloned={() => move(continueOnboarding)}
          />
        );
      case 'logins':
        return (
          <OnboardingLoginsStep
            tab={tab}
            {...(firstRunProgress === undefined ? {} : { progress: firstRunProgress })}
            onDone={() => move(continueOnboarding)}
            onLeave={() => move(skipOnboardingStep)}
          />
        );
      case 'speedups':
        return <OnboardingSpeedupsStep tab={tab} />;
      case 'voice':
        return (
          <OnboardingVoiceStep
            {...(voiceEngine === undefined ? {} : { engine: voiceEngine })}
            {...(voiceCleanup === undefined ? {} : { cleanup: voiceCleanup })}
          />
        );
      case 'warden':
        return (
          <OnboardingWardenStep tab={tab} onSaved={() => move(current => markOnboardingStep(current, 'warden'))} />
        );
      case 'learning':
        return (
          <OnboardingLearningStep tab={tab} onSaved={() => move(current => markOnboardingStep(current, 'learning'))} />
        );
      case 'controls':
        return <OnboardingControlsStep tab={tab} />;
      case 'done':
        return <OnboardingDoneStep rows={rows} machineName={machineName} onNavigate={onNavigate} />;
    }
  };

  const rail = (layout: 'column' | 'row') => (
    <nav
      ref={layout === 'row' ? strip : undefined}
      aria-label="Setup progress"
      data-onboarding-rail={layout}
      className={cn(
        layout === 'column'
          ? 'hidden min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border-strong px-3 py-5 md:flex'
          : 'scroll-thin relative flex shrink-0 gap-1 overflow-x-auto border-b border-border-strong px-panel py-2 md:hidden',
      )}
    >
      <p
        className={cn('kt-navgroup__title m-0 shrink-0', layout === 'row' && 'self-center whitespace-nowrap')}
        data-onboarding-count=""
      >
        {onboardingSetCount(progress)}
      </p>
      {ONBOARDING_STEPS.map(step => {
        const state = step.id === 'done' ? undefined : progress.states[step.id];
        return (
          <button
            key={step.id}
            type="button"
            className={cn('kt-navpill', layout === 'row' && 'shrink-0 whitespace-nowrap')}
            // `.kt-navpill` fills its column; across a phone's strip each step is only as wide as its name.
            style={layout === 'row' ? { width: 'auto' } : undefined}
            data-onboarding-go={step.id}
            data-state={state ?? 'todo'}
            aria-current={step.id === at ? 'step' : undefined}
            onClick={() => move(current => goToOnboardingStep(current, step.id))}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-meta font-semibold',
                state === 'done' && 'border-ok bg-ok text-bg',
                state === 'skipped' && 'border-dashed border-border-strong text-muted',
                state === undefined && 'border-border-strong',
              )}
            >
              {onboardingRailMarker(progress, step.id)}
            </span>
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            {state === 'skipped' && layout === 'column' ? (
              <span className="text-meta text-muted" aria-hidden="true">
                skipped
              </span>
            ) : null}
            <span className="sr-only">{state === undefined ? '' : `, ${state === 'done' ? 'set' : 'skipped'}`}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <section
      data-machine-onboarding={String(connection.daemonId)}
      data-onboarding-at={at}
      aria-labelledby="machine-onboarding-title"
      className="flex h-full min-h-0 min-w-0 flex-col md:grid md:grid-cols-[15rem_minmax(0,1fr)]"
    >
      {rail('column')}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {rail('row')}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel py-5 md:px-8 md:py-7">
          <div className="mx-auto flex w-full max-w-[52rem] min-w-0 flex-col gap-4">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="kt-label m-0">New machine setup · {machineName}</p>
                <p className="m-0 text-meta text-muted">Any step can be skipped and revisited later in Settings.</p>
              </div>
              {at === 'done' ? null : (
                <Button type="button" variant="ghost" data-onboarding-later-all="" onClick={onLeave}>
                  Finish later
                </Button>
              )}
            </div>
            <h1
              id="machine-onboarding-title"
              ref={titleRef}
              tabIndex={-1}
              className="m-0 font-display text-display font-semibold tracking-display text-fg outline-none"
            >
              {at === 'done' ? `${machineName} is set up` : onboardingStepLabel(at)}
            </h1>
            <div className="min-w-0">{body(at)}</div>
          </div>
        </div>
        <footer
          className="border-t border-border-strong bg-surface px-panel pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] md:px-8"
          data-onboarding-foot=""
        >
          <div className="mx-auto flex w-full max-w-[52rem] min-w-0 items-center justify-between gap-2">
            <div className="shrink-0">
              {at === 'pair' ? null : (
                <Button type="button" variant="ghost" data-onboarding-back="" onClick={() => move(backOnboardingStep)}>
                  ‹ Back
                </Button>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              {at === 'done' ? (
                <>
                  <Button type="button" data-onboarding-restart="" onClick={() => move(() => ONBOARDING_START)}>
                    Start again
                  </Button>
                  <Button type="button" variant="primary" data-onboarding-finish="" onClick={finish}>
                    Finish setup
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    data-onboarding-skip=""
                    onClick={() => move(skipOnboardingStep)}
                  >
                    Skip
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    data-onboarding-next=""
                    onClick={() => move(continueOnboarding)}
                  >
                    Continue
                  </Button>
                </>
              )}
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}
