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
  it('opens on direct and needs nothing deployed for it', async () => {
    const view = await mount(<ConnectStage write={async () => {}} method="direct" />);
    const toolbar = must(view.container.querySelector('[role="toolbar"]'), 'the carrier switcher');

    expect(toolbar.getAttribute('aria-label')).toBe('Connection method');
    expect(toolbar.querySelectorAll('button')).toHaveLength(3);
    expect(must(toolbar.querySelector('[aria-pressed="true"]'), 'the chosen carrier').textContent).toBe('Direct');
    expect(view.container.textContent).toContain('Nothing to deploy');
    expect(view.container.querySelector('[data-onboarding-method-caveat]')).toBeNull();
    await view.unmount();
  });

  it('rewrites the steps, not just a label, when the carrier changes', async () => {
    const view = await mount(<ConnectStage write={async () => {}} method="direct" />);
    const steps = (): number => must(view.container.querySelector('ol'), 'the steps').querySelectorAll('li').length;
    const before = steps();

    await click(must(view.container.querySelector('[data-onboarding-method="own-relay"]'), 'your own relay'));

    expect(steps()).toBeGreaterThan(before);
    expect(view.container.textContent).toContain('task relay:deploy');
    expect(view.container.textContent).toContain('RELAY_DAEMON_IDS');
    // The honest limit, said where the reader is deciding rather than after.
    expect(must(view.container.querySelector('[data-onboarding-method-caveat]'), 'the caveat').textContent).toContain(
      'not wired up yet',
    );
    await view.unmount();
  });

  it('keeps the reason there is no default relay one tap away', async () => {
    const view = await mount(<ConnectStage write={async () => {}} method="own-protocol" />);
    const aside = asideOf(view.container);

    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain('no relay address');
    // A carrier a reader must build has nothing to copy, and prints nothing.
    expect(view.container.querySelector('[data-onboarding-copy]')).toBeNull();
    expect(view.container.textContent).toContain('docs/relay-protocol.md');
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
