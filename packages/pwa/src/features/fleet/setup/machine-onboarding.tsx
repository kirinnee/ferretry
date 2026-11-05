/**
 * New machine setup — onboarding v2 (spec R4, R6; build plan P9; the approved mock's "New machine
 * setup").
 *
 * ONE PROGRESS RAIL, NOT A FORCED STEPPER, AND NO STEPPER INSIDE A STEP. The steps are listed down the
 * left on a desktop and across the top on a phone; any of them opens with one tap, every one has Skip, and
 * Done lists what was set and what was skipped with a "Set up later" link to the Settings panel that owns
 * it. Claude Code and Codex are a step each, and each makes its runtime on its own screen. The rules — which
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
import type { ParakeetVoice } from '../../../lib/stt/parakeet-voice.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readConfigFile } from '../../config-files/config-files-api.ts';
import type { PairingClientFactory } from '../../settings/add-device-settings.tsx';
import { readSpeedups } from '../../speedups/speedups-api.ts';
import { jevKeyStatus } from '../../warden/warden-config-card.tsx';
import { wardenMachineDefaultLogin, wardenSummary } from '../../warden/warden-settings-model.ts';
import { readFleetRuntimes } from '../catalog-api.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import {
  FooterQuietContext,
  FooterSaveContext,
  FooterSlotContext,
  useFooterQuietState,
  usePendingSavesState,
} from './footer-slot.tsx';
import { type HarnessReport, OnboardingHarnessStep } from './harness-step.tsx';
import {
  answerOnboardingHarness,
  backOnboardingStep,
  chooseOnboardingStart,
  completeOnboardingStep,
  continueOnboarding,
  goToOnboardingStep,
  type MachineSetupProgress,
  type MachineSetupStepId,
  markOnboardingStep,
  ONBOARDING_START,
  ONBOARDING_STEPS,
  type OnboardingDoneFacts,
  onboardingDoneRows,
  onboardingLaterHref,
  onboardingNeedsRuntime,
  onboardingRailMarker,
  onboardingSetCount,
  onboardingStepAfter,
  onboardingStepLabel,
  skipOnboardingStep,
} from './onboarding-model.ts';
import {
  OnboardingControlsStep,
  OnboardingDoneStep,
  OnboardingLearningStep,
  OnboardingPairStep,
  OnboardingStartStep,
  OnboardingVoiceStep,
  OnboardingWardenStep,
  type VoiceCleanupPort,
} from './onboarding-steps.tsx';
import { machineItemHash } from './settings-route.ts';
import type { MachineSetupProgressPort } from './setup-progress.ts';
import { SetupNote } from './setup-ui.tsx';
import { OnboardingSpeedupsStep } from './speedups-step.tsx';
import { machineVoiceEngine, VOICE_FILE } from './voice-default.ts';

export interface MachineOnboardingProps extends MachineTabProps {
  /** Every OTHER machine this browser has paired, for Start from › Clone. */
  readonly sources: readonly DaemonConnectionRecord[];
  /** Where the rail's place is kept; absent when this browser has no storage. */
  readonly progress?: MachineSetupProgressPort;
  /** Open on this step (Import again opens on Claude Code); the kept progress otherwise. */
  readonly startAt?: MachineSetupStepId;
  /** Finish setup: the person is done here. */
  readonly onFinish: () => void;
  /** Finish later: leave now, the place kept. */
  readonly onLeave: () => void;
  /** Go to an address in the app (Done's "Set up later" links). */
  readonly onNavigate: (to: string) => void;
  /** This device's dictation settings, for the Voice step's clean-up choice. */
  readonly voiceCleanup?: VoiceCleanupPort;
  /** Parakeet on this device for the Voice step; the app's own unless the harness or a test hands one in. */
  readonly voice?: ParakeetVoice | null;
  /** The harness and tests hand in a pairing client, so no capture ever holds a real code. */
  readonly createPairingClient?: PairingClientFactory;
  /** How often a waiting sign-in is re-read. Supplied in tests. */
  readonly pollMs?: number;
}

/** The steps whose own action is the page's one primary; the footer adds no Continue beside it. */
const ownsPrimary = (step: MachineSetupStepId, start: MachineSetupProgress['start']): boolean =>
  step === 'claude' || step === 'codex' || step === 'speedups' || (step === 'start' && start === 'clone');

/** The last import left something to do: worth saying on the page it moved to. A good import says nothing here. */
const carriesNote = (report: HarnessReport): boolean => report.conversationsFailed || report.signIn.length > 0;

/**
 * What the last import left to do, carried to the page it moved to: conversations that were not brought
 * in, or a runtime that still needs a sign-in. The rail's tick already says the step is set.
 */
function ImportCarryNote({ report, machineName }: { readonly report: HarnessReport; readonly machineName: string }) {
  const name = report.harness === 'claude' ? 'Claude Code' : 'Codex';
  return (
    <SetupNote live tone="warn" name="import-carry" title={`Still to do from ${name}`}>
      {report.conversationsFailed && report.conversations !== null ? <span>{report.conversations}</span> : null}
      {report.signIn.map(item => (
        <a
          key={item.credential}
          href={machineItemHash(machineName, 'sign-ins', item.credential)}
          className="font-semibold text-accent underline"
          data-carry-sign-in={item.credential}
        >
          Sign in {item.runtime} later
        </a>
      ))}
    </SetupNote>
  );
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
      const [speedups, warden, learning, runtimes, voice] = await Promise.all([
        readSpeedups(client).catch(() => null),
        client.request('/v1/warden/config', WardenConfigViewSchema).catch(() => null),
        client.request('/v1/learning/config', LearningConfigSchema).catch(() => null),
        readFleetRuntimes(client).catch(() => null),
        readConfigFile(client, VOICE_FILE).catch(() => null),
      ]);
      if (!live) return;
      const jev = jevKeyStatus(speedups).state === 'set';
      setFacts({
        ...(speedups === null
          ? {}
          : { keys: Object.fromEntries(speedups.providers.map(provider => [provider.label, provider.set])) }),
        ...(warden === null ? {} : { warden: wardenSummary(warden.config, jev, wardenMachineDefaultLogin(warden)) }),
        ...(learning === null ? {} : { passiveDefault: learning.passiveDefault }),
        ...(voice === null ? {} : { voiceEngine: machineVoiceEngine(voice.text) }),
        ...(runtimes === null
          ? {}
          : {
              runtimes: {
                claude: runtimes.runtimes.filter(runtime => runtime.harness === 'claude').map(runtime => runtime.name),
                codex: runtimes.runtimes.filter(runtime => runtime.harness === 'codex').map(runtime => runtime.name),
              },
              needsSignIn: runtimes.runtimes
                .filter(runtime => runtime.credential.status === 'needs_sign_in')
                .map(runtime => runtime.name),
            }),
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
    startAt,
    onFinish,
    onLeave,
    onNavigate,
    voiceCleanup,
    voice,
    createPairingClient,
    pollMs,
    ...tab
  } = props;
  const { connection, machineName } = tab;
  const [progress, setProgress] = useState<MachineSetupProgress>(() => {
    const kept = store?.saved ?? ONBOARDING_START;
    return startAt === undefined ? kept : goToOnboardingStep(kept, startAt);
  });
  const [clonedFrom, setClonedFrom] = useState<string | undefined>(undefined);
  const [reports, setReports] = useState<Readonly<Partial<Record<'claude' | 'codex', HarnessReport>>>>({});
  const [carried, setCarried] = useState<{ readonly report: HarnessReport; readonly on: MachineSetupStepId } | null>(
    null,
  );
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const footerQuiet = useFooterQuietState();
  const pending = usePendingSavesState();
  const [saving, setSaving] = useState(false);
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

  const doneNotes = Object.values(reports).flatMap(report => [
    ...(report.conversations === null ? [] : [report.conversations]),
    // Frozen at import time, so only the ones the machine still reports (read when Done opened) are said.
    ...report.signIn
      .filter(item => facts.needsSignIn === undefined || facts.needsSignIn.includes(item.runtime))
      .map(item => `${item.runtime} still needs a sign-in (Settings › Sign-ins).`),
  ]);

  /** Continue on a page with an edit not saved yet: save it, and move on only when every save went through. */
  const saveAndContinue = async (): Promise<void> => {
    setSaving(true);
    try {
      for (const edit of pending.saves) if (!(await edit.save())) return;
      move(continueOnboarding);
    } finally {
      setSaving(false);
    }
  };

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
      case 'claude':
      case 'codex':
        return (
          <OnboardingHarnessStep
            key={step}
            tab={tab}
            harness={step}
            answers={progress.answers?.[step] ?? {}}
            onAnswers={answers => move(current => answerOnboardingHarness(current, step, answers))}
            onReady={() => move(current => markOnboardingStep(current, step))}
            onFinished={(report, stillHere) => {
              if (report !== null) {
                setReports(current => ({ ...current, [step]: report }));
                setCarried({ report, on: onboardingStepAfter(step) });
              }
              move(current => completeOnboardingStep(current, step, stillHere));
            }}
            {...(pollMs === undefined ? {} : { pollMs })}
          />
        );
      case 'speedups':
        return (
          <OnboardingSpeedupsStep
            tab={tab}
            onSaved={() => move(current => markOnboardingStep(current, 'speedups'))}
            onFinished={stillHere => move(current => completeOnboardingStep(current, 'speedups', stillHere))}
          />
        );
      case 'voice':
        return (
          <OnboardingVoiceStep
            tab={tab}
            {...(voice === undefined ? {} : { voice })}
            onSet={() => move(current => markOnboardingStep(current, 'voice'))}
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
        return (
          <OnboardingDoneStep
            rows={rows}
            machineName={machineName}
            onNavigate={onNavigate}
            notes={doneNotes}
            {...(onboardingNeedsRuntime(facts)
              ? { createRuntimeHref: onboardingLaterHref(connection.daemonId, machineName, 'claude') }
              : {})}
          />
        );
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
          : // No scrollbar on the phone strip: its thumb read as a stray underline under the bar.
            'relative flex shrink-0 gap-1 overflow-x-auto border-b border-border-strong px-panel py-2 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden',
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
              <p className="kt-label m-0">Set up {machineName}</p>
              {at === 'done' ? null : (
                <button
                  type="button"
                  className="shrink-0 text-meta text-muted underline"
                  data-onboarding-later-all=""
                  onClick={onLeave}
                >
                  Finish later
                </button>
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
            {carried !== null && carried.on === at && carriesNote(carried.report) ? (
              <ImportCarryNote report={carried.report} machineName={machineName} />
            ) : null}
            <FooterSlotContext.Provider value={slot}>
              <FooterQuietContext.Provider value={footerQuiet}>
                <FooterSaveContext.Provider value={pending.report}>
                  <div className="min-w-0">{body(at)}</div>
                </FooterSaveContext.Provider>
              </FooterQuietContext.Provider>
            </FooterSlotContext.Provider>
          </div>
        </div>
        <footer
          className="border-t border-border-strong bg-surface px-panel pt-3 [--own-pad-bottom:0.75rem] md:px-8"
          data-onboarding-foot=""
          data-safe-bottom=""
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
              {at === 'done' ? null : (
                <Button type="button" variant="ghost" data-onboarding-skip="" onClick={() => move(skipOnboardingStep)}>
                  Skip
                </Button>
              )}
              <span className="contents" ref={setSlot} data-onboarding-slot="" />
              {at === 'done' ? (
                <Button type="button" variant="primary" data-onboarding-finish="" onClick={finish}>
                  Finish setup
                </Button>
              ) : ownsPrimary(at, progress.start) || footerQuiet.quiet ? null : pending.saves.length > 0 ? (
                // An edit on this page is not saved yet: Continue saves it first, so nothing is dropped quietly.
                <Button
                  type="button"
                  variant="primary"
                  data-onboarding-next="save"
                  disabled={saving || pending.saves.some(edit => !edit.ready)}
                  onClick={() => void saveAndContinue()}
                >
                  {saving ? 'Saving…' : 'Save and continue'}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  data-onboarding-next=""
                  onClick={() => move(continueOnboarding)}
                >
                  Continue
                </Button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}
