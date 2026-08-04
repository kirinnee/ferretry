/**
 * First run, driven rather than described.
 *
 * These assertions are all document facts — which screen is on the glass, what
 * has focus, which controls exist — because every one of them is a claim about a
 * person's ability to finish setup, and none of them survives being asserted
 * against source text.
 *
 * The question this suite answers first is the one the reader asked for: from the
 * opening screen, can somebody tell which of the three they are? So the chooser
 * is tested as a chooser — three answers, three different journeys behind them —
 * and each journey is then walked to its end.
 */

import { describe, expect, it } from 'bun:test';

import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from '../../../src/features/onboarding/hosted-relay.ts';
import { OnboardingPage, scheduleFocusedOnboardingControl } from '../../../src/features/onboarding/onboarding-page.tsx';
import {
  type OnboardingProgressStorage,
  OnboardingProgressStore,
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

const root = (container: HTMLElement): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-onboarding="setup"]'), 'the setup screen');

const screenOf = (container: HTMLElement): string | null => root(container).getAttribute('data-onboarding-screen');

const routeOf = (container: HTMLElement): string | null => root(container).getAttribute('data-onboarding-route');

interface PageOptions {
  readonly progress?: OnboardingProgressStore;
  readonly fleetReady?: boolean;
  readonly onOpenFleet?: () => void;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback?: HostedRelayFallback;
}

const pageWith = async (options: PageOptions = {}) => {
  const opened: string[] = [];
  const view = await mount(
    <OnboardingPage
      progress={options.progress ?? new OnboardingProgressStore({ storage: new MemoryStorage() })}
      write={async () => {}}
      channel="apt"
      fleetReady={options.fleetReady ?? false}
      connectionStatus={null}
      fallback={options.fallback ?? CHECKING_HOSTED_RELAY}
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

/** Answers the chooser the way a reader does: by pressing their own answer. */
const enter = async (container: HTMLElement, route: string): Promise<void> => {
  await click(buttonWith(container, `button[data-onboarding-route="${route}"]`));
};

const next = async (container: HTMLElement): Promise<void> => {
  await click(buttonWith(container, '[data-onboarding-next]'));
};

const chooseConnection = async (container: HTMLElement, connection: string): Promise<void> => {
  await click(buttonWith(container, `[data-onboarding-connection="${connection}"]`));
};

describe('the opening question', () => {
  it('asks which of the three the reader is, and shows nothing else', async () => {
    const { view } = await pageWith();

    expect(screenOf(view.container)).toBe('choose');
    expect(routeOf(view.container)).toBe('none');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe('Which of these are you?');

    // A real list of real buttons, one per answer, each saying what happens.
    const answers = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(answers.map(node => node.getAttribute('data-onboarding-route'))).toEqual([
      'have-link',
      'first-time',
      'agent',
    ]);
    expect(answers[0]?.textContent).toContain('I have a link or QR');
    expect(answers[0]?.textContent).toContain('Nothing to install');
    expect(answers[1]?.textContent).toContain('First time setup');
    expect(answers[2]?.textContent).toContain('Let an agent set it up');

    // No stepper, no track and no diagram of a journey nobody has chosen.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    await view.unmount();
  });

  it('sends each answer to a different first screen', async () => {
    const link = await pageWith();
    await enter(link.view.container, 'have-link');
    // Straight to pairing: no install, no daemon, no carrier choice.
    expect(screenOf(link.view.container)).toBe('scan');
    expect(link.view.container.textContent).not.toContain('sudo apt install fy');
    await link.view.unmount();

    const first = await pageWith();
    await enter(first.view.container, 'first-time');
    expect(screenOf(first.view.container)).toBe('install');
    await first.view.unmount();

    const agent = await pageWith();
    await enter(agent.view.container, 'agent');
    expect(screenOf(agent.view.container)).toBe('brief');
    await agent.view.unmount();
  });

  it('is what Back reaches from the first step of any route', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('chooser');
    await click(back);

    // Picking the wrong answer has to be survivable, and then re-answerable.
    expect(screenOf(view.container)).toBe('choose');
    await enter(view.container, 'agent');
    expect(screenOf(view.container)).toBe('brief');
    await view.unmount();
  });

  it('remembers the answer and the step across a reload of the whole page', async () => {
    const storage = new MemoryStorage();
    const firstVisit = await pageWith({ progress: new OnboardingProgressStore({ storage }) });
    await enter(firstVisit.view.container, 'first-time');
    await next(firstVisit.view.container);
    await firstVisit.view.unmount();

    // A new tab, with only storage in between.
    const second = await pageWith({ progress: new OnboardingProgressStore({ storage }) });
    expect(routeOf(second.view.container)).toBe('first-time');
    expect(screenOf(second.view.container)).toBe('daemon');
    await second.view.unmount();
  });
});

describe('the first-time route', () => {
  it('walks the default path and puts fy pair before scanning, with the whole track visible', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    expect(view.container.textContent).toContain('step 1 of 6');
    const diagram = must(view.container.querySelector('[role="img"]'), 'the arrangement diagram');
    expect(diagram.getAttribute('data-onboarding-diagram')).toBe('install');
    expect(diagram.getAttribute('aria-label')).toContain('not yet linked');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Install Ferretry');

    // A real ordered list, not a row of divs pretending to be one.
    const track = must(view.container.querySelector('[aria-label="Setup steps"]'), 'the step track');
    expect(track.querySelectorAll('li')).toHaveLength(6);
    expect(must(track.querySelector('[aria-current="step"]'), 'the current step').textContent).toContain('Install');
    // Only the steps already reached are jumpable, and none have been yet.
    expect(track.querySelectorAll('[data-onboarding-jump]')).toHaveLength(0);
    // State is never carried by colour alone.
    expect(track.textContent).toContain('current step');
    expect(track.textContent).toContain('not reached yet');

    await next(view.container);
    expect(screenOf(view.container)).toBe('daemon');
    await next(view.container);
    expect(screenOf(view.container)).toBe('connect');
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    await chooseConnection(view.container, 'default-relay');
    expect(screenOf(view.container)).toBe('pair');
    expect(view.container.textContent).toContain('Run this on the computer');
    await next(view.container);
    expect(screenOf(view.container)).toBe('scan');

    // Scan IS verifiable — the daemon answers in this tab — so there is no
    // button here that could declare a browser paired with nothing "done".
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(buttonWith(view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe('step');
    await view.unmount();
  });

  it('moves focus to the new step heading, but not on the first paint', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const heading = must(view.container.querySelector('#onboarding-step-title'), 'the step heading');
    // Entering the route IS a screen change, so focus has already moved to it.
    expect(document.activeElement).toBe(heading);

    (document.activeElement as HTMLElement).blur();
    await next(view.container);
    expect(document.activeElement).toBe(must(view.container.querySelector('#onboarding-step-title'), 'the heading'));
    await view.unmount();
  });

  it('lets the reader jump back to a step they have reached, and forward again', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    await next(view.container);
    await next(view.container);
    await chooseConnection(view.container, 'direct');
    expect(screenOf(view.container)).toBe('pair');

    await click(buttonWith(view.container, '[data-onboarding-jump="install"]'));
    expect(screenOf(view.container)).toBe('install');
    // Stepping back does not unreach pairing.
    await click(buttonWith(view.container, '[data-onboarding-jump="pair"]'));
    expect(screenOf(view.container)).toBe('pair');
    await view.unmount();
  });

  it('finishes only when the daemon actually answers', async () => {
    const { view } = await pageWith({ fleetReady: false });
    await enter(view.container, 'first-time');
    await next(view.container);
    await next(view.container);
    await chooseConnection(view.container, 'default-relay');
    expect(view.container.textContent).toContain('fy pair');
    await next(view.container);

    await click(buttonWith(view.container, '[data-test-pair]'));

    expect(screenOf(view.container)).toBe('done');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('You are set up');
    await view.unmount();
  });

  it('offers the fleet when there is one, and refuses to pretend when there is not', async () => {
    const storage = new MemoryStorage();
    const progress = new OnboardingProgressStore({ storage });
    progress.choose('first-time');
    progress.goTo('done');
    const unpaired = await pageWith({ progress, fleetReady: false });

    // Damaged or half-finished setup must not offer a fleet that cannot open.
    expect(unpaired.view.container.textContent).toContain('Nothing is paired in this browser yet');
    await click(buttonWith(unpaired.view.container, '[data-onboarding-open-fleet]'));
    expect(screenOf(unpaired.view.container)).toBe('scan');
    await unpaired.view.unmount();

    // `paired` is what makes a stored "finished" believable: without a pairing
    // the same document reads as the question again.
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

describe('the install step', () => {
  it('leads with the guessed platform and keeps every other one reachable', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const selected = () =>
      must(
        view.container.querySelector('[data-onboarding-channel][aria-pressed="true"]'),
        'the selected channel',
      ).getAttribute('data-onboarding-channel');

    expect(selected()).toBe('apt');
    expect(view.container.textContent).toContain('sudo apt install fy');
    expect(view.container.querySelectorAll('[data-onboarding-channel]')).toHaveLength(5);

    await click(buttonWith(view.container, '[data-onboarding-channel="dnf"]'));
    expect(selected()).toBe('dnf');
    expect(view.container.textContent).toContain('sudo dnf install fy');
    expect(view.container.textContent).not.toContain('sudo apt install fy');

    await click(buttonWith(view.container, '[data-onboarding-channel="brew"]'));
    expect(view.container.textContent).toContain('brew install --cask ferretry');
    await click(buttonWith(view.container, '[data-onboarding-channel="nix"]'));
    expect(view.container.textContent).toContain('nix profile install github:kirinnee/ferretry');
    await view.unmount();
  });

  it('names the script as the fallback, and only while it is showing', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    // A packaged route is selected, so nothing is telling this reader about a
    // fallback they are not looking at.
    expect(view.container.querySelector('[data-onboarding-fallback-note]')).toBeNull();

    await click(buttonWith(view.container, '[data-onboarding-channel="curl"]'));
    expect(view.container.textContent).toContain('install.sh | bash');
    const note = must(view.container.querySelector('[data-onboarding-fallback-note]'), 'the fallback note');
    expect(note.textContent).toContain('generic fallback');
    // The reason a Mac owner should not be here: the cask clears the quarantine.
    expect(note.textContent).toContain('Gatekeeper');
    await view.unmount();
  });

  it('gives every command a copy control, and no longer hides the agent path in an aside', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );

    expect(labels).toContain('Copy install command');
    expect(labels).toContain('Copy check');
    // The agent brief is a route of its own now, not an annexe of this step.
    expect(labels).not.toContain('Copy setup prompt');
    expect(view.container.textContent).toContain('fy --version');
    await view.unmount();
  });
});

describe('the daemon step', () => {
  it('prints the real commands and what a healthy answer looks like', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    await next(view.container);

    expect(view.container.textContent).toContain('fy daemon start');
    expect(view.container.textContent).toContain('fy daemon status');
    expect(view.container.textContent).toContain('fyd is serving');
    // The service route, for a machine that will be rebooted.
    expect(view.container.textContent).toContain('fy daemon install');
    // No token export, no missing-binary warning: onboarding describes the
    // shipped world, not a workaround.
    expect(view.container.textContent).not.toContain('FY_TOKEN');
    await view.unmount();
  });
});

describe('the reach-it step', () => {
  const toConnect = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'first-time');
    await next(container);
    await next(container);
  };

  it('is a second chooser led by the recommended default relay', async () => {
    const { view } = await pageWith();
    await toConnect(view.container);

    expect(screenOf(view.container)).toBe('connect');
    expect(
      [...view.container.querySelectorAll('[data-onboarding-connection]')].map(node =>
        node.getAttribute('data-onboarding-connection'),
      ),
    ).toEqual(['default-relay', 'own-relay', 'direct']);
    expect(view.container.textContent).toContain('Recommended');
    expect(view.container.textContent).toContain('Direct is used whenever it is reachable');
    await view.unmount();
  });

  it('expands the self-hosted route into separately tracked operations', async () => {
    const { view } = await pageWith();
    await toConnect(view.container);
    await chooseConnection(view.container, 'own-relay');

    expect(screenOf(view.container)).toBe('relay-fingerprint');
    expect(view.container.textContent).toContain('step 4 of 10');
    expect(view.container.querySelectorAll('[aria-label="Setup steps"] li')).toHaveLength(10);
    expect(view.container.textContent).toContain('fy pair --no-wait');
    await next(view.container);
    expect(screenOf(view.container)).toBe('relay-source');
    await next(view.container);
    expect(screenOf(view.container)).toBe('relay-allow');
    expect(view.container.textContent).toContain('RELAY_DAEMON_IDS');
    await next(view.container);
    expect(screenOf(view.container)).toBe('relay-deploy');
    expect(view.container.textContent).toContain('task relay:deploy');
    await view.unmount();
  });

  it('takes the direct and default choices straight to fy pair', async () => {
    const { view } = await pageWith();
    await toConnect(view.container);
    await chooseConnection(view.container, 'direct');
    expect(screenOf(view.container)).toBe('pair');
    await click(buttonWith(view.container, '[data-onboarding-back]'));
    expect(screenOf(view.container)).toBe('connect');
    await chooseConnection(view.container, 'default-relay');
    expect(screenOf(view.container)).toBe('pair');
    await view.unmount();
  });
});

describe('the agent route', () => {
  it('shows the whole prompt and one control to copy it', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'agent');

    expect(view.container.textContent).toContain('step 1 of 4');
    const prompt = must(view.container.querySelector('[data-onboarding-prompt]'), 'the prompt');
    // On the glass, not behind a disclosure: it is about to be handed to
    // something with a shell on the reader's machine.
    expect(prompt.textContent).toContain('Set up Ferretry on this machine');
    expect(prompt.textContent).toContain('stop and report');
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );
    expect(labels).toEqual(['Copy setup prompt']);

    // Then pairing, because the agent ends by showing a QR.
    await next(view.container);
    expect(screenOf(view.container)).toBe('pair');
    expect(view.container.textContent).toContain('fy pair');
    await view.unmount();
  });
});

describe('the have-a-link route', () => {
  it('goes straight to scanning, with no command to run', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'have-link');

    expect(screenOf(view.container)).toBe('scan');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Scan QR or paste link');
    // The pairing surface itself, unforked.
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    // A two-step route gets no track: "Pair · Done" tells this reader nothing.
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    // And no `fy pair` block, because it has already been run elsewhere.
    expect(view.container.querySelector('[data-onboarding-copy="Copy pair command"]')).toBeNull();
    expect(view.container.textContent).toContain('single-use');
    await view.unmount();
  });

  it('finishes on the same done screen when the daemon answers', async () => {
    const { view } = await pageWith({ fleetReady: true });
    await enter(view.container, 'have-link');
    await click(buttonWith(view.container, '[data-test-pair]'));

    expect(screenOf(view.container)).toBe('done');
    expect(routeOf(view.container)).toBe('have-link');
    await view.unmount();
  });
});

describe('with the software keyboard open', () => {
  const toPair = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'first-time');
    await next(container);
    await next(container);
    await chooseConnection(container, 'default-relay');
    await next(container);
  };

  it('keeps the step, its actions and the track, and hides only standing chrome', async () => {
    const { view } = await pageWith();
    await toPair(view.container);

    // The pairing field's step is still fully operable.
    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Setup steps"]')).not.toBeNull();
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
    await toPair(view.container);
    const field = must(view.container.querySelector<HTMLInputElement>('#fake-pairing-link'), 'the pairing field');
    const scrolled: ScrollIntoViewOptions[] = [];
    field.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      scrolled.push(typeof options === 'object' ? options : {});
    };
    field.focus();

    // The hook-to-effect path is proved by the real-app keyboard capture. This
    // rendered unit drives the narrow scheduling seam directly so another DOM
    // test cannot remove the process-wide root attribute between its mutation
    // and MutationObserver callback.
    const cancel = scheduleFocusedOnboardingControl(root(view.container));
    await nextFrame();

    expect(scrolled).toContainEqual({ block: 'center' });
    cancel?.();
    await view.unmount();
  });

  it('leaves the page alone when the keyboard opens over something unfocused', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const heading = must(view.container.querySelector('#onboarding-step-title'), 'the step heading');
    let scrolls = 0;
    (heading as HTMLElement).blur();
    (heading as HTMLElement).scrollIntoView = () => {
      scrolls += 1;
    };

    const cancel = scheduleFocusedOnboardingControl(root(view.container));
    await nextFrame();

    expect(scrolls).toBe(0);
    cancel?.();
    await view.unmount();
  });
});
