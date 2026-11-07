import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  FileSessionEnvironmentStore,
  TmuxPaneDelivery,
  TmuxResumeLauncher,
  TmuxSessionLifecycleLauncher,
} from '../../../../src/adapters/index.ts';
import {
  createSessionRecord,
  defaultSessionLifecycleSettings,
  LaunchEnvironmentStore,
  parseSessionId,
  type SessionId,
  type TmuxCommandPort,
  TmuxController,
} from '../../../../src/lib/index.ts';

/**
 * EVERY LAUNCH PATH HANDS A FERRET THE SWITCHES ITS RECORD SAYS. There are exactly two pane launches:
 * the first launch — which a start, a fork, a Pack sub-ferret and an imported or continued conversation
 * all reach through the lifecycle — and the relaunch, which a Restart, a same-harness migration, a
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

/** A tmux server that answers just enough of the vocabulary for a launch and records each `new-session`. */
class LaunchRecordingTmux implements TmuxCommandPort {
  readonly launches: Array<readonly string[]> = [];
  alive = false;

  async execute(argv: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const command = argv[0];
    if (command === 'has-session')
      return { stdout: '', stderr: this.alive ? '' : 'no such session', code: this.alive ? 0 : 1 };
    if (command === 'new-session') {
      this.launches.push(argv);
      this.alive = true;
    }
    if (command === 'kill-session') this.alive = false;
    if (command === 'display-message') return { stdout: '0||0|1|24|80\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  }
}

/** The `-e NAME=VALUE` pairs one `new-session` handed the pane. */
function paneEnvironment(argv: readonly string[]): Readonly<Record<string, string>> {
  const pairs: Array<[string, string]> = [];
  argv.forEach((value, index) => {
    const next = argv[index + 1];
    if (value !== '-e' || next === undefined) return;
    const at = next.indexOf('=');
    pairs.push([next.slice(0, at), next.slice(at + 1)]);
  });
  return Object.fromEntries(pairs);
}

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
  const controller = new TmuxController(tmux);
  const delivery = new TmuxPaneDelivery(controller, async () => undefined);
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
    subject.tmux.alive = false;
    await subject.relaunch.relaunch(subject.id);

    // Assert
    const [launched, relaunched] = subject.tmux.launches.map(paneEnvironment);
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
    off.tmux.alive = false;
    await off.relaunch.relaunch(off.id);
    await on.first.launch(on.record);
    on.tmux.alive = false;
    await on.relaunch.relaunch(on.id);

    // Assert
    for (const argv of off.tmux.launches)
      should(switches(paneEnvironment(argv))).deepEqual({ FY_HYPERMEDIA: '0', FY_PACK: '0' });
    for (const argv of on.tmux.launches)
      should(switches(paneEnvironment(argv))).deepEqual({ FY_HYPERMEDIA: '1', FY_PACK: '1' });
  });
});
