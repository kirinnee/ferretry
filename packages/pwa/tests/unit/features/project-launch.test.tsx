import { afterEach, describe, expect, it } from 'bun:test';
import type { ProjectInfo, StartSessionRequest } from '@ferretry/protocol';

import { ProjectLaunch } from '../../../src/features/projects/project-launch.tsx';
import { interact, mount, type Mounted, must } from '../../support/dom.ts';

const project: ProjectInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
} as ProjectInfo;

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

const launcher = async (onLaunch: (request: StartSessionRequest) => Promise<void>): Promise<Mounted> => {
  open = await mount(<ProjectLaunch project={project} onLaunch={onLaunch} />);
  return open;
};

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const disclosure = (view: Mounted): HTMLButtonElement =>
  must(view.container.querySelector<HTMLButtonElement>('[aria-controls="project-launch-agent"]'), 'the disclosure');

/** The launch button lives inside the disclosed panel, never in the header. */
const submit = (view: Mounted): HTMLButtonElement =>
  must(view.container.querySelector<HTMLButtonElement>('#project-launch-agent button'), 'the submit button');

describe('ProjectLaunch', () => {
  it('keeps the wrapper field closed until a reader asks to launch', async () => {
    // Act
    const view = await launcher(async () => undefined);

    // Assert
    expect(disclosure(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('#project-launch-agent')).toBeNull();
  });

  it('will not start a session until an installed wrapper is named', async () => {
    // Arrange
    const started: StartSessionRequest[] = [];
    const view = await launcher(async request => {
      started.push(request);
    });

    // Act
    await press(disclosure(view));
    const button = submit(view);
    await press(button);

    // Assert — the page cannot guess a wrapper, so it refuses rather than
    // inventing one, and the daemon is never asked.
    expect(button.disabled).toBe(true);
    expect(started).toEqual([]);
    expect(view.container.textContent).toContain('Top-level interactive session in /work/ferretry');
  });

  it('starts one top-level interactive session in the project folder', async () => {
    // Arrange
    const started: StartSessionRequest[] = [];
    const view = await launcher(async request => {
      started.push(request);
    });

    // Act
    await press(disclosure(view));
    await type(
      must(view.container.querySelector<HTMLInputElement>('#project-launch-agent-name'), 'the wrapper field'),
      ' claude-auto-loge ',
    );
    await press(submit(view));

    // Assert
    expect(started).toEqual([
      { agent: 'claude-auto-loge', cwd: '/work/ferretry', mode: 'interactive', boardAccess: 'none' },
    ]);
  });

  it('states a refused launch verbatim and offers the retry rather than losing the draft', async () => {
    // Arrange
    const view = await launcher(async () => {
      throw new Error('agent wrapper claude-auto-nope is not installed');
    });

    // Act
    await press(disclosure(view));
    const field = must(
      view.container.querySelector<HTMLInputElement>('#project-launch-agent-name'),
      'the wrapper field',
    );
    await type(field, 'claude-auto-nope');
    await press(submit(view));

    // Assert
    const alert = must(view.container.querySelector('[role="alert"]'), 'the refusal');
    expect(alert.textContent).toContain('agent wrapper claude-auto-nope is not installed');
    expect(field.value).toBe('claude-auto-nope');
    expect(submit(view).textContent).toContain('Retry launch');
    expect(submit(view).disabled).toBe(false);
  });

  it('refuses a non-Error rejection without inventing a message for it', async () => {
    // Arrange
    const view = await launcher(async () => {
      throw 'the daemon closed the connection';
    });

    // Act
    await press(disclosure(view));
    await type(
      must(view.container.querySelector<HTMLInputElement>('#project-launch-agent-name'), 'the wrapper field'),
      'claude',
    );
    await press(submit(view));

    // Assert
    expect(must(view.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'the daemon closed the connection',
    );
  });

  it('does not start a second session while the first is still open', async () => {
    // Arrange
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let starts = 0;
    const view = await launcher(async () => {
      starts += 1;
      await held;
    });

    // Act
    await press(disclosure(view));
    await type(
      must(view.container.querySelector<HTMLInputElement>('#project-launch-agent-name'), 'the wrapper field'),
      'claude',
    );
    await press(submit(view));
    // A second press while the first request is still in flight.
    await press(submit(view));

    // Assert
    expect(starts).toBe(1);
    expect(submit(view).textContent).toContain('Launching…');
    expect(submit(view).disabled).toBe(true);

    release();
    await interact(async () => {
      await Promise.resolve();
    });
  });

  it('closes the wrapper field again when the disclosure is pressed twice', async () => {
    // Arrange
    const view = await launcher(async () => undefined);

    // Act
    await press(disclosure(view));
    await press(disclosure(view));

    // Assert
    expect(disclosure(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('#project-launch-agent')).toBeNull();
  });
});
