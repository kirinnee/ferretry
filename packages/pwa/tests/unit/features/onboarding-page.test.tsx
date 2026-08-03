/**
 * The stepper, driven rather than described.
 *
 * These assertions are all document facts — which stage is on the glass, what
 * has focus, which controls exist — because every one of them is a claim about
 * a person's ability to finish setup, and none of them survives being asserted
 * against source text.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { OnboardingPage } from '../../../src/features/onboarding/onboarding-page.tsx';
import {
  OnboardingProgressStore,
  type OnboardingProgressStorage,
} from '../../../src/features/onboarding/onboarding-progress.ts';
import { interact, mount, must } from '../../support/dom.ts';

class MemoryStorage implements OnboardingProgressStorage {
  #value: string | null = null;
  getItem(): string | null {
    return this.#value;
  }
  setItem(_key: string, next: string): void {
    this.#value = next;
  }
}

/** Lets a `requestAnimationFrame` callback run, the way a real frame would. */
const nextFrame = async (): Promise<void> =>
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => resolve());
  });

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const buttonWith = (container: HTMLElement, selector: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(selector), `a control matching ${selector}`);

const stepOf = (container: HTMLElement): string | null =>
  must(container.querySelector('[data-onboarding="setup"]'), 'the stepper').getAttribute('data-onboarding-step');

interface PageOptions {
  readonly progress?: OnboardingProgressStore;
  readonly fleetReady?: boolean;
  readonly onOpenFleet?: () => void;
}

const pageWith = async (options: PageOptions = {}) => {
  const opened: string[] = [];
  const view = await mount(
    <OnboardingPage
      progress={options.progress ?? new OnboardingProgressStore({ storage: new MemoryStorage() })}
      write={async () => {}}
      channel="apt"
      fleetReady={options.fleetReady ?? false}
      onOpenFleet={options.onOpenFleet ?? (() => opened.push('fleet'))}
      renderPairing={({ onPaired }) => (
        <>
          <input id="fake-pairing-link" aria-label="Pairing link" />
          <button type="button" data-test-pair="" onClick={onPaired}>
            pretend the daemon answered
          </button>
        </>
      )}
    />,
  );
  return { opened, view };
};

afterEach(() => {
  document.documentElement.removeAttribute('data-keyboard');
});

describe('the first-run stepper', () => {
  it('opens on install, showing one stage and the whole track', async () => {
    const { view } = await pageWith();

    expect(stepOf(view.container)).toBe('install');
    expect(view.container.textContent).toContain('Ferretry runs on your own machine');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the stage heading').textContent).toBe('Install Ferretry');
    expect(view.container.textContent).toContain('Step 1 of 4');

    // A real ordered list, not a row of divs pretending to be one.
    const track = must(view.container.querySelector('ol'), 'the step track');
    expect(track.querySelectorAll('li')).toHaveLength(4);
    expect(must(track.querySelector('[aria-current="step"]'), 'the current step').textContent).toContain('Install');
    // Only the stages already reached are jumpable, and none have been yet.
    expect(track.querySelectorAll('[data-onboarding-jump]')).toHaveLength(0);
    // State is never carried by colour alone.
    expect(track.textContent).toContain('current step');
    expect(track.textContent).toContain('not reached yet');
    await view.unmount();
  });

  it('always offers Next where it cannot check the machine, and never where it can', async () => {
    const { view } = await pageWith();

    // Install: unverifiable, so Next is unconditional.
    expect(view.container.querySelector('[data-onboarding-back]')).toBeNull();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(stepOf(view.container)).toBe('daemon');

    // Daemon: also unverifiable.
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(stepOf(view.container)).toBe('pair');

    // Pair IS verifiable — the daemon answers in this tab — so there is no
    // button here that could declare a browser paired with nothing "done".
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).not.toBeNull();
    await view.unmount();
  });

  it('moves focus to the new stage heading, but not on the first paint', async () => {
    const { view } = await pageWith();
    const heading = must(view.container.querySelector('#onboarding-step-title'), 'the stage heading');
    // The initial render is a page load; the browser has already placed focus.
    expect(document.activeElement).not.toBe(heading);

    await click(buttonWith(view.container, '[data-onboarding-next]'));

    expect(document.activeElement).toBe(must(view.container.querySelector('#onboarding-step-title'), 'the heading'));
    await view.unmount();
  });

  it('lets the reader jump back to a stage they have reached, and forward again', async () => {
    const { view } = await pageWith();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(stepOf(view.container)).toBe('pair');

    await click(buttonWith(view.container, '[data-onboarding-jump="install"]'));
    expect(stepOf(view.container)).toBe('install');
    // Stepping back does not unreach pairing.
    await click(buttonWith(view.container, '[data-onboarding-jump="pair"]'));
    expect(stepOf(view.container)).toBe('pair');
    await view.unmount();
  });

  it('remembers the stage across a reload of the whole page', async () => {
    const storage = new MemoryStorage();
    const first = await pageWith({ progress: new OnboardingProgressStore({ storage }) });
    await click(buttonWith(first.view.container, '[data-onboarding-next]'));
    await first.view.unmount();

    // A new tab, with only storage in between.
    const second = await pageWith({ progress: new OnboardingProgressStore({ storage }) });
    expect(stepOf(second.view.container)).toBe('daemon');
    await second.view.unmount();
  });

  it('finishes only when the daemon actually answers', async () => {
    const { view } = await pageWith({ fleetReady: false });
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(view.container.textContent).toContain('fy pair');

    await click(buttonWith(view.container, '[data-test-pair]'));

    expect(stepOf(view.container)).toBe('done');
    expect(must(view.container.querySelector('h2'), 'the stage heading').textContent).toBe('You are set up');
    await view.unmount();
  });

  it('offers the fleet when there is one, and refuses to pretend when there is not', async () => {
    const storage = new MemoryStorage();
    const progress = new OnboardingProgressStore({ storage });
    progress.goTo('done');
    const unpaired = await pageWith({ progress, fleetReady: false });

    // Damaged or half-finished setup must not offer a fleet that cannot open.
    expect(unpaired.view.container.textContent).toContain('Nothing is paired in this browser yet');
    await click(buttonWith(unpaired.view.container, '[data-onboarding-open-fleet]'));
    expect(stepOf(unpaired.view.container)).toBe('pair');
    await unpaired.view.unmount();

    // `paired` is what makes a stored "finished" believable: without a pairing
    // the same document reads as a fresh start, which the test below proves.
    const paired = await pageWith({
      progress: new OnboardingProgressStore({ storage, paired: true }),
      fleetReady: true,
    });
    await click(buttonWith(paired.view.container, '[data-onboarding-jump="done"]'));
    await click(buttonWith(paired.view.container, '[data-onboarding-open-fleet]'));
    expect(paired.opened).toEqual(['fleet']);
    await paired.view.unmount();
  });
});

describe('the install stage', () => {
  it('leads with the guessed platform and keeps every other one reachable', async () => {
    const { view } = await pageWith();
    const selected = () =>
      must(view.container.querySelector('[aria-pressed="true"]'), 'the selected channel').getAttribute(
        'data-onboarding-channel',
      );

    expect(selected()).toBe('apt');
    expect(view.container.textContent).toContain('sudo apt install fy');
    expect(view.container.querySelectorAll('[data-onboarding-channel]')).toHaveLength(4);

    await click(buttonWith(view.container, '[data-onboarding-channel="dnf"]'));
    expect(selected()).toBe('dnf');
    expect(view.container.textContent).toContain('sudo dnf install fy');
    expect(view.container.textContent).not.toContain('sudo apt install fy');

    await click(buttonWith(view.container, '[data-onboarding-channel="brew"]'));
    expect(view.container.textContent).toContain('brew install --cask ferretry');
    await click(buttonWith(view.container, '[data-onboarding-channel="curl"]'));
    expect(view.container.textContent).toContain('install.sh | bash');
    await view.unmount();
  });

  it('gives every command a copy control, including the agent prompt', async () => {
    const { view } = await pageWith();
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );

    expect(labels).toContain('Copy command');
    expect(labels).toContain('Copy check');
    expect(labels).toContain('Copy setup prompt');
    expect(view.container.textContent).toContain('fy --version');
    await view.unmount();
  });
});

describe('the daemon stage', () => {
  it('prints the two real commands and what a healthy answer looks like', async () => {
    const { view } = await pageWith();
    await click(buttonWith(view.container, '[data-onboarding-next]'));

    expect(view.container.textContent).toContain('fy daemon start');
    expect(view.container.textContent).toContain('fy daemon status');
    expect(view.container.textContent).toContain('fyd is serving');
    // No token export, no missing-binary warning: onboarding describes the
    // shipped world, not a workaround.
    expect(view.container.textContent).not.toContain('FY_TOKEN');
    await view.unmount();
  });
});

describe('with the software keyboard open', () => {
  it('keeps the stage, its actions and the track, and hides only standing chrome', async () => {
    document.documentElement.setAttribute('data-keyboard', 'open');
    const { view } = await pageWith();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    await click(buttonWith(view.container, '[data-onboarding-next]'));

    // The pairing field's stage is still fully operable.
    expect(stepOf(view.container)).toBe('pair');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    expect(view.container.querySelector('ol')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).not.toBeNull();

    // Exactly one subtree opts out, and it holds no control and no focus.
    const hidden = [...view.container.querySelectorAll('[data-kb-hide]')];
    expect(hidden).toHaveLength(1);
    expect(must(hidden[0], 'the standing chrome').querySelector('button, input, a')).toBeNull();
    // Nothing in this file measures the viewport itself.
    expect(view.container.innerHTML).not.toContain('100dvh');
    expect(view.container.innerHTML).not.toContain('100vh');
    await view.unmount();
  });

  it('brings the focused field back into view when the keyboard arrives', async () => {
    const { view } = await pageWith();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    const field = must(view.container.querySelector<HTMLInputElement>('#fake-pairing-link'), 'the pairing field');
    const scrolled: ScrollIntoViewOptions[] = [];
    field.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      scrolled.push(typeof options === 'object' ? options : {});
    };
    field.focus();

    // The producer writes the attribute; this screen only observes it — and
    // then waits a frame, because the shell is still its pre-keyboard height in
    // the commit that carries the attribute.
    await interact(async () => {
      document.documentElement.setAttribute('data-keyboard', 'open');
      await nextFrame();
    });

    expect(scrolled).toEqual([{ block: 'center' }]);
    await view.unmount();
  });

  it('leaves the page alone when the keyboard opens over something unfocused', async () => {
    const { view } = await pageWith();
    const field = must(view.container.querySelector('#onboarding-step-title'), 'the stage heading');
    let scrolls = 0;
    (field as HTMLElement).scrollIntoView = () => {
      scrolls += 1;
    };

    await interact(async () => {
      document.documentElement.setAttribute('data-keyboard', 'open');
      await nextFrame();
    });

    expect(scrolls).toBe(0);
    await view.unmount();
  });
});
