import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSessionEnvironmentStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-environment-store.ts';
import { TmuxResumeLauncher } from '../../../../../daemon/adapters/session/resume/tmux-resume-launcher.ts';
import { TmuxSessionLifecycleLauncher } from '../../../../../daemon/adapters/session/lifecycle/tmux-session-lifecycle-launcher.ts';
import { createSessionRecord } from '../../../../../daemon/lib/session/lifecycle/policy.ts';
import { defaultSessionLifecycleSettings } from '../../../../../daemon/lib/session/lifecycle/settings.ts';
import { LaunchEnvironmentStore } from '../../../../../daemon/lib/session/lifecycle/launch-environment.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import type {
  TmuxController,
  TmuxLaunch,
  TmuxPaneDelivery,
} from '../../../../../daemon/lib/session/peers/tmux-lifecycle.ts';

/**
 * EVERY LAUNCH PATH HANDS A FERRET THE SWITCHES ITS RECORD SAYS. There are exactly two pane launches:
 * the first launch — which a start, a fork, a Pack sub-ferret and an imported or continued conversation
 * all reach through the lifecycle — and the relaunch, which a Restart, a same-harness move, a
 * revive and a resume all reach through the resume service. Both read the session's mode from its
 * record and its environment through one `LaunchEnvironmentStore`, so these cases pin both halves for
 * an interactive and an unattended ferret, including one started before Pack mode existed.
 */

const homes = new Set<string>();
const NOW = '2026-10-20T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-kirin';

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

/**
 * The terminals plugin's controller as the launchers see it (the injected `TmuxController` port): it records the
 * environment each launch hands its pane — what today's real controller turned into `new-session -e NAME=VALUE`.
 */
class LaunchRecordingTmux implements TmuxController {
  readonly launches: Array<Readonly<Record<string, string>>> = [];
  running = false;

  async alive(): Promise<boolean> {
    return this.running;
  }

  async launch(launch: TmuxLaunch): Promise<void> {
    this.launches.push(launch.env ?? {});
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async state() {
    return { alive: this.running, dead: false, promptReady: true, history: '', visible: '' };
  }

  async paneIdentities() {
    return undefined;
  }

  async paneIdentity() {
    return undefined;
  }

  async paneSighting() {
    return undefined;
  }

  async killPaneExact(): Promise<void> {}
}

/** Delivery is never reached by a bare launch; any call fails the case loudly. */
const NO_DELIVERY: TmuxPaneDelivery = {
  waitReady: async () => {
    throw new Error('a launch must not wait on the pane here');
  },
  deliver: async () => {
    throw new Error('a launch must not deliver here');
  },
  waitStartupSettled: async () => {
    throw new Error('a launch must not wait on startup here');
  },
};

const SWITCHES = ['FY_HYPERMEDIA', 'FY_PACK'] as const;
const switches = (env: Readonly<Record<string, string>>) => Object.fromEntries(SWITCHES.map(name => [name, env[name]]));

async function fixture(mode: 'auto' | 'interactive', stored: Readonly<Record<string, string>>) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-launch-switches-'));
  homes.add(home);
  const id = parseSessionId(`session-${mode}`);
  const files = new FileSessionEnvironmentStore(session => join(home, session));
  await files.write(id, stored);
  // What Pack mode's hooks derive from this record: a top-level ferret, machine switch on.
  const environments = new LaunchEnvironmentStore(files, async () => ({ FY_PACK: '1' }));
  const record = createSessionRecord(
    { agent: AGENT, cwd: '/workspace/project', mode, ...(mode === 'auto' ? { prompt: 'work' } : {}) },
    { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
  const tmux = new LaunchRecordingTmux();
  const controller = tmux;
  const delivery = NO_DELIVERY;
  const first = new TmuxSessionLifecycleLauncher(controller, delivery, environments);
  const relaunch = new TmuxResumeLauncher(
    controller,
    async (_session: SessionId) => ({
      tmuxSession: record.config.tmuxSession,
      cwd: record.config.cwd,
      command: record.config.command,
      env: await environments.read(id),
      agent: record.config.agent,
      mode: record.config.mode,
    }),
    delivery,
  );
  return { id, record, tmux, first, relaunch };
}

describe('the switches every launch path hands a ferret', () => {
  it.each([
    ['interactive', { FY_HYPERMEDIA: '1', FY_PACK: '1' }],
    ['auto', { FY_HYPERMEDIA: '0', FY_PACK: '1' }],
  ] as const)('should launch and relaunch an %s ferret started before Pack mode with %j', async (mode, expected) => {
    // Arrange — nothing stored but the mode: the state every ferret older than these switches is in.
    const subject = await fixture(mode, { FY_SESSION_MODE: mode });

    // Act — the first launch, then the pane dies and the session is relaunched into it.
    await subject.first.launch(subject.record);
    subject.tmux.running = false;
    await subject.relaunch.relaunch(subject.id);

    // Assert
    const [launched, relaunched] = subject.tmux.launches;
    should(subject.tmux.launches).have.length(2);
    should(switches(launched ?? {})).deepEqual(expected);
    should(switches(relaunched ?? {})).deepEqual(expected);
    should(relaunched?.FY_SESSION_MODE).equal(mode);
  });

  it("should keep the owner's stored switches on every launch, in either direction", async () => {
    // Arrange — an interactive ferret the owner switched off, and an auto one switched on.
    const off = await fixture('interactive', { FY_HYPERMEDIA: '0', FY_PACK: '0' });
    const on = await fixture('auto', { FY_HYPERMEDIA: '1' });

    // Act
    await off.first.launch(off.record);
    off.tmux.running = false;
    await off.relaunch.relaunch(off.id);
    await on.first.launch(on.record);
    on.tmux.running = false;
    await on.relaunch.relaunch(on.id);

    // Assert
    for (const env of off.tmux.launches)
      should(switches(env)).deepEqual({ FY_HYPERMEDIA: '0', FY_PACK: '0' });
    for (const env of on.tmux.launches)
      should(switches(env)).deepEqual({ FY_HYPERMEDIA: '1', FY_PACK: '1' });
  });
});
