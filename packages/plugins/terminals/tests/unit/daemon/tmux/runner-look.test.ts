import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { InputHolds, Redaction } from '@ferretry/kernel/contract';
import { type ActRecord, testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures');
/** A value the Vault knows, drawn on the pane inside the command a permission prompt asks about. */
const SECRET = 'sk-live-u4look';
const PERMISSION = readFileSync(join(FIXTURES, 'permission-prompts/claude-2.1.281-bash.txt'), 'utf8').replaceAll(
  'https://example.com',
  `https://example.com/?key=${SECRET}`,
);
const NOW = '2026-11-08T10:00:00.000Z';
const NOW_SECONDS = Date.parse(NOW) / 1_000;

/** A pane in memory, read through the runner's own tmux questions: what it shows and every question asked of it. */
function subject(options: { readonly session?: string; readonly watched?: boolean } = {}) {
  const handle = '%7' as RunnerHandle;
  const calls: (readonly string[])[] = [];
  const acts: ActRecord[] = [];
  let screen = PERMISSION;
  let activityAt = NOW_SECONDS - 5;
  let dead = false;
  let held = false;
  const holds: InputHolds = { decide: () => (held ? { refused: 'input_pending' } : 'allow') };
  const masked: string[] = [];
  const redaction: Redaction = {
    read: async fn =>
      await fn({
        text: text => {
          const out = text.replaceAll(SECRET, '*'.repeat(SECRET.length));
          masked.push(out);
          return out;
        },
        cells: cells => cells,
        lines: lines => lines,
      }),
  };
  const runner = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        const format = args.at(-1) ?? '';
        if (args[0] === 'display-message' && format.startsWith('#{pane_id}|'))
          return {
            code: 0,
            stdout: `%7|4242|${dead ? 1 : 0}|${options.session ?? 'fy-f-hadi'}|1000\n`,
            stderr: '',
          };
        if (args[0] === 'display-message')
          return { code: 0, stdout: `${dead ? 1 : 0}||1|22|40|120|${activityAt}|0|%7|4242\n`, stderr: '' };
        if (args[0] === 'capture-pane') return { code: 0, stdout: screen, stderr: '' };
        if (args[0] === 'send-keys' || args[0] === 'kill-session') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`a look must not run ${args[0]}`);
      },
    },
    spawn: {
      run: async () => {
        throw new Error('a look must not spawn');
      },
      runBytes: () => Promise.reject(new Error('a look must not spawn')),
      start: () => {
        throw new Error('a look must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => NOW as never,
    now: () => NOW as never,
    ...(options.watched === false
      ? {}
      : {
          look: {
            act: testActRunner({
              holds: () => holds,
              actor: () => 'ferret',
              minted: new TestMintedIds(),
              record: act => acts.push(act),
            }),
            redaction,
            digest: text => `digest:${text.length}:${text.includes(SECRET) ? 'raw' : 'masked'}`,
          },
        }),
  });
  return {
    runner,
    handle,
    calls,
    acts,
    masked,
    captures: () => calls.filter(call => call[0] === 'capture-pane').length,
    redraw: (next: string) => {
      screen = next;
      activityAt = NOW_SECONDS - 1;
    },
    die: () => {
      dead = true;
    },
    hold: () => {
      held = true;
    },
  };
}

describe('TmuxRunner.look (U4, the turn watch read)', () => {
  it('#U4 look reads the exact pane inside one read act and masks the screen before it is parsed', async () => {
    // Arrange
    const pane = subject();

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert: one act, the read op, on the pane id itself.
    should(pane.acts.map(act => [act.target, act.op, act.outcome])).deepEqual([
      [{ kind: 'terminal', key: '%7' }, 'read', 'ran'],
    ]);
    should(look?.permission).be.true();
    should(look?.request).be.ok();
    should(look?.frame).equal(`digest:${PERMISSION.length}:masked`);
    // Nothing of the secret leaves, in any field.
    should(JSON.stringify(look)).not.containEql(SECRET);
    should(JSON.stringify(look)).containEql('*'.repeat(SECRET.length));
    // Every tmux question named the pane by its id.
    should(pane.calls.every(call => call.includes('%7'))).be.true();
  });

  it('#U4 look under a Vault hold reads nothing: no tmux question, no capture, no answer', async () => {
    // Arrange
    const pane = subject();
    pane.hold();

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert
    should(look).be.undefined();
    should(pane.calls).deepEqual([]);
    should(pane.acts.map(act => act.outcome)).deepEqual([{ refused: 'input_pending' }]);
  });

  it('should ask one question and capture nothing again while the frame is unchanged, and capture when it moved', async () => {
    // Arrange
    const pane = subject();
    await pane.runner.look(pane.handle);

    // Act
    const same = await pane.runner.look(pane.handle);
    const capturesWhileUnchanged = pane.captures();
    pane.redraw('  ✻ Working… (3s · esc to interrupt)\n');
    const moved = await pane.runner.look(pane.handle);

    // Assert
    should(capturesWhileUnchanged).equal(1);
    should(pane.captures()).equal(2);
    should(same?.frame).equal(`digest:${PERMISSION.length}:masked`);
    should(moved?.working).be.true();
    should(moved?.frame).not.equal(same?.frame);
    // An unchanged frame is masked again on every look: a value the Vault learns later is still masked.
    should(pane.masked).have.length(3);
  });

  it('should keep no pane text after a stop, polite or not: the next look captures the screen again', async () => {
    // Arrange
    const pane = subject();
    await pane.runner.look(pane.handle);

    // Act
    await pane.runner.stop(pane.handle, 'polite');
    await pane.runner.look(pane.handle);
    const afterPolite = pane.captures();
    await pane.runner.stop(pane.handle, 'now');
    await pane.runner.look(pane.handle);

    // Assert: an unchanged frame would have been served from memory; a stop forgot it.
    should(afterPolite).equal(2);
    should(pane.captures()).equal(3);
  });

  it('should never read a pane that is not a ferret’s own (a person’s shell)', async () => {
    // Arrange
    const pane = subject({ session: 'fy-webterm-abc' });

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert
    should(look).be.undefined();
    should(pane.captures()).equal(0);
  });

  it('should answer nothing for a dead pane, a handle that is not a pane id, or a runner with no watch', async () => {
    // Arrange
    const dead = subject();
    dead.die();
    const unwatched = subject({ watched: false });

    // Act
    const answers = [
      await dead.runner.look(dead.handle),
      await dead.runner.look('fy-f-hadi' as RunnerHandle),
      await unwatched.runner.look(unwatched.handle),
    ];

    // Assert
    should(answers).deepEqual([undefined, undefined, undefined]);
    should(dead.captures()).equal(0);
    should(unwatched.calls).deepEqual([]);
  });
});
