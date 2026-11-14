/**
 * Onboarding's per-machine views: the steps screen (`/d/<machine>/onboarding/steps`: every step the plugins declared,
 * each with the panels they contributed to the `onboarding.step` slot) and the Setup tab in the machine's Settings,
 * which is the way back to it for a machine that still has steps to look at.
 */

import { daemonHomeHref, daemonOfClient, daemonSettingsHref, PanelSlot, useOptionalRouter } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import type { PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ONBOARDING_STEP_SLOT, type OnboardingView, stepSubject, type StepState } from '../../contract/index.ts';
import { LINK_COSTS } from '../link-costs.ts';
import { onboardingScreen } from '../onboarding-screen.ts';

const STATE_LABEL: Readonly<Record<StepState, string>> = {
  pending: 'Not looked at yet',
  found: 'Already set up',
  later: 'Left for later',
  done: 'Done',
  skipped: 'Skipped',
};

/**
 * Whether to say what linking the terminal's own sign-in costs under this step: when the check that found it said it is
 * the terminal's own (`linked`). The fact is the step's, recorded with its answer, so no plugin id is named here.
 */
const sayLinkCosts = (step: { readonly state: StepState; readonly linked?: true | undefined }): boolean =>
  step.state === 'found' && step.linked === true;

type Reading =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly view: OnboardingView };

/** Reads the steps now and again whenever any step changes anywhere; a failed read says so and can be tried again. */
function useOnboardingView(client: PluginClient): { readonly reading: Reading; readonly retry: () => void } {
  const screen = useMemo(() => onboardingScreen(client), [client]);
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });
  const again = useRef<(() => void) | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      screen.load().then(
        view => {
          if (live) setReading({ kind: 'ready', view });
        },
        () => {
          // A failed refresh keeps the steps already drawn; only a first read that fails says so.
          if (live) setReading(current => (current.kind === 'ready' ? current : { kind: 'failed' }));
        },
      );
    };
    again.current = () => {
      setReading(current => (current.kind === 'failed' ? { kind: 'loading' } : current));
      load();
    };
    load();
    const stop = screen.subscribe(load);
    return () => {
      live = false;
      stop();
    };
  }, [screen]);
  return { reading, retry: useCallback(() => again.current?.(), []) };
}

/** A link that moves with the router (no page load) where there is one, and is a plain link elsewhere. */
function RouterLink({
  href,
  children,
  ...marks
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly [mark: `data-${string}`]: string;
}): ReactNode {
  const router = useOptionalRouter();
  const go = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (router === null || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(href);
  };
  return (
    <a href={href} onClick={go} className="inline-flex min-h-11 items-center text-cell" {...marks}>
      {children}
    </a>
  );
}

/**
 * The close of the setup, once no step waits for an answer: what was set up, and each step left for later or skipped,
 * with the way to its settings, so nothing left undone is lost.
 */
export function SetupSummary({
  daemon,
  steps,
}: {
  readonly daemon: string;
  readonly steps: readonly {
    readonly plugin: string;
    readonly id: string;
    readonly title: string;
    readonly state: StepState;
  }[];
}): ReactNode {
  if (steps.length === 0 || steps.some(step => step.state === 'pending')) return null;
  const set = steps.filter(step => step.state === 'done' || step.state === 'found');
  const later = steps.filter(step => step.state === 'later' || step.state === 'skipped');
  return (
    <section className="kt-panel flex flex-col gap-2 p-3" data-onboarding-summary="">
      <h2 className="m-0 text-cell font-semibold">Setup is finished</h2>
      <p className="m-0 text-cell text-muted" data-onboarding-summary-set="">
        {set.length === 0 ? 'No step was set up here.' : `Set up: ${set.map(step => step.title).join(', ')}.`}
      </p>
      {later.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-onboarding-summary-later="">
          <p className="m-0 text-cell text-muted">Set up later, from Settings:</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {later.map(step => (
              <li key={`${step.plugin}.${step.id}`}>
                <RouterLink
                  href={daemonSettingsHref(daemon, step.plugin)}
                  data-onboarding-later-link={`${step.plugin}.${step.id}`}
                >
                  {step.title}
                </RouterLink>{' '}
                <span className="text-meta text-muted">({STATE_LABEL[step.state].toLowerCase()})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Where a machine's steps page is. */
export const stepsHref = (daemon: string): string => `${daemonHomeHref(daemon)}/onboarding/steps`;

/** `/d/<machine>/onboarding/steps`: every declared step, with the panels the plugins contributed to it. */
export function createStepsScreen(client: PluginClient) {
  const screen = onboardingScreen(client);
  return function StepsScreen(_props: ScreenProps): ReactNode {
    const daemon = daemonOfClient(client);
    const { reading, retry } = useOnboardingView(client);
    const [unsaved, setUnsaved] = useState<{
      readonly plugin: string;
      readonly step: string;
      readonly state: Exclude<StepState, 'pending'>;
    } | null>(null);
    const answer = useCallback((plugin: string, step: string, state: Exclude<StepState, 'pending'>) => {
      setUnsaved(null);
      void screen.answer(plugin, step, { state }).catch(() => setUnsaved({ plugin, step, state }));
    }, []);
    if (daemon === undefined || reading.kind === 'loading')
      return (
        <p role="status" className="m-0 p-4 text-cell text-muted">
          Loading the setup steps…
        </p>
      );
    if (reading.kind === 'failed')
      return (
        <div className="flex flex-col items-start gap-2 p-4" data-onboarding-read-failed="">
          <p role="alert" className="m-0 text-cell text-muted">
            Could not read the setup steps from this machine.
          </p>
          <Button type="button" size="sm" onClick={retry} data-onboarding-retry="">
            Try again
          </Button>
        </div>
      );
    const { view } = reading;
    return (
      <section className="mx-auto flex w-full max-w-[560px] flex-col gap-3 p-3" data-onboarding-steps="">
        <h1 className="m-0 text-title font-semibold">Set up this machine</h1>
        {unsaved === null ? null : (
          <div className="flex flex-wrap items-center gap-2" data-onboarding-unsaved="">
            <p role="alert" className="m-0 text-cell text-muted">
              That answer was not saved.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => answer(unsaved.plugin, unsaved.step, unsaved.state)}
              data-onboarding-retry-answer=""
            >
              Try again
            </Button>
          </div>
        )}
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
                {sayLinkCosts(step) ? (
                  <p className="m-0 text-meta text-muted" data-link-costs="">
                    {LINK_COSTS}
                  </p>
                ) : null}
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
        <SetupSummary daemon={daemon} steps={view.steps} />
        <RouterLink href={daemonHomeHref(daemon)} data-onboarding-open-machine="">
          Open this machine
        </RouterLink>
      </section>
    );
  };
}

/**
 * The machine's Settings › Setup tab: how many steps still wait for an answer, and the way to the steps screen. It is
 * the entry for a machine that was paired but not set up, since nothing else links to the steps.
 */
export function createSetupTab(client: PluginClient) {
  return function SetupTab(_props: SettingsProps): ReactNode {
    const daemon = daemonOfClient(client);
    const { reading, retry } = useOnboardingView(client);
    if (daemon === undefined) return null;
    if (reading.kind === 'loading')
      return (
        <p role="status" className="m-0 text-cell text-muted">
          Looking at the setup steps…
        </p>
      );
    if (reading.kind === 'failed')
      return (
        <div className="flex flex-col items-start gap-2" data-onboarding-read-failed="">
          <p role="alert" className="m-0 text-cell text-muted">
            Could not read the setup steps from this machine.
          </p>
          <Button type="button" size="sm" onClick={retry} data-onboarding-retry="">
            Try again
          </Button>
        </div>
      );
    const waiting = reading.view.steps.filter(step => step.state === 'pending').length;
    return (
      <section className="flex flex-col items-start gap-2" data-onboarding-setup-tab={waiting}>
        <p className="m-0 text-cell text-muted">
          {waiting === 0
            ? 'Every setup step on this machine has an answer.'
            : waiting === 1
              ? '1 setup step on this machine has not been looked at yet.'
              : `${waiting} setup steps on this machine have not been looked at yet.`}
        </p>
        <RouterLink href={stepsHref(daemon)} data-onboarding-open-steps="">
          {waiting === 0 ? 'Review the setup steps' : 'Open the setup steps'}
        </RouterLink>
      </section>
    );
  };
}
