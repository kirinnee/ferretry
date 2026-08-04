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
  DAEMON_SERVING_OUTPUT,
  DAEMON_STATUS_COMMAND,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';
import {
  DaemonStage,
  DoneStage,
  InstallStage,
  PairStage,
} from '../../../src/features/onboarding/onboarding-stages.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const asideOf = (container: HTMLElement): HTMLDetailsElement =>
  must(container.querySelector<HTMLDetailsElement>('details'), 'the disclosure');

describe('the install stage', () => {
  it('puts one command on the glass and folds the rest away, still there', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    // One command block visible, one behind the disclosure.
    expect(view.container.querySelectorAll('pre')).toHaveLength(2);
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(VERIFY_COMMAND);
    // The agent prompt is a paste, not a printout — a labelled row, no `<pre>`.
    expect(aside.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
    expect(aside.textContent).toContain('says nothing about you');
    await view.unmount();
  });

  it('offers four routes as an even grid rather than a ragged wrap', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="brew" />);
    const toolbar = must(view.container.querySelector('[role="toolbar"]'), 'the route switcher');

    expect(toolbar.getAttribute('aria-label')).toBe('Install method');
    expect(toolbar.className).toContain('grid-cols-2');
    expect(toolbar.querySelectorAll('button')).toHaveLength(4);
    // The guess leads, and swapping it swaps the command rather than adding one.
    expect(must(toolbar.querySelector('[aria-pressed="true"]'), 'the guess').textContent).toBe('macOS');
    await click(must(toolbar.querySelector('[data-onboarding-channel="dnf"]'), 'the dnf route'));
    expect(view.container.textContent).toContain('sudo dnf install fy');
    expect(view.container.textContent).not.toContain('brew install');
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
