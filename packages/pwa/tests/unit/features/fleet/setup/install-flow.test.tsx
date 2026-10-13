import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-api.ts';
import { InstallTool } from '../../../../../src/features/fleet/setup/install-flow.tsx';
import type { SetupHarness } from '../../../../../src/features/fleet/setup/setup-words.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  type Call,
  machineView,
  NOTHING_INSTALLED,
  NOW,
  PASSWORD,
  permissions,
  STUDIO,
  scan,
  scriptedClient,
  UNLOCKED,
} from './setup-support.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const LOCKED = permissions({ mayApply: false, applyRefusal: 'locked' });

interface Harness {
  readonly harness?: SetupHarness;
  readonly online?: boolean;
  readonly checking?: boolean;
}

const element = (
  client: ReturnType<typeof scriptedClient>,
  spies: { left: number[]; retried: number[] },
  { harness = 'claude', online = true, checking = false }: Harness = {},
) => (
  <InstallTool
    harness={harness}
    machine={machineView()}
    machineName="studio-mac"
    connection={STUDIO}
    createClient={async () => client}
    online={online}
    checking={checking}
    onRetry={() => spies.retried.push(1)}
    onLeave={() => spies.left.push(1)}
    now={NOW}
  />
);

const spies = () => ({ left: [] as number[], retried: [] as number[] });

describe('InstallTool', () => {
  it('says the tool is not installed, shows the exact command, installs it and finishes with Done', async () => {
    const calls: Call[] = [];
    const watch = spies();
    const client = scriptedClient(
      {
        '/v1/fleet/permissions': permissions(),
        '/v1/fleet/setup/scan': NOTHING_INSTALLED,
        '/v1/fleet/machine/tools/install': {
          outcomes: [{ harness: 'claude', outcome: 'installed', command: 'npm install -g @anthropic-ai/claude-code' }],
        },
      },
      calls,
    );
    const view = await mount(element(client, watch));
    try {
      expect(view.container.querySelector('[data-machine-stepper="install"]')?.textContent).toContain(
        'Install Claude Code',
      );
      await settle();
      const text = view.container.textContent ?? '';
      expect(text).toContain('Claude Code isn’t installed on studio-mac. Ferretry can install it.');
      expect(text).toContain('npm install -g @anthropic-ai/claude-code');
      // Only the tool this flow is for is offered.
      expect(text).not.toContain('@openai/codex');
      expect(view.container.querySelector('[data-install-flow="claude"]')).not.toBeNull();

      await click(view.container.querySelector('[data-change-submit]'), 'install');
      const install = must(
        calls.find(call => call.path === '/v1/fleet/machine/tools/install'),
        'install call',
      );
      expect(install.body).toEqual({ harnesses: ['claude'] });
      expect(view.container.querySelector('[data-setup-note="installed"]')?.textContent).toContain(
        'Installed Claude Code.',
      );
      expect(view.container.textContent).not.toContain('isn’t installed on studio-mac');
      expect(watch.retried).toEqual([1]);

      expect(watch.left).toEqual([]);
      await click(view.container.querySelector('[data-install-finish]'), 'done');
      expect(watch.left).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });

  it('says what it is doing while the scan is read', async () => {
    const watch = spies();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      '/v1/fleet/setup/scan': NOTHING_INSTALLED,
    });
    const slow: FleetClient = {
      request: async (path, schema, init) => {
        if (path === '/v1/fleet/setup/scan') await gate;
        return await client.request(path, schema, init);
      },
    };
    const view = await mount(
      <InstallTool
        harness="codex"
        machine={machineView()}
        machineName="studio-mac"
        connection={STUDIO}
        createClient={async () => slow}
        online
        checking={false}
        onRetry={() => undefined}
        onLeave={() => watch.left.push(1)}
        now={NOW}
      />,
    );
    try {
      await settle();
      expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Looking at what’s on studio-mac…');
      release();
      await settle();
      expect(view.container.textContent).toContain('Codex isn’t installed on studio-mac. Ferretry can install it.');
      // No package manager: nothing to pick, the command to run by hand instead.
      expect(view.container.querySelector('[data-setup-note="install-manual"]')?.textContent).toContain(
        'Codex can’t be installed from here',
      );
      expect(view.container.textContent).toContain('npm install -g @openai/codex');
      expect(view.container.querySelector('[data-change-submit]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says it is already installed and only offers Done', async () => {
    const watch = spies();
    const client = scriptedClient({ '/v1/fleet/permissions': permissions(), '/v1/fleet/setup/scan': scan() });
    const view = await mount(element(client, watch, { harness: 'codex' }));
    try {
      await settle();
      expect(view.container.querySelector('[data-setup-note="already-installed"]')?.textContent).toContain(
        'Codex is installed on studio-mac',
      );
      expect(view.container.querySelector('[data-change-submit]')).toBeNull();
      await click(view.container.querySelector('[data-install-finish]'), 'done');
      expect(watch.left).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });

  it('asks a locked browser for the operator password, then looks and offers the install', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      { '/v1/fleet/permissions': LOCKED, '/v1/grants/unlock': UNLOCKED, '/v1/fleet/setup/scan': NOTHING_INSTALLED },
      calls,
    );
    const view = await mount(element(client, spies()));
    try {
      await settle();
      // Nothing is read until the browser unlocks.
      expect(calls.some(call => call.path === '/v1/fleet/setup/scan')).toBe(false);
      const submit = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'submit');
      expect(submit.textContent).toBe('Look at studio-mac');
      await type(must(view.container.querySelector<HTMLInputElement>('[data-change-password]'), 'password'), PASSWORD);
      await click(submit, 'look');
      expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(true);
      expect(calls.some(call => call.path === '/v1/fleet/setup/scan')).toBe(true);
      expect(view.container.textContent).toContain(
        'Claude Code isn’t installed on studio-mac. Ferretry can install it.',
      );
    } finally {
      await view.unmount();
    }
  });

  it('keeps the form and says so when the password is wrong, without a second failure note', async () => {
    const client = scriptedClient({
      '/v1/fleet/permissions': LOCKED,
      '/v1/grants/unlock': new FyHttpError('Wrong. 3 attempts remaining.', 403, 'grant_wrong_password'),
    });
    const view = await mount(element(client, spies()));
    try {
      await settle();
      await type(
        must(view.container.querySelector<HTMLInputElement>('[data-change-password]'), 'password'),
        'nope-nope-nope',
      );
      await click(view.container.querySelector('[data-change-submit]'), 'look');
      expect(view.container.querySelector('[data-change-refusal]')?.textContent).toContain('3 attempts remaining');
      expect(view.container.querySelector('[data-setup-note="scan-failed"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says it could not look when the scan cannot be read', async () => {
    const client = scriptedClient({ '/v1/fleet/permissions': permissions() });
    const view = await mount(element(client, spies()));
    try {
      await settle();
      const note = must(view.container.querySelector('[data-setup-note="scan-failed"]'), 'scan failure');
      expect(note.textContent).toContain('Couldn’t look at studio-mac');
      expect(note.textContent).toContain(
        'This machine didn’t answer, so nothing was changed. Check it is awake and try again.',
      );
      expect(view.container.querySelector('[data-install-flow]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('pauses on an offline machine and Retry asks again', async () => {
    const watch = spies();
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      '/v1/fleet/setup/scan': NOTHING_INSTALLED,
    });
    const view = await mount(element(client, watch, { online: false }));
    try {
      await settle();
      const paused = must(view.container.querySelector('[data-stepper-paused]'), 'paused note');
      expect(paused.textContent).toContain('studio-mac is asleep or offline');
      expect(paused.textContent).toContain('This is paused. Your progress is kept.');
      expect(view.container.querySelector('[data-install-flow]')).toBeNull();
      await click(view.container.querySelector('[data-stepper-retry]'), 'retry');
      expect(watch.retried).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });

  it('asks before leaving from Cancel and leaves straight away from Back', async () => {
    const watch = spies();
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      '/v1/fleet/setup/scan': NOTHING_INSTALLED,
    });
    const view = await mount(element(client, watch));
    try {
      await settle();
      await click(view.container.querySelector('[data-stepper-cancel]'), 'cancel');
      expect(view.container.querySelector('[data-stepper-confirm]')?.textContent).toContain('Stop installing?');
      expect(watch.left).toEqual([]);
      await click(view.container.querySelector('[data-stepper-keep]'), 'keep going');
      expect(view.container.querySelector('[data-stepper-confirm]')).toBeNull();
      await click(view.container.querySelector('[data-stepper-back]'), 'back');
      expect(watch.left).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });
});
