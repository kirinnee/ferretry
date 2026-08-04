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
  agentSetupPrompt,
  DAEMON_SERVING_OUTPUT,
  DAEMON_STATUS_COMMAND,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';
import {
  AgentPairStage,
  BriefStage,
  DaemonStage,
  DoneStage,
  ElsewhereStage,
  InstallStage,
  PairStage,
  RelayAllowStage,
  RelayDeployStage,
  RelayFingerprintStage,
  RelaySourceStage,
  ScanStage,
} from '../../../src/features/onboarding/onboarding-stages.tsx';
import { interact, mount, must } from '../../support/dom.ts';

/** The bare setup page, which is what a reader can open on the other machine. */
const PLAIN_URL = 'https://ferretry.example.invalid/setup';

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
    const view = await mount(<InstallStage write={async () => {}} channel="apt" onAgentInstead={() => {}} />);

    // One command block visible, and the check folded away beside it.
    expect(view.container.querySelectorAll('pre')).toHaveLength(2);
    const aside = asideOf(view.container);
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain(VERIFY_COMMAND);
    // Who installs it is a QUESTION now, so this step offers a way to change the
    // answer rather than a second copy of the prompt that answer hands over.
    expect(view.container.querySelectorAll('details')).toHaveLength(2);
    expect(view.container.querySelector('[data-onboarding-aside="Rather have an agent do it?"]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).toBeNull();
    // No escape from an assumption nobody made: this reader chose the machine.
    expect(view.container.querySelector('[data-onboarding-other-machine]')).toBeNull();
    await view.unmount();
  });

  it('changes answer to an agent instead of restating what an agent would do', async () => {
    const switched: string[] = [];
    const view = await mount(
      <InstallStage write={async () => {}} channel="apt" onAgentInstead={() => switched.push('agent')} />,
    );

    await click(must(view.container.querySelector('[data-onboarding-agent-instead]'), 'the change-answer control'));
    expect(switched).toEqual(['agent']);
    await view.unmount();
  });

  it('offers a way out of an ASSUMED machine, from the screen the assumption is wrong on', async () => {
    // A reader who did not read the screen before this is looking at commands for
    // the wrong host. The way out has to be here, not only back there.
    const switched: string[] = [];
    const view = await mount(
      <InstallStage
        write={async () => {}}
        channel="apt"
        onAgentInstead={() => {}}
        onOtherMachine={() => switched.push('other')}
      />,
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
    const view = await mount(<InstallStage write={async () => {}} channel="brew" onAgentInstead={() => {}} />);
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
    const view = await mount(<BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} />);
    const prompt = must(view.container.querySelector('[data-onboarding-prompt]'), 'the prompt');

    // Not behind a disclosure: it is about to be handed something with a shell.
    expect(view.container.querySelector('details')).toBeNull();
    expect(prompt.textContent).toBe(agentSetupPrompt('this'));
    // Scrolls in its own box, so a thirty-line prompt cannot push the next
    // action off a phone.
    expect(prompt.className).toContain('overflow-auto');
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
    await view.unmount();
  });

  it('says which computer the prompt goes on, because that is the one way to get nothing from it', async () => {
    const here = await mount(<BriefStage write={async () => {}} target="this" plainUrl={PLAIN_URL} />);
    expect(here.container.textContent).toContain('on this computer');
    expect(here.container.textContent).toContain('not into anything on this page');
    // The reader answered where they are, so the prompt names ONE pairing command.
    expect(here.container.textContent).toContain(PAIR_OPEN_COMMAND);
    // Nothing to send: the agent is on the machine holding this clipboard.
    expect(here.container.querySelector('[data-onboarding-prompt-handoff]')).toBeNull();
    await here.unmount();

    const elsewhere = await mount(<BriefStage write={async () => {}} target="other" plainUrl={PLAIN_URL} />);
    expect(elsewhere.container.textContent).toContain('on that computer');
    expect(elsewhere.container.textContent).toContain(PAIR_COMMAND);
    await elsewhere.unmount();
  });

  it('sends the prompt to the other machine, because a clipboard does not reach it', async () => {
    // The gap the previous release declared: "copy this" ended in a reader
    // retyping thirty lines. There is no QR in this direction — nothing on a desk
    // points a camera at a phone — so it is the OS share sheet and words.
    const shared: unknown[] = [];
    const view = await mount(
      <BriefStage
        write={async () => {}}
        target="other"
        plainUrl={PLAIN_URL}
        share={async payload => {
          shared.push(payload);
        }}
      />,
    );

    const handoff = must(view.container.querySelector('[data-onboarding-prompt-handoff]'), 'the prompt hand-off');
    expect(handoff.textContent).toContain('does not reach it');
    // And the alternative that needs no sending at all: the prompt is public and
    // identical on every device, so opening this page over there is enough.
    expect(handoff.textContent).toContain(PLAIN_URL);

    await click(must(view.container.querySelector('[data-onboarding-share-prompt]'), 'the share control'));
    expect(shared).toEqual([{ title: 'Ferretry setup prompt', text: agentSetupPrompt('other') }]);
    await view.unmount();
  });

  it('draws no share control when this browser has no share sheet', async () => {
    // A button that throws when pressed is worse than one that was never drawn;
    // the copy button and the page address are still there.
    const view = await mount(<BriefStage write={async () => {}} target="other" plainUrl={PLAIN_URL} />);
    expect(view.container.querySelector('[data-onboarding-prompt-handoff]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-share-prompt]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-copy="Copy setup prompt"]')).not.toBeNull();
    await view.unmount();
  });

  it('swallows a share the reader changed their mind about', async () => {
    // Dismissing the sheet rejects with `AbortError`, and an unhandled rejection
    // would be a console failure caused by somebody pressing Cancel.
    const view = await mount(
      <BriefStage
        write={async () => {}}
        target="other"
        plainUrl={PLAIN_URL}
        share={async () => {
          throw new Error('AbortError');
        }}
      />,
    );
    await click(must(view.container.querySelector('[data-onboarding-share-prompt]'), 'the share control'));
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
});

describe('the agent pairing stage', () => {
  it('asks for no commands, because the reader never had the terminal', async () => {
    const view = await mount(<AgentPairStage pairing={<p>the real pairing screen</p>} target="other" />);

    expect(view.container.querySelector('pre')).toBeNull();
    expect(must(view.container.querySelector('[data-onboarding-pairing]'), 'the pairing slot').textContent).toBe(
      'the real pairing screen',
    );
    // An expired code is the agent's to reproduce, not the reader's.
    expect(view.container.textContent).toContain('ask your agent to run');
    expect(view.container.textContent).toContain('single-use');
    // When the daemon is elsewhere, `fy pair --open` opened a browser on a machine
    // the reader is not sitting at, so claiming they may already be connected
    // would be a lie — whether this device is a phone or a second computer.
    expect(view.container.querySelector('[data-onboarding-agent-opened]')).toBeNull();
    await view.unmount();
  });

  it('says the journey may already be finished in another tab, when the daemon is HERE', async () => {
    const view = await mount(<AgentPairStage pairing={<p>the real pairing screen</p>} target="this" />);

    const opened = must(view.container.querySelector('[data-onboarding-agent-opened]'), 'the already-paired note');
    expect(opened.textContent).toContain(PAIR_OPEN_COMMAND);
    expect(opened.textContent).toContain('another tab');
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
