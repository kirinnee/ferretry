/**
 * Onboarding's per-machine views: the steps screen (`/d/<machine>/onboarding/steps`: every step the plugins declared,
 * each with the panels they contributed to the `onboarding.step` slot) and the Setup tab in the machine's Settings,
 * which is the way back to it for a machine that still has steps to look at.
 */

import { daemonOfClient, daemonSettingsHref, SettingGroup, SettingRow, useOptionalRouter } from '@ferretry/app';
import { Button, Loading, type ReadPress, readPress } from '@ferretry/app/ui';
import type { PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type OnboardingView, sideOf, type StepState } from '../../contract/index.ts';
import { setupFlowHref } from '../features/setup-flow/flow-href.ts';
import { onboardingScreen } from '../onboarding-screen.ts';

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
    const load = (press: ReadPress = {}): void => {
      screen.load(press).then(
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
      load(readPress(true));
    };
    load();
    const stop = screen.subscribe(() => load());
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

/** A step's group, as the closing summary reads it (the page titles are never listed: they say nothing out of context). */
export interface SummaryStep {
  readonly plugin: string;
  readonly id: string;
  readonly title: string;
  /** The progress bar's name for the step's plugin ("Claude Code"): what the summary calls it. */
  readonly group: string;
  readonly state: StepState;
}

/** The plugin whose setup page names the machine itself. */
const MACHINE_PLUGIN = 'onboarding';

/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

interface SummaryGroup {
  readonly plugin: string;
  readonly group: string;
  readonly set: number;
  readonly left: number;
}

/** One entry per plugin, in the order the flow met them: how many of its pages were set up and how many were not. */
const groupsOf = (steps: readonly SummaryStep[]): readonly SummaryGroup[] => {
  const groups = new Map<string, SummaryGroup>();
  for (const step of steps) {
    const before = groups.get(step.plugin) ?? {
      plugin: step.plugin,
      group: step.group,
      set: 0,
      left: 0,
    };
    const wasSet = step.state === 'done' || step.state === 'found';
    groups.set(step.plugin, {
      ...before,
      set: before.set + (wasSet ? 1 : 0),
      left: before.left + (wasSet ? 0 : 1),
    });
  }
  return [...groups.values()];
};

/**
 * The close of the setup, once no step waits for an answer, in a few plain sentences: what was set up here, and what was
 * skipped, each with the way to its Settings so nothing left undone is lost. It names plugins ("Claude Code"), never the
 * pages inside them.
 */
export function SetupSummary({
  daemon,
  steps,
}: {
  readonly daemon: string;
  readonly steps: readonly SummaryStep[];
}): ReactNode {
  if (steps.length === 0 || steps.some(step => step.state === 'pending')) return null;
  const groups = groupsOf(steps);
  const left = groups.filter(group => group.left > 0);
  // The machine's own page (its name) is not a thing to list: the sentence is about what was brought in.
  const named = groups.filter(group => group.set > 0);
  const set = named.some(group => group.plugin !== MACHINE_PLUGIN)
    ? named.filter(group => group.plugin !== MACHINE_PLUGIN)
    : named;
  return (
    <section className="kt-panel flex flex-col gap-3 p-4" data-onboarding-summary="">
      <p className="m-0 text-row leading-base text-fg" data-onboarding-summary-set="">
        {set.length === 0
          ? 'Nothing was set up this time.'
          : `Set up on this machine: ${listOf(set.map(group => group.group))}.`}{' '}
        {left.length === 0 ? 'Nothing was skipped.' : null}
      </p>
      {left.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-onboarding-summary-later="">
          <p className="m-0 text-cell leading-base text-muted">
            Skipped for now. You can change these any time in Settings:
          </p>
          <ul className="m-0 flex list-none flex-col p-0">
            {left.map(group => (
              <li key={group.plugin} className="flex min-h-11 items-center gap-2">
                <RouterLink href={daemonSettingsHref(daemon, group.plugin)} data-onboarding-later-link={group.plugin}>
                  {group.group}
                </RouterLink>
                {group.set > 0 ? <span className="text-meta text-muted">(some pages skipped)</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Where a machine's setup is: the flow, which resumes at the first page still to answer. */
export const stepsHref = (daemon: string): string => setupFlowHref(daemon);

/**
 * `/d/<machine>/onboarding/steps` (and v4's `/d/<machine>/setup`): the old scrolling list of every step, now a way into the
 * setup flow (`onboarding/setup`), which draws the same steps one page at a time. A bookmark or an old link lands there.
 */
export function createStepsScreen(client: PluginClient) {
  return function StepsScreen(_props: ScreenProps): ReactNode {
    const daemon = daemonOfClient(client);
    const router = useOptionalRouter();
    // Once: the router object changes with every route, and a second navigate would loop while this screen is still mounted.
    const sent = useRef(false);
    useEffect(() => {
      if (daemon === undefined || router === null || sent.current) return;
      sent.current = true;
      router.navigate(setupFlowHref(daemon), { replace: true });
    }, [daemon, router]);
    return <Loading kind="page" label="Opening the setup…" />;
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
    const waiting = reading.view.steps.filter(step => sideOf(step) === 'daemon' && step.state === 'pending').length;
    return (
      <section className="min-w-0" data-onboarding-setup-tab={waiting}>
        <SettingGroup label="Setup steps">
          <SettingRow
            name="This machine"
            hint={
              waiting === 0
                ? 'Every setup step on this machine has an answer.'
                : waiting === 1
                  ? '1 setup step on this machine has not been looked at yet.'
                  : `${waiting} setup steps on this machine have not been looked at yet.`
            }
            control={() => (
              <RouterLink href={stepsHref(daemon)} data-onboarding-open-steps="">
                {waiting === 0 ? 'Review the setup steps' : 'Open the setup steps'}
              </RouterLink>
            )}
          />
        </SettingGroup>
      </section>
    );
  };
}
