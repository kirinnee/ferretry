/**
 * `daemon.status` › first-run-stepper: the first-run stepper on a machine's Home while any step is open. Each step's
 * button goes to the place that already does that job (a Settings tab, the new-ferret page, the unlock); this panel
 * owns no form of its own.
 */
import { daemonOfClient, daemonSettingsHref, useEveryDaemon, useOptionalRouter, useScreenHref } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useMemo } from 'react';
import { stepsHref } from '../../views/steps-screen.tsx';
import { addProjectHref, projectAction } from './project-action.ts';
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
        // Every plugin's own steps (Claude Code, Codex, Warden, …) are one setup flow, opened at the first page still to answer.
        case 'setup': {
          const run = go(stepsHref(daemon));
          return run === undefined ? undefined : { label: 'Continue setup', run };
        }
        // The last step: a project (the registry with its add form already open, until the create-a-project flow lands),
        // or no project at all. Each button depends on its own plugin alone: Projects off leaves Continue a conversation
        // as the one way through, Conversations off leaves Create a project.
        case 'project': {
          const projects = screenHref(daemon, 'projects', 'projects');
          return projectAction(
            go(projects === undefined ? undefined : addProjectHref(projects)),
            go(screenHref(daemon, 'conversation', 'links')),
          );
        }
        default:
          return undefined;
      }
    }, [daemon, current, row, router, screenHref]);
    if (daemon === undefined || !reading.visible || reading.steps === undefined) return null;
    return <StepperView action={action} onDismiss={reading.dismiss} steps={reading.steps} />;
  };
}
