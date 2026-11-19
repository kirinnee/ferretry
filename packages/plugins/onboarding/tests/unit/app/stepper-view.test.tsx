import { describe, expect, it } from 'bun:test';
import { StepperView } from '../../../app/features/stepper/stepper-view.tsx';
import { deriveSteps, type StepperFacts } from '../../../app/features/stepper/stepper-model.ts';
import { StepperHarness } from './stepper-harness.tsx';
import { mount, must } from '../support/dom.ts';

const ALL: StepperFacts = { passkey: true, name: true, login: true, runtime: true, ferret: true };

describe('the stepper view', () => {
  it('draws done / current / next with exactly one highlight and one button', async () => {
    const ran: string[] = [];
    const view = await mount(
      <StepperView
        action={{ label: 'Add a login', run: () => ran.push('go') }}
        onDismiss={() => undefined}
        steps={deriveSteps({ ...ALL, login: false, runtime: false, ferret: false })}
      />,
    );
    const items = [...view.container.querySelectorAll('[data-step]')].map(
      item => `${item.getAttribute('data-step')}:${item.getAttribute('data-state')}`,
    );
    expect(items).toEqual(['pair:done', 'passkey:done', 'name:done', 'login:current', 'runtime:next', 'ferret:next']);
    expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    const buttons = view.container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Add a login');
    must(buttons[0], 'the action').click();
    expect(ran).toEqual(['go']);
    // State is said in words too, not only in marks.
    expect(view.container.textContent).toContain('Login — up next');
    expect(view.container.textContent).toContain('Runtime — later');
    await view.unmount();
  });

  it('offers Dismiss only once every step is done', async () => {
    const open = await mount(
      <StepperView onDismiss={() => undefined} steps={deriveSteps({ ...ALL, ferret: false })} />,
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
    const harness = StepperHarness.answering({ ferret: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelectorAll('[data-first-run-stepper="open"]')).toHaveLength(1);
    await view.unmount();
  });

  it('resumes after a reload: the remembered steps draw at once, before any read comes back', async () => {
    const first = StepperHarness.answering({ login: false });
    const before = await mount(<first.Component />);
    await first.settle();
    expect(before.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('login');
    await before.unmount();

    // A reload: new page, same storage, a machine that has not answered yet.
    const reloaded = StepperHarness.silent(first.storage);
    const after = await mount(<reloaded.Component />);
    expect(after.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('login');
    await after.unmount();
  });

  it('an already set-up machine shows NOTHING: no stepper, no completion card, even on fresh storage', async () => {
    const harness = StepperHarness.answering({});
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();
  });

  it('a machine whose every ferret is archived is not waiting for a first ferret', async () => {
    const harness = StepperHarness.answering({ archivedFerret: true });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    await view.unmount();
  });

  it('a dismissed stepper stays away after a reload, until a step opens again', async () => {
    // The stepper was open on this device (a ferret to make), then the last step was done: the card says so.
    const done = StepperHarness.answering({ ferret: false });
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

    // A ferret is gone: a step is open again, so the stepper has something to say.
    const reopened = StepperHarness.answering({ ferret: false }, done.storage);
    const last = await mount(<reopened.Component />);
    await reopened.settle();
    expect(last.container.querySelector('[data-first-run-stepper="open"]')).not.toBeNull();
    await last.unmount();
  });

  it('asks the machine six quiet reads on open (the archive too, as no live ferret answers) and none by itself afterwards (no polling)', async () => {
    const harness = StepperHarness.answering({ ferret: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    expect(harness.calls()).toBe(6);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(harness.calls()).toBe(6);
    await view.unmount();
  });

  it('re-reads when the machine says a step changed', async () => {
    const harness = StepperHarness.answering({ ferret: false });
    const view = await mount(<harness.Component />);
    await harness.settle();
    harness.change({ ferret: true });
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

  it('with no passkey and no login, a slow passkey read draws nothing, then Passkey as the current step (never Login first)', async () => {
    const harness = StepperHarness.answering({ passkey: false, login: false }).holdPasskey();
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
    const first = StepperHarness.answering({ passkey: false, login: false });
    const before = await mount(<first.Component />);
    await first.settle();
    await before.unmount();
    const reloaded = StepperHarness.answering({ passkey: false, login: false }, first.storage).holdPasskey();
    const after = await mount(<reloaded.Component />);
    await reloaded.settle();
    expect(after.container.querySelector('[data-state="current"]')?.getAttribute('data-step')).toBe('passkey');
    await after.unmount();
  });
});
