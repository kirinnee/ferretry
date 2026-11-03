/**
 * The stages were cut hard, so these tests are about what SURVIVED the cut.
 *
 * Halving the words on a setup screen is only an improvement if nothing honest
 * went with them. Each assertion below names a fact the page is not allowed to
 * lose: the verification command, what a healthy daemon prints, that the pairing
 * code expires, that the agent prompt carries nothing personal, and that the
 * install commands a reader copies are the pinned ones.
 *
 * The disclosures are asserted CLOSED as well as present. A `<details>` that
 * ships open is not a disclosure; it is the paragraph it replaced.
 */

import { describe, expect, it } from 'bun:test';

import {
  agentSetupPrompt,
  DAEMON_START_COMMAND,
  installChannel,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';
import {
  BriefStage,
  ElsewhereStage,
  HandoffStage,
  InstallStage,
  LocalStage,
  PairStage,
} from '../../../src/features/onboarding/onboarding-stages.tsx';
import { interact, mount, must } from '../../support/dom.ts';

/** The bare setup page, which is what a reader can open on the other machine. */
const PLAIN_URL = 'https://ferretry.example.invalid/setup';

const FALLBACK = { kind: 'available', relayUrl: 'https://relay.example.invalid' } as const;

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const aside = (container: HTMLElement, summary: string): HTMLDetailsElement =>
  must(container.querySelector<HTMLDetailsElement>(`[data-onboarding-aside="${summary}"]`), summary);

/**
 * The command a reader is actually looking at: the first block on the page.
 *
 * Scoped rather than read off the whole container, because disclosures legitimately
 * hold other commands — the check, the service — and the agent prompt contains
 * EVERY documented install command. Asserting against the page text would prove
 * the opposite of what it says.
 */
const visibleCommand = (container: HTMLElement): string =>
  must(container.querySelector('pre'), 'the command block').textContent ?? '';

describe('the install stage', () => {
  it('puts the detected install command and the daemon start in ONE block to copy', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    // Verbatim from the pinned channel table, never reworded, then the start.
    expect(visibleCommand(view.container)).toBe(`${installChannel('apt').command}\n${DAEMON_START_COMMAND}`);
    expect(view.container.querySelector('[data-onboarding-copy="Copy install and start commands"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Detected: Debian / Ubuntu');
    expect(view.container.textContent).toContain('Needs Claude Code or Codex');
    await view.unmount();
  });

  it('folds ONE disclosure away, the service, and drops the three that asked questions nobody had', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="apt" />);

    expect(aside(view.container, 'Keep it running after a reboot').open).toBe(false);
    expect(view.container.querySelectorAll('[data-onboarding-aside]')).toHaveLength(1);
    expect(view.container.querySelector('[data-onboarding-agent-instead]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
    // The prompt itself lives on the agent route's own page, not here.
    expect(view.container.querySelector('[data-onboarding-prompt]')).toBeNull();
    await view.unmount();
  });

  it('keeps the other platforms behind a link, then offers the named routes as an even grid', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="brew" />);

    // Collapsed by default: the detected route is the page, the rest is a link.
    expect(view.container.querySelector('[role="toolbar"]')).toBeNull();
    const link = must(view.container.querySelector('[data-onboarding-other-platforms]'), 'the platforms link');
    expect(link.textContent).toBe('Not macOS?');
    await click(link);

    const toolbar = must(view.container.querySelector('[role="toolbar"]'), 'the route switcher');
    expect(toolbar.getAttribute('aria-label')).toBe('Install method');
    expect(toolbar.className).toContain('grid-cols-2');
    expect(toolbar.querySelectorAll('button')).toHaveLength(5);
    // The fallback takes a full row of its own rather than sitting in a ragged 2+2+1.
    const fallback = must(toolbar.querySelector('[data-onboarding-channel="curl"]'), 'the fallback route');
    expect(fallback.className).toContain('col-span-2');
    for (const id of ['apt', 'dnf', 'brew', 'nix']) {
      expect(must(toolbar.querySelector(`[data-onboarding-channel="${id}"]`), id).className).not.toContain('col-span');
    }

    // The guess leads, and swapping it swaps the command rather than adding one.
    expect(must(toolbar.querySelector('[aria-pressed="true"]'), 'the guess').textContent).toBe('macOS');
    await click(must(toolbar.querySelector('[data-onboarding-channel="dnf"]'), 'the dnf route'));
    expect(visibleCommand(view.container)).toContain('sudo dnf install fy');
    expect(visibleCommand(view.container)).toContain(DAEMON_START_COMMAND);
    expect(visibleCommand(view.container)).not.toContain('brew install');
    await view.unmount();
  });

  it('says the generic fallback is a fallback, and calls the link "Other platforms"', async () => {
    const view = await mount(<InstallStage write={async () => {}} channel="curl" />);

    expect(view.container.querySelector('[data-onboarding-fallback-note]')).not.toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-other-platforms]'), 'the link').textContent).toBe(
      'Other platforms',
    );
    await view.unmount();
  });
});

describe('the brief stage', () => {
  it('leads with one primary Copy prompt and folds the whole prompt behind Show prompt', async () => {
    const view = await mount(
      <BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} pairing={<p>the pairing screen</p>} />,
    );

    const copy = must(view.container.querySelector('[data-onboarding-copy="Copy prompt"]'), 'the primary');
    expect(copy.getAttribute('data-variant')).toBe('primary');
    expect(copy.textContent).toBe('Copy prompt');

    // Still shown in full — it is about to be handed something with a shell.
    const disclosure = aside(view.container, 'Show prompt');
    expect(disclosure.open).toBe(false);
    const prompt = must(disclosure.querySelector('[data-onboarding-prompt]'), 'the prompt');
    expect(prompt.textContent).toBe(agentSetupPrompt('this'));
    // Scrolls in its own box, so a thirty-line prompt cannot push the next action off a phone.
    expect(prompt.className).toContain('overflow-auto');
    await view.unmount();
  });

  it('steps the copy down to a plain button while the pairing screen has its own primary', async () => {
    const resting = await mount(
      <BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} pairing={<p>the pairing screen</p>} />,
    );
    expect(
      must(resting.container.querySelector('[data-onboarding-copy="Copy prompt"]'), 'resting').getAttribute(
        'data-variant',
      ),
    ).toBe('primary');
    await resting.unmount();

    const engaged = await mount(
      <BriefStage
        write={async () => {}}
        target="this"
        plainUrl={PLAIN_URL}
        pairing={<p>the pairing screen</p>}
        engaged
      />,
    );
    const copy = must(engaged.container.querySelector('[data-onboarding-copy="Copy prompt"]'), 'engaged');
    expect(copy.hasAttribute('data-variant')).toBe(false);
    expect(copy.textContent).toBe('Copy prompt');
    await engaged.unmount();
  });

  it('says what finishes the page, and puts the pairing surface after it', async () => {
    const view = await mount(
      <BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} pairing={<p>the pairing screen</p>} />,
    );

    expect(must(view.container.querySelector('[data-onboarding-after]'), 'the follow-up').textContent).toBe(
      '2. When it finishes, Ferretry opens here by itself. If it shows a QR:',
    );
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the pairing screen',
    );
    expect(view.container.textContent).toContain('single-use');
    await view.unmount();
  });

  it('says which computer the prompt goes on, because that is the one way to get nothing from it', async () => {
    const here = await mount(
      <BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} pairing={<p>pairing</p>} />,
    );
    expect(here.container.textContent).toContain('on this computer');
    // The reader answered where they are, so the prompt names ONE pairing command.
    expect(here.container.textContent).toContain(PAIR_OPEN_COMMAND);
    // Nothing to send: the agent is on the machine holding this clipboard.
    expect(here.container.querySelector('[data-onboarding-prompt-handoff]')).toBeNull();
    await here.unmount();

    const elsewhere = await mount(
      <BriefStage write={async () => {}} target="other" plainUrl={PLAIN_URL} pairing={<p>pairing</p>} />,
    );
    expect(elsewhere.container.textContent).toContain('on that computer');
    expect(elsewhere.container.textContent).toContain(PAIR_COMMAND);
    expect(must(elsewhere.container.querySelector('[data-onboarding-after]'), 'the follow-up').textContent).toBe(
      '2. When it finishes, it shows a QR or a link. Scan it or paste it here:',
    );
    await elsewhere.unmount();
  });

  it('sends the prompt to the other machine, because a clipboard does not reach it', async () => {
    // There is no QR in this direction — nothing on a desk points a camera at a
    // phone — so it is the OS share sheet and words.
    const shared: unknown[] = [];
    const view = await mount(
      <BriefStage
        write={async () => {}}
        target="other"
        plainUrl={PLAIN_URL}
        pairing={<p>pairing</p>}
        share={async payload => {
          shared.push(payload);
        }}
      />,
    );

    const handoff = must(view.container.querySelector('[data-onboarding-prompt-handoff]'), 'the prompt hand-off');
    expect(handoff.textContent).toContain('does not reach it');
    // And the alternative that needs no sending at all: opening this page over there is enough.
    expect(handoff.textContent).toContain(PLAIN_URL);

    await click(must(view.container.querySelector('[data-onboarding-share-prompt]'), 'the share control'));
    expect(shared).toEqual([{ title: 'Ferretry setup prompt', text: agentSetupPrompt('other') }]);
    await view.unmount();
  });

  it('draws no share control when this browser has no share sheet', async () => {
    const view = await mount(
      <BriefStage write={async () => {}} target="other" plainUrl={PLAIN_URL} pairing={<p>pairing</p>} />,
    );
    expect(view.container.querySelector('[data-onboarding-prompt-handoff]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-share-prompt]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy prompt"]')).not.toBeNull();
    await view.unmount();
  });

  it('swallows a share the reader changed their mind about', async () => {
    // Dismissing the sheet rejects with `AbortError`; an unhandled rejection would
    // be a console failure caused by somebody pressing Cancel.
    const view = await mount(
      <BriefStage
        write={async () => {}}
        target="other"
        plainUrl={PLAIN_URL}
        pairing={<p>pairing</p>}
        share={async () => {
          throw new Error('AbortError');
        }}
      />,
    );
    await click(must(view.container.querySelector('[data-onboarding-share-prompt]'), 'the share control'));
    await view.unmount();
  });

  it('drops the expiry advice when the pairing failure already says its remedy', async () => {
    const view = await mount(
      <BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} pairing={<p>pairing</p>} stated />,
    );
    expect(view.container.textContent).not.toContain('single-use');
    await view.unmount();
  });
});

describe('the local stage', () => {
  it('shows fy pair --open and says there is nothing to scan', async () => {
    const view = await mount(
      <LocalStage write={async () => {}} pairing={<p>the pairing screen</p>} fallback={FALLBACK} />,
    );

    expect(visibleCommand(view.container)).toBe(PAIR_OPEN_COMMAND);
    expect(view.container.textContent).toContain('Nothing to scan');
    // The page finishes by itself: no button of its own.
    expect(view.container.querySelector('[data-onboarding-next]')).toBeNull();
    await view.unmount();
  });

  it('keeps the plain pairing fallback and the connection explanation behind closed disclosures', async () => {
    const view = await mount(
      <LocalStage write={async () => {}} pairing={<p>the pairing screen</p>} fallback={FALLBACK} />,
    );

    const failed = aside(view.container, 'It did not open a browser');
    expect(failed.open).toBe(false);
    expect(failed.textContent).toContain(PAIR_COMMAND);
    expect(failed.querySelector('[data-onboarding-pairing]')?.textContent).toBe('the pairing screen');

    const about = aside(view.container, 'About connections');
    expect(about.open).toBe(false);
    expect(about.querySelector('[data-onboarding-connection-note]')).not.toBeNull();
    await view.unmount();
  });
});

describe('the elsewhere stage', () => {
  it('teaches nothing: the setup link is the page, and that computer shows a QR to scan here', async () => {
    // The recursion: that computer walks the same subflow answering "this one", so
    // installation is taught in exactly one place and always about the machine the
    // reader is sitting at.
    const view = await mount(
      <ElsewhereStage
        handoff={<p>the hand-off panel</p>}
        pairing={<p>the pairing screen</p>}
        onAddAsClient={() => {}}
      />,
    );

    expect(view.container.textContent).toContain('open this link on the computer that will run them');
    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).toContain('the hand-off panel');
    expect(view.container.textContent).toContain('When that computer shows a QR, scan it here:');
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the pairing screen',
    );
    await view.unmount();
  });

  it('offers the other thing the reader may have meant, one tap away', async () => {
    const switched: string[] = [];
    const view = await mount(
      <ElsewhereStage
        handoff={<p>the hand-off panel</p>}
        pairing={<p>the pairing screen</p>}
        onAddAsClient={() => switched.push('add-client')}
      />,
    );

    expect(aside(view.container, 'A daemon already exists?').open).toBe(false);
    await click(must(view.container.querySelector('[data-onboarding-add-client]'), 'the client control'));
    expect(switched).toEqual(['add-client']);
    await view.unmount();
  });
});

describe('the hand-off stage', () => {
  it('is the panel and a way to skip, with no claim that anything was checked', async () => {
    const view = await mount(<HandoffStage handoff={<p>the hand-off panel</p>} />);

    expect(view.container.textContent).toContain('the hand-off panel');
    expect(view.container.textContent).toContain('Skip');
    await view.unmount();
  });
});

describe('the pair stage', () => {
  it('names fy pair once, then hands over to the pairing surface', async () => {
    const view = await mount(<PairStage pairing={<p>the real pairing screen</p>} />);

    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).toContain('1. On the computer running Ferretry, run');
    expect(view.container.textContent).toContain(PAIR_COMMAND);
    expect(view.container.textContent).toContain('2. Scan the QR it shows.');
    expect(view.container.textContent).toContain('works once, for about two minutes');
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the real pairing screen',
    );
    await view.unmount();
  });

  it('drops the expiry sentence when the pairing failure already says its remedy', async () => {
    const view = await mount(<PairStage pairing={<p>pairing</p>} stated />);
    expect(view.container.textContent).not.toContain('works once');
    await view.unmount();
  });
});
