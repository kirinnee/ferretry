import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess } from '../../../src/adapters/index.ts';
import {
  SttyTerminalModes,
  TmuxInputTarget,
  type ProgramRunner,
  type TerminalLocator,
  type TmuxCommandPort,
} from '../../../src/lib/index.ts';
import { waitFor, waitForValue } from '../support/wait-for.ts';

/**
 * The write guard's `if-shell -F` syntax, run by a REAL tmux. The unit tests evaluate the condition with a
 * fake; this proves tmux accepts the command, evaluates the comparisons, runs the right branch and that the
 * hex bytes arrive. It is compare-and-ENQUEUE: it says nothing about who reads the bytes afterwards.
 */

const SESSION = 'fy-webterm-Hadi-0a1b2c3d-abc123abc123';
const PANE = `${SESSION}:0.0`;
const VALUE = 'hunter2-UNIQUE';

const run: ProgramRunner = async argv => {
  const [command = '', ...rest] = argv;
  const child = Bun.spawn([command, ...rest], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output : undefined;
};

async function fixture() {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux is required for input guard coverage');
  const home = await mkdtemp(join(tmpdir(), 'fy-input-guard-'));
  const sink = join(home, 'typed.txt');
  const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
  // A pane whose foreground program is `cat` with echo off: it writes whatever reaches it to a file.
  const started = await tmux.execute([
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '80',
    '-y',
    '24',
    '-c',
    home,
    `stty -echo; exec cat > '${sink}'`,
  ]);
  if (started.code !== 0) throw new Error(`could not start the pane: ${started.stderr}`);
  await waitFor(
    async () =>
      (await tmux.execute(['display-message', '-p', '-t', PANE, '#{pane_current_command}'])).stdout.trim() === 'cat',
    'the pane to run cat',
  );
  const locator: TerminalLocator = { locate: async () => ({ tmuxSession: SESSION }) };
  const subject = (port: TmuxCommandPort) =>
    new TmuxInputTarget(port, locator, new SttyTerminalModes(process.platform, run), run);
  const typed = async (): Promise<string> => await readFile(sink, 'utf8').catch(() => '');
  const done = async () => {
    await tmux.execute(['kill-server']).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  };
  return { tmux, subject, typed, done };
}

const dev = { kind: 'terminal', key: 'dev' } as const;

describe('the input write guard against the real tmux', () => {
  it('should type the value and its Enter through the guarded if-shell when the pane is as it was observed', async () => {
    const { tmux, subject, typed, done } = await fixture();
    try {
      const target = subject(tmux);
      const observed = await target.observe('s1', dev);
      if (!observed.ok) throw new Error(`could not observe the pane: ${observed.reason}`);

      const outcome = await target.type('s1', dev, VALUE, true, observed.facts);

      should(outcome).equal('typed');
      should(await waitForValue(async () => ((await typed()) === '' ? undefined : await typed()), 'the bytes')).equal(
        `${VALUE}\n`,
      );
    } finally {
      await done();
    }
  });

  it('should type nothing and answer target_changed when tmux evaluates a mismatching condition', async () => {
    const { tmux, subject, typed, done } = await fixture();
    try {
      // The pane's shell pid in the condition is wrong by the time tmux evaluates it.
      const stale: TmuxCommandPort = {
        execute: async (args, stdin) =>
          await tmux.execute(
            args[0] === 'if-shell'
              ? args.map(arg => arg.replace(/(pane_pid\},)\d+/u, (_match, head: string) => `${head}1`))
              : args,
            stdin,
          ),
      };
      const target = subject(stale);
      const observed = await target.observe('s1', dev);
      if (!observed.ok) throw new Error(`could not observe the pane: ${observed.reason}`);

      const refused = await target.type('s1', dev, VALUE, true, observed.facts);
      // A later, honest write is the barrier: whatever the refused one queued would be in front of it.
      const barrier = await subject(tmux).type('s1', dev, 'after', true, observed.facts);

      should(refused).equal('target_changed');
      should(barrier).equal('typed');
      should(await waitForValue(async () => ((await typed()) === '' ? undefined : await typed()), 'the bytes')).equal(
        'after\n',
      );
    } finally {
      await done();
    }
  });
});
