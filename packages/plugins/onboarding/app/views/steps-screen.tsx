/**
 * Onboarding's per-machine views: the steps screen (`/d/<machine>/onboarding/steps`: every step the plugins declared,
 * each with the panels they contributed to the `onboarding.step` slot) and the Setup tab in the machine's Settings,
 * which is the way back to it for a machine that still has steps to look at.
 */

import { daemonOfClient, SettingGroup, SettingRow, useOptionalRouter } from '@ferretry/app';
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
export function RouterLink({
  href,
  children,
  button,
  ...marks
}: {
  readonly href: string;
  readonly children: ReactNode;
  /** Drawn as a real button (the app's bordered 44px one): a link that goes to a place, looking like what it is for. */
  readonly button?: true;
  readonly [mark: `data-${string}` | `aria-${string}`]: string;
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
