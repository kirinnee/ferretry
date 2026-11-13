import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { LaunchRequest } from '../../../app/lib/ferrets.ts';
import { ProjectLaunch } from '../../../app/views/project-launch.tsx';
import { clickEvent, PROJECT, typeInto } from './support/client.ts';

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

const launcher = async (onLaunch: (request: LaunchRequest) => Promise<void>): Promise<Mounted> => {
  open = await mount(<ProjectLaunch project={PROJECT} onLaunch={onLaunch} />);
  return open;
};

const press = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(clickEvent()));
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => typeInto(input, value));
};

const disclosure = (view: Mounted): HTMLButtonElement =>
  must(view.container.querySelector<HTMLButtonElement>('[aria-controls="project-launch-runtime"]'), 'the disclosure');

/** The launch button lives inside the disclosed panel, never in the header. */
const submit = (view: Mounted): HTMLButtonElement =>
  must(view.container.querySelector<HTMLButtonElement>('#project-launch-runtime button'), 'the submit button');

const runtimeField = (view: Mounted): HTMLInputElement =>
  must(view.container.querySelector<HTMLInputElement>('#project-launch-runtime-name'), 'the runtime field');

describe('ProjectLaunch', () => {
  it('keeps the runtime field closed until a reader asks to start', async () => {
    const view = await launcher(async () => undefined);

    expect(disclosure(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('#project-launch-runtime')).toBeNull();
  });

  it('will not start a ferret until a runtime is named', async () => {
    const started: LaunchRequest[] = [];
    const view = await launcher(async request => {
      started.push(request);
    });

    await press(disclosure(view));
    const button = submit(view);
    await press(button);

    // The page cannot guess a runtime, so it refuses rather than inventing one, and the daemon is never asked.
    expect(button.disabled).toBe(true);
    expect(started).toEqual([]);
    expect(view.container.textContent).toContain('Top-level interactive ferret in /work/ferretry');
  });

  it('starts one top-level INTERACTIVE ferret in the project folder, never an autonomous one', async () => {
    const started: LaunchRequest[] = [];
    const view = await launcher(async request => {
      started.push(request);
    });

    await press(disclosure(view));
    await type(runtimeField(view), ' claude-code ');
    await press(submit(view));

    expect(started).toEqual([{ runtime: 'claude-code', folder: '/work/ferretry', mode: 'interactive' }]);
  });

  it('states a refused start verbatim and offers the retry rather than losing the draft', async () => {
    const view = await launcher(async () => {
      throw new Error('runtime claude-nope is not set up');
    });

    await press(disclosure(view));
    await type(runtimeField(view), 'claude-nope');
    await press(submit(view));

    expect(must(view.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'runtime claude-nope is not set up',
    );
    expect(runtimeField(view).value).toBe('claude-nope');
    expect(submit(view).textContent).toContain('Retry launch');
    expect(submit(view).disabled).toBe(false);
  });

  it('refuses a non-Error rejection without inventing a message for it', async () => {
    const view = await launcher(async () => {
      throw 'the daemon closed the connection';
    });

    await press(disclosure(view));
    await type(runtimeField(view), 'claude');
    await press(submit(view));

    expect(must(view.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'the daemon closed the connection',
    );
  });

  it('does not start a second ferret while the first is still open', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let starts = 0;
    const view = await launcher(async () => {
      starts += 1;
      await held;
    });

    await press(disclosure(view));
    await type(runtimeField(view), 'claude');
    await press(submit(view));
    // A second press while the first request is still in flight.
    await press(submit(view));

    expect(starts).toBe(1);
    expect(submit(view).textContent).toContain('Launching…');
    expect(submit(view).disabled).toBe(true);

    release();
    await interact(async () => {
      await Promise.resolve();
    });
  });

  it('closes the runtime field again when the disclosure is pressed twice', async () => {
    const view = await launcher(async () => undefined);

    await press(disclosure(view));
    await press(disclosure(view));

    expect(disclosure(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('#project-launch-runtime')).toBeNull();
  });
});
