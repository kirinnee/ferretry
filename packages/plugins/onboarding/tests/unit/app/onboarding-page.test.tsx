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
 * device: the start screen, the one question, and each set of answers to its end.
 */

import { describe, expect, it } from 'bun:test';

import type { DeviceKind } from '../../../app/device-kind.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from '../../../app/hosted-relay-state.ts';
import type { OnboardingRouteId, OnboardingStepId } from '../../../app/onboarding-model.ts';
import { OnboardingPage, scheduleFocusedOnboardingControl } from '../../../app/onboarding-page.tsx';
import { type OnboardingProgressStorage, OnboardingProgressStore } from '../../../app/onboarding-progress.ts';
import type { SetupSharePort } from '../../../app/setup-handoff-panel.tsx';
import { interact, mount, must } from '../support/dom.ts';

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

/** The command block on the glass, as distinct from the check folded below it. */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';
interface PageOptions {
  readonly progress?: OnboardingProgressStore;
  readonly device?: DeviceKind;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback?: HostedRelayFallback;
  readonly share?: SetupSharePort;
}

const pageWith = async (options: PageOptions = {}) => {
  const handedOff: OnboardingRouteId[] = [];
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
      fallback={options.fallback ?? CHECKING_HOSTED_RELAY}
      onHandOff={route => handedOff.push(route)}
      renderPairing={({ onPaired, onStatedFailure }) => (
        <>
          <input id="fake-pairing-link" aria-label="Pairing link" />
          <button type="button" data-test-pair="" onClick={onPaired}>
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
    />,
  );
  return { handedOff, view };
};

/** The card for an answer: the radio inside the label that carries the answer's id. */
const cardOf = (container: HTMLElement, id: string): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>(`[data-choice-cards] input[value="${id}"]`), `the ${id} card`);

/**
 * Answers the ENTRY question the way a reader does: by choosing their own card, then pressing Continue. Choosing a card
 * starts nothing, because the arrow keys also choose.
 */
const answerEntry = async (container: HTMLElement, route: string): Promise<void> => {
  await click(cardOf(container, route));
  await click(buttonWith(container, '[data-onboarding-continue]'));
};

const answerTarget = async (container: HTMLElement, target: string): Promise<void> => {
  await click(cardOf(container, target));
  await click(buttonWith(container, '[data-onboarding-continue]'));
};

/**
 * Walks the daemon subflow the way a reader walks it, and never by seeding.
 *
 * The target card is chosen when this device ASKS it, and taken through the install page's escape when this device
 * ASSUMED it — which is exactly how a real reader gets there, and therefore proof that the escape is reachable at all. A
 * phone offers neither, because the hardware already answered.
 */
const enter = async (container: HTMLElement, route: string, target: 'this' | 'other' = 'this'): Promise<void> => {
  await answerEntry(container, route);
  if (route === 'add-client') return;
  if (screenOf(container) === 'target') await answerTarget(container, target);
  else if (target === 'other') {
    const wayOut = container.querySelector('[data-onboarding-other-machine]');
    if (wayOut !== null) await click(wayOut);
  }
};

const next = async (container: HTMLElement): Promise<void> => {
  await click(buttonWith(container, '[data-onboarding-next]'));
};

/** A store already walking a journey, for the screens that are reached by pairing. */
const walking = (options: {
  readonly device?: DeviceKind;
  readonly route?: 'first-time' | 'add-daemon' | 'add-client';
  readonly target?: 'this' | 'other';
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
  }
  store.goTo(options.step);
  return store;
};

describe('the start screen', () => {
  it('asks what the reader HAS, in three cards that are not the page wide, and never what this device is', async () => {
    const { view } = await pageWith();

    expect(screenOf(view.container)).toBe('entry');
    expect(routeOf(view.container)).toBe('none');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe('What do you want to do?');
    // The arrangement, said once before any answer is read: the work happens on a
    // computer and this page is a window onto it.
    expect(view.container.textContent).toContain('Ferretry runs your agents on a computer');

    const cards = [...view.container.querySelectorAll('[data-choice-cards] label[data-choice]')];
    expect(cards.map(node => node.getAttribute('data-choice'))).toEqual(['first-time', 'add-client', 'add-daemon']);
    // The owner's words, one line each.
    expect(cards[0]?.textContent).toContain('First time');
    expect(cards[0]?.textContent).toContain('Set up a computer to run your agents, then this browser.');
    expect(cards[1]?.textContent).toContain('Pair');
    expect(cards[1]?.textContent).toContain('Scan or upload a QR, or paste a link from a device you already use.');
    expect(cards[2]?.textContent).toContain('Set up a new daemon');
    expect(cards[2]?.textContent).toContain('Add one more computer to your fleet.');
    // An icon on every card, and a native radio group underneath.
    for (const card of cards) expect(card.querySelector('svg')).not.toBeNull();
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();

    // No stepper, no track, no diagram of a journey nobody has chosen — and no
    // Back, because there is nothing behind the first screen.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-back]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    await view.unmount();
  });

  it('offers a phone the same three cards, because none of them is impossible there', async () => {
    // The defect this replaced: a phone was offered "add this as a daemon" — a
    // role no phone can hold — and had it withdrawn a screen later.
    const { view } = await pageWith({ device: 'mobile' });

    expect(view.container.querySelectorAll('[data-choice-cards] label[data-choice]')).toHaveLength(3);
    expect(view.container.textContent).not.toContain('this as a daemon');
    expect(view.container.textContent).not.toContain('What is this device?');
    await view.unmount();
  });

  it('starts nothing on selection: Continue is off until a card is chosen, and the arrow keys only move the choice', async () => {
    // An arrow only moves the focus and Enter chooses, so an answer that acted on selection would act only for a person
    // who chose it.
    const { view } = await pageWith();
    const go = buttonWith(view.container, '[data-onboarding-continue]');
    expect(go.disabled).toBe(true);

    const press = (holder: HTMLInputElement, key: string) =>
      interact(() => holder.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    const first = must(
      view.container.querySelector<HTMLInputElement>('[data-choice-cards] input[tabindex="0"]'),
      'first',
    );
    first.focus();
    await press(first, 'ArrowDown');
    expect(document.activeElement).toBe(cardOf(view.container, 'add-client'));
    expect(cardOf(view.container, 'add-client').checked).toBe(false);
    expect(buttonWith(view.container, '[data-onboarding-continue]').disabled).toBe(true);
    await press(cardOf(view.container, 'add-client'), 'Enter');
    expect(cardOf(view.container, 'add-client').checked).toBe(true);
    await press(cardOf(view.container, 'add-client'), 'ArrowDown');
    expect(cardOf(view.container, 'add-daemon').checked).toBe(false);
    await press(cardOf(view.container, 'add-daemon'), 'Enter');
    expect(cardOf(view.container, 'add-daemon').checked).toBe(true);
    // Two arrows later the journey has still not started.
    expect(screenOf(view.container)).toBe('entry');
    expect(buttonWith(view.container, '[data-onboarding-continue]').disabled).toBe(false);

    await click(buttonWith(view.container, '[data-onboarding-continue]'));
    expect(screenOf(view.container)).toBe('target');
    await view.unmount();
  });

  it('draws its action as an auto-width, right-aligned button in the shared footer, never the page wide', async () => {
    const { view } = await pageWith();
    const footer = must(view.container.querySelector('[data-onboarding-actions]'), 'the footer');
    expect(footer.className).toContain('fy-ob-actions');
    for (const button of footer.querySelectorAll('button')) {
      expect(button.className).not.toContain('w-full');
      expect(button.className).not.toContain('flex-1');
    }
    await view.unmount();
  });

  it('short-circuits a reader holding a link straight to pairing', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'add-client');

    // Neither question is asked: there is nothing to install and nobody to install it.
    expect(screenOf(view.container)).toBe('scan');
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
    const answers = [...view.container.querySelectorAll('[data-choice-cards] label[data-choice]')];
    expect(answers.map(node => node.getAttribute('data-choice'))).toEqual(['this', 'other']);
    expect(answers[0]?.textContent).toContain('This computer');
    expect(answers[1]?.textContent).toContain('Another computer');

    // Choosing a card asks nothing more; Continue opens the commands (there is no "who installs it" screen).
    expect(buttonWith(view.container, '[data-onboarding-continue]').disabled).toBe(true);
    await answerTarget(view.container, 'this');
    expect(screenOf(view.container)).toBe('install');
    await view.unmount();
  });

  it('is never asked of a phone, which goes straight to the page that says to use a computer', async () => {
    // Agents need a terminal. Asking a phone would be paperwork, and offering it
    // "this one" would be a lie the next screen has to withdraw.
    const { view } = await pageWith({ device: 'mobile' });
    await answerEntry(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('elsewhere');
    expect(view.container.querySelector('[data-choice-cards]')).toBeNull();
    await view.unmount();
  });

  it('is assumed on a computer starting from scratch, with the way out on the page it matters on', async () => {
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    // One question shorter for the common path, and the assumption has its escape on the very commands it makes wrong.
    expect(screenOf(view.container)).toBe('install');
    expect(view.container.querySelector('[data-onboarding-other-machine]')).not.toBeNull();
    await click(buttonWith(view.container, '[data-onboarding-other-machine]'));
    expect(screenOf(view.container)).toBe('elsewhere');
    await view.unmount();
  });

  it('draws no way out of an answer the reader chose, and none on a phone', async () => {
    // A control that undoes a deliberate choice reads as the page doubting them,
    // and Back already reaches the question they answered.
    const chosen = await pageWith();
    await enter(chosen.view.container, 'add-daemon', 'this');
    expect(chosen.view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
    await chosen.view.unmount();

    const phone = await pageWith({ device: 'mobile' });
    await answerEntry(phone.view.container, 'first-time');
    expect(phone.view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
    await phone.view.unmount();
  });
});

describe('who installs it', () => {
  it('is no question and no option: the install page opens on the commands, with no agent entry point (C59 O7)', async () => {
    // r10 O5 (decision D1) removed the screen that asked "Who installs it?"; C59 O7 removed the "Let an agent do it" link
    // that replaced it, because installing needs permissions an agent usually does not have.
    const { view } = await pageWith();
    await answerEntry(view.container, 'first-time');

    expect(screenOf(view.container)).toBe('install');
    expect(view.container.textContent).not.toContain('Who installs it?');
    expect(view.container.querySelector('[data-onboarding-doer]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-agent-link], [data-onboarding-agent-instead]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/let an agent do it|have claude or codex open|setup prompt/i);
    await view.unmount();
  });

  it("has no agent entry point on the other computer's page either, on a phone", async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await answerEntry(view.container, 'first-time');

    expect(screenOf(view.container)).toBe('elsewhere');
    expect(view.container.querySelector('[data-onboarding-agent-link], [data-onboarding-agent-instead]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/let an agent do it|setup prompt/i);
    await view.unmount();
  });

  it('lands Back on the question the reader actually answered', async () => {
    // A Back that reaches a question nobody saw is how two questions start
    // feeling like a maze.
    const asked = await pageWith();
    await answerEntry(asked.view.container, 'add-daemon');
    await answerTarget(asked.view.container, 'this');
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

  it('remembers every answer and the step across a reload of the whole page', async () => {
    const storage = new MemoryStorage();
    const firstVisit = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    await enter(firstVisit.view.container, 'first-time');
    /* install → daemon, so the resumed place is one step in */
    await next(firstVisit.view.container);
    await firstVisit.view.unmount();

    // A new tab, with only storage in between.
    const second = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    expect(routeOf(second.view.container)).toBe('first-time');
    expect(screenOf(second.view.container)).toBe('daemon');
    await second.view.unmount();
  });
});

describe('a journey that was stored inside the removed agent steps', () => {
  it('opens the start screen instead of a screen that no longer exists (C59 O7)', async () => {
    for (const current of ['brief', 'agent-pair']) {
      const storage = new MemoryStorage();
      storage.setItem(
        'fy:onboarding:progress',
        JSON.stringify({
          format: 1,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'agent',
          current,
          furthest: current,
        }),
      );
      const { view } = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
      expect(screenOf(view.container)).toBe('entry');
      await view.unmount();
    }
  });
});

describe('this computer, by hand', () => {
  it('walks the arc and never asks the reader to scan their own screen', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    expect(view.container.textContent).toContain('step 1 of 3');
    const diagram = must(view.container.querySelector('[role="img"]'), 'the arrangement diagram');
    expect(diagram.getAttribute('data-onboarding-diagram')).toBe('install');
    expect(diagram.getAttribute('aria-label')).toContain('not yet linked');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Install Ferretry');

    // A real ordered list, not a row of divs pretending to be one.
    const track = must(view.container.querySelector('[aria-label="Setup steps"]'), 'the step track');
    expect(track.querySelectorAll('li')).toHaveLength(3);
    expect(must(track.querySelector('[aria-current="step"]'), 'the current step').textContent).toContain('Install');
    // Only the steps already reached are jumpable, and none have been yet.
    expect(track.querySelectorAll('[data-onboarding-jump]')).toHaveLength(0);
    // State is never carried by colour alone.
    expect(track.textContent).toContain('current step');
    expect(track.textContent).toContain('not reached yet');

    // There is no "install Claude Code or Codex" page between install and the daemon: the setup flow's own Claude and
    // Codex steps install and sign in (r10 O5).
    await next(view.container);
    expect(screenOf(view.container)).toBe('daemon');
    // The carrier is SAID on the daemon step, never asked: direct first, the
    // hosted relay as the automatic fallback, and no control to answer.
    expect(view.container.querySelector('[data-onboarding-connection-note]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-connection]')).toBeNull();
    await next(view.container);

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
    expect(screenOf(view.container)).toBe('local');

    await click(buttonWith(view.container, '[data-onboarding-jump="install"]'));
    expect(screenOf(view.container)).toBe('install');
    // Stepping back does not unreach the pairing step.
    await click(buttonWith(view.container, '[data-onboarding-jump="local"]'));
    expect(screenOf(view.container)).toBe('local');
    await view.unmount();
  });

  it('hands the person to the setup flow when the daemon answers, naming the journey', async () => {
    // The pairing step is the LAST step of every list: no phone offer, no "you are set up" page. The host (the route)
    // opens the flow on the machine that was just paired.
    const first = await pageWith();
    await enter(first.view.container, 'first-time');
    await next(first.view.container);
    await next(first.view.container);
    expect(screenOf(first.view.container)).toBe('local');
    await click(buttonWith(first.view.container, '[data-test-pair]'));
    expect(first.handedOff).toEqual(['first-time']);
    expect(first.view.container.querySelector('[data-onboarding-open-fleet]')).toBeNull();
    await first.view.unmount();

    const added = await pageWith();
    await enter(added.view.container, 'add-daemon');
    await next(added.view.container);
    await next(added.view.container);
    await click(buttonWith(added.view.container, '[data-test-pair]'));
    expect(added.handedOff).toEqual(['add-daemon']);
    await added.view.unmount();
  });
});

describe('another computer, by hand', () => {
  it('is ONE screen that teaches nothing, and reads the same on both devices', async () => {
    // The recursion: that computer opens this page and walks the by-hand list
    // there, answering "this one". A second copy of the install instructions
    // written about somebody else's keyboard is a copy that goes wrong.
    for (const device of ['mobile', 'desktop'] as const) {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time', 'other');

      expect(screenOf(view.container)).toBe('elsewhere');
      expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe(
        'Open Ferretry on that computer',
      );
      expect(view.container.textContent).toContain('step 1 of 2');
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
      ).toContain('#fy-setup=f1;route=first-time;target=this;step=install');
      await view.unmount();
    }
  });

  it('comes back to this device to finish pairing, then hands on to the setup flow', async () => {
    const { view, handedOff } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time', 'other');

    await next(view.container);
    // The reader's own half: that computer prints a code and this device uses it.
    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(handedOff).toEqual(['first-time']);
    await view.unmount();
  });

  it('shares the link through the OS when this browser has a share sheet', async () => {
    const shared: (string | undefined)[] = [];
    const share: SetupSharePort = async payload => {
      shared.push(payload.url);
    };
    const { view } = await pageWith({ device: 'mobile', share });
    await enter(view.container, 'first-time', 'other');

    await click(buttonWith(view.container, '[data-onboarding-share]'));
    expect(shared).toEqual([`${HREF}#fy-setup=f1;route=first-time;target=this;step=install`]);
    await view.unmount();
  });

  it('draws no share control when the browser has no share sheet', async () => {
    // A button that throws `NotAllowedError` when pressed is worse than one that
    // was never drawn, and copy plus the printed link are still there.
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time', 'other');

    expect(view.container.querySelector('[data-onboarding-share]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup link"]')).not.toBeNull();
    await view.unmount();
  });

  it('offers the other thing the reader may have meant, one tap away', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'add-daemon', 'other');

    expect(screenOf(view.container)).toBe('elsewhere');
    await click(buttonWith(view.container, '[data-onboarding-add-client]'));
    expect(routeOf(view.container)).toBe('add-client');
    expect(screenOf(view.container)).toBe('scan');
    await view.unmount();
  });

  it('is reachable from the install step, for a reader the assumption was wrong for', async () => {
    // The way out, for somebody who did not read the screen before this and is now looking at commands for the wrong
    // machine. There is no second question after it: the other computer's page is the answer.
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    expect(screenOf(view.container)).toBe('install');

    await click(buttonWith(view.container, '[data-onboarding-other-machine]'));
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

  it('offers the commands and the machine escape, and no agent prompt', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );

    expect(labels).toContain('Copy install command');
    expect(labels).toContain('Copy check');
    expect(labels).not.toContain('Copy setup prompt');
    expect(view.container.querySelector('[data-onboarding-prompt]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-agent-link]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-agent-instead]')).toBeNull();
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

  it("draws Back and Next as auto-width buttons in the shared footer, 44px tall by the page frame's rule", async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const footer = must(view.container.querySelector('[data-onboarding-actions]'), 'the footer');
    expect(footer.className).toContain('fy-ob-actions');
    expect(footer.querySelectorAll('button')).toHaveLength(2);
    for (const button of footer.querySelectorAll('button')) {
      expect(button.className).not.toContain('w-full');
      expect(button.className).not.toContain('flex-1');
    }
    await view.unmount();
  });
});

describe('the steps that are gone', () => {
  it('has no "Install Claude Code or Codex" page: install leads straight to the daemon', async () => {
    // Ferretry RUNS Claude Code and Codex; it is not either of them. The setup flow's Claude and Codex steps install and
    // sign in (r10 O5, decision D1), so the daemonless half no longer carries an agents stage.
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    await next(view.container);

    expect(screenOf(view.container)).toBe('daemon');
    expect(view.container.textContent).not.toContain('npm install -g @anthropic-ai/claude-code');
    expect(view.container.querySelector('[data-onboarding-harness]')).toBeNull();
    await view.unmount();
  });

  it('has no "add your phone" page and no "you are set up" page, whichever step is stored', async () => {
    // A document stored before r10 O5 may name either; it is read as a lost place, never as a page.
    const storage = new MemoryStorage();
    storage.setItem(
      'fy:onboarding:progress',
      JSON.stringify({
        format: 1,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        current: 'done',
        furthest: 'done',
      }),
    );
    const { view } = await pageWith({ progress: new OnboardingProgressStore({ storage, device: 'desktop' }) });
    expect(screenOf(view.container)).toBe('entry');
    expect(view.container.textContent).not.toContain('You are set up');
    await view.unmount();
  });
});

describe('the daemon step', () => {
  it('prints the real commands and what a healthy answer looks like', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    /* install → daemon */
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

describe('how other devices reach the daemon', () => {
  const toDaemon = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'first-time');
    /* install → daemon */
    await next(container);
  };

  it('is stated on the daemon step, never asked, and Next leads straight to pairing', async () => {
    const { view } = await pageWith({ fallback: { kind: 'available', relayUrl: 'https://relay.example.test' } });
    await toDaemon(view.container);

    expect(screenOf(view.container)).toBe('daemon');
    const note = must(view.container.querySelector('[data-onboarding-connection-note]'), 'the connection note');
    expect(note.getAttribute('data-onboarding-fallback')).toBe('available');
    expect(note.textContent).toContain('directly first');
    // No carrier chooser, no self-hosting route: nothing in first run offers either.
    expect(view.container.querySelector('[data-onboarding-connection]')).toBeNull();
    expect(view.container.textContent).not.toContain('Set up my own relay');
    expect(view.container.textContent).not.toContain('RELAY_DAEMON_IDS');
    expect(view.container.textContent).not.toContain('task relay:deploy');

    await next(view.container);
    expect(screenOf(view.container)).toBe('local');
    await click(buttonWith(view.container, '[data-onboarding-back]'));
    expect(screenOf(view.container)).toBe('daemon');
    await view.unmount();
  });

  it('keeps the same destinations: every journey still ends where it paired', async () => {
    // Removing the question removed one screen and moved no one: the same-machine
    // journey still pairs on `local`.
    const track = async (device: DeviceKind): Promise<string[]> => {
      const { view } = await pageWith({ device });
      await enter(view.container, 'first-time');
      const steps = [...view.container.querySelectorAll('[aria-label="Setup steps"] li')].map(
        node => node.textContent ?? '',
      );
      await view.unmount();
      return steps;
    };
    const desktop = await track('desktop');
    expect(desktop).toHaveLength(3);
    for (const [index, label] of ['Install', 'Daemon', 'Open'].entries()) {
      expect(desktop[index]).toContain(label);
    }
    expect(desktop.join(' ')).not.toContain('Connect');
    // A phone walks two steps, and a rail of two says nothing.
    expect(await track('mobile')).toHaveLength(0);
  });
});

describe('the pair route', () => {
  it('opens straight on Access’s scan, upload and paste surface: no terminal command comes first', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.textContent).toContain('Pair this browser · step 1 of 1');
    expect(view.container.textContent).not.toContain('Run this on the computer where the daemon is running');
    expect(view.container.textContent).not.toContain('Copy pair command');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Scan QR or paste link');
    // The pairing surface itself, unforked.
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    // Scan IS verifiable — the daemon answers in this tab — so no button here
    // could declare a browser paired with nothing "done".
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.textContent).toContain('single-use');
    await view.unmount();
  });

  it('adds no advice of its own beneath a failure that already says its remedy', async () => {
    // B6: an older Ferretry on one side names the update commands; the step still added "the code
    // expires, run fy pair again" and "this step finishes itself", advice about what was working.
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    await click(buttonWith(view.container, '[data-test-stated]'));
    const stated = view.container.textContent;
    await click(buttonWith(view.container, '[data-test-cleared]'));

    expect(stated).not.toContain('single-use');
    expect(stated).not.toContain('This step finishes itself');
    expect(view.container.textContent).toContain('single-use');
    expect(view.container.textContent).toContain('This step finishes itself');
    await view.unmount();
  });

  it('goes back to the start screen, which is what opened it', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('entry');
    await click(back);
    expect(screenOf(view.container)).toBe('entry');
    await view.unmount();
  });

  it("hands on to THIS device's own setup when the daemon answers", async () => {
    const { view, handedOff } = await pageWith();
    await enter(view.container, 'add-client');
    await click(buttonWith(view.container, '[data-test-pair]'));

    // The route reads `add-client` as the Pair journey: the client half of the flow, not the machine's steps.
    expect(handedOff).toEqual(['add-client']);
    await view.unmount();
  });
});

describe('with the software keyboard open', () => {
  const toScan = async (container: HTMLElement): Promise<void> => {
    await enter(container, 'add-client');
  };

  it('keeps the step and its actions, and hides only standing chrome', async () => {
    const { view } = await pageWith();
    await toScan(view.container);

    // The pairing field's step is still fully operable.
    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
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
        view.container.querySelector<HTMLInputElement>('[data-onboarding="setup"] input[type="radio"]'),
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
