import { afterEach, describe, expect, it } from 'bun:test';
import type { HarnessUpdateStartRequest, HarnessUpdateView } from '@ferretry/protocol';
import {
  type AgentClisClient,
  AgentClisSurface,
  agentClisSettingsTab,
} from '../../../../src/features/settings/agent-clis.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { waitFor } from '../../../support/learning-dom.ts';
import { claudeCli, clisView, codexCli, VERIFIED_URL } from './agent-clis-support.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'device-a' });
const NOW = Date.parse('2026-10-20T12:00:00.000Z');

class HttpRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** A machine whose answers are queued; the last answer repeats. */
class FakeMachine implements AgentClisClient {
  readonly reads: (HarnessUpdateView | Error)[];
  readonly starts: HarnessUpdateStartRequest[] = [];
  startAnswers: (HarnessUpdateView | Error)[] = [];

  constructor(...reads: (HarnessUpdateView | Error)[]) {
    this.reads = reads;
  }

  /** Once set, every read after the first waits for `step`, so a test decides when a poll lands. */
  gated = false;
  private served = 0;
  private readonly parked: Array<() => void> = [];

  get parkedReads(): number {
    return this.parked.length;
  }

  step(): void {
    this.parked.shift()?.();
  }

  async harnessUpdate(): Promise<HarnessUpdateView> {
    if (this.gated && this.served > 0) await new Promise<void>(resolve => this.parked.push(resolve));
    this.served += 1;
    const next = this.reads.length > 1 ? this.reads.shift() : this.reads[0];
    if (next === undefined || next instanceof Error) throw next ?? new Error('no answer');
    return next;
  }

  async startHarnessUpdate(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> {
    this.starts.push(request);
    const next = this.startAnswers.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error('no answer');
    return next;
  }
}

const settle = async (ms = 10): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const show = async (machine: FakeMachine, pollMs = 5): Promise<HTMLElement> => {
  mounted = await mount(
    <AgentClisSurface
      connection={connection}
      createClient={async () => machine}
      pollMs={pollMs}
      clock={() => NOW}
      write={async () => undefined}
    />,
  );
  await settle();
  return mounted.container;
};

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const target = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => target.click());
  await settle();
};

const card = (container: HTMLElement, harness: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-agent-cli="${harness}"]`), `the ${harness} card`);

const running = (command: string) => ({ state: 'running', startedAt: '2026-10-20T12:00:00.000Z', command }) as const;
const finished = (outcome: 'succeeded' | 'failed', message: string) =>
  ({ state: 'finished', report: { outcome, message, finishedAt: '2026-10-20T12:01:00.000Z' } }) as const;

describe('AgentClisSurface', () => {
  it('shows each harness: the file that runs, how it was installed, what Ferretry verified, and the newest', async () => {
    const container = await show(new FakeMachine(clisView()));
    const claude = card(container, 'claude');
    expect(claude.querySelector('h4')?.textContent).toBe('Claude Code 2.1.200');
    expect(claude.querySelector('[data-agent-cli-verification]')?.textContent).toBe('Older than verified');
    expect(claude.getAttribute('data-agent-cli-method')).toBe('npm-global');
    const text = claude.textContent ?? '';
    expect(text).toContain('/home/kirin/.nvm/versions/node/v22/bin/claude');
    expect(text).toContain('inherited environment (PATH)');
    expect(text).toContain(
      'npm global package @anthropic-ai/claude-code in /home/kirin/.nvm/versions/node/v22 (node from nvm)',
    );
    expect(text).toContain('2.1.230 on npm, checked 2 minutes ago.');
    expect(text).toContain('If the new version does not start, the old one is put back.');
    expect(container.textContent).toContain('running ferrets keep their current version until they are restarted');
    expect(card(container, 'codex').textContent).toContain('keeps no previous version');
  });

  it('updates to the verified version with one press', async () => {
    const machine = new FakeMachine(
      clisView(),
      clisView(claudeCli({ job: finished('succeeded', 'Updated Claude Code 2.1.200 → 2.1.220.') })),
    );
    machine.startAnswers = [clisView(claudeCli({ job: running('npm install -g …') }), codexCli())];
    const container = await show(machine);
    await click(container, '[data-agent-cli-update="claude:verified"]');
    expect(machine.starts).toEqual([{ harness: 'claude', target: '2.1.220' }]);
    await settle(40);
    expect(card(container, 'claude').querySelector('[data-agent-cli-job]')?.textContent).toBe(
      'Updated Claude Code 2.1.200 → 2.1.220.',
    );
  });

  it('asks a second time before going past the verified version, with the known risks one tap away', async () => {
    const machine = new FakeMachine(clisView());
    machine.startAnswers = [clisView(codexCli({ job: running('brew update') }))];
    const container = await show(machine, 10_000);
    await click(container, '[data-agent-cli-update="codex:newest"]');
    expect(machine.starts).toEqual([]);
    const confirm = must(container.querySelector<HTMLElement>('[data-agent-cli-confirm="codex"]'), 'the confirm');
    expect(confirm.textContent).toContain('Ferretry cannot tell which Codex version this installs');
    expect(confirm.querySelector('a')?.getAttribute('href')).toBe(VERIFIED_URL);
    await click(container, '[data-agent-cli-confirm-yes]');
    expect(machine.starts).toEqual([{ harness: 'codex', confirmUnverified: true }]);
    expect(container.querySelector('[data-agent-cli-confirm]')).toBeNull();
    expect(card(container, 'codex').querySelector('[data-agent-cli-job]')?.textContent).toBe(
      'Updating — running brew update',
    );
  });

  it('cancels the second question without sending anything', async () => {
    const machine = new FakeMachine(clisView());
    const container = await show(machine);
    await click(container, '[data-agent-cli-update="claude:latest"]');
    expect(container.querySelector('[data-agent-cli-confirm="claude"]')?.textContent).toContain(
      'Claude Code 2.1.230 has not been verified by Ferretry yet.',
    );
    const cancel = must(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel'),
      'Cancel',
    );
    await interact(() => cancel.click());
    expect(container.querySelector('[data-agent-cli-confirm]')).toBeNull();
    expect(machine.starts).toEqual([]);
  });

  it('turns the daemon’s own unverified refusal into the same question, and says any other refusal', async () => {
    const machine = new FakeMachine(clisView());
    machine.startAnswers = [
      new HttpRefusal('not verified', 409, 'harness_update_unverified', {
        error: 'not verified',
        code: 'harness_update_unverified',
        target: '2.1.221',
        verified: '2.1.220',
      }),
      new HttpRefusal('Claude Code is already being updated', 409, 'harness_update_in_progress'),
      new HttpRefusal('not verified', 409, 'harness_update_unverified', {
        error: 'not verified',
        code: 'harness_update_unverified',
        verified: '2.1.220',
      }),
    ];
    const container = await show(machine);
    await click(container, '[data-agent-cli-update="claude:verified"]');
    expect(container.querySelector('[data-agent-cli-confirm="claude"]')?.textContent).toContain('Claude Code 2.1.221');
    await click(container, '[data-agent-cli-confirm-yes]');
    expect(machine.starts.at(-1)).toEqual({ harness: 'claude', target: '2.1.221', confirmUnverified: true });
    expect(card(container, 'claude').querySelector('[data-agent-cli-error]')?.textContent).toBe(
      'Claude Code is already being updated',
    );
    await click(container, '[data-agent-cli-update="claude:verified"]');
    expect(container.querySelector('[data-agent-cli-confirm="claude"]')?.textContent).toContain('cannot tell which');
  });

  it('keeps the last view while a poll fails, and confirms nothing that is not pending', async () => {
    const machine = new FakeMachine(
      clisView(claudeCli({ job: running('npm') })),
      new Error('blip'),
      clisView(claudeCli({ job: finished('failed', 'npm stopped.') })),
    );
    machine.gated = true;
    const container = await show(machine);
    const job = (): string | undefined => card(container, 'claude').querySelector('[data-agent-cli-job]')?.textContent;
    expect(job()).toBe('Updating — running npm');

    await waitFor(() => machine.parkedReads === 1, 'the first poll to be asked');
    await interact(async () => machine.step());
    await waitFor(() => machine.parkedReads === 1, 'the next poll to be asked after the failed one');
    expect(job()).toBe('Updating — running npm');

    await interact(async () => machine.step());
    await waitFor(() => job() === 'npm stopped.', 'the finished view on screen');
  });

  it('draws the steps for a method Ferretry cannot update, an unreadable version, an unverified one and a missing harness', async () => {
    const container = await show(
      new FakeMachine(
        clisView(
          claudeCli({
            method: { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
            plan: {
              kind: 'manual',
              explanation: 'Claude Code comes from your home-manager configuration.',
              steps: [
                {
                  command: 'nix flake update nixpkgs',
                  note: 'in the flake that holds your home-manager configuration',
                },
                { command: 'darwin-rebuild switch --flake .' },
              ],
            },
            installed: { state: 'unreadable', reason: 'it did not answer within 20 seconds' },
            verification: 'unknown',
          }),
          codexCli({
            installed: { state: 'ok', version: '0.163.0' },
            verification: 'unverified',
            available: false,
            plan: { kind: 'manual', explanation: 'Ferretry cannot update Codex here: odd.', steps: [] },
          }),
          codexCli({
            location: { state: 'absent', searched: ['/opt/bin'] },
            method: null,
            plan: null,
            installed: null,
            available: false,
          }),
        ),
      ),
    );
    const claude = card(container, 'claude');
    expect(claude.querySelector('[data-agent-cli-plan="manual"]')?.textContent).toContain(
      'home-manager configuration.',
    );
    expect(claude.querySelectorAll('[data-agent-cli-plan="manual"] li').length).toBe(2);
    expect(claude.textContent).toContain('unreadable — it did not answer within 20 seconds');
    expect(claude.querySelector('[data-agent-cli-verification]')?.textContent).toBe('Version unknown');
    const [unverified, missing] = [...container.querySelectorAll<HTMLElement>('[data-agent-cli="codex"]')];
    expect(unverified?.querySelector('[data-agent-cli-unverified-note]')?.textContent).toContain(
      'newer than the one Ferretry verified',
    );
    expect(unverified?.querySelector('[data-agent-cli-plan="manual"] ol')).toBeNull();
    expect(missing?.textContent).toContain('Not found');
    expect(missing?.textContent).toContain('Not found on this daemon’s PATH or in /opt/bin.');
    expect(missing?.querySelector('[data-agent-cli-plan]')).toBeNull();
  });

  it('shows no Update button when nothing is newer', async () => {
    const container = await show(new FakeMachine(clisView(claudeCli({ available: false }))));
    expect(container.querySelector('[data-agent-cli-update]')).toBeNull();
    expect(container.querySelector('[data-agent-cli-available]')).toBeNull();
  });

  it('tells an older machine apart from a failed read', async () => {
    let container = await show(new FakeMachine(new HttpRefusal('unknown route', 404, 'unknown_route')));
    expect(container.querySelector('[data-agent-clis-missing]')).not.toBeNull();
    await mounted?.unmount();
    container = await show(new FakeMachine(new Error('the relay is down')));
    expect(container.textContent).toContain('could not read which agent CLIs this machine runs: the relay is down');
  });

  it('says it is reading until the machine answers', async () => {
    mounted = await mount(
      <AgentClisSurface connection={connection} createClient={() => new Promise(() => undefined)} />,
    );
    expect(mounted.container.textContent).toContain('checking for newer ones');
  });

  it('mounts as a Settings › Machine panel', async () => {
    const tab = agentClisSettingsTab(async () => new FakeMachine(clisView()));
    expect(tab.id).toBe('agent-clis');
    const Surface = tab.Surface;
    mounted = await mount(<Surface connection={connection} />);
    await settle();
    expect(mounted.container.textContent).toContain('Agent CLIs');
  });
});
