import { describe, expect, it } from 'bun:test';
import { StepperView } from '../../../app/features/stepper/stepper-view.tsx';
import { deriveSteps, type StepperFacts } from '../../../app/features/stepper/stepper-model.ts';
import { StepperHarness } from './stepper-harness.tsx';
import { mount, must } from '../support/dom.ts';

const ALL: StepperFacts = { passkey: true, name: true, setup: true, project: true };

describe('the stepper view', () => {
  it('draws done / current / next with exactly one highlight and one button', async () => {
    const ran: string[] = [];
    const view = await mount(
      <StepperView
        action={{ label: 'Continue setup', run: () => ran.push('go') }}
        onDismiss={() => undefined}
        steps={deriveSteps({ ...ALL, setup: false, project: false })}
      />,
    );
    const items = [...view.container.querySelectorAll('[data-step]')].map(
      item => `${item.getAttribute('data-step')}:${item.getAttribute('data-state')}`,
    );
    expect(items).toEqual(['pair:done', 'passkey:done', 'name:done', 'setup:current', 'project:next']);
    expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    const buttons = view.container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Continue setup');
    must(buttons[0], 'the action').click();
    expect(ran).toEqual(['go']);
    // State is said in words too, not only in marks.
    expect(view.container.textContent).toContain('Setup — up next');
    expect(view.container.textContent).toContain('Project — later');
    await view.unmount();
  });

  it('the Project step offers Create a project (the one highlight), Continue a conversation beside it, and the projectless words', async () => {
    const ran: string[] = [];
    const view = await mount(
      <StepperView
        action={{
          label: 'Create a project',
          run: () => ran.push('create'),
          alternative: { label: 'Continue a conversation', run: () => ran.push('resume') },
          note: 'Without a project, a ferret works in a folder you name.',
        }}
        onDismiss={() => undefined}
        steps={deriveSteps({ ...ALL, project: false })}
      />,
    );
    expect(view.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('project');
    const primary = must(
      view.container.querySelector<HTMLElement>('[data-first-run-stepper-action="project"]'),
      'primary',
    );
    const other = must(
      view.container.querySelector<HTMLElement>('[data-first-run-stepper-alternative="project"]'),
      'alternative',
    );
    expect(primary.textContent).toBe('Create a project');
    expect(other.textContent).toBe('Continue a conversation');
    expect(view.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-first-run-stepper-note]')?.textContent).toContain(
      'works in a folder you name',
    );
    primary.click();
    other.click();
    expect(ran).toEqual(['create', 'resume']);
    await view.unmount();
  });

  it('says no projectless words once the step is done (a finished stepper explains nothing)', async () => {
    const view = await mount(
      <StepperView
        action={{ label: 'x', run: () => undefined, note: 'gone' }}
        onDismiss={() => undefined}
        steps={deriveSteps(ALL)}
      />,
    );
    expect(view.container.querySelector('[data-first-run-stepper-note]')).toBeNull();
    await view.unmount();
  });

  it('offers Dismiss only once every step is done', async () => {
    const open = await mount(
      <StepperView onDismiss={() => undefined} steps={deriveSteps({ ...ALL, project: false })} />,
    );
    expect(open.container.querySelector('[data-first-run-stepper-dismiss]')).toBeNull();
    await open.unmount();
    const dismissed: string[] = [];
    const done = await mount(<StepperView onDismiss={() => dismissed.push('x')} steps={deriveSteps(ALL)} />);
    must(done.container.querySelector<HTMLElement>('[data-first-run-stepper-dismiss]'), 'dismiss').click();
    expect(dismissed).toEqual(['x']);
    await done.unmount();
  });
});

describe('the stepper on a machine', () => {
  it('draws nothing until it knows, then draws the steps once', async () => {
    const blank = StepperHarness.silent(StepperHarness.answering({}).storage);
    const waiting = await mount(<blank.Component />);
    expect(waiting.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await waiting.unmount();
    const harness = StepperHarness.answering({ project: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelectorAll('[data-first-run-stepper="open"]')).toHaveLength(1);
    await view.unmount();
  });

  it('resumes after a reload: the remembered steps draw at once, before any read comes back', async () => {
    const first = StepperHarness.answering({ setup: false });
    const before = await mount(<first.Component />);
    await first.settle();
    expect(before.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('setup');
    await before.unmount();

    // A reload: new page, same storage, a machine that has not answered yet.
    const reloaded = StepperHarness.silent(first.storage);
    const after = await mount(<reloaded.Component />);
    expect(after.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('setup');
    await after.unmount();
  });

  it('an already set-up machine shows NOTHING: no stepper, no completion card, even on fresh storage', async () => {
    const harness = StepperHarness.answering({});
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();
  });

  it('a machine whose every ferret is archived is not waiting for a project (it works projectless)', async () => {
    const harness = StepperHarness.answering({ conversation: true, archivedFerret: true });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();
  });

  it('a dismissed stepper stays away after a reload, until a step opens again', async () => {
    // The stepper was open on this device (a project to make), then the last step was done: the card says so.
    const done = StepperHarness.answering({ project: false });
    const view = await mount(<done.Component />);
    await done.settle();
    expect(view.container.querySelector('[data-first-run-stepper="open"]')).not.toBeNull();
    done.change({});
    await done.settle();
    expect(view.container.querySelector('[data-first-run-stepper="done"]')).not.toBeNull();
    await done.dismiss(view.container);
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();

    const reloaded = StepperHarness.answering({}, done.storage);
    const again = await mount(<reloaded.Component />);
    await reloaded.settle();
    expect(again.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await again.unmount();

    // A project is gone: a step is open again, so the stepper has something to say.
    const reopened = StepperHarness.answering({ project: false }, done.storage);
    const last = await mount(<reopened.Component />);
    await reopened.settle();
    expect(last.container.querySelector('[data-first-run-stepper="open"]')).not.toBeNull();
    await last.unmount();
  });

  it('asks the machine six quiet reads on open (the archive too, as no project and no live ferret answers) and none by itself afterwards (no polling)', async () => {
    const harness = StepperHarness.answering({ project: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(harness.calls()).toBe(6);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(harness.calls()).toBe(6);
    await view.unmount();
  });

  it('re-reads when the machine says a step changed', async () => {
    const harness = StepperHarness.answering({ project: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    harness.change({ project: true });
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper="done"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('the stepper through a lock and a slow read', () => {
  it('an already set-up machine that was LOCKED shows the Unlock card, and after the unlock shows NOTHING (no false "set up" card)', async () => {
    const harness = StepperHarness.answering({});
    const view = await mount(<harness.Component locked />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper="open"]')).not.toBeNull();
    await view.render(<harness.Component locked={false} />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();
    // ...and after a reload on the same storage too.
    const again = StepperHarness.answering({}, harness.storage);
    const reloaded = await mount(<again.Component />);
    await again.settle();
    expect(reloaded.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await reloaded.unmount();
  });

  it('with no passkey and no setup step done, a slow passkey read draws nothing, then Passkey as the current step (never Setup first)', async () => {
    const harness = StepperHarness.answering({ passkey: false, setup: false }).holdPasskey();
    const view = await mount(<harness.Component />);
    await harness.settle(); // every other read has answered; the passkey one has not
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    harness.releasePasskey();
    await harness.settle();
    const current = [...view.container.querySelectorAll('[data-state="current"]')].map(item =>
      item.getAttribute('data-step'),
    );
    expect(current).toEqual(['passkey']);
    await view.unmount();
  });

  it('a slow passkey read behind remembered steps keeps the remembered current step, not a different one', async () => {
    const first = StepperHarness.answering({ passkey: false, setup: false });
    const before = await mount(<first.Component />);
    await first.settle();
    await before.unmount();
    const reloaded = StepperHarness.answering({ passkey: false, setup: false }, first.storage).holdPasskey();
    const after = await mount(<reloaded.Component />);
    await reloaded.settle();
    expect(after.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('passkey');
    await after.unmount();
  });
});
