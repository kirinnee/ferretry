import { describe, expect, it } from 'bun:test';
import { mount, must } from '@ferretry/app/testing';
import {
  addProjectHref,
  continueConversationHref,
  projectAction,
} from '../../../app/features/stepper/project-action.ts';
import { StepperView } from '../../../app/features/stepper/stepper-view.tsx';
import { deriveSteps } from '../../../app/features/stepper/stepper-model.ts';

const OPEN = deriveSteps({ passkey: true, name: true, setup: true, project: false });
const noop = (): void => undefined;

describe('the Project step buttons depend on their own plugin only', () => {
  it('Create a project opens the registry with its add form already open (no second press)', () => {
    expect(addProjectHref('/d/studio/projects')).toBe('/d/studio/projects?add=1');
  });

  it('Continue a conversation goes to New ferret with its continue section open (the Conversations page is gone)', () => {
    const asked: string[][] = [];
    const href = continueConversationHref((daemon, plugin, screen) => {
      asked.push([daemon, plugin, screen]);
      return `/d/${daemon}/new`;
    }, 'studio');
    expect(asked).toEqual([['studio', 'ferrets', 'new-ferret']]);
    expect(href).toBe('/d/studio/new?continue=1');
    // With the Ferrets screen off there is no address, and so no button (the same as any other missing plugin).
    expect(continueConversationHref(() => undefined, 'studio')).toBeUndefined();
  });

  it('both plugins on: Create a project is primary, Continue a conversation beside it', () => {
    const action = must(projectAction(noop, noop), 'action');
    expect(action.label).toBe('Create a project');
    expect(action.alternative?.label).toBe('Continue a conversation');
    expect(action.note).toContain('Without a project');
  });

  it('Projects paused: Continue a conversation is the one way through, and it is drawn', async () => {
    const ran: string[] = [];
    const action = must(
      projectAction(undefined, () => ran.push('resume')),
      'action',
    );
    expect(action.label).toBe('Continue a conversation');
    expect(action.alternative).toBeUndefined();
    const view = await mount(<StepperView action={action} onDismiss={noop} steps={OPEN} />);
    const button = must(
      view.container.querySelector<HTMLElement>('[data-first-run-stepper-action="project"]'),
      'button',
    );
    expect(button.textContent).toBe('Continue a conversation');
    expect(view.container.querySelector('[data-first-run-stepper-alternative]')).toBeNull();
    button.click();
    expect(ran).toEqual(['resume']);
    await view.unmount();
  });

  it('Conversations paused: Create a project alone', () => {
    const action = must(projectAction(noop, undefined), 'action');
    expect(action.label).toBe('Create a project');
    expect(action.alternative).toBeUndefined();
  });

  it('neither plugin: no button', () => {
    expect(projectAction(undefined, undefined)).toBeUndefined();
  });
});
