/**
 * `daemon.status` › first-run-stepper: the first-run stepper on a machine's Home while any step is open. Each step's
 * button goes to the place that already does that job (a Settings tab, the new-ferret page, the unlock); this panel
 * owns no form of its own.
 */
import { daemonOfClient, daemonSettingsHref, useEveryDaemon, useOptionalRouter, useScreenHref } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useMemo } from 'react';
import { StepperView, type StepperAction } from './stepper-view.tsx';
import { useStepper } from './use-stepper.ts';

export function createStepperPanel(client: PluginClient) {
  return function StepperPanel(): ReactNode {
    const daemon = daemonOfClient(client);
    const row = useEveryDaemon().find(candidate => candidate.daemon === daemon);
    const router = useOptionalRouter();
    const screenHref = useScreenHref();
    const reading = useStepper(client, daemon ?? '', row?.locked ?? false);
    const current = reading.steps?.find(step => step.state === 'current');
    const action = useMemo((): StepperAction | undefined => {
      if (daemon === undefined || current === undefined) return undefined;
      const go = (href: string | undefined) => (href === undefined ? undefined : () => router?.navigate(href));
      switch (current.id) {
        case 'passkey': {
          if (row?.locked === true) return { label: 'Unlock', run: () => void row.unlock() };
          const run = go(daemonSettingsHref(daemon, 'access', 'security'));
          return run === undefined ? undefined : { label: 'Add a passkey', run };
        }
        case 'name': {
          const run = go(daemonSettingsHref(daemon, 'kernel', 'name'));
          return run === undefined ? undefined : { label: 'Name this machine', run };
        }
        case 'login': {
          const run = go(daemonSettingsHref(daemon, 'logins', 'logins'));
          return run === undefined ? undefined : { label: 'Add a login', run };
        }
        case 'runtime': {
          const run = go(daemonSettingsHref(daemon, 'runtimes', 'runtimes'));
          return run === undefined ? undefined : { label: 'Add a runtime', run };
        }
        case 'ferret': {
          const run = go(screenHref(daemon, 'ferrets', 'new-ferret'));
          return run === undefined ? undefined : { label: 'New ferret', run };
        }
        default:
          return undefined;
      }
    }, [daemon, current, row, router, screenHref]);
    if (daemon === undefined || !reading.visible || reading.steps === undefined) return null;
    return <StepperView action={action} onDismiss={reading.dismiss} steps={reading.steps} />;
  };
}
