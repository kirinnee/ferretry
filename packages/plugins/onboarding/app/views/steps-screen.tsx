/**
 * Onboarding's per-machine views: the steps screen (`/d/<machine>/onboarding/steps`: every step the plugins declared,
 * each with the panels they contributed to the `onboarding.step` slot) and the Setup tab in the machine's Settings,
 * which is the way back to it for a machine that still has steps to look at.
 */

import {
  DEVICE_SETTINGS_HREF,
  daemonOfClient,
  daemonSettingsHref,
  SettingGroup,
  SettingRow,
  useOptionalRouter,
} from '@ferretry/app';
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
  button,
  ...marks
}: {
  readonly href: string;
  readonly children: ReactNode;
  /** Drawn as a real button (the app's bordered 44px one): a link that goes to a place, looking like what it is for. */
  readonly button?: true;
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
    <a
      href={href}
      onClick={go}
      className={button === true ? 'kt-btn min-h-11 px-4 no-underline' : 'inline-flex min-h-11 items-center text-cell'}
      {...marks}
    >
      {children}
    </a>
  );
}

/** A step, as the closing summary reads it (the page titles of a plugin's many pages are never listed: they say nothing out of context). */
export interface SummaryStep {
  readonly plugin: string;
  readonly id: string;
  readonly title: string;
  /** The progress bar's name for the step's plugin ("Claude Code"): what the summary calls a machine step. */
  readonly group: string;
  readonly state: StepState;
  /** A machine step is set up ON the machine; a client step is this device's own (named by its title: "Passkey"). */
  readonly phase?: 'daemon' | 'client';
}

/** The plugin whose setup page names the machine itself. */
const MACHINE_PLUGIN = 'onboarding';

/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

interface SummaryGroup {
  /** The Settings tab that holds it. */
  readonly plugin: string;
  readonly name: string;
  readonly phase: 'daemon' | 'client';
  readonly set: number;
  readonly left: number;
}

/**
 * One entry per plugin on the machine (in the order the flow met them) and one per page of this device (a device page
 * is named by its own title): how many of its pages were set up and how many were not.
 */
const groupsOf = (steps: readonly SummaryStep[]): readonly SummaryGroup[] => {
  const groups = new Map<string, SummaryGroup>();
  for (const step of steps) {
    const phase = step.phase ?? 'daemon';
    const id = phase === 'client' ? `client:${step.plugin}.${step.id}` : `daemon:${step.plugin}`;
    const before = groups.get(id) ?? {
      plugin: step.plugin,
      name: phase === 'client' ? step.title : step.group,
      phase,
      set: 0,
      left: 0,
    };
    const wasSet = step.state === 'done' || step.state === 'found';
    groups.set(id, { ...before, set: before.set + (wasSet ? 1 : 0), left: before.left + (wasSet ? 0 : 1) });
  }
  return [...groups.values()];
};

/**
 * The close of the setup, once no step waits for an answer: what was set up (on the machine, and on this device), and what
 * was skipped, each skipped thing with a button to its Settings so nothing left undone is lost, and where to change
 * the rest. It names plugins ("Claude Code") and device pages ("Passkey"), never the pages inside a plugin.
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
  const named = (phase: SummaryGroup['phase']): readonly string[] => {
    const set = groups.filter(group => group.phase === phase && group.set > 0);
    // The machine's own page (its name) is not a thing to list: the sentence is about what was brought in.
    const listed =
      phase === 'daemon' && set.some(group => group.plugin !== MACHINE_PLUGIN)
        ? set.filter(group => group.plugin !== MACHINE_PLUGIN)
        : set;
    return listed.map(group => group.name);
  };
  const onMachine = named('daemon');
  const onDevice = named('client');
  const sentences = [
    onMachine.length === 0 ? null : `Set up on this machine: ${listOf(onMachine)}.`,
    onDevice.length === 0 ? null : `Set up on this device: ${listOf(onDevice)}.`,
  ].filter((line): line is string => line !== null);
  return (
    <section className="kt-panel flex flex-col gap-3 p-4" data-onboarding-summary="">
      <div className="flex flex-col gap-1" data-onboarding-summary-set="">
        {sentences.length === 0 ? (
          <p className="m-0 text-row leading-base text-fg">Nothing was set up this time.</p>
        ) : (
          sentences.map(line => (
            <p key={line} className="m-0 text-row leading-base text-fg">
              {line}
            </p>
          ))
        )}
        {left.length === 0 ? <p className="m-0 text-row leading-base text-muted">Nothing was skipped.</p> : null}
      </div>
      {left.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-onboarding-summary-later="">
          <p className="m-0 text-row leading-base text-muted">Skipped for now. Finish any of these when you like:</p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {left.map(group => (
              <li key={`${group.phase}:${group.plugin}:${group.name}`} className="flex items-center gap-2">
                <RouterLink
                  button
                  href={group.phase === 'client' ? DEVICE_SETTINGS_HREF : daemonSettingsHref(daemon, group.plugin)}
                  data-onboarding-later-link={group.plugin}
                >
                  {group.name}
                </RouterLink>
                {group.set > 0 ? <span className="text-meta text-muted">(some pages skipped)</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col items-start gap-2" data-onboarding-summary-where="">
        <p className="m-0 text-row leading-base text-muted">
          {onDevice.length > 0 && onMachine.length === 0
            ? 'You can change any of this later in the Settings for this device.'
            : 'You can change any of this later in this machine\u2019s Settings.'}
        </p>
        <RouterLink
          button
          href={onDevice.length > 0 && onMachine.length === 0 ? DEVICE_SETTINGS_HREF : daemonSettingsHref(daemon)}
          data-onboarding-open-settings=""
        >
          Open Settings
        </RouterLink>
      </div>
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
