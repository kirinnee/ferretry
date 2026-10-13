import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { InstallPhase, MissingTool } from '../../../../../src/features/fleet/setup/install-model.ts';
import { useSetupAccess } from '../../../../../src/features/fleet/setup/setup-access.ts';
import type { SetupHarness } from '../../../../../src/features/fleet/setup/setup-words.ts';
import { ToolInstall } from '../../../../../src/features/fleet/setup/tool-install.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { type Call, machineAnswer, NOTHING_INSTALLED, NOW, PASSWORD, STUDIO, scriptedClient } from './setup-support.ts';

const INSTALL_PATH = '/v1/fleet/machine/tools/install';

const missing = (): MissingTool[] => NOTHING_INSTALLED.tools.filter((tool): tool is MissingTool => !tool.installed);
const runnableOnly = (): MissingTool[] => missing().filter(tool => tool.install.kind === 'runnable');
const manualOnly = (): MissingTool[] => missing().filter(tool => tool.install.kind !== 'runnable');
const BOTH_RUNNABLE: MissingTool[] = [
  ...runnableOnly(),
  {
    harness: 'codex',
    label: 'Codex',
    installed: false,
    install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
  },
];

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

interface Seen {
  readonly phases: InstallPhase[];
  readonly installed: (readonly SetupHarness[])[];
  skips: number;
}

interface HarnessProps {
  readonly answers: Parameters<typeof scriptedClient>[0];
  readonly calls: Call[];
  readonly seen: Seen;
  readonly tools: readonly MissingTool[];
  readonly initial?: InstallPhase;
  readonly skippable?: boolean;
  readonly doneHint?: string;
  /** Holds the install request open until it resolves. */
  readonly hold?: Promise<void>;
}

function Harness({
  answers,
  calls,
  seen,
  tools,
  initial = { kind: 'choose' },
  skippable = true,
  doneHint,
  hold,
}: HarnessProps) {
  const [client] = useState((): FleetClient => {
    const inner = scriptedClient(answers, calls);
    return {
      request: async (path, schema, init) => {
        if (path === INSTALL_PATH) await hold;
        return await inner.request(path, schema, init);
      },
    };
  });
  const [connection] = useState(() => STUDIO);
  const [createClient] = useState(() => async () => client);
  const access = useSetupAccess({ connection, createClient, now: NOW });
  const [phase, setPhase] = useState<InstallPhase>(initial);
  return (
    <ToolInstall
      machineName="studio-mac"
      tools={tools}
      access={access}
      phase={phase}
      onPhase={next => {
        seen.phases.push(next);
        setPhase(next);
      }}
      onInstalled={harnesses => seen.installed.push(harnesses)}
      {...(skippable ? { onSkip: () => (seen.skips += 1) } : {})}
      {...(doneHint === undefined ? {} : { doneHint })}
    />
  );
}

const fresh = (): { calls: Call[]; seen: Seen } => ({ calls: [], seen: { phases: [], installed: [], skips: 0 } });

const text = (view: { container: HTMLElement }, selector: string): string | undefined =>
  view.container.querySelector(selector)?.textContent ?? undefined;

describe('ToolInstall', () => {
  it('lists each runnable tool with its exact command and a tool with no package manager as a manual note', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness answers={{ '/v1/fleet/machine': machineAnswer() }} calls={calls} seen={seen} tools={missing()} />,
    );
    try {
      await settle();
      const choices = view.container.querySelectorAll('[data-setup-choice]');
      expect(choices).toHaveLength(1);
      expect(choices[0]?.textContent).toContain('Install Claude Code');
      expect(choices[0]?.textContent).toContain('Ferretry will run:');
      expect(choices[0]?.textContent).toContain('npm install -g @anthropic-ai/claude-code');

      const manual = must(view.container.querySelector('[data-setup-note="install-manual"]'), 'manual note');
      expect(manual.textContent).toContain('Codex can’t be installed from here');
      expect(manual.textContent).toContain('No package manager was found on studio-mac.');
      expect(manual.textContent).toContain('Run this yourself in a terminal on studio-mac:');
      expect(manual.textContent).toContain('npm install -g @openai/codex');

      const submit = must(view.container.querySelector('[data-change-submit]'), 'submit') as HTMLButtonElement;
      expect(submit.textContent).toBe('Install 1 tool');
      expect(submit.disabled).toBe(false);
      expect(view.container.querySelector('[data-change-password]')).toBeNull();
      expect(calls.filter(call => call.path === INSTALL_PATH)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  it('shows only the manual note, and no install button, when nothing can be installed from here', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness answers={{ '/v1/fleet/machine': machineAnswer() }} calls={calls} seen={seen} tools={manualOnly()} />,
    );
    try {
      await settle();
      expect(view.container.querySelector('[data-setup-choices]')).toBeNull();
      expect(view.container.querySelector('[data-change-submit]')).toBeNull();
      expect(text(view, '[data-setup-note="install-manual"]')).toContain('npm install -g @openai/codex');
    } finally {
      await view.unmount();
    }
  });

  it('disables the button with "Pick a tool to install" once every tool is unticked, and counts the ticked ones', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness answers={{ '/v1/fleet/machine': machineAnswer() }} calls={calls} seen={seen} tools={BOTH_RUNNABLE} />,
    );
    try {
      await settle();
      const submit = () => must(view.container.querySelector('[data-change-submit]'), 'submit') as HTMLButtonElement;
      const box = (harness: string) =>
        must(
          view.container.querySelector(`[data-setup-choice="${harness}"] input[type="checkbox"]`),
          `${harness} checkbox`,
        ) as HTMLInputElement;
      expect(submit().textContent).toBe('Install 2 tools');
      expect(box('claude').checked).toBe(true);
      expect(box('codex').checked).toBe(true);

      await click(box('codex'), 'untick codex');
      expect(box('codex').checked).toBe(false);
      expect(submit().textContent).toBe('Install 1 tool');

      await click(box('claude'), 'untick claude');
      expect(submit().textContent).toBe('Pick a tool to install');
      expect(submit().disabled).toBe(true);

      await click(box('codex'), 'tick codex again');
      expect(box('codex').checked).toBe(true);
      expect(submit().textContent).toBe('Install 1 tool');
      expect(submit().disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('sends the picked harnesses to the install route, says it is installing, then reports done', async () => {
    const { calls, seen } = fresh();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const view = await mount(
      <Harness
        answers={{
          '/v1/fleet/machine': machineAnswer(),
          [INSTALL_PATH]: {
            outcomes: [
              { harness: 'claude', outcome: 'installed', command: 'npm install -g @anthropic-ai/claude-code' },
            ],
          },
        }}
        hold={gate}
        calls={calls}
        seen={seen}
        tools={missing()}
        doneHint="Next: sign in."
      />,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'install');

      const running = must(view.container.querySelector('[data-setup-note="installing"]'), 'running note');
      expect(running.textContent).toContain('Installing Claude Code on studio-mac…');
      expect(running.textContent).toContain('This can take a minute. studio-mac answers when it has finished.');
      expect(running.textContent).toContain('npm install -g @anthropic-ai/claude-code');
      expect(running.textContent).not.toContain('@openai/codex');
      expect(view.container.querySelector('[data-change-submit]')).toBeNull();

      release?.();
      await settle();

      expect(seen.phases.map(phase => phase.kind)).toEqual(['running', 'done']);
      expect(seen.installed).toEqual([['claude']]);
      const sent = calls.filter(call => call.path === INSTALL_PATH);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toEqual({ harnesses: ['claude'] });
      const done = must(view.container.querySelector('[data-setup-note="installed"]'), 'done note');
      expect(done.textContent).toContain('Installed Claude Code.');
      expect(done.textContent).toContain('Next: sign in.');
    } finally {
      await view.unmount();
    }
  });

  it('says what was installed without a hint when none is given', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness
        answers={{
          '/v1/fleet/machine': machineAnswer(),
          [INSTALL_PATH]: {
            outcomes: [
              { harness: 'claude', outcome: 'already-installed' },
              { harness: 'codex', outcome: 'installed', command: 'npm install -g @openai/codex' },
            ],
          },
        }}
        calls={calls}
        seen={seen}
        tools={BOTH_RUNNABLE}
      />,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'install both');
      expect(calls.find(call => call.path === INSTALL_PATH)?.body).toEqual({ harnesses: ['claude', 'codex'] });
      const done = must(view.container.querySelector('[data-setup-note="installed"]'), 'done note');
      expect(done.textContent).toBe('Installed Codex.');
      expect(seen.installed).toEqual([['codex']]);
    } finally {
      await view.unmount();
    }
  });

  it('sends the operator password with the request when this browser is off the machine', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness
        answers={{
          '/v1/fleet/machine': machineAnswer({ confirmation: 'operator-password' }),
          [INSTALL_PATH]: { outcomes: [{ harness: 'claude', outcome: 'already-installed' }] },
        }}
        calls={calls}
        seen={seen}
        tools={runnableOnly()}
      />,
    );
    try {
      await settle();
      const submit = must(view.container.querySelector('[data-change-submit]'), 'submit') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      const field = must(view.container.querySelector('[data-change-password]'), 'password field') as HTMLInputElement;
      await type(field, PASSWORD);
      expect(submit.disabled).toBe(false);
      await click(submit, 'install');

      expect(calls.find(call => call.path === INSTALL_PATH)?.body).toEqual({
        harnesses: ['claude'],
        operatorPassword: PASSWORD,
      });
      expect(view.container.querySelector('[data-setup-note="installed"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows the reason, the manual command, Retry and Skip after a failure, and Retry sends the same request again', async () => {
    const { calls, seen } = fresh();
    let attempts = 0;
    const view = await mount(
      <Harness
        answers={{
          '/v1/fleet/machine': machineAnswer(),
          [INSTALL_PATH]: () => {
            attempts += 1;
            return attempts === 1
              ? {
                  outcomes: [
                    {
                      harness: 'claude',
                      outcome: 'failed',
                      cause: 'needs-admin',
                      reason: 'npm needs administrator rights on studio-mac.',
                      manualCommand: 'sudo npm install -g @anthropic-ai/claude-code',
                    },
                  ],
                }
              : {
                  outcomes: [
                    { harness: 'claude', outcome: 'installed', command: 'npm install -g @anthropic-ai/claude-code' },
                  ],
                };
          },
        }}
        calls={calls}
        seen={seen}
        tools={missing()}
      />,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'install');

      const failed = must(view.container.querySelector('[data-setup-note="install-failed"]'), 'failure note');
      expect(failed.textContent).toContain('Couldn’t install on studio-mac');
      expect(failed.textContent).toContain('Claude Code: npm needs administrator rights on studio-mac.');
      expect(failed.textContent).toContain('Run this yourself in a terminal on studio-mac, then tap Retry:');
      expect(failed.textContent).toContain('sudo npm install -g @anthropic-ai/claude-code');
      const retry = must(view.container.querySelector('[data-change-submit]'), 'retry') as HTMLButtonElement;
      expect(retry.textContent).toBe('Retry');
      expect(seen.installed).toEqual([]);

      await click(retry, 'retry');
      expect(calls.filter(call => call.path === INSTALL_PATH).map(call => call.body)).toEqual([
        { harnesses: ['claude'] },
        { harnesses: ['claude'] },
      ]);
      expect(seen.phases.map(phase => phase.kind)).toEqual(['running', 'failed', 'running', 'done']);
      expect(text(view, '[data-setup-note="installed"]')).toBe('Installed Claude Code.');
      expect(seen.installed).toEqual([['claude']]);
    } finally {
      await view.unmount();
    }
  });

  it('calls onSkip from the failed phase, and offers no Skip when there is no handler', async () => {
    const failure = {
      outcomes: [
        {
          harness: 'claude',
          outcome: 'failed',
          cause: 'timed-out',
          reason: 'The install took too long.',
          manualCommand: 'npm install -g @anthropic-ai/claude-code',
        },
      ],
    };
    const failedPhase: InstallPhase = {
      kind: 'failed',
      harnesses: ['claude'],
      failures: [
        {
          harness: 'claude',
          reason: 'The install took too long.',
          manualCommand: 'npm install -g @anthropic-ai/claude-code',
        },
      ],
    };
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness
        answers={{ '/v1/fleet/machine': machineAnswer(), [INSTALL_PATH]: failure }}
        calls={calls}
        seen={seen}
        tools={missing()}
        initial={failedPhase}
      />,
    );
    try {
      await settle();
      const skip = must(view.container.querySelector('[data-install-skip]'), 'skip');
      expect(skip.textContent).toBe('Skip, continue without them');
      await click(skip, 'skip');
      expect(seen.skips).toBe(1);
      expect(calls.filter(call => call.path === INSTALL_PATH)).toHaveLength(0);
    } finally {
      await view.unmount();
    }

    const bare = fresh();
    const noSkip = await mount(
      <Harness
        answers={{ '/v1/fleet/machine': machineAnswer() }}
        calls={bare.calls}
        seen={bare.seen}
        tools={missing()}
        initial={failedPhase}
        skippable={false}
      />,
    );
    try {
      await settle();
      expect(noSkip.container.querySelector('[data-install-skip]')).toBeNull();
      expect(noSkip.container.querySelector('[data-change-submit]')?.textContent).toBe('Retry');
    } finally {
      await noSkip.unmount();
    }
  });

  it('goes back to choosing, with the refusal sentence shown, when the machine refuses the request', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness
        answers={{
          '/v1/fleet/machine': machineAnswer(),
          [INSTALL_PATH]: new FyHttpError('Installing tools is switched off on this machine.', 403, 'forbidden'),
        }}
        calls={calls}
        seen={seen}
        tools={missing()}
      />,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'install');

      expect(seen.phases.map(phase => phase.kind)).toEqual(['running', 'choose']);
      expect(seen.installed).toEqual([]);
      expect(view.container.querySelector('[data-tool-install]')).not.toBeNull();
      expect(view.container.querySelector('[data-setup-note="installing"]')).toBeNull();
      expect(text(view, '[data-change-refusal]')).toBe('Installing tools is switched off on this machine.');
      expect((view.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('says the machine did not answer when the request cannot reach it', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness answers={{ '/v1/fleet/machine': machineAnswer() }} calls={calls} seen={seen} tools={missing()} />,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'install');
      expect(seen.phases.map(phase => phase.kind)).toEqual(['running', 'choose']);
      expect(text(view, '[data-change-refusal]')).toContain('This machine didn’t answer, so nothing was changed.');
    } finally {
      await view.unmount();
    }
  });

  it('renders the running phase straight from the controlled prop', async () => {
    const { calls, seen } = fresh();
    const view = await mount(
      <Harness
        answers={{ '/v1/fleet/machine': machineAnswer() }}
        calls={calls}
        seen={seen}
        tools={BOTH_RUNNABLE}
        initial={{ kind: 'running', harnesses: ['claude', 'codex'] }}
      />,
    );
    try {
      await settle();
      const running = must(view.container.querySelector('[data-setup-note="installing"]'), 'running note');
      expect(running.getAttribute('role')).toBe('status');
      expect(running.textContent).toContain('Installing Claude Code and Codex on studio-mac…');
      expect(running.textContent).toContain('npm install -g @openai/codex');
    } finally {
      await view.unmount();
    }
  });
});
