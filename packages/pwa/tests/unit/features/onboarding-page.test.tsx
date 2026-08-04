/**
 * First run, driven rather than described.
 *
 * These assertions are all document facts — which screen is on the glass, what
 * has focus, which controls exist — because every one of them is a claim about a
 * person's ability to finish setup, and none of them survives being asserted
 * against source text.
 *
 * THE QUESTION THIS SUITE ANSWERS FIRST IS WHETHER A PHONE IS ASKED ANYTHING IT
 * CANNOT ANSWER. A daemon runs on a computer, so "which computer runs it" is not a
 * question for a phone at all, and the screen that would have asked states the
 * fact instead. Everything after that is the same journey walked on both kinds of
 * device: the entry, the two questions, and each set of answers to its end.
 */

import { describe, expect, it } from 'bun:test';

import type { DeviceKind } from '../../../src/features/onboarding/device-kind.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from '../../../src/features/onboarding/hosted-relay.ts';
import { OnboardingPage, scheduleFocusedOnboardingControl } from '../../../src/features/onboarding/onboarding-page.tsx';
import {
  type OnboardingProgressStorage,
  OnboardingProgressStore,
} from '../../../src/features/onboarding/onboarding-progress.ts';
import type { SetupSharePort } from '../../../src/features/onboarding/setup-handoff-panel.tsx';
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

/** The command block on the glass, as distinct from the agent brief folded below it. */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';

interface PageOptions {
  readonly progress?: OnboardingProgressStore;
  readonly device?: DeviceKind;
  readonly fleetReady?: boolean;
  readonly onOpenFleet?: () => void;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback?: HostedRelayFallback;
  readonly share?: SetupSharePort;
}

const pageWith = async (options: PageOptions = {}) => {
  const opened: string[] = [];
  const view = await mount(
    <OnboardingPage
      progress={
        options.progress ??
        new OnboardingProgressStore({ storage: new MemoryStorage(), device: options.device ?? 'desktop' })
      }
      write={async () => {}}
      channel="apt"
      href={HREF}
      share={options.share}
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

const next = async (container: HTMLElement): Promise<void> => {
  await click(buttonWith(container, '[data-onboarding-next]'));
};

const chooseConnection = async (container: HTMLElement, connection: string): Promise<void> => {
  await click(buttonWith(container, `[data-onboarding-connection="${connection}"]`));
};

/** A store already walking a journey, for the screens that are reached by pairing. */
const walking = (options: {
  readonly device?: DeviceKind;
  readonly route?: 'first-time' | 'add-daemon' | 'add-client';
  readonly target?: 'this' | 'other';
  readonly doer?: 'self' | 'agent';
  readonly step: string;
  readonly storage?: OnboardingProgressStorage;
  readonly paired?: boolean;
}): OnboardingProgressStore => {
  const store = new OnboardingProgressStore({
    storage: options.storage ?? new MemoryStorage(),
    device: options.device ?? 'desktop',
    ...(options.paired === undefined ? {} : { paired: options.paired }),
  });
  const route = options.route ?? 'first-time';
  store.choose(route);
  if (route !== 'add-client') {
    store.chooseTarget(options.target ?? 'this', route);
    store.chooseDoer(options.doer ?? 'self');
  }
  store.goTo(options.step as never);
  return store;
};

describe('the entry question', () => {
  it('asks what the reader HAS, and never what this device is', async () => {
    const { view } = await pageWith();

    expect(screenOf(view.container)).toBe('entry');
    expect(routeOf(view.container)).toBe('none');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe('What do you have?');
    // The arrangement, said once before any answer is read: the work happens on a
    // computer and this page is a window onto it.
    expect(view.container.textContent).toContain('Ferretry runs your agents on a computer');

    const answers = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(answers.map(node => node.getAttribute('data-onboarding-route'))).toEqual([
      'first-time',
      'add-client',
      'add-daemon',
    ]);
    expect(answers[0]?.textContent).toContain('First time setup');
    expect(answers[1]?.textContent).toContain('I have a link or QR');
    expect(answers[2]?.textContent).toContain('Add another daemon');

    // No stepper, no track, no diagram of a journey nobody has chosen — and no
    // Back, because there is nothing behind the first screen.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    await view.unmount();
  });

  it('offers a phone the same three answers, because none of them is impossible there', async () => {
    // The defect this replaced: a phone was offered "add this as a daemon" — a
    // role no phone can hold — and had it withdrawn a screen later.
    const { view } = await pageWith({ device: 'mobile' });

    const answers = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(answers).toHaveLength(3);
    expect(view.container.textContent).not.toContain('this as a daemon');
    expect(view.container.textContent).not.toContain('What is this device?');
    await view.unmount();
  });

  it('short-circuits a reader holding a link straight to pairing', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'add-client');

    // Neither question is asked: there is nothing to install and nobody to install it.
    expect(screenOf(view.container)).toBe('pair');
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
    expect(answers[0]?.textContent).toContain('This computer');
    expect(answers[1]?.textContent).toContain('Another computer');

    await click(buttonWith(view.container, 'button[data-onboarding-target="this"]'));
    expect(screenOf(view.container)).toBe('doer');
    await view.unmount();
  });

  it('is never asked of a phone, which is told the fact instead', async () => {
    // Agents need a terminal. Asking a phone would be paperwork, and offering it
    // "this one" would be a lie the next screen has to withdraw.
    const { view } = await pageWith({ device: 'mobile' });
    await answerEntry(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('doer');
    expect(view.container.querySelector('[data-onboarding-target]')).toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-where]'), 'the machine line').textContent).toBe(
      'Ferretry runs on a computer. This phone becomes your remote control.',
    );
    await view.unmount();
  });

  it('is assumed on a computer starting from scratch, and the assumption is on the glass', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    // One question shorter for the common path, and the assumption is STATED
    // rather than discovered three screens into commands for the wrong machine.
    expect(screenOf(view.container)).toBe('doer');
    const where = must(view.container.querySelector('[data-onboarding-where]'), 'the machine line');
    expect(where.getAttribute('data-onboarding-where')).toBe('assumed:this');
    expect(where.textContent).toBe('This computer will run your agents.');
    await view.unmount();
  });

  it('has a way out of the assumption, on the screen that states it', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    await click(buttonWith(view.container, '[data-onboarding-switch-target="other"]'));
    expect(must(view.container.querySelector('[data-onboarding-where]'), 'the machine line').textContent).toBe(
      'Another computer will run your agents.',
    );
    // Reversible, because a reader who took the wrong turn has to be able to
    // take it back without leaving the screen.
    await click(buttonWith(view.container, '[data-onboarding-switch-target="this"]'));
    expect(must(view.container.querySelector('[data-onboarding-where]'), 'the machine line').textContent).toBe(
      'This computer will run your agents.',
    );
    await view.unmount();
  });

  it('draws no way out of an answer the reader chose, and none on a phone', async () => {
    // A control that undoes a deliberate choice reads as the page doubting them,
    // and Back already reaches the question they answered.
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
    expect(answers[0]?.textContent).toContain('this computer');
    expect(answers[1]?.textContent).toContain('I do it myself');
    // Still no journey: no track, no diagram, no Next.
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
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
    // A Back that reaches a question nobody saw is how two questions start
    // feeling like a maze.
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

  it('is what Back reaches from the first step of every daemon journey', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('doer');
    await click(back);

    // Picking the wrong answer has to be survivable, and then re-answerable.
    expect(screenOf(view.container)).toBe('doer');
    await answerDoer(view.container, 'agent');
    expect(screenOf(view.container)).toBe('brief');
    await view.unmount();
  });

  it('remembers every answer and the step across a reload of the whole page', async () => {
    const storage = new MemoryStorage();
    const firstVisit = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    await enter(firstVisit.view.container, 'first-time');
    await next(firstVisit.view.container);
    await firstVisit.view.unmount();

    // A new tab, with only storage in between.
    const second = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    expect(routeOf(second.view.container)).toBe('first-time');
    expect(screenOf(second.view.container)).toBe('daemon');
    await second.view.unmount();
  });
});

describe('an agent doing it', () => {
  it('is three steps that read the same wherever the reader is standing', async () => {
    for (const device of ['desktop', 'mobile'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'agent', device === 'mobile' ? 'other' : 'this');

      expect(view.container.textContent).toContain('Get a daemon running · step 1 of 3');
      expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe(
        'Give your agent the prompt',
      );
      // No platform picker and no carrier question: the agent detects and chooses
      // on the machine it is already on. The prompt is the ONLY block on the
      // glass — it legitimately lists every documented install command, which is
      // what makes it a brief an agent can follow.
      expect(view.container.querySelector('[data-onboarding-channel]')).toBeNull();
      expect(view.container.querySelector('[data-onboarding-connection]')).toBeNull();
      expect(view.container.querySelectorAll('pre')).toHaveLength(1);

      expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
      const prompt = must(view.container.querySelector('[data-onboarding-prompt]'), 'the prompt');
      expect(prompt.textContent).toContain('Set up Ferretry on this machine');
      // It no longer makes the agent ASK where the human is reading this page:
      // the reader answered that before an agent was offered at all.
      expect(prompt.textContent).not.toContain('Ask me whether');
      // And a track of three, because a rail of two says nothing.
      expect(view.container.querySelectorAll('[aria-label="Setup steps"] li')).toHaveLength(3);
      await view.unmount();
    }
  });

  it('sends the prompt to the other machine, because a clipboard does not go there', async () => {
    const shared: unknown[] = [];
    const share: SetupSharePort = async payload => {
      shared.push(payload.text);
    };
    const { view } = await pageWith({ device: 'mobile', share });
    await enter(view.container, 'first-time', 'agent');

    // The gap the previous release declared honestly. There is no QR in this
    // direction — nothing on a desk points a camera at a phone.
    const handoff = must(view.container.querySelector('[data-onboarding-prompt-handoff]'), 'the prompt hand-off');
    expect(handoff.textContent).toContain('another computer');
    expect(handoff.textContent).toContain(HREF);
    await click(buttonWith(view.container, '[data-onboarding-share-prompt]'));
    expect(shared).toHaveLength(1);
    expect(String(shared[0])).toContain('Set up Ferretry on this machine');
    await view.unmount();
  });

  it('keeps the prompt to itself when the agent is on this machine', async () => {
    const { view } = await pageWith({ share: async () => {} });
    await enter(view.container, 'first-time', 'agent');

    expect(view.container.textContent).toContain('on this computer');
    expect(view.container.querySelector('[data-onboarding-prompt-handoff]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-share-prompt]')).toBeNull();
    await view.unmount();
  });

  it('pairs with what the agent printed, and finishes when the daemon answers', async () => {
    const { view } = await pageWith({ fleetReady: true });
    await enter(view.container, 'first-time', 'agent');
    await next(view.container);

    expect(screenOf(view.container)).toBe('agent-pair');
    // The pairing surface itself, unforked — and no `Next`, because this is the
    // one step the page can actually verify.
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    // The daemon is on this machine, so the agent may already have opened a
    // paired tab — and somebody staring at a pairing field beside a finished app
    // concludes the setup failed.
    expect(view.container.textContent).toContain('fy pair --open');

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(screenOf(view.container)).toBe('done');
    await view.unmount();
  });

  it('claims nothing about an already-open tab when the daemon is elsewhere', async () => {
    // `fy pair --open` opens a browser on the DAEMON's machine, which the reader
    // is not sitting at — whether this device is a phone or a second computer.
    for (const device of ['mobile', 'desktop'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'agent', 'other');
      await next(view.container);

      expect(screenOf(view.container)).toBe('agent-pair');
      expect(view.container.querySelector('[data-onboarding-agent-opened]')).toBeNull();
      await view.unmount();
    }
  });

  it('is reachable from the install step, for a reader who changes their mind', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    await click(buttonWith(view.container, '[data-onboarding-agent-instead]'));
    expect(screenOf(view.container)).toBe('brief');
    await view.unmount();
  });

  it('resumes mid-journey across a reload, like every other answer', async () => {
    const storage = new MemoryStorage();
    const first = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'mobile' }) });
    await enter(first.view.container, 'first-time', 'agent');
    await next(first.view.container);
    await first.view.unmount();

    const second = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'mobile' }) });
    expect(screenOf(second.view.container)).toBe('agent-pair');
    await second.view.unmount();
  });
});

describe('this computer, by hand', () => {
  it('walks the arc and never asks the reader to scan their own screen', async () => {
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

    // THE COLLAPSE. The daemon is on this machine, so there is no QR and no code
    // — just a command that opens this browser already paired.
    expect(screenOf(view.container)).toBe('local');
    expect(view.container.textContent).toContain('fy pair --open');
    expect(view.container.textContent).toContain('no QR, no code to type');
    // Nothing here declares the journey finished on a click: the daemon answers.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(buttonWith(view.container, '[data-onboarding-back]').getAttribute('data-onboarding-back')).toBe('step');
    await view.unmount();
  });

  it('keeps a way through for a terminal that cannot open a browser', async () => {
    // A headless host, a remote shell, a locked-down desktop: common enough that
    // the fallback is one tap away rather than gone.
    const { view } = await pageWith({ progress: walking({ step: 'local' }) });

    expect(view.container.textContent).toContain('It did not open a browser');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await view.unmount();
  });

  it('offers the phone once the computer is connected, and lets it be skipped', async () => {
    const { view } = await pageWith({ progress: walking({ step: 'handoff' }), fleetReady: true });

    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Add your phone');
    // A QR, because a phone has a camera and this screen is what it points at.
    const qr = must(view.container.querySelector('[data-onboarding-qr]'), 'the hand-off QR');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toContain('phone');
    expect(
      must(view.container.querySelector('[data-onboarding-handoff]'), 'the hand-off').getAttribute(
        'data-onboarding-handoff',
      ),
    ).toBe('phone');
    // The link carries the PLACE, not just the page: the phone resumes at pairing.
    expect(
      must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent,
    ).toContain('#fy-setup=v2;route=add-client;step=pair');
    // Optional, and it says so — the reader is already finished. Said ONCE: the
    // advance note under every step already carries it.
    expect(view.container.textContent).toContain('Skip it and add a device whenever you like');
    await next(view.container);
    expect(screenOf(view.container)).toBe('done');
    await view.unmount();
  });

  it('moves focus to the new step heading, but not on the first paint', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const heading = must(view.container.querySelector('#onboarding-step-title'), 'the step heading');
    // Entering the journey IS a screen change, so focus has already moved to it.
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
    expect(screenOf(view.container)).toBe('local');

    await click(buttonWith(view.container, '[data-onboarding-jump="install"]'));
    expect(screenOf(view.container)).toBe('install');
    // Stepping back does not unreach the pairing step.
    await click(buttonWith(view.container, '[data-onboarding-jump="local"]'));
    expect(screenOf(view.container)).toBe('local');
    await view.unmount();
  });

  it('advances along the journey when the daemon answers, rather than jumping to the end', async () => {
    const { view } = await pageWith({ fleetReady: false });
    await enter(view.container, 'first-time');
    await next(view.container);
    await next(view.container);
    await chooseConnection(view.container, 'default-relay');

    await click(buttonWith(view.container, '[data-test-pair]'));

    // NOT 'done'. The step after pairing here is the offer to add the reader's
    // phone — the one thing that makes this more than the other lists in
    // sequence. A hardcoded 'done' here deleted it.
    expect(screenOf(view.container)).toBe('handoff');
    await next(view.container);
    expect(screenOf(view.container)).toBe('done');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('You are set up');
    await view.unmount();
  });

  it('goes straight to the end on a journey with nothing after pairing', async () => {
    // Adding one more daemon has no phone to offer: this is not a first machine.
    const { view } = await pageWith({ fleetReady: true });
    await enter(view.container, 'add-daemon');
    await next(view.container);
    await next(view.container);
    await chooseConnection(view.container, 'direct');
    expect(screenOf(view.container)).toBe('local');

    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(screenOf(view.container)).toBe('done');
    await view.unmount();
  });

  it('restates what the chosen fallback would see, where the connection becomes real', async () => {
    // The carrier choice was made several screens — possibly several days —
    // before anything was connected, and it is a decision about somebody else's
    // infrastructure. Saying "Direct" here and stopping would quietly retire it.
    const progress = walking({ step: 'connect' });
    progress.chooseConnection('default-relay');
    progress.goTo('done');
    const relayed = await pageWith({ progress, fleetReady: true });

    expect(relayed.view.container.textContent).toContain('Connection in use: Direct');
    const disclosure = must(
      relayed.view.container.querySelector('[data-onboarding-fallback-disclosure]'),
      'the fallback disclosure',
    );
    expect(disclosure.textContent).toContain('could not read a byte of it');
    expect(disclosure.textContent).toContain('metered and capped');
    await relayed.view.unmount();

    // A direct connection has no third party in it, and an empty list under a
    // "what they can see" heading reads as a redaction rather than an absence.
    const direct = walking({ step: 'connect' });
    direct.chooseConnection('direct');
    direct.goTo('done');
    const plain = await pageWith({ progress: direct, fleetReady: true });
    expect(plain.view.container.querySelector('[data-onboarding-fallback-disclosure]')).toBeNull();
    await plain.view.unmount();
  });

  it('offers the fleet when there is one, and refuses to pretend when there is not', async () => {
    const storage = new MemoryStorage();
    const unpaired = await pageWith({ progress: walking({ step: 'done', storage }), fleetReady: false });

    // Damaged or half-finished setup must not offer a fleet that cannot open.
    expect(unpaired.view.container.textContent).toContain('Nothing is paired in this browser yet');
    await click(buttonWith(unpaired.view.container, '[data-onboarding-open-fleet]'));
    // Back to the step that pairs THIS journey: the same machine, not a scan.
    expect(screenOf(unpaired.view.container)).toBe('local');
    await unpaired.view.unmount();

    // `paired` is what makes a stored "finished" believable: without a pairing
    // the same document reads as the entry question again.
    const paired = await pageWith({
      progress: new OnboardingProgressStore({ storage, device: 'desktop', paired: true }),
      fleetReady: true,
    });
    await click(buttonWith(paired.view.container, '[data-onboarding-jump="done"]'));
    await click(buttonWith(paired.view.container, '[data-onboarding-open-fleet]'));
    expect(paired.opened).toEqual(['fleet']);
    await paired.view.unmount();
  });
});

describe('another computer, by hand', () => {
  it('is ONE screen that teaches nothing, and reads the same on both devices', async () => {
    // The recursion: that computer opens this page and walks the by-hand list
    // there, answering "this one". A second copy of the install instructions
    // written about somebody else's keyboard is a copy that goes wrong.
    for (const device of ['mobile', 'desktop'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'self', 'other');

      expect(screenOf(view.container)).toBe('elsewhere');
      expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe(
        'Open Ferretry on that computer',
      );
      expect(view.container.textContent).toContain('step 1 of 3');
      // No install commands anywhere: they belong to the machine being set up.
      expect(view.container.textContent).not.toContain('sudo apt install fy');

      // Nothing on a desk points a camera at another screen, so this direction is
      // a LINK — and it carries the place, so that computer opens at the install.
      expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
      expect(view.container.textContent).toContain('no camera pointed at this screen');
      expect(
        must(view.container.querySelector('[data-onboarding-handoff]'), 'the hand-off').getAttribute(
          'data-onboarding-handoff',
        ),
      ).toBe('computer');
      expect(
        must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent,
      ).toContain('#fy-setup=v2;route=first-time;target=this;doer=self;step=install');
      await view.unmount();
    }
  });

  it('comes back to this device to finish pairing', async () => {
    const { view } = await pageWith({ device: 'mobile', fleetReady: true });
    await enter(view.container, 'first-time', 'self', 'other');

    await next(view.container);
    // The reader's own half: that computer prints a code and this device uses it.
    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(screenOf(view.container)).toBe('done');
    await view.unmount();
  });

  it('shares the link through the OS when this browser has a share sheet', async () => {
    const shared: (string | undefined)[] = [];
    const share: SetupSharePort = async payload => {
      shared.push(payload.url);
    };
    const { view } = await pageWith({ device: 'mobile', share });
    await enter(view.container, 'first-time', 'self', 'other');

    await click(buttonWith(view.container, '[data-onboarding-share]'));
    expect(shared).toEqual([`${HREF}#fy-setup=v2;route=first-time;target=this;doer=self;step=install`]);
    await view.unmount();
  });

  it('draws no share control when the browser has no share sheet', async () => {
    // A button that throws `NotAllowedError` when pressed is worse than one that
    // was never drawn, and copy plus the printed link are still there.
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time', 'self', 'other');

    expect(view.container.querySelector('[data-onboarding-share]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup link"]')).not.toBeNull();
    await view.unmount();
  });

  it('offers the other thing the reader may have meant, one tap away', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'add-daemon', 'self', 'other');

    expect(screenOf(view.container)).toBe('elsewhere');
    await click(buttonWith(view.container, '[data-onboarding-add-client]'));
    expect(routeOf(view.container)).toBe('add-client');
    expect(screenOf(view.container)).toBe('pair');
    await view.unmount();
  });

  it('is reachable from the install step, for a reader the assumption was wrong for', async () => {
    // The second way out, for somebody who did not read the screen before this
    // and is now looking at commands for the wrong machine.
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    expect(screenOf(view.container)).toBe('install');

    await click(buttonWith(view.container, '[data-onboarding-other-machine]'));
    // Who installs it is genuinely open again: that machine may have an agent.
    expect(screenOf(view.container)).toBe('doer');
    expect(must(view.container.querySelector('[data-onboarding-where]'), 'the machine line').textContent).toBe(
      'Another computer will run your agents.',
    );
    await answerDoer(view.container, 'self');
    expect(screenOf(view.container)).toBe('elsewhere');
    await view.unmount();
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
    expect(visibleCommand(view.container)).toContain('sudo apt install fy');
    expect(view.container.querySelectorAll('[data-onboarding-channel]')).toHaveLength(5);

    await click(buttonWith(view.container, '[data-onboarding-channel="dnf"]'));
    expect(selected()).toBe('dnf');
    expect(visibleCommand(view.container)).toContain('sudo dnf install fy');
    expect(visibleCommand(view.container)).not.toContain('sudo apt install fy');

    await click(buttonWith(view.container, '[data-onboarding-channel="brew"]'));
    expect(visibleCommand(view.container)).toContain('brew install --cask ferretry');
    await click(buttonWith(view.container, '[data-onboarding-channel="nix"]'));
    expect(visibleCommand(view.container)).toContain('nix profile install github:kirinnee/ferretry');
    await view.unmount();
  });

  it('names the script as the fallback, and only while it is showing', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    // A packaged route is selected, so nothing is telling this reader about a
    // fallback they are not looking at.
    expect(view.container.querySelector('[data-onboarding-fallback-note]')).toBeNull();

    await click(buttonWith(view.container, '[data-onboarding-channel="curl"]'));
    expect(visibleCommand(view.container)).toContain('install.sh | bash');
    const note = must(view.container.querySelector('[data-onboarding-fallback-note]'), 'the fallback note');
    expect(note.textContent).toContain('generic fallback');
    // The reason a Mac owner should not be here: the cask clears the quarantine.
    expect(note.textContent).toContain('Gatekeeper');
    await view.unmount();
  });

  it('offers both changes of answer rather than a second copy of either', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );

    expect(labels).toContain('Copy install command');
    expect(labels).toContain('Copy check');
    // The prompt lives on the agent answer's own step, where it is the whole
    // screen. Two copies of it would be two things to keep true.
    expect(labels).not.toContain('Copy setup prompt');
    expect(view.container.querySelector('[data-onboarding-prompt]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-aside="Rather have an agent do it?"]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-agent-instead]')).not.toBeNull();
    // And the machine, because these commands are addressed to one.
    expect(view.container.querySelector('[data-onboarding-aside="Setting up a different machine?"]')).not.toBeNull();
    expect(view.container.textContent).toContain('fy --version');
    await view.unmount();
  });

  it('draws no way out of a machine the reader chose outright', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('install');
    expect(view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
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

  it('takes the direct and default choices straight to the local pairing step', async () => {
    const { view } = await pageWith();
    await toConnect(view.container);
    await chooseConnection(view.container, 'direct');
    expect(screenOf(view.container)).toBe('local');
    await click(buttonWith(view.container, '[data-onboarding-back]'));
    expect(screenOf(view.container)).toBe('connect');
    await chooseConnection(view.container, 'default-relay');
    expect(screenOf(view.container)).toBe('local');
    await view.unmount();
  });

  it('is never on a phone journey at all, because no phone stands a daemon up', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time');
    expect(view.container.querySelector('[data-onboarding-connection]')).toBeNull();
    expect(view.container.querySelectorAll('[aria-label="Setup steps"] li')).toHaveLength(3);
    await view.unmount();
  });
});

describe('the add-a-client route', () => {
  it('runs fy pair somewhere else, then uses the code here', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    expect(screenOf(view.container)).toBe('pair');
    expect(view.container.textContent).toContain('Pair this browser · step 1 of 3');
    expect(view.container.textContent).toContain('Run this on the computer where the daemon is running');
    await next(view.container);

    expect(screenOf(view.container)).toBe('scan');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Scan QR or paste link');
    // The pairing surface itself, unforked.
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    // Scan IS verifiable — the daemon answers in this tab — so no button here
    // could declare a browser paired with nothing "done".
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.textContent).toContain('single-use');
    await view.unmount();
  });

  it('goes back to the entry question, which is what opened it', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('entry');
    await click(back);
    expect(screenOf(view.container)).toBe('entry');
    await view.unmount();
  });

  it('finishes on the same done screen when the daemon answers', async () => {
    const { view } = await pageWith({ fleetReady: true });
    await enter(view.container, 'add-client');
    await next(view.container);
    await click(buttonWith(view.container, '[data-test-pair]'));

    expect(screenOf(view.container)).toBe('done');
    expect(routeOf(view.container)).toBe('add-client');
    await view.unmount();
  });

  it('sends a stranded reader back to the scan rather than to a local daemon', async () => {
    // The done stage's fallback has to name the step THIS journey pairs on: there
    // is no daemon on this machine to open a browser from.
    const { view } = await pageWith({
      progress: walking({ route: 'add-client', step: 'done' }),
      fleetReady: false,
    });

    await click(buttonWith(view.container, '[data-onboarding-open-fleet]'));
    expect(screenOf(view.container)).toBe('scan');
    await view.unmount();
  });
});

describe('with the software keyboard open', () => {
  const toScan = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'add-client');
    await next(container);
  };

  it('keeps the step, its actions and the track, and hides only standing chrome', async () => {
    const { view } = await pageWith();
    await toScan(view.container);

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
    await toScan(view.container);
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
