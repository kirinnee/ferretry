/**
 * The stages were cut hard, so these tests are about what SURVIVED the cut.
 *
 * Halving the words on a setup screen is only an improvement if nothing honest
 * went with them. Each assertion below names a fact the page is not allowed to
 * lose: the verification command, what a healthy daemon prints, that the pairing
 * code expires, that the agent prompt carries nothing personal, and that a
 * browser paired with nothing is never offered a fleet.
 *
 * The disclosures are asserted CLOSED as well as present. A `<details>` that
 * ships open is not a disclosure; it is the paragraph it replaced.
 */

import { describe, expect, it } from 'bun:test';

import {
  AGENT_SETUP_PROMPT,
  DAEMON_SERVING_OUTPUT,
  DAEMON_STATUS_COMMAND,
  PAIR_COMMAND,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';
import {
  BriefStage,
  ConnectStage,
  DaemonStage,
  DoneStage,
  InstallStage,
  PairStage,
  ScanStage,
} from '../../../src/features/onboarding/onboarding-stages.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const asideOf = (container: HTMLElement): HTMLDetailsElement =>
  must(container.querySelector<HTMLDetailsElement>('details'), 'the disclosure');

describe('the install stage', () => {
  it('puts one command on the glass and folds the check away, still there', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    // One command block visible, one behind the disclosure.
    expect(view.container.querySelectorAll('pre')).toHaveLength(2);
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(VERIFY_COMMAND);
    // The agent path is a ROUTE now. It was hiding behind this same disclosure,
    // which put an entire alternative journey beside a version check.
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).toBeNull();
    await view.unmount();
  });

  it('offers the named routes as an even grid, with the script spanning beneath them', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="brew" />);
    const toolbar = must(view.container.querySelector('[role="toolbar"]'), 'the route switcher');

    expect(toolbar.getAttribute('aria-label')).toBe('Install method');
    expect(toolbar.className).toContain('grid-cols-2');
    expect(toolbar.querySelectorAll('button')).toHaveLength(5);
    // Four named routes in two even columns, and the fallback taking a full row
    // of its own rather than sitting in a ragged 2+2+1 as though it were a peer.
    const fallback = must(toolbar.querySelector('[data-onboarding-channel="curl"]'), 'the fallback route');
    expect(fallback.className).toContain('col-span-2');
    for (const id of ['apt', 'dnf', 'brew', 'nix']) {
      expect(must(toolbar.querySelector(`[data-onboarding-channel="${id}"]`), id).className).not.toContain('col-span');
    }

    // The guess leads, and swapping it swaps the command rather than adding one.
    expect(must(toolbar.querySelector('[aria-pressed="true"]'), 'the guess').textContent).toBe('macOS');
    await click(must(toolbar.querySelector('[data-onboarding-channel="dnf"]'), 'the dnf route'));
    expect(view.container.textContent).toContain('sudo dnf install fy');
    expect(view.container.textContent).not.toContain('brew install');
    await view.unmount();
  });
});

describe('the connect stage', () => {
  it('reports the order rather than asking the reader to choose one', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'available', relayUrl: 'https://relay.example.test' }} />);

    // No toolbar, no pressed state, nothing to pick: the transport decides.
    expect(view.container.querySelector('[role="toolbar"]')).toBeNull();
    expect(view.container.querySelector('[aria-pressed]')).toBeNull();
    expect(view.container.textContent).toContain('nothing to choose here');
    // Two carriers in a real ordered list, in the order they are tried.
    const steps = [...must(view.container.querySelector('ol'), 'the order').querySelectorAll('li')];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.textContent).toContain('Direct');
    expect(steps[1]?.textContent).toContain('hosted relay');
    await view.unmount();
  });

  it('does not advertise running your own relay', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'disabled' }} />);

    // Still supported by the protocol and documented; deliberately not a fork in
    // the road offered to somebody who has just installed a CLI.
    expect(view.container.textContent).not.toContain('wrangler');
    expect(view.container.textContent).not.toContain('relay:deploy');
    expect(view.container.textContent).not.toContain('Cloudflare account');
    // And nothing to run at all, so nothing to copy.
    expect(view.container.querySelector('[data-onboarding-copy]')).toBeNull();
    expect(view.container.querySelector('pre')).toBeNull();
    await view.unmount();
  });

  it('says the fallback is there, and where, when it is advertised', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'available', relayUrl: 'https://relay.example.test' }} />);
    const stage = must(view.container.querySelector('[data-onboarding-fallback]'), 'the stage');

    expect(stage.getAttribute('data-onboarding-fallback')).toBe('available');
    // The address is shown because it names who would carry the traffic. It came
    // from the runtime answer; there is no such string in the bundle.
    expect(view.container.textContent).toContain('https://relay.example.test');
    expect(view.container.textContent).toContain('only if direct');
    await view.unmount();
  });

  it('states the kill switch as a constraint, not as an error', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'disabled' }} />);

    expect(
      must(view.container.querySelector('[data-onboarding-fallback]'), 'the stage').getAttribute(
        'data-onboarding-fallback',
      ),
    ).toBe('disabled');
    // What it means FOR THE READER: direct is now the only carrier.
    expect(view.container.textContent).toContain('switched off');
    expect(view.container.textContent).toContain('only carrier');
    // Announced, because the answer lands after first paint.
    expect(must(view.container.querySelector('[role="status"]'), 'the readout').textContent).toContain('switched off');
    await view.unmount();
  });

  it('shows ignorance as ignorance, never as available and never as disabled', async () => {
    const view = await mount(
      <ConnectStage fallback={{ kind: 'undetermined', reason: 'this page could not reach the relay directory' }} />,
    );

    expect(
      must(view.container.querySelector('[data-onboarding-fallback]'), 'the stage').getAttribute(
        'data-onboarding-fallback',
      ),
    ).toBe('undetermined');
    expect(view.container.textContent).toContain('Unavailable');
    expect(view.container.textContent).toContain('could not reach the relay directory');
    // Not blamed on an operator who did nothing, and not claimed as a carrier.
    expect(view.container.textContent).not.toContain('switched off');
    expect(view.container.textContent).not.toContain('Available now');
    await view.unmount();
  });

  it('waits visibly rather than showing an answer it does not have', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'checking' }} />);

    expect(view.container.textContent).toContain('Checking whether');
    expect(view.container.textContent).not.toContain('Unavailable');
    expect(view.container.textContent).not.toContain('Available now');
    await view.unmount();
  });

  it('keeps what the hosted relay can see one tap away', async () => {
    const view = await mount(<ConnectStage fallback={{ kind: 'available', relayUrl: 'https://relay.example.test' }} />);
    const aside = asideOf(view.container);

    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain('fingerprint');
    expect(aside.textContent).toContain('could not read');
    await view.unmount();
  });
});

describe('the brief stage', () => {
  it('shows the whole prompt rather than asking for blind trust', async () => {
    const view = await mount(<BriefStage write={async () => {}} />);
    const prompt = must(view.container.querySelector('[data-onboarding-prompt]'), 'the prompt');

    // Not behind a disclosure: it is about to be handed something with a shell.
    expect(view.container.querySelector('details')).toBeNull();
    expect(prompt.textContent).toBe(AGENT_SETUP_PROMPT);
    // Scrolls in its own box, so a thirty-line prompt cannot push the next
    // action off a phone.
    expect(prompt.className).toContain('overflow-auto');
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('the scan stage', () => {
  it('runs no command at a reader who already has a link', async () => {
    const view = await mount(<ScanStage pairing={<p>the real pairing screen</p>} />);

    expect(view.container.querySelector('pre')).toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the real pairing screen',
    );
    // Still said once, folded away, for somebody who turns out not to have one.
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(PAIR_COMMAND);
    await view.unmount();
  });
});

describe('the daemon stage', () => {
  it('shows the start command and keeps the liveness check one tap away', async () => {
    const view = await mount(<DaemonStage write={async () => {}} />);
    const aside = asideOf(view.container);

    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(DAEMON_STATUS_COMMAND);
    expect(aside.textContent).toContain(DAEMON_SERVING_OUTPUT);
    await view.unmount();
  });
});

describe('the pair stage', () => {
  it('keeps the expiry on the glass, because an expired code cannot be diagnosed', async () => {
    const view = await mount(<PairStage write={async () => {}} pairing={<p>the real pairing screen</p>} />);

    expect(view.container.querySelector('details')).toBeNull();
    expect(view.container.textContent).toContain('One use, about two minutes');
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the real pairing screen',
    );
    await view.unmount();
  });
});

describe('the done stage', () => {
  it('offers the fleet when there is one', async () => {
    const opened: string[] = [];
    const view = await mount(
      <DoneStage fleetReady onOpenFleet={() => opened.push('fleet')} onBackToPairing={() => opened.push('pair')} />,
    );

    expect(view.container.querySelector('[role="status"]')).toBeNull();
    await click(must(view.container.querySelector('[data-onboarding-open-fleet]'), 'the final action'));
    expect(opened).toEqual(['fleet']);
    await view.unmount();
  });

  it('refuses to pretend when this browser is paired with nothing', async () => {
    const opened: string[] = [];
    const view = await mount(
      <DoneStage
        fleetReady={false}
        onOpenFleet={() => opened.push('fleet')}
        onBackToPairing={() => opened.push('pair')}
      />,
    );
    const action = must(view.container.querySelector('[data-onboarding-open-fleet]'), 'the final action');

    // Damaged state is not empty state: the button says what it can actually do.
    expect(must(view.container.querySelector('[role="status"]'), 'the warning').textContent).toContain(
      'Nothing is paired',
    );
    expect(action.textContent).toBe('Back to pairing');
    await click(action);
    expect(opened).toEqual(['pair']);
    await view.unmount();
  });
});
