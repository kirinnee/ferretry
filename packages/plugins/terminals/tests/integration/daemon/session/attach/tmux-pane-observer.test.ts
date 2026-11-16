import { afterEach, describe, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { TmuxPaneObserver } from '../../../../../daemon/adapters/session/attach/tmux-pane-observer.ts';
import { processIncarnationFor } from '../../../../../daemon/adapters/session/processes/process-incarnation.ts';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

const incarnation = processIncarnationFor(process.platform, bunSpawn({ PATH: '/usr/bin:/bin' }));

/** A private tmux server whose panes are exactly `panes`, by session. */
const tmuxHolding = (panes: Readonly<Record<string, { readonly paneId: string; readonly pid: number }>>) => ({
  paneIdentity: async (session: string) => panes[session],
});

describe('TmuxPaneObserver', () => {
  it('should name the whole incarnation of the live process behind a recorded pane', async () => {
    // Arrange
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;
    const subject = new TmuxPaneObserver(tmuxHolding({ 'fy-a': { paneId: '%7', pid } }), incarnation);

    // Act
    const actual = await subject.observe({ tmuxSession: 'fy-a', paneId: '%7', pid, processStartTicks: 1 });

    // Assert
    should(actual?.tmuxSession).equal('fy-a');
    should(actual?.paneId).equal('%7');
    should(actual?.pid).equal(pid);
    should(actual?.processStartTicks).equal(await incarnation.startOf(pid));
  });

  it('should see nothing when the private server no longer holds the recorded session', async () => {
    // Arrange
    const subject = new TmuxPaneObserver(tmuxHolding({}), incarnation);

    // Act
    const actual = await subject.observe({ tmuxSession: 'fy-gone', paneId: '%1', pid: 1, processStartTicks: 1 });

    // Assert
    should(actual).be.undefined();
  });

  it('should see nothing when the pane names a process that has already exited', async () => {
    // Arrange
    const child = spawn('true', [], { stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const pid = child.pid as number;
    await exited;
    const subject = new TmuxPaneObserver(tmuxHolding({ 'fy-dead': { paneId: '%2', pid } }), incarnation);

    // Act
    const actual = await subject.observe({ tmuxSession: 'fy-dead', paneId: '%2', pid, processStartTicks: 1 });

    // Assert
    should(actual).be.undefined();
  });
});
