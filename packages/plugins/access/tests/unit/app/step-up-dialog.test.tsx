/**
 * The passkey prompt, tested against a REAL document: a modal's contract (what the scrim does, what a
 * disabled button does) is made of document facts, and its focus hook needs a `document` to mount at all.
 */

import { describe, expect, it } from 'bun:test';
import { STEP_UP_ACTS } from '@ferretry/core-gate/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { z } from 'zod';
import {
  FIRST_PASSKEY_TITLE,
  STEP_UP_BOUND_SCOPE_NOTE,
  STEP_UP_ONCE_SCOPE_NOTE,
  STEP_UP_SCOPE_NOTE,
  StepUpDialog,
  sharedBoundNote,
  UNLOCK_COPY,
} from '../../../app/features/step-up/step-up-dialog.tsx';
import { type DaemonConnection, daemonConnection } from '../../../app/shell-grants.ts';
import { stepUpStaysSentence } from '../../../app/lib/security-settings-client.ts';
import { ownerCommandOffer } from '../../../app/lib/step-up-ceremony.ts';
import { StepUpGate, type StepUpGateDependencies } from '../../../app/lib/step-up-gate.ts';
import { interact, type Mounted, mount, must } from '../../support/app/dom.ts';

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
      expect(confirmButton(mounted.container).textContent).toContain('Add a passkey');
      expect(confirmButton(mounted.container).hasAttribute('data-step-up-first-passkey')).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the unlock prompt for a device with no passkey and no window (U-P)', () => {
  const COMMAND = "fy passkey window 'Liftoff Browser'";
  const mountUnlock = async (gate: StepUpGate) =>
    await mount(<StepUpDialog gate={gate} copy={UNLOCK_COPY} machineName={id => `Name of ${id}`} />);
  const gateWith = (ownerCommand: () => Promise<string | undefined>, ceremony = async () => undefined) =>
    new StepUpGate({
      ceremony,
      describe: (_reason, hints) => (hints?.ownerCommand === undefined ? 'plain' : `closed: ${hints.ownerCommand}`),
      firstPasskey: async () => false,
      ownerCommand,
    });

  it('P-U1 should say the exact command for the owner, with a copy control, and offer Add a passkey', async () => {
    const gate = gateWith(async () => COMMAND);
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());

      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      expect(must(dialog.querySelector('h2'), 'the title').textContent).toBe(FIRST_PASSKEY_TITLE);
      expect(dialog.textContent).toContain('No window is open to add one. On the machine itself, run this:');
      expect(must(dialog.querySelector('[data-passkey-owner-command] code'), 'the command').textContent).toBe(COMMAND);
      expect(dialog.querySelector('button[aria-label="Copy the command"]')).not.toBeNull();
      expect(confirmButton(mounted.container).textContent).toContain('Add a passkey');
      expect(dialog.textContent).not.toContain('<this device>');
    } finally {
      await mounted.unmount();
    }
  });

  it("P-U1b should print the machine's own client program: a daemon whose client is fy5 gets fy5 passkey window <name>", async () => {
    const offer = ownerCommandOffer(async () => ({
      request: async <T,>(_path: string, schema: z.ZodType<T>): Promise<T> =>
        schema.parse({ passkeys: [], registration: 'closed', deviceName: 'Liftoff Browser', clientName: 'fy5' }),
    }));
    const gate = gateWith(async () => await offer(studio));
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());

      const command = must(mounted.container.querySelector('[data-passkey-owner-command] code'), 'the command');
      expect(command.textContent).toBe("fy5 passkey window 'Liftoff Browser'");
    } finally {
      await mounted.unmount();
    }
  });

  it('P-U2 should keep the command on screen and say the window is still closed when Add a passkey is pressed too early', async () => {
    const gate = gateWith(
      async () => COMMAND,
      async () => {
        throw new Error('registration-closed');
      },
    );
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());
      await interact(() => confirmButton(mounted.container).click());
      await interact(async () => await Promise.resolve());

      const failure = must(mounted.container.querySelector('[data-step-up-failure]'), 'the failure').textContent;
      expect(failure).toBe(`closed: ${COMMAND}`);
      expect(mounted.container.querySelector('[data-passkey-owner-command]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('P-U3 should show the ordinary unlock when the machine named no command (a window is open, a passkey is held, or the read failed)', async () => {
    const gate = gateWith(async () => undefined);
    const mounted = await mountUnlock(gate);
    try {
      await interact(() => void gate.require(studio));
      await interact(async () => await Promise.resolve());

      expect(mounted.container.querySelector('[data-passkey-owner-command]')).toBeNull();
      expect(confirmButton(mounted.container).textContent).toContain('Unlock');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the passkey prompt bound to a staged task plan', () => {
  it("lists the daemon's own summary, one line each, and says it covers exactly that", async () => {
    const { gate } = harness();
    const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
    try {
      await interact(
        () =>
          void gate.require(
            studio,
            'Line 2: sign in to vercel.com once\nLine 4: paste into vercel once',
            'explicit',
            STEP_UP_ACTS.approveTaskPlan,
            `tps_${'d'.repeat(24)}` as never,
          ),
      );
      await interact(async () => await Promise.resolve());
      const summary = must(mounted.container.querySelector('[data-step-up-summary]'), 'the summary');
      expect([...summary.querySelectorAll('li')].map(item => item.textContent)).toEqual([
        'Line 2: sign in to vercel.com once',
        'Line 4: paste into vercel once',
      ]);
      expect(must(mounted.container.querySelector('[data-step-up-scope]'), 'the scope').textContent).toBe(
        STEP_UP_BOUND_SCOPE_NOTE,
      );
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the passkey prompt bound to a task plan, once another request joins it', () => {
  it('stops saying it covers exactly the list, says what it does buy, and says the staged request must be confirmed again', async () => {
    const { gate } = harness();
    const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
    try {
      await interact(
        () =>
          void gate.require(
            studio,
            'Line 2: sign in to vercel.com once',
            'explicit',
            STEP_UP_ACTS.approveTaskPlan,
            `tps_${'d'.repeat(24)}` as never,
          ),
      );
      await interact(() => void gate.require(studio, 'add a paired device', 'explicit', STEP_UP_ACTS.addDevice));
      await interact(async () => await Promise.resolve());
      const scope = must(mounted.container.querySelector('[data-step-up-scope]'), 'the scope').textContent;
      expect(scope).toBe(sharedBoundNote(STEP_UP_SCOPE_NOTE));
      expect(scope).toContain('the time it is set to');
      expect(scope).toContain('confirm the staged request again');
      expect(scope).not.toContain('Allow again');
      expect(scope).not.toContain('exactly');
      expect(mounted.container.querySelector('[data-step-up-summary]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the exact-list words when the same one request is all that waits', async () => {
    const { gate } = harness();
    const stage = `tps_${'d'.repeat(24)}` as never;
    void gate.require(studio, 'Line 2: sign in once', 'explicit', STEP_UP_ACTS.approveTaskPlan, stage);
    expect(gate.snapshot()?.bound).toBe(true);
    expect(gate.snapshot()?.shared).toBeUndefined();
    void gate.require(studio, 'Line 2: sign in once', 'explicit', STEP_UP_ACTS.approveTaskPlan, stage);
    expect(gate.snapshot()?.bound).toBe(true);
    void gate.require(
      studio,
      'Line 5: paste once',
      'explicit',
      STEP_UP_ACTS.approveTaskPlan,
      `tps_${'e'.repeat(24)}` as never,
    );
    expect(gate.snapshot()?.bound).toBeUndefined();
    expect(gate.snapshot()?.shared).toBe(true);
  });

  it('re-checks what the prompt covers on every request that joins, even with the same words and no new act', () => {
    const { gate } = harness();
    const words = 'Line 2: sign in once';
    void gate.require(studio, words, 'explicit', STEP_UP_ACTS.approveTaskPlan, `tps_${'d'.repeat(24)}` as never);
    expect(gate.snapshot()?.bound).toBe(true);
    void gate.require(studio, words, 'explicit', STEP_UP_ACTS.approveTaskPlan, `tps_${'e'.repeat(24)}` as never);
    expect(gate.snapshot()?.bound).toBeUndefined();
    expect(gate.snapshot()?.shared).toBe(true);
  });
});

describe('the passkey prompt for an act that takes its own passkey once (O12 S4)', () => {
  /** A gate whose machine says its window is 15 minutes, as Settings > Security does by default. */
  function windowed() {
    const gate = new StepUpGate({
      ceremony: async () => undefined,
      describe: () => 'unknown',
      scope: async () => stepUpStaysSentence(15),
    });
    return gate;
  }
  const IMPORT = 'put a configuration change into effect';

  it('says an import’s passkey confirms that one change, never that it covers 15 minutes of changes', async () => {
    const gate = windowed();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio, IMPORT, 'explicit', STEP_UP_ACTS.loosenConfig));
      await interact(async () => await Promise.resolve());

      const scope = must(container.querySelector('[data-step-up-scope]'), 'the scope note').textContent;
      expect(scope).toBe(STEP_UP_ONCE_SCOPE_NOTE);
      expect(scope).not.toContain('15 minutes');
      expect(gate.snapshot()?.once).toBe(true);
    });
  });

  it('keeps the machine’s window words for an ordinary change that names no act', async () => {
    const gate = windowed();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio, 'change the settings for the agent fleet'));
      await interact(async () => await Promise.resolve());

      expect(must(container.querySelector('[data-step-up-scope]'), 'the scope note').textContent).toBe(
        stepUpStaysSentence(15),
      );
      expect(gate.snapshot()?.once).toBeUndefined();
    });
  });

  it('stops saying "this one change" once another request joins the prompt, because the proof is then stamped for none', async () => {
    const gate = windowed();

    await withDialog(gate, async ({ container }) => {
      await interact(() => void gate.require(studio, IMPORT, 'explicit', STEP_UP_ACTS.loosenConfig));
      await interact(() => void gate.require(studio, 'open a terminal'));
      await interact(async () => await Promise.resolve());

      expect(gate.snapshot()?.once).toBeUndefined();
      expect(must(container.querySelector('[data-step-up-scope]'), 'the scope note').textContent).toBe(
        stepUpStaysSentence(15),
      );
    });
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

describe('the step-up prompt for a device with no passkey (A555)', () => {
  const stepUpGate = (deps: Partial<StepUpGateDependencies>) =>
    new StepUpGate({ ceremony: async () => undefined, describe: () => 'plain', ...deps });
  const open = async (gate: StepUpGate) => {
    const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
    await interact(() => void gate.require(studio, 'open a terminal'));
    await interact(async () => await Promise.resolve());
    return mounted;
  };
  const passkeysView = (view: Record<string, unknown>) =>
    ({
      request: async <T,>(_path: string, schema: z.ZodType<T>): Promise<T> => schema.parse(view),
    }) as const;

  it('(a) should offer Add a passkey in place, and no command, when a window is open', async () => {
    const mounted = await open(stepUpGate({ firstPasskey: async () => true, ownerCommand: async () => undefined }));
    try {
      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      expect(must(dialog.querySelector('h2'), 'the title').textContent).toBe(FIRST_PASSKEY_TITLE);
      expect(dialog.textContent).toContain('no passkey for Name of daemon-studio yet, and it can add one now');
      expect(dialog.textContent).toContain('Then it confirms.');
      expect(dialog.textContent).not.toContain('passkey window');
      expect(confirmButton(mounted.container).textContent).toContain('Add a passkey');
      expect(confirmButton(mounted.container).hasAttribute('data-step-up-first-passkey')).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('(b) should say plainly that the device has no passkey and give the exact command, never "no window" first', async () => {
    const offer = ownerCommandOffer(async () =>
      passkeysView({ passkeys: [], registration: 'closed', deviceName: 'Liftoff Browser', clientName: 'fy5' }),
    );
    const mounted = await open(stepUpGate({ firstPasskey: async () => false, ownerCommand: offer }));
    try {
      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      const purpose = must(dialog.querySelector('[id$="-purpose"]'), 'the sentence').textContent ?? '';
      expect(purpose.startsWith('This device has no passkey yet')).toBe(true);
      expect(purpose).toContain('No window is open to add one.');
      expect(must(dialog.querySelector('[data-passkey-owner-command] code'), 'the command').textContent).toBe(
        "fy5 passkey window 'Liftoff Browser'",
      );
      expect(dialog.textContent).not.toContain('No passkey window is open for this device yet');
    } finally {
      await mounted.unmount();
    }
  });

  it('(b) should fall back to fy only when the machine reported no CLI name', async () => {
    const offer = ownerCommandOffer(async () =>
      passkeysView({ passkeys: [], registration: 'closed', deviceName: 'Phone' }),
    );
    const mounted = await open(stepUpGate({ ownerCommand: offer }));
    try {
      expect(
        must(mounted.container.querySelector('[data-passkey-owner-command] code'), 'the command').textContent,
      ).toBe("fy passkey window 'Phone'");
    } finally {
      await mounted.unmount();
    }
  });

  it('(c) should keep today’s confirm for a device that holds a passkey', async () => {
    const offer = ownerCommandOffer(async () =>
      passkeysView({
        passkeys: [{ id: 'AQID', origin: 'https://ferretry.pages.dev', createdAt: '2026-10-13T10:00:00.000Z' }],
        registration: 'closed',
      }),
    );
    const mounted = await open(stepUpGate({ firstPasskey: async () => false, ownerCommand: offer }));
    try {
      const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
      expect(must(dialog.querySelector('h2'), 'the title').textContent).toBe('Confirm it’s you');
      expect(mounted.container.querySelector('[data-passkey-owner-command]')).toBeNull();
      expect(confirmButton(mounted.container).textContent).toContain('Use passkey');
    } finally {
      await mounted.unmount();
    }
  });
});
