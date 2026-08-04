/**
 * First run, driven rather than described.
 *
 * These assertions are all document facts — which screen is on the glass, what
 * has focus, which controls exist — because every one of them is a claim about a
 * person's ability to finish setup, and none of them survives being asserted
 * against source text.
 *
 * The question this suite answers first is the one the reader asked for: from the
 * opening screen, can somebody tell within two seconds which of the three they
 * are? So the chooser is tested as a chooser, ON BOTH KINDS OF DEVICE, because
 * the third answer means something different on a phone — and then each journey
 * is walked to its end.
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
  it('asks what this device is, and shows nothing else', async () => {
    const { view } = await pageWith();

    expect(screenOf(view.container)).toBe('choose');
    expect(routeOf(view.container)).toBe('none');
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('h2'), 'the question').textContent).toBe('What is this device?');
    // The two roles are named before the answers are read, because they are what
    // the answers are ABOUT.
    expect(view.container.textContent).toContain('A daemon runs your agents and needs a terminal');

    // A real list of real buttons, one per answer, each saying what happens.
    const answers = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(answers.map(node => node.getAttribute('data-onboarding-route'))).toEqual([
      'first-time',
      'add-client',
      'add-daemon',
    ]);
    expect(answers[0]?.textContent).toContain('First time setup');
    expect(answers[1]?.textContent).toContain('Add this as a client');
    expect(answers[2]?.textContent).toContain('Add this as a daemon');
    expect(answers[2]?.textContent).toContain('Needs a terminal');

    // No stepper, no track and no diagram of a journey nobody has chosen.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Setup steps"]')).toBeNull();
    expect(view.container.querySelector('[role="img"]')).toBeNull();
    await view.unmount();
  });

  it('never offers a phone a role a phone cannot hold', async () => {
    const { view } = await pageWith({ device: 'mobile' });

    // Still three answers — an option that silently vanishes reads as a broken
    // page — but the daemon one says what is actually true about this device.
    const answers = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(answers).toHaveLength(3);
    expect(answers[2]?.textContent).not.toContain('Needs a terminal');
    expect(answers[2]?.textContent).toContain('needs a computer');
    await view.unmount();
  });

  it('sends each answer to a different first screen', async () => {
    const client = await pageWith();
    await enter(client.view.container, 'add-client');
    // Nothing to install: a daemon already exists somewhere else.
    expect(screenOf(client.view.container)).toBe('pair');
    expect(client.view.container.textContent).not.toContain('sudo apt install fy');
    await client.view.unmount();

    const first = await pageWith();
    await enter(first.view.container, 'first-time');
    expect(screenOf(first.view.container)).toBe('install');
    await first.view.unmount();

    const daemon = await pageWith();
    await enter(daemon.view.container, 'add-daemon');
    expect(screenOf(daemon.view.container)).toBe('install');
    await daemon.view.unmount();
  });

  it('is what Back reaches from the first step of any route', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');

    const back = buttonWith(view.container, '[data-onboarding-back]');
    expect(back.getAttribute('data-onboarding-back')).toBe('chooser');
    await click(back);

    // Picking the wrong answer has to be survivable, and then re-answerable.
    expect(screenOf(view.container)).toBe('choose');
    await enter(view.container, 'add-client');
    expect(screenOf(view.container)).toBe('pair');
    await view.unmount();
  });

  it('remembers the answer and the step across a reload of the whole page', async () => {
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

describe('the first-time route on a computer', () => {
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
    const progress = new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' });
    progress.choose('first-time');
    progress.goTo('local');
    const { view } = await pageWith({ progress });

    expect(view.container.textContent).toContain('It did not open a browser');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await view.unmount();
  });

  it('offers the phone once the computer is connected, and lets it be skipped', async () => {
    const progress = new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' });
    progress.choose('first-time');
    progress.goTo('handoff');
    const { view } = await pageWith({ progress, fleetReady: true });

    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('Add your phone');
    // A QR, because a phone has a camera and this screen is what it points at.
    const qr = must(view.container.querySelector('[data-onboarding-qr]'), 'the hand-off QR');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toContain('phone');
    // The link carries the PLACE, not just the page: the phone resumes at pairing.
    expect(
      must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent,
    ).toContain('#fy-setup=v1;add-client;pair');
    // Optional, and it says so — the reader is already finished.
    expect(view.container.textContent).toContain('Skip it if you do not want one');
    await next(view.container);
    expect(screenOf(view.container)).toBe('done');
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
    expect(screenOf(view.container)).toBe('local');

    await click(buttonWith(view.container, '[data-onboarding-jump="install"]'));
    expect(screenOf(view.container)).toBe('install');
    // Stepping back does not unreach the pairing step.
    await click(buttonWith(view.container, '[data-onboarding-jump="local"]'));
    expect(screenOf(view.container)).toBe('local');
    await view.unmount();
  });

  it('finishes only when the daemon actually answers', async () => {
    const { view } = await pageWith({ fleetReady: false });
    await enter(view.container, 'first-time');
    await next(view.container);
    await next(view.container);
    await chooseConnection(view.container, 'default-relay');

    await click(buttonWith(view.container, '[data-test-pair]'));

    expect(screenOf(view.container)).toBe('done');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('You are set up');
    await view.unmount();
  });

  it('restates what the chosen fallback would see, where the connection becomes real', async () => {
    // The carrier choice was made several screens — possibly several days —
    // before anything was connected, and it is a decision about somebody else's
    // infrastructure. Saying "Direct" here and stopping would quietly retire it.
    const progress = new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' });
    progress.choose('first-time');
    progress.goTo('connect');
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
    const direct = new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' });
    direct.choose('first-time');
    direct.goTo('connect');
    direct.chooseConnection('direct');
    direct.goTo('done');
    const plain = await pageWith({ progress: direct, fleetReady: true });
    expect(plain.view.container.querySelector('[data-onboarding-fallback-disclosure]')).toBeNull();
    await plain.view.unmount();
  });

  it('offers the fleet when there is one, and refuses to pretend when there is not', async () => {
    const storage = new MemoryStorage();
    const progress = new OnboardingProgressStore({ storage, device: 'desktop' });
    progress.choose('first-time');
    progress.goTo('done');
    const unpaired = await pageWith({ progress, fleetReady: false });

    // Damaged or half-finished setup must not offer a fleet that cannot open.
    expect(unpaired.view.container.textContent).toContain('Nothing is paired in this browser yet');
    await click(buttonWith(unpaired.view.container, '[data-onboarding-open-fleet]'));
    // Back to the step that pairs THIS route: the same machine, not a scan.
    expect(screenOf(unpaired.view.container)).toBe('local');
    await unpaired.view.unmount();

    // `paired` is what makes a stored "finished" believable: without a pairing
    // the same document reads as the question again.
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

describe('the first-time route on a phone', () => {
  it('says what is true and hands the daemon half to a computer', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time');

    expect(screenOf(view.container)).toBe('need-computer');
    expect(must(view.container.querySelector('h2'), 'the step heading').textContent).toBe('You will need a computer');
    // No install commands anywhere: this device has nowhere to type them.
    expect(view.container.textContent).not.toContain('sudo apt install fy');

    // A computer has no camera pointed at a phone, so this direction is a LINK.
    expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
    expect(view.container.textContent).toContain('no camera pointed at this screen');
    const handoff = must(view.container.querySelector('[data-onboarding-handoff]'), 'the hand-off');
    expect(handoff.getAttribute('data-onboarding-handoff')).toBe('mobile');
    // And it carries the place: the computer opens at the beginning of setup.
    expect(
      must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the printed link').textContent,
    ).toContain('#fy-setup=v1;first-time;install');
    await view.unmount();
  });

  it('comes back to the phone to finish pairing', async () => {
    const { view } = await pageWith({ device: 'mobile', fleetReady: true });
    await enter(view.container, 'first-time');
    expect(view.container.textContent).toContain('step 1 of 3');

    await next(view.container);
    // The phone's own half: the computer prints a code and this device uses it.
    expect(screenOf(view.container)).toBe('scan');
    expect(view.container.querySelector('[data-test-pair]')).not.toBeNull();
    await click(buttonWith(view.container, '[data-test-pair]'));
    expect(screenOf(view.container)).toBe('done');
    await view.unmount();
  });

  it('shares the link through the OS when this browser has a share sheet', async () => {
    const shared: string[] = [];
    const share: SetupSharePort = async payload => {
      shared.push(payload.url);
    };
    const { view } = await pageWith({ device: 'mobile', share });
    await enter(view.container, 'first-time');

    await click(buttonWith(view.container, '[data-onboarding-share]'));
    expect(shared).toEqual([`${HREF}#fy-setup=v1;first-time;install`]);
    await view.unmount();
  });

  it('draws no share control when the browser has no share sheet', async () => {
    // A button that throws `NotAllowedError` when pressed is worse than one that
    // was never drawn, and copy plus the printed link are still there.
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'first-time');

    expect(view.container.querySelector('[data-onboarding-share]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup link"]')).not.toBeNull();
    await view.unmount();
  });

  it('refuses to start a daemon on a phone, and offers what the reader may have meant', async () => {
    const { view } = await pageWith({ device: 'mobile' });
    await enter(view.container, 'add-daemon');

    expect(screenOf(view.container)).toBe('need-computer');
    // A one-screen route: a `Next` here would advance to itself and read as stuck.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    // Not a dead end: the other thing they may have meant is one tap away.
    await click(buttonWith(view.container, '[data-onboarding-add-client]'));
    expect(routeOf(view.container)).toBe('add-client');
    expect(screenOf(view.container)).toBe('pair');
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
    // Scoped to the block on the glass: the agent brief in the disclosure below
    // legitimately lists every documented command, which is what makes it usable.
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

  it('keeps the agent prompt as an alternative to the command, not a third identity', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'first-time');
    const labels = [...view.container.querySelectorAll('[data-onboarding-copy]')].map(node =>
      node.getAttribute('data-onboarding-copy'),
    );

    expect(labels).toContain('Copy install command');
    expect(labels).toContain('Copy check');
    // Beside the install command it replaces, in a disclosure of its own — and
    // whole, because it is about to be handed to something with a shell.
    expect(labels).toContain('Copy setup prompt');
    expect(view.container.querySelector('[data-onboarding-aside="Rather have an agent do it?"]')).not.toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-prompt]'), 'the prompt').textContent).toContain(
      'stop and report',
    );
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
});

describe('the add-a-client route', () => {
  it('runs fy pair somewhere else, then uses the code here', async () => {
    const { view } = await pageWith();
    await enter(view.container, 'add-client');

    expect(screenOf(view.container)).toBe('pair');
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
    // The done stage's fallback has to name the step THIS route pairs on: there
    // is no daemon on this machine to open a browser from.
    const progress = new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' });
    progress.choose('add-client');
    progress.goTo('done');
    const { view } = await pageWith({ progress, fleetReady: false });

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
