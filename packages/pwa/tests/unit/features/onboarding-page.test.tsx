/**
 * First run, driven rather than described.
 *
 * These assertions are all document facts — which screen is on the glass, what
 * has focus, which controls exist — because every one of them is a claim about a
 * person's ability to finish setup, and none of them survives being asserted
 * against source text.
 *
 * The shape under test: a two-card chooser, two small questions for a daemon
 * journey, then ONE page for every journey except the by-hand install. The page
 * that ends a journey is the pairing itself — there is no "Done" page, no track
 * and no diagram, and the daemon answering is the only thing that finishes a
 * pairing page.
 */

import { describe, expect, it } from 'bun:test';
import type { DeviceKind } from '../../../src/features/onboarding/device-kind.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from '../../../src/features/onboarding/hosted-relay.ts';
import {
  agentSetupPrompt,
  DAEMON_START_COMMAND,
  installChannel,
  type OnboardingStepId,
  PAIR_OPEN_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';
import { OnboardingPage, scheduleFocusedOnboardingControl } from '../../../src/features/onboarding/onboarding-page.tsx';
import {
  type OnboardingProgressStorage,
  OnboardingProgressStore,
} from '../../../src/features/onboarding/onboarding-progress.ts';
import type { SetupSharePort } from '../../../src/features/onboarding/setup-handoff-panel.tsx';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../support/dom.ts';

class MemoryStorage implements OnboardingProgressStorage {
  #value: string | null = null;
  getItem(): string | null {
    return this.#value;
  }
  setItem(_key: string, next: string): void {
    this.#value = next;
  }
  /** What a reload would find. */
  get stored(): string | null {
    return this.#value;
  }
}

/** A `.invalid` origin: a QR rendered in a suite must not point at anything real. */
const HREF = 'https://ferretry.example.invalid/setup';

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

/** The command block on the glass. */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';

const quietOf = (container: HTMLElement): string | null =>
  must(container.querySelector('[data-test-quiet]'), 'the pairing slot').getAttribute('data-test-quiet');

interface PageOptions {
  readonly progress?: OnboardingProgressStore;
  readonly device?: DeviceKind;
  readonly pairings?: number;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback?: HostedRelayFallback;
  readonly share?: SetupSharePort;
}

const pageWith = async (options: PageOptions = {}) => {
  const opened: (string | undefined)[] = [];
  const progress =
    options.progress ??
    new OnboardingProgressStore({ storage: new MemoryStorage(), device: options.device ?? 'desktop' });
  const element = (pairings: number) => (
    <OnboardingPage
      progress={progress}
      write={async () => {}}
      channel="apt"
      href={HREF}
      share={options.share}
      pairings={pairings}
      fallback={options.fallback ?? CHECKING_HOSTED_RELAY}
      onOpenFleet={daemonId => opened.push(daemonId)}
      renderPairing={({ onPaired, onStatedFailure, quiet }) => (
        <>
          <span data-test-quiet={String(quiet)} />
          <input id="fake-pairing-link" aria-label="Pairing link" />
          <button type="button" data-test-pair="" onClick={() => onPaired('daemon-a' as DaemonId)}>
            pretend the daemon answered
          </button>
          <button type="button" data-test-stated="" onClick={() => onStatedFailure(true)}>
            pretend an older Ferretry refused
          </button>
          <button type="button" data-test-cleared="" onClick={() => onStatedFailure(false)}>
            pretend the failure cleared
          </button>
        </>
      )}
    />
  );
  const view = await mount(element(options.pairings ?? 0));
  return { opened, view, progress, setPairings: async (count: number) => await view.render(element(count)) };
};

/** Answers the ENTRY question the way a reader does: by pressing their own answer. */
const answerEntry = async (container: HTMLElement, route: string): Promise<void> => {
  await click(buttonWith(container, `button[data-onboarding-route="${route}"]`));
};

const answerDoer = async (container: HTMLElement, doer: string): Promise<void> => {
  await click(buttonWith(container, `button[data-onboarding-doer="${doer}"]`));
};

/**
 * Walks the whole daemon subflow the way a reader walks it, and never by seeding.
 *
 * The target is pressed when this device ASKS it, and taken through the escape
 * when this device ASSUMED it — which is exactly how a real reader gets there, and
 * therefore proof that the escape is reachable at all. A phone offers neither,
 * because the hardware already answered.
 */
const enter = async (
  container: HTMLElement,
  route: string,
  doer = 'self',
  target: 'this' | 'other' = 'this',
): Promise<void> => {
  await answerEntry(container, route);
  if (route !== 'add-client') {
    const asked = container.querySelector(`button[data-onboarding-target="${target}"]`);
    if (asked !== null) await click(asked);
    const wayOut = container.querySelector(`button[data-onboarding-switch-target="${target}"]`);
    if (wayOut !== null) await click(wayOut);
    await answerDoer(container, doer);
  }
};

/** A store already walking a journey, for the screens that are reached by pairing. */
const walking = (options: {
  readonly device?: DeviceKind;
  readonly route?: 'first-time' | 'add-daemon' | 'add-client';
  readonly target?: 'this' | 'other';
  readonly doer?: 'self' | 'agent';
  readonly step: OnboardingStepId;
  readonly storage?: OnboardingProgressStorage;
}): OnboardingProgressStore => {
  const store = new OnboardingProgressStore({
    storage: options.storage ?? new MemoryStorage(),
    device: options.device ?? 'desktop',
  });
  const route = options.route ?? 'first-time';
  store.choose(route);
  if (route !== 'add-client') {
    store.chooseTarget(options.target ?? 'this', route);
    store.chooseDoer(options.doer ?? 'self');
  }
  store.goTo(options.step);
  return store;
};

/** Things the simpler first run deleted; no screen may bring them back. */
const expectNoRemovedChrome = (container: HTMLElement): void => {
  expect(container.querySelector('[aria-label="Setup steps"]')).toBeNull();
  expect(container.querySelector('[data-onboarding-diagram]')).toBeNull();
  expect(container.querySelector('[data-onboarding-jump]')).toBeNull();
  expect(container.querySelector('[data-onboarding-open-fleet]')).toBeNull();
  expect(container.textContent).not.toContain('You are set up');
};

describe('the entry question', () => {
  it('is a welcome with two cards and a small add-computer link, and nothing behind it', async () => {
    const { view } = await pageWith();

    expect(screenOf(view.container)).toBe('entry');
    expect(routeOf(view.container)).toBe('none');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the welcome').textContent).toBe('Welcome');
    expect(view.container.textContent).toContain('Ferretry runs your agents on a computer');

    const cards = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(cards.map(node => node.getAttribute('data-onboarding-route'))).toEqual(['first-time', 'add-client']);
    expect(cards[0]?.textContent).toContain('Set up a computer');
    expect(cards[1]?.textContent).toContain('I have a QR or link');
    const link = buttonWith(view.container, 'button[data-onboarding-route="add-daemon"]');
    expect(link.textContent).toBe('Add another computer');
    expect(link.closest('li')).toBeNull();

    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-step-count]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    expectNoRemovedChrome(view.container);
    await view.unmount();
  });

  it('offers a phone the same answers, because none of them is impossible there', async () => {
    const { view } = await pageWith({ device: 'mobile' });

    expect(view.container.querySelectorAll('button[data-onboarding-route]')).toHaveLength(3);
    expect(view.container.textContent).not.toContain('this as a daemon');
    await view.unmount();
  });

  it('short-circuits a reader holding a QR or link straight to pairing, with no question', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'add-client');

    expect(screenOf(view.container)).toBe('pair');
    expect(routeOf(view.container)).toBe('add-client');
    expect(view.container.textContent).not.toContain('sudo apt install fy');
    await view.unmount();
  });
});

describe('which computer runs the daemon', () => {
  it('is asked outright when a fleet is being added to from a computer', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('target');
    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe(
      'Which computer runs the daemon?',
    );
    const answers = [...view.container.querySelectorAll('li button[data-onboarding-target]')];
    expect(answers.map(node => node.getAttribute('data-onboarding-target'))).toEqual(['this', 'other']);

    await click(buttonWith(view.container, 'button[data-onboarding-target="this"]'));
    expect(screenOf(view.container)).toBe('doer');
    await view.unmount();
  });

  it('is never asked of a phone, which is told the fact instead', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await answerEntry(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('doer');
    expect(view.container.querySelector('[data-onboarding-target]')).toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-where]'), 'the machine line').textContent).toBe(
      'Ferretry runs on a computer. This phone becomes your remote control.',
    );
    await view.unmount();
  });

  it('is assumed on a computer starting from scratch, with a reversible way out', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    expect(screenOf(view.container)).toBe('doer');
    const where = (): Element => must(view.container.querySelector('[data-onboarding-where]'), 'the machine line');
    expect(where().getAttribute('data-onboarding-where')).toBe('assumed:this');
    expect(where().textContent).toBe('This computer will run your agents.');

    await click(buttonWith(view.container, '[data-onboarding-switch-target="other"]'));
    expect(where().textContent).toBe('Another computer will run your agents.');
    await click(buttonWith(view.container, '[data-onboarding-switch-target="this"]'));
    expect(where().textContent).toBe('This computer will run your agents.');
    await view.unmount();
  });

  it('draws no way out of an answer the reader chose, and none on a phone', async () => {
    const chosen = await pageWith();
    await answerEntry(chosen.view.container, 'add-daemon');
    await click(buttonWith(chosen.view.container, 'button[data-onboarding-target="other"]'));
    expect(chosen.view.container.querySelector('[data-onboarding-switch-target]')).toBeNull();
    await chosen.view.unmount();

    const phone = await pageWith({ device: 'mobile' });
    await answerEntry(phone.view.container, 'first-time');
    expect(phone.view.container.querySelector('[data-onboarding-switch-target]')).toBeNull();
    await phone.view.unmount();
  });
});

describe('who installs it', () => {
  it('is asked of everybody, worded for the machine already settled', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe('Who installs it?');
    const answers = [...view.container.querySelectorAll('li button[data-onboarding-doer]')];
    expect(answers.map(node => node.getAttribute('data-onboarding-doer'))).toEqual(['agent', 'self']);
    expect(answers[0]?.textContent).toContain('An agent does it');
    expect(answers[1]?.textContent).toContain('I do it myself');
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expectNoRemovedChrome(view.container);
    await view.unmount();
  });

  it('names the machine as THAT computer once the daemon lives elsewhere', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await answerEntry(view.container, 'first-time');

    const answers = [...view.container.querySelectorAll('li button[data-onboarding-doer]')];
    expect(answers[0]?.textContent).toContain('that computer');
    expect(answers[1]?.textContent).toContain('Open Ferretry on that computer');
    await view.unmount();
  });

  it('lands Back on the question the reader actually answered', async () => {
    const asked = await pageWith();
    await answerEntry(asked.view.container, 'add-daemon');
    await click(buttonWith(asked.view.container, 'button[data-onboarding-target="this"]'));
    expect(buttonWith(asked.view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe(
      'target',
    );
    await click(buttonWith(asked.view.container, '[data-onboarding-back]'));
    expect(screenOf(asked.view.container)).toBe('target');
    await click(buttonWith(asked.view.container, '[data-onboarding-back="entry"]'));
    expect(screenOf(asked.view.container)).toBe('entry');
    await asked.view.unmount();

    const assumed = await pageWith();
    await answerEntry(assumed.view.container, 'first-time');
    expect(buttonWith(assumed.view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe(
      'entry',
    );
    await click(buttonWith(assumed.view.container, '[data-onboarding-back]'));
    expect(screenOf(assumed.view.container)).toBe('entry');
    await assumed.view.unmount();
  });
});

describe('an agent doing it: ONE page', () => {
  it('is the prompt, the pairing surface and nothing else, wherever the reader is standing', async () => {
    for (const device of ['desktop', 'mobile'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'agent', device === 'mobile' ? 'other' : 'this');

      expect(screenOf(view.container)).toBe('brief');
      // One page is not "step 1 of 1".
      expect(view.container.querySelector('[data-onboarding-step-count]')).toBeNull();
      expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
      expect(view.container.querySelector('[data-onboarding-channel]')).toBeNull();

      const copy = buttonWith(view.container, '[data-onboarding-copy="Copy prompt"]');
      expect(copy.getAttribute('data-variant')).toBe('primary');
      const disclosure = must(
        view.container.querySelector<HTMLDetailsElement>('[data-onboarding-aside="Show prompt"]'),
        'the prompt disclosure',
      );
      expect(disclosure.open).toBe(false);
      expect(disclosure.querySelector('[data-onboarding-prompt]')?.textContent).toBe(
        agentSetupPrompt(device === 'mobile' ? 'other' : 'this'),
      );
      // Only an agent on THIS computer can open Ferretry here by itself.
      expect(view.container.querySelector('[data-onboarding-after]')?.textContent).toContain(
        device === 'mobile' ? 'it shows a QR or a link' : 'Ferretry opens here by itself. If it shows a QR:',
      );
      // The pairing surface is a fallback under a primary, so it is drawn quiet.
      expect(quietOf(view.container)).toBe('true');
      expectNoRemovedChrome(view.container);
      await view.unmount();
    }
  });

  it('shares the prompt to the other machine only when the agent is NOT on this one', async () => {
    const shared: unknown[] = [];
    const share: SetupSharePort = async payload => {
      shared.push(payload.text);
    };
    const away = await pageWith({ device: 'mobile', share });
    await enter(away.view.container, 'first-time', 'agent');
    expect(away.view.container.querySelector('[data-onboarding-prompt-handoff]')).not.toBeNull();
    await click(buttonWith(away.view.container, '[data-onboarding-share-prompt]'));
    expect(shared).toEqual([agentSetupPrompt('other')]);
    await away.view.unmount();

    const here = await pageWith({ share });
    await enter(here.view.container, 'first-time', 'agent');
    expect(here.view.container.querySelector('[data-onboarding-prompt-handoff]')).toBeNull();
    expect(here.view.container.querySelector('[data-onboarding-share-prompt]')).toBeNull();
    await here.view.unmount();
  });

  it('goes straight into the app, at the daemon that answered, when it pairs', async () => {
    const { view, opened } = await pageWith();
    await enter(view.container, 'first-time', 'agent');

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(opened).toEqual(['daemon-a']);
    await view.unmount();
  });

  it('is reachable from the install page, for a reader who changes their mind', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    expect(screenOf(view.container)).toBe('install');

    await click(buttonWith(view.container, '[data-onboarding-agent-instead]'));
    expect(screenOf(view.container)).toBe('brief');
    await view.unmount();
  });

  it('resumes on its page across a reload', async () => {
    const storage = new MemoryStorage();
    const first = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'mobile' }) });
    await enter(first.view.container, 'first-time', 'agent');
    await first.view.unmount();

    const second = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'mobile' }) });
    expect(screenOf(second.view.container)).toBe('brief');
    await second.view.unmount();
  });
});

describe('another computer, by hand: ONE page', () => {
  it('is the setup link as the primary action, then the pairing, and reads the same on both devices', async () => {
    for (const device of ['mobile', 'desktop'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'self', 'other');

      expect(screenOf(view.container)).toBe('elsewhere');
      expect(view.container.querySelector('[data-onboarding-step-count]')).toBeNull();
      // Teaches nothing: that computer walks the install list itself.
      expect(view.container.querySelector('pre')).toBeNull();
      const copy = buttonWith(view.container, '[data-onboarding-copy="Copy setup link"]');
      expect(copy.getAttribute('data-variant')).toBe('primary');
      expect(
        must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent,
      ).toContain('#fy-setup=v2;route=first-time;target=this;doer=self;step=install');
      // The carrier is a link, not a QR, because nothing on a desk points a camera at a screen.
      expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
      expect(view.container.querySelector('[data-onboarding-handoff]')?.getAttribute('data-onboarding-handoff')).toBe(
        'computer',
      );
      expect(quietOf(view.container)).toBe('true');
      expectNoRemovedChrome(view.container);
      await view.unmount();
    }
  });

  it('shares the link through the OS when this browser has a share sheet, and draws nothing when not', async () => {
    const urls: unknown[] = [];
    const withShare = await pageWith({
      share: async payload => {
        urls.push(payload.url);
      },
    });
    await enter(withShare.view.container, 'first-time', 'self', 'other');
    await click(buttonWith(withShare.view.container, '[data-onboarding-share]'));
    expect(String(urls[0])).toContain('#fy-setup=v2;route=first-time');
    await withShare.view.unmount();

    const without = await pageWith();
    await enter(without.view.container, 'first-time', 'self', 'other');
    expect(without.view.container.querySelector('[data-onboarding-share]')).toBeNull();
    await without.view.unmount();
  });

  it('finishes when the daemon answers, by going into the app', async () => {
    const { view, opened } = await pageWith();
    await enter(view.container, 'first-time', 'self', 'other');

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(opened).toEqual(['daemon-a']);
    await view.unmount();
  });

  it('offers the other thing the reader may have meant, one tap away', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time', 'self', 'other');

    await click(buttonWith(view.container, '[data-onboarding-add-client]'));
    expect(screenOf(view.container)).toBe('pair');
    expect(routeOf(view.container)).toBe('add-client');
    await view.unmount();
  });

  it('is reachable from the install page, for a reader the assumption was wrong for', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    expect(screenOf(view.container)).toBe('install');

    await click(buttonWith(view.container, '[data-onboarding-other-machine]'));
    // The answer is changed, so the question behind it (who installs it) is asked again.
    expect(screenOf(view.container)).toBe('doer');
    await answerDoer(view.container, 'self');
    expect(screenOf(view.container)).toBe('elsewhere');
    await view.unmount();
  });
});

describe('this computer, by hand', () => {
  it('opens on the install page: the channel command and the daemon start in ONE block, one primary', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    expect(screenOf(view.container)).toBe('install');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Install and start');
    expect(must(view.container.querySelector('[data-onboarding-step-count]'), 'the step count').textContent).toBe(
      'Step 1 of 3',
    );
    expect(visibleCommand(view.container)).toBe(`${installChannel('apt').command}\n${DAEMON_START_COMMAND}`);
    expect(view.container.querySelector('[data-onboarding-other-platforms]')).not.toBeNull();

    const primaries = view.container.querySelectorAll('[data-variant="primary"]');
    expect(primaries).toHaveLength(1);
    expect(buttonWith(view.container, '[data-onboarding-next]').textContent).toBe('I ran it');
    expectNoRemovedChrome(view.container);
    await view.unmount();
  });

  it('puts Back on the first page at the question that opened it, and re-answering works', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('doer');
    await click(back);
    expect(screenOf(view.container)).toBe('doer');
    await answerDoer(view.container, 'agent');
    expect(screenOf(view.container)).toBe('brief');
    await view.unmount();
  });

  it('moves on only when the reader says "I ran it", and the local page has no primary of its own', async () => {
    const { view, opened } = await pageWith();
    await enter(view.container, 'first-time');
    // The page cannot see the terminal: a daemon answering elsewhere is not "I ran it".
    await click(buttonWith(view.container, '[data-onboarding-next]'));

    expect(screenOf(view.container)).toBe('local');
    expect(must(view.container.querySelector('[data-onboarding-step-count]'), 'the step count').textContent).toBe(
      'Step 2 of 3',
    );
    expect(visibleCommand(view.container)).toBe(PAIR_OPEN_COMMAND);
    expect(view.container.textContent).toContain('Nothing to scan');
    const about = must(
      view.container.querySelector<HTMLDetailsElement>('[data-onboarding-aside="About connections"]'),
      'the connection disclosure',
    );
    expect(about.open).toBe(false);
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[data-variant="primary"]')).toBeNull();
    expect(buttonWith(view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe('step');
    expect(quietOf(view.container)).toBe('false');
    expect(opened).toEqual([]);

    await click(buttonWith(view.container, '[data-onboarding-back]'));
    expect(screenOf(view.container)).toBe('install');
    await view.unmount();
  });

  it('advances to the phone offer when the daemon answers, rather than leaving first-time setup', async () => {
    const { view, opened, setPairings } = await pageWith({ progress: walking({ step: 'local' }) });

    await click(buttonWith(view.container, '[data-test-pair]'));
    // A real pairing also raises the count; the offer is not shown without one.
    await setPairings(1);

    expect(screenOf(view.container)).toBe('handoff');
    expect(opened).toEqual([]);
    await view.unmount();
  });

  it('goes straight into the app on a journey with nothing after pairing', async () => {
    const { view, opened } = await pageWith({ progress: walking({ route: 'add-daemon', step: 'local' }) });
    expect(view.container.querySelector('[data-onboarding-step-count]')?.textContent).toBe('Step 2 of 2');

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(opened).toEqual(['daemon-a']);
    expect(screenOf(view.container)).toBe('local');
    await view.unmount();
  });

  it('shows the phone offer only once something is paired, and sends a stranded reader back', async () => {
    const stranded = await pageWith({ progress: walking({ step: 'handoff' }), pairings: 0 });
    expect(screenOf(stranded.view.container)).toBe('local');
    await stranded.view.unmount();
  });

  it('keeps the way through for a terminal that cannot open a browser', async () => {
    const { view } = await pageWith({ progress: walking({ step: 'local' }) });

    expect(view.container.querySelector('[data-onboarding-aside="It did not open a browser"]')).not.toBeNull();
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await view.unmount();
  });

  it('remembers the page across a reload of the whole page', async () => {
    const storage = new MemoryStorage();
    const first = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    await enter(first.view.container, 'first-time');
    await click(buttonWith(first.view.container, '[data-onboarding-next]'));
    await first.view.unmount();

    const second = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    expect(routeOf(second.view.container)).toBe('first-time');
    expect(screenOf(second.view.container)).toBe('local');
    await second.view.unmount();
  });
});

describe('the phone offer', () => {
  const offer = async (storage = new MemoryStorage()) =>
    await pageWith({ progress: walking({ step: 'handoff', storage }), pairings: 1 });

  it('is a labelled QR carrying only the public setup link, with Skip and "I scanned it"', async () => {
    const storage = new MemoryStorage();
    const { view } = await offer(storage);

    expect(screenOf(view.container)).toBe('handoff');
    expect(must(view.container.querySelector('h2'), 'the heading').textContent).toBe('Add your phone (optional)');
    expect(view.container.querySelector('[data-onboarding-step-count]')?.textContent).toBe('Step 3 of 3');

    const qr = must(view.container.querySelector('[data-onboarding-qr]'), 'the hand-off QR');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toContain('phone');
    const printed = must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent;
    expect(printed).toContain('#fy-setup=v2;route=add-client;step=pair');
    // Nothing identifying travels: no pairing code, no token, no daemon address.
    expect(printed).not.toMatch(/code=|token|fp=|daemon/);

    expect(buttonWith(view.container, '[data-onboarding-skip]').textContent).toBe('Skip');
    const scanned = buttonWith(view.container, '[data-onboarding-next]');
    expect(scanned.textContent).toBe('I scanned it');
    expect(scanned.getAttribute('data-variant')).toBe('primary');
    expectNoRemovedChrome(view.container);
    await view.unmount();
  });

  it('sends Skip into the app', async () => {
    const { view, opened } = await offer();
    await click(buttonWith(view.container, '[data-onboarding-skip]'));
    expect(opened).toEqual([undefined]);
    await view.unmount();
  });

  it('sends "I scanned it" into the app', async () => {
    const { view, opened } = await offer();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(opened).toEqual([undefined]);
    await view.unmount();
  });

  it('draws its QR locally: never announced, never persisted, never fetched', async () => {
    const storage = new MemoryStorage();
    const { view } = await offer(storage);
    const qr = must(view.container.querySelector('[data-onboarding-qr]'), 'the hand-off QR');

    // Not announced: the image has a name, not the link, and no live region wraps it.
    expect(qr.getAttribute('aria-label')).not.toContain('fy-setup');
    expect(qr.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    // Not fetched: a drawn path of squares, no image element and no URL inside it.
    expect(view.container.querySelector('img')).toBeNull();
    expect(qr.outerHTML).not.toMatch(/https?:|href|src=|<image/);
    // Not persisted: storage holds a place, never the QR or a link.
    expect(storage.stored).not.toBeNull();
    expect(storage.stored).not.toContain('<svg');
    expect(storage.stored).not.toContain('fy-setup');
    expect(storage.stored).not.toContain(HREF);
    await view.unmount();
  });
});

describe('the add-a-client route: ONE page', () => {
  it('is "run fy pair" plus the pairing surface, with no step count', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    expect(screenOf(view.container)).toBe('pair');
    expect(view.container.querySelector('[data-onboarding-step-count]')).toBeNull();
    expect(view.container.textContent).toContain('1. On the computer running Ferretry, run');
    expect(view.container.textContent).toContain('fy pair');
    expect(view.container.querySelector('[data-onboarding-pairing]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(quietOf(view.container)).toBe('false');
    expectNoRemovedChrome(view.container);
    await view.unmount();
  });

  it('never renders a pairing code of its own', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');
    expect(view.container.innerHTML).not.toMatch(/code=|[0-9A-Z]{4}-[0-9A-Z]{4}/);
    await view.unmount();
  });

  it('adds no expiry advice of its own beneath a failure that already says its remedy', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');
    expect(view.container.textContent).toContain('works once');

    await click(buttonWith(view.container, '[data-test-stated]'));
    expect(view.container.textContent).not.toContain('works once');

    await click(buttonWith(view.container, '[data-test-cleared]'));
    expect(view.container.textContent).toContain('works once');
    await view.unmount();
  });

  it('goes back to the entry question, which is what opened it', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    expect(buttonWith(view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe('entry');
    await click(buttonWith(view.container, '[data-onboarding-back]'));
    expect(screenOf(view.container)).toBe('entry');
    await view.unmount();
  });
});

describe('finishing a pairing page', () => {
  it('goes into the app when the embedded pairing reports it, naming the daemon', async () => {
    const { view, opened } = await pageWith({ progress: walking({ route: 'add-client', step: 'pair' }) });

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(opened).toEqual(['daemon-a']);
    await view.unmount();
  });

  it('goes into the app, with no daemon named, when the count of pairings rises', async () => {
    const { view, opened, setPairings } = await pageWith({ progress: walking({ route: 'add-client', step: 'pair' }) });

    await setPairings(1);
    expect(opened).toEqual([undefined]);
    await view.unmount();
  });

  it('settles exactly once however many ways the daemon answers', async () => {
    const reported = await pageWith({ progress: walking({ route: 'add-client', step: 'pair' }) });
    await click(buttonWith(reported.view.container, '[data-test-pair]'));
    await click(buttonWith(reported.view.container, '[data-test-pair]'));
    await reported.setPairings(1);
    await reported.setPairings(2);
    expect(reported.opened).toEqual(['daemon-a']);
    await reported.view.unmount();

    const counted = await pageWith({ progress: walking({ route: 'add-client', step: 'pair' }) });
    await counted.setPairings(1);
    await click(buttonWith(counted.view.container, '[data-test-pair]'));
    expect(counted.opened).toEqual([undefined]);
    await counted.view.unmount();
  });

  it('advances, once, on a non-last pairing page when the count rises', async () => {
    const { view, opened, setPairings } = await pageWith({ progress: walking({ step: 'local' }) });

    await setPairings(1);
    expect(screenOf(view.container)).toBe('handoff');
    await setPairings(2);
    expect(screenOf(view.container)).toBe('handoff');
    expect(opened).toEqual([]);
    await view.unmount();
  });

  it('ignores a rise in pairings on a page that is not waiting for the daemon', async () => {
    const { view, opened, setPairings } = await pageWith({ progress: walking({ step: 'install' }) });

    await setPairings(1);
    expect(screenOf(view.container)).toBe('install');
    expect(opened).toEqual([]);
    await view.unmount();
  });

  it('is not finished by pairings that were already there when the page opened', async () => {
    const { view, opened } = await pageWith({ progress: walking({ route: 'add-client', step: 'pair' }), pairings: 2 });
    expect(screenOf(view.container)).toBe('pair');
    expect(opened).toEqual([]);
    await view.unmount();
  });
});

describe('a failure that already says its remedy', () => {
  it('drops the page-finishing advice on the page it happened on', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time', 'agent');
    expect(view.container.textContent).toContain('single-use');

    await click(buttonWith(view.container, '[data-test-stated]'));
    expect(view.container.textContent).not.toContain('single-use');
    await view.unmount();
  });
});

describe('moving between screens', () => {
  it('moves focus to the new step heading, but not on the first paint', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const heading = must(view.container.querySelector('#onboarding-step-title'), 'the step heading');
    expect(document.activeElement).toBe(heading);

    (document.activeElement as HTMLElement).blur();
    await click(buttonWith(view.container, '[data-onboarding-next]'));
    expect(document.activeElement).toBe(must(view.container.querySelector('#onboarding-step-title'), 'the heading'));
    await view.unmount();
  });
});

describe('with the software keyboard open', () => {
  const toPair = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'add-client');
  };

  it('keeps the step and its actions, and hides only standing chrome', async () => {
    const { view } = await pageWith();
    await toPair(view.container);

    expect(screenOf(view.container)).toBe('pair');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).not.toBeNull();

    const hidden = [...view.container.querySelectorAll('[data-kb-hide]')];
    expect(hidden).toHaveLength(1);
    expect(must(hidden[0], 'the standing chrome').querySelector('button, input, a')).toBeNull();
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

    const cancel = scheduleFocusedOnboardingControl(root(view.container));
    await nextFrame();

    expect(scrolled).toContainEqual({ block: 'center' });
    cancel?.();
    await view.unmount();
  });

  it('schedules the focused field back into view from the page itself when it opens with the keyboard up', async () => {
    const frames: FrameRequestCallback[] = [];
    const original = {
      request: window.requestAnimationFrame,
      cancel: window.cancelAnimationFrame,
    };
    window.requestAnimationFrame = callback => frames.push(callback);
    window.cancelAnimationFrame = () => undefined;
    document.documentElement.setAttribute('data-keyboard', 'open');
    try {
      const { view } = await pageWith();
      const control = must(
        view.container.querySelector<HTMLButtonElement>('[data-onboarding="setup"] button'),
        'a focusable control',
      );
      const scrolled: ScrollIntoViewOptions[] = [];
      control.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
        scrolled.push(typeof options === 'object' ? options : {});
      };
      control.focus();
      for (const frame of frames.splice(0)) frame(0);
      expect(scrolled).toContainEqual({ block: 'center' });
      await view.unmount();
    } finally {
      document.documentElement.removeAttribute('data-keyboard');
      window.requestAnimationFrame = original.request;
      window.cancelAnimationFrame = original.cancel;
    }
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
