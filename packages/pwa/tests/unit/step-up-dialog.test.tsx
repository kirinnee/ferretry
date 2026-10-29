/**
 * The passkey prompt, tested against a REAL document: a modal's contract (what the scrim does, what a
 * disabled button does) is made of document facts, and its focus hook needs a `document` to mount at all.
 */

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FIRST_PASSKEY_TITLE,
  STEP_UP_SCOPE_NOTE,
  StepUpDialog,
  UNLOCK_COPY,
} from '../../src/features/step-up/step-up-dialog.tsx';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { StepUpGate, type StepUpGateDependencies } from '../../src/lib/step-up-gate.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const studio = daemonConnection({
  daemonId: 'daemon-studio',
  baseUrl: 'https://studio.example',
  deviceId: 'device-one',
});

/** A gate whose ceremony the test settles by hand, so a busy prompt can be looked at. */
function harness() {
  const ceremonies: DaemonConnection[] = [];
  let release: () => void = () => undefined;
  let refuse: (reason: unknown) => void = () => undefined;
  const gate = new StepUpGate({
    ceremony: daemon => {
      ceremonies.push(daemon);
      return new Promise<void>((resolve, reject) => {
        release = resolve;
        refuse = reject;
      });
    },
    describe: reason => (reason instanceof Error ? reason.message : 'unknown'),
  });
  return {
    gate,
    ceremonies,
    finish: () => release(),
    fail: (message: string) => refuse(new Error(message)),
  };
}

/** Mounts, runs the body, and unmounts even when it throws: a failed test would otherwise leak its mount. */
async function withDialog(gate: StepUpGate, body: (mounted: Mounted) => Promise<void>): Promise<void> {
  const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
  try {
    await body(mounted);
  } finally {
    await mounted.unmount();
  }
}

const named = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)),
    `the "${text}" button`,
  );

const backdrop = (container: HTMLElement): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>('button[aria-label="Cancel the passkey confirmation"]'),
    'the backdrop button',
  );

const confirmButton = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('[data-step-up-confirm]'), 'the confirm button');

describe('the passkey prompt', () => {
  it('renders nothing while no machine is asking', async () => {
    const { gate } = harness();

    await withDialog(gate, async ({ container }) => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.innerHTML).toBe('');
    });
  });

  it('names the machine, states what a confirmation covers and offers both buttons', async () => {
    const { gate } = harness();

    await withDialog(gate, async ({ container }) => {
      // Act
      await interact(() => void gate.require(studio));

      // Assert
      const dialog = must(container.querySelector('[role="dialog"]'), 'the dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.textContent).toContain('Confirm it’s you');
      expect(dialog.textContent).toContain('Name of daemon-studio');
      expect(must(container.querySelector('[data-step-up-scope]'), 'the scope note').textContent).toBe(
        STEP_UP_SCOPE_NOTE,
      );
      expect(container.querySelector('[data-step-up-failure]')).toBeNull();
      expect(confirmButton(container).textContent).toContain('Use passkey');
      expect(confirmButton(container).disabled).toBe(false);
      expect(named(container, 'Cancel').disabled).toBe(false);
    });
  });

  it('says the act and the machine in one sentence, naming each act when several are waiting', async () => {
    const { gate } = harness();

    await withDialog(gate, async ({ container }) => {
      // Act
      await interact(() => void gate.require(studio, 'open a terminal'));

      // Assert
      const purpose = must(container.querySelector('[id$="-purpose"]'), 'the purpose sentence');
      expect(purpose.textContent).toBe('Confirm with your passkey to open a terminal on Name of daemon-studio.');
      expect(must(container.querySelector('[data-step-up-act]'), 'the act').textContent).toBe('open a terminal');
      expect(must(container.querySelector('[data-step-up-machine]'), 'the machine').textContent).toBe(
        'Name of daemon-studio',
      );

      // Act — a second act joins the same prompt.
      await interact(() => void gate.require(studio, 'open the remote browser'));
      expect(purpose.textContent).toBe(
        'Confirm with your passkey to open a terminal and open the remote browser on Name of daemon-studio.',
      );
    });
  });

  it('falls back to naming the machine and "this change" when no act came with the request', async () => {
    const { gate } = harness();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio));

      const purpose = must(container.querySelector('[id$="-purpose"]'), 'the purpose sentence');
      expect(purpose.textContent).toBe('Confirm with your passkey to make this change on Name of daemon-studio.');
    });
  });

  it('shows a failed attempt as an alert and lets the person try again', async () => {
    const { gate, fail } = harness();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio));
      let confirming: Promise<void> = Promise.resolve();
      await interact(() => {
        confirming = gate.confirm();
      });

      // Act — the ceremony throws instead of finishing.
      await interact(async () => {
        fail('That passkey confirmation did not check out. Try again.');
        await confirming;
      });

      // Assert
      const alert = must(container.querySelector('[data-step-up-failure]'), 'the failure alert');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toBe('That passkey confirmation did not check out. Try again.');
      expect(confirmButton(container).textContent).toContain('Use passkey');
      expect(confirmButton(container).disabled).toBe(false);
    });
  });

  it('shows the busy label and disables every button while the passkey sheet is up', async () => {
    const { gate, finish } = harness();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio));

      // Act
      let confirming: Promise<void> = Promise.resolve();
      await interact(() => {
        confirming = gate.confirm();
      });

      // Assert
      expect(confirmButton(container).textContent).toContain('Waiting for your passkey…');
      expect(confirmButton(container).disabled).toBe(true);
      expect(named(container, 'Cancel').disabled).toBe(true);
      expect(backdrop(container).disabled).toBe(true);

      await interact(async () => {
        finish();
        await confirming;
      });
    });
  });

  it('runs the ceremony for the machine on screen when Use passkey is pressed', async () => {
    const { gate, ceremonies, finish } = harness();

    await withDialog(gate, async ({ container }) => {
      let answer: boolean | undefined;
      await interact(() => {
        void gate.require(studio).then(value => {
          answer = value;
        });
      });

      // Act
      await interact(() => confirmButton(container).click());
      expect(ceremonies).toEqual([studio]);
      await interact(async () => {
        finish();
        await Promise.resolve();
      });

      // Assert — the request resolves true and the prompt goes away.
      expect(answer).toBe(true);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it('dismisses the prompt from Cancel, resolving the request false', async () => {
    const { gate } = harness();

    await withDialog(gate, async ({ container }) => {
      let answer: boolean | undefined;
      await interact(() => {
        void gate.require(studio).then(value => {
          answer = value;
        });
      });

      // Act
      await interact(() => named(container, 'Cancel').click());

      // Assert
      expect(answer).toBe(false);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it('dismisses the prompt from the backdrop button, resolving the request false', async () => {
    const { gate, ceremonies } = harness();

    await withDialog(gate, async ({ container }) => {
      let answer: boolean | undefined;
      await interact(() => {
        void gate.require(studio).then(value => {
          answer = value;
        });
      });

      // Act
      await interact(() => backdrop(container).click());

      // Assert — dismissed, and no ceremony ever ran.
      expect(answer).toBe(false);
      expect(ceremonies).toEqual([]);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});

describe('the unlock prompt', () => {
  const unlockHarness = (scope?: StepUpGateDependencies['scope']) => {
    const gate = new StepUpGate({
      ceremony: async () => undefined,
      describe: () => 'unknown',
      ...(scope === undefined ? {} : { scope }),
    });
    return gate;
  };
  const mountUnlock = async (gate: StepUpGate) =>
    await mount(<StepUpDialog gate={gate} copy={UNLOCK_COPY} machineName={id => `Name of ${id}`} />);

  it('says Unlock, one sentence naming the machine, the machine’s own hours, and an Unlock button', async () => {
    const gate = unlockHarness(async () => 'It stays unlocked on this device for 8 hours.');
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());

      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      expect(must(dialog.querySelector('h2'), 'the title').textContent).toBe('Unlock');
      expect(must(dialog.querySelector('[id$="-purpose"]'), 'the sentence').textContent).toBe(
        'Unlock Name of daemon-studio with your passkey.',
      );
      expect(must(dialog.querySelector('[data-step-up-scope]'), 'the line').textContent).toBe(
        'It stays unlocked on this device for 8 hours.',
      );
      expect(mounted.container.querySelector('[data-step-up-act]')).toBeNull();
      expect(confirmButton(mounted.container).textContent).toContain('Unlock');
      expect(dialog.textContent).not.toContain('15 minutes');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows no line at all until the machine has said its hours, and never blocks the button on it', async () => {
    const gate = unlockHarness(() => new Promise<string>(() => undefined));
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));

      expect(mounted.container.querySelector('[data-step-up-scope]')).toBeNull();
      expect(confirmButton(mounted.container).disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('leads with setting up a passkey for a device that may add its first one now', async () => {
    // A freshly paired device inside its first-passkey window: the way in is to set one up here, not to
    // be sent to another device or to the machine.
    const gate = new StepUpGate({
      ceremony: async () => undefined,
      describe: () => 'unknown',
      firstPasskey: async () => true,
    });
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());

      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      expect(must(dialog.querySelector('h2'), 'the title').textContent).toBe(FIRST_PASSKEY_TITLE);
      expect(must(dialog.querySelector('[id$="-purpose"]'), 'the sentence').textContent).toContain(
        'no passkey for Name of daemon-studio yet, and it can add one now',
      );
      expect(dialog.textContent).not.toContain('fy passkey window');
      expect(confirmButton(mounted.container).textContent).toContain('Set up passkey');
      expect(confirmButton(mounted.container).hasAttribute('data-step-up-first-passkey')).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the passkey prompt on the server', () => {
  it('renders nothing while the gate holds no prompt, and never starts a ceremony', () => {
    const { gate, ceremonies } = harness();

    const markup = renderToStaticMarkup(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);

    expect(markup).toBe('');
    expect(ceremonies).toEqual([]);
  });
});
