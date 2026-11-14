import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';

import { SttyTerminalModes, type ProgramRunner } from '../../../../daemon/lib/inputs/terminal-modes.ts';
import { TmuxInputTarget, type TerminalLocator } from '../../../../daemon/lib/inputs/terminal-target.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor, waitForValue } from '../support/wait-for.ts';

/**
 * A SEALED PASTE INTO THE PRODUCTION TERMINAL TARGET, against a REAL tmux (secure-clip-2 fix round 2, item 8). The unit tests
 * drive `TmuxInputTarget.type` over a fake tmux; this runs the same code over the real one, on the disposable socket and the
 * `cat > file` pane the write-guard integration test uses (`tmux-input-guard.test.ts`), and proves, with the Vault's protection
 * seam (`TypeOptions.protect`) observed from the pane itself:
 *   - the protection is installed BEFORE tmux is asked to type: when it runs, the pane's sink holds no byte and tmux was asked
 *     for nothing but its looks;
 *   - a protection that cannot be installed types NOTHING (the sink stays empty);
 *   - a check that refuses (the copy ended, a person took over) runs BEFORE the protection and types nothing;
 *   - a write that fails before tmux is told, or whose answer is lost after it was, leaves the protection installed (it is never
 *     taken back: bytes may have landed) and is reported `uncertain`, never `typed`.
 * It does not compose the Vault's masking registry or Accounts (another package is reached only through its contract), so the
 * masking itself past expiry, the cap and the MCP serialisation are proved in the composed host tier, with a recording terminal.
 */

const SESSION = 'fy-webterm-Hadi-0a1b2c3d-abc123abc123';
const PANE = `${SESSION}:0.0`;
const VALUE = 'FAKE-SC-7f3a91';
const dev = { kind: 'terminal', key: 'dev' } as const;

const run: ProgramRunner = async argv => {
  const [command = '', ...rest] = argv;
  const child = Bun.spawn([command, ...rest], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output : undefined;
};

/** The real tmux, with a record of what it was asked and a way to fail the typed write at either end. */
class SpyTmux extends BunTmuxProcess {
  readonly asked: string[] = [];
  mode: 'normal' | 'fail-before-send' | 'fail-after-send' = 'normal';
  override async execute(args: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    this.asked.push(args[0] ?? '');
    if (args[0] !== 'if-shell') return await super.execute(args, stdin);
    if (this.mode === 'fail-before-send') throw new Error('tmux is gone');
    const answer = await super.execute(args, stdin);
    if (this.mode === 'fail-after-send') throw new Error('the answer was lost');
    return answer;
  }
}

async function fixture() {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux is required for sealed paste coverage');
  const home = await mkdtemp(join(tmpdir(), 'fy-sealed-paste-'));
  const sink = join(home, 'typed.txt');
  const tmux = new SpyTmux(executable, join(home, 'tmux.sock'));
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
  const target = new TmuxInputTarget(
    tmux as TmuxCommandPort,
    locator,
    new SttyTerminalModes(process.platform, run),
    run,
  );
  const typed = async (): Promise<string> => await readFile(sink, 'utf8').catch(() => '');
  const done = async () => {
    // This file's own server, by its own socket.
    await tmux.execute(['kill-server']).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  };
  const observed = await target.observe('s1', dev);
  if (!observed.ok) throw new Error(`could not observe the pane: ${observed.reason}`);
  return { tmux, target, typed, done, facts: observed.facts };
}

/** A later, honest write is the barrier: whatever an earlier one queued in tmux would be in front of it. */
async function barrierBytes(world: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  world.tmux.mode = 'normal';
  const outcome = await world.target.type('s1', dev, 'after', true, world.facts);
  if (outcome !== 'typed') throw new Error(`the barrier write was ${outcome}`);
  return await waitForValue(async () => {
    const text = await world.typed();
    return text.endsWith('after\n') ? text : undefined;
  }, 'the barrier bytes');
}

describe('a sealed paste into the production terminal target, against the real tmux', () => {
  it('should install the protection BEFORE tmux is asked to type, then type the value', async () => {
    const world = await fixture();
    try {
      const seen: { asked: string[] }[] = [];
      const outcome = await world.target.type('s1', dev, VALUE, true, world.facts, {
        protect: () => {
          // Synchronous, inside the target's turn: tmux has been asked for its looks only, and for no write.
          seen.push({ asked: [...world.tmux.asked] });
        },
      });

      should(outcome).equal('typed');
      should(seen).have.length(1);
      should(seen[0]?.asked.includes('if-shell')).equal(false);
      // The pane's own sink shows the bytes arrived, after the protection.
      should(
        await waitForValue(async () => ((await world.typed()) === '' ? undefined : await world.typed()), 'the bytes'),
      ).equal(`${VALUE}\n`);
      should(world.tmux.asked.includes('if-shell')).equal(true);
    } finally {
      await world.done();
    }
  });

  it('should type NOTHING when the protection cannot be installed', async () => {
    const world = await fixture();
    try {
      const outcome = await world.target
        .type('s1', dev, VALUE, true, world.facts, {
          protect: () => {
            throw new Error('cannot keep it masked');
          },
        })
        .catch(() => 'threw');
      const after = await barrierBytes(world);

      // Whatever the outcome's spelling, no byte of the value reached the pane: only the barrier did.
      should(['threw', 'target_gone', 'uncertain']).containEql(outcome);
      should(after).equal('after\n');
    } finally {
      await world.done();
    }
  });

  it('should run a refusing check BEFORE the protection and type nothing', async () => {
    const world = await fixture();
    try {
      let protectAsked = 0;
      const outcome = await world.target.type('s1', dev, VALUE, true, world.facts, {
        refuse: async () => 'the copy ended before it could be typed',
        protect: () => {
          protectAsked += 1;
        },
      });
      const after = await barrierBytes(world);

      should(outcome).equal('guard_refused');
      should(protectAsked).equal(0);
      should(after).equal('after\n');
    } finally {
      await world.done();
    }
  });

  it('should keep the protection installed, and say uncertain, when the write fails before tmux was told', async () => {
    const world = await fixture();
    try {
      let protectAsked = 0;
      world.tmux.mode = 'fail-before-send';
      const outcome = await world.target.type('s1', dev, VALUE, true, world.facts, {
        protect: () => {
          protectAsked += 1;
        },
      });
      const after = await barrierBytes(world);

      should(outcome).equal('uncertain');
      // The protection was installed first and nothing took it back.
      should(protectAsked).equal(1);
      should(after).equal('after\n');
    } finally {
      await world.done();
    }
  });

  it('should keep the protection installed, and say uncertain, when the answer is lost AFTER tmux typed the value', async () => {
    const world = await fixture();
    try {
      let protectAsked = 0;
      world.tmux.mode = 'fail-after-send';
      const outcome = await world.target.type('s1', dev, VALUE, true, world.facts, {
        protect: () => {
          protectAsked += 1;
        },
      });
      world.tmux.mode = 'normal';
      // The value really did land (the answer was lost, not the bytes): the protection had to be there already.
      const landed = await waitForValue(async () => {
        const text = await world.typed();
        return text.includes(VALUE) ? text : undefined;
      }, 'the value in the pane');

      should(outcome).equal('uncertain');
      should(protectAsked).equal(1);
      should(landed).equal(`${VALUE}\n`);
    } finally {
      await world.done();
    }
  });
});
