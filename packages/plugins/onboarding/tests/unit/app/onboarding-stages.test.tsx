/**
 * The stages were cut hard, so these tests are about what SURVIVED the cut.
 *
 * Halving the words on a setup screen is only an improvement if nothing honest
 * went with them. Each assertion below names a fact the page is not allowed to
 * lose: the verification command, what a healthy daemon prints, that the pairing
 * code expires, and that a browser paired with nothing is never offered a fleet.
 *
 * The disclosures are asserted CLOSED as well as present. A `<details>` that
 * ships open is not a disclosure; it is the paragraph it replaced.
 */

import { describe, expect, it } from 'bun:test';

import {
  DAEMON_SERVING_OUTPUT,
  DAEMON_STATUS_COMMAND,
  PAIR_COMMAND,
  VERIFY_COMMAND,
} from '../../../app/onboarding-model.ts';
import { DaemonStage, ElsewhereStage, InstallStage, ScanStage } from '../../../app/onboarding-stages.tsx';
import { interact, mount, must } from '../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const asideOf = (container: HTMLElement): HTMLDetailsElement =>
  must(container.querySelector<HTMLDetailsElement>('details'), 'the disclosure');

/**
 * The command a reader is actually looking at.
 *
 * Scoped rather than read off the whole container, because the folded-away check
 * is also a command block, and asserting against the page text would prove
 * nothing about the one on the glass.
 */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';

describe('the install stage', () => {
  it('puts one command on the glass and folds the check away, still there', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    // One command block visible, and the check folded away beside it.
    expect(view.container.querySelectorAll('pre')).toHaveLength(2);
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(VERIFY_COMMAND);
    expect(view.container.querySelectorAll('details')).toHaveLength(1);
    // No escape from an assumption nobody made: this reader chose the machine.
    expect(view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
    await view.unmount();
  });

  it('offers no way to hand the install to an agent (C59 O7)', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    expect(view.container.querySelector('[data-onboarding-agent-link], [data-onboarding-agent-instead]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/let an agent do it|have claude or codex open|setup prompt/i);
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).toBeNull();
    await view.unmount();
  });

  it('offers a way out of an ASSUMED machine, from the screen the assumption is wrong on', async () => {
    // A reader who did not read the screen before this is looking at commands for
    // the wrong host. The way out has to be here, not only back there.
    const switched: string[] = [];
    const view = await mount(
      <InstallStage write={async () => {}} channel="apt" onOtherMachine={() => switched.push('other')} />,
    );

    const aside = must(
      view.container.querySelector<HTMLDetailsElement>('[data-onboarding-aside="Setting up a different machine?"]'),
      'the machine escape',
    );
    expect(aside.open).toBe(false);
    await click(must(view.container.querySelector('[data-onboarding-other-machine]'), 'the escape control'));
    expect(switched).toEqual(['other']);
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

describe('the elsewhere stage', () => {
  it('teaches nothing, and says to open this page on the machine that matters', async () => {
    // The recursion: that computer walks the same subflow answering "this one", so
    // installation is taught in exactly one place and always about the machine the
    // reader is sitting at.
    const view = await mount(<ElsewhereStage handoff={<p>the hand-off panel</p>} onAddAsClient={() => {}} />);

    expect(view.container.textContent).toContain('Open this page on the computer that will run your agents');
    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).toContain('the hand-off panel');
    await view.unmount();
  });

  it('offers the other thing the reader may have meant, one tap away', async () => {
    const switched: string[] = [];
    const view = await mount(
      <ElsewhereStage handoff={<p>the hand-off panel</p>} onAddAsClient={() => switched.push('add-client')} />,
    );

    expect(asideOf(view.container).open).toBe(false);
    await click(must(view.container.querySelector('[data-onboarding-add-client]'), 'the client control'));
    expect(switched).toEqual(['add-client']);
    await view.unmount();
  });

  it('offers no way to hand the install to an agent (C59 O7)', async () => {
    const view = await mount(<ElsewhereStage handoff={<p>the hand-off panel</p>} onAddAsClient={() => {}} />);
    expect(view.container.querySelector('[data-onboarding-agent-link], [data-onboarding-agent-instead]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/let an agent do it|setup prompt/i);
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
