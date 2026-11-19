/**
 * `daemon.status` › first-run-stepper: the first-run stepper on a machine's Home while any step is open. Each step's
 * button goes to the place that already does that job (a Settings tab, the new-ferret page, the unlock); this panel
 * owns no form of its own.
 */
import { daemonOfClient, daemonSettingsHref, useEveryDaemon, useOptionalRouter, useScreenHref } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useMemo } from 'react';
import { stepsHref } from '../../views/steps-screen.tsx';
import { PROJECTLESS_WORDS } from './projectless-words.ts';
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
      // The machine wants its unlock before it can say whether this step holds: that is the one thing to press.
      if (current.locked === true)
        return row === undefined ? undefined : { label: 'Unlock', run: () => void row.unlock() };
      const go = (href: string | undefined) => (href === undefined ? undefined : () => router?.navigate(href));
      switch (current.id) {
        case 'passkey': {
          const run = go(daemonSettingsHref(daemon, 'access', 'security'));
          return run === undefined ? undefined : { label: 'Add a passkey', run };
        }
        case 'name': {
          const run = go(daemonSettingsHref(daemon, 'kernel', 'name'));
          return run === undefined ? undefined : { label: 'Name this machine', run };
        }
        // Both tool steps go to the setup steps page, where the import wizard (`runtimes.import`) finds what the tool
        // has, installs or signs in what is missing, and imports what the person picks. Until that step is on the page
        // the same page still holds each tool's own step.
        case 'claude':
        case 'codex': {
          const run = go(stepsHref(daemon));
          return run === undefined
            ? undefined
            : { label: current.id === 'claude' ? 'Set up Claude Code' : 'Set up Codex', run };
        }
        // The last step: a project (the add-project form until the create-a-project flow lands), or no project at all.
        case 'project': {
          const create = go(screenHref(daemon, 'projects', 'projects'));
          const resume = go(screenHref(daemon, 'conversation', 'links'));
          if (create === undefined) return undefined;
          return {
            label: 'Create a project',
            run: create,
            alternative: resume === undefined ? undefined : { label: 'Continue a conversation', run: resume },
            note: PROJECTLESS_WORDS,
          };
        }
        default:
          return undefined;
      }
    }, [daemon, current, row, router, screenHref]);
    if (daemon === undefined || !reading.visible || reading.steps === undefined) return null;
    return <StepperView action={action} onDismiss={reading.dismiss} steps={reading.steps} />;
  };
}
