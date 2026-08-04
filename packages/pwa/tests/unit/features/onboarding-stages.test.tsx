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
  DaemonStage,
  DoneStage,
  InstallStage,
  PairStage,
  RelayAllowStage,
  RelayDeployStage,
  RelayFingerprintStage,
  RelaySourceStage,
  ScanStage,
} from '../../../src/features/onboarding/onboarding-stages.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const asideOf = (container: HTMLElement): HTMLDetailsElement =>
  must(container.querySelector<HTMLDetailsElement>('details'), 'the disclosure');

/**
 * The command a reader is actually looking at.
 *
 * Scoped rather than read off the whole container, because the agent prompt in
 * the second disclosure legitimately contains EVERY documented install command —
 * that is what makes it a brief an agent can follow on a machine nobody here can
 * see. Asserting against the page text would prove the opposite of what it says.
 */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';

describe('the install stage', () => {
  it('puts one command on the glass and folds the check away, still there', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    // One command block visible; the check and the agent brief are each folded away.
    expect(view.container.querySelectorAll('pre')).toHaveLength(3);
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(VERIFY_COMMAND);
    // The agent path is an alternative to THIS command, and it gets a disclosure
    // of its own rather than sharing one with a version check.
    expect(view.container.querySelectorAll('details')).toHaveLength(2);
    expect(view.container.querySelector('[data-onboarding-aside="Rather have an agent do it?"]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
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
    expect(visibleCommand(view.container)).toContain('sudo dnf install fy');
    expect(visibleCommand(view.container)).not.toContain('brew install');
    await view.unmount();
  });
});

describe('the self-hosted relay steps', () => {
  it('keeps each deploy operation on its own stage', async () => {
    const fingerprint = await mount(<RelayFingerprintStage write={async () => {}} />);
    expect(fingerprint.container.textContent).toContain('fy pair --no-wait');
    await fingerprint.unmount();

    const source = await mount(<RelaySourceStage write={async () => {}} />);
    expect(source.container.textContent).toContain('git clone https://github.com/kirinnee/ferretry');
    await source.unmount();

    const allow = await mount(<RelayAllowStage />);
    expect(allow.container.textContent).toContain('RELAY_DAEMON_IDS');
    expect(asideOf(allow.container).open).toBe(false);
    await allow.unmount();

    const deploy = await mount(<RelayDeployStage write={async () => {}} />);
    expect(deploy.container.textContent).toContain('task relay:deploy');
    await deploy.unmount();
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
    expect(view.container.textContent).toContain('single-use');
    expect(view.container.textContent).toContain(PAIR_COMMAND);
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
  it('only asks the computer to make a code; scanning is the next stage', async () => {
    const view = await mount(<PairStage write={async () => {}} />);

    expect(view.container.querySelector('details')).toBeNull();
    expect(view.container.textContent).toContain('computer where the daemon is running');
    expect(view.container.querySelector('[data-onboarding-pairing]')).toBeNull();
    await view.unmount();
  });
});

describe('the done stage', () => {
  it('offers the fleet when there is one', async () => {
    const opened: string[] = [];
    const view = await mount(
      <DoneStage
        fleetReady
        connectionStatus="Direct"
        onOpenFleet={() => opened.push('fleet')}
        onBackToPairing={() => opened.push('pair')}
      />,
    );

    expect(must(view.container.querySelector('[role="status"]'), 'the carrier indicator').textContent).toContain(
      'Connection in use: Direct',
    );
    await click(must(view.container.querySelector('[data-onboarding-open-fleet]'), 'the final action'));
    expect(opened).toEqual(['fleet']);
    await view.unmount();
  });

  it('refuses to pretend when this browser is paired with nothing', async () => {
    const opened: string[] = [];
    const view = await mount(
      <DoneStage
        fleetReady={false}
        connectionStatus={null}
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
