import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { InputHolds, Redaction } from '@ferretry/kernel/contract';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
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
function subject(
  options: {
    readonly session?: string;
    readonly watched?: boolean;
    readonly redaction?: Redaction;
    readonly screen?: string;
  } = {},
) {
  const handle = '%7' as RunnerHandle;
  const calls: (readonly string[])[] = [];
  const acts: ActRecord[] = [];
  let screen = options.screen ?? PERMISSION;
  let activityAt = NOW_SECONDS - 5;
  let dead = false;
  let held = false;
  /** The next tmux question of each kind waits for its release (`facts`: the pane-facts question). */
  const gates = new Map<'capture-pane' | 'facts', Promise<void>>();
  const gate = async (kind: 'capture-pane' | 'facts') => {
    const waiting = gates.get(kind);
    gates.delete(kind);
    await waiting;
  };
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
        if (args[0] === 'display-message' && format.startsWith('#{pane_id}|')) {
          await gate('facts');
          return {
            code: 0,
            stdout: `%7|4242|${dead ? 1 : 0}|${options.session ?? 'fy-f-hadi'}|1000\n`,
            stderr: '',
          };
        }
        if (args[0] === 'display-message')
          return { code: 0, stdout: `${dead ? 1 : 0}||1|22|40|120|${activityAt}|0|%7|4242\n`, stderr: '' };
        if (args[0] === 'capture-pane') {
          await gate('capture-pane');
          return { code: 0, stdout: screen, stderr: '' };
        }
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
            redaction: options.redaction ?? redaction,
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
    /** Holds the next question of that kind until the answer is called. */
    holdNext: (kind: 'capture-pane' | 'facts') => {
      let release = () => {};
      gates.set(kind, new Promise<void>(resolve => (release = resolve)));
      return () => release();
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

  it('#U4 look masks a value wrapped across two pane rows in both rows before the screen is parsed', async () => {
    // Arrange: capture-pane (no -J) splits the 40-character token printed at column 60 of an 80-column row.
    const token = 'ghp_FAKELOOKwrapAAAABBBBCCCCDDDDEEEE1234';
    const [head, tail] = [token.slice(0, 20), token.slice(20)];
    const pane = subject({
      // The Vault's own conformance fake: `text` masks within a row only, `lines` matches the rows as one run.
      redaction: new FakeRedaction(new Map([['GH_TOKEN' as SecretName, token]])),
      screen: `$ echo $GH_TOKEN\n${'.'.repeat(60)}${head}\n${tail}\n> \n`,
    });

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert: neither half of the token is in any field of the look, and each half was starred where it stood.
    should(look).be.ok();
    const answered = JSON.stringify(look);
    should(answered).not.containEql(head);
    should(answered).not.containEql(tail);
    should(look?.status).containEql(`${'.'.repeat(60)}${'*'.repeat(head.length)}`);
    should(look?.status).containEql('*'.repeat(tail.length));
  });

  it('#U4 look masks a value the harness UI broke inside its indent (2 and 3 rows) or its │ … │ box before the screen is parsed', async () => {
    // Arrange: Claude Code hard-breaks a word longer than its box; each continuation row starts with the box's indent.
    const long = `FAKEJWTlook.${'Z9y8X7w6V5u4T3s2R1q0'.repeat(10)}`;
    const token = 'ghp_FAKELOOKboxAAAABBBBCCCCDDDDEEEE12345';
    const reply = `FAKEreply-${'k'.repeat(90)}`;
    const rows = [
      '⏺ Bash(env)',
      `  ⎿  ${long.slice(0, 75)}`,
      `     ${long.slice(75, 150)}`,
      `     ${long.slice(150)}`,
      `⏺ ${reply.slice(0, 78)}`,
      `  ${reply.slice(78)}`,
      `│ ${token.slice(0, 28)} │`,
      `│ ${token.slice(28).padEnd(28)} │`,
      '> ',
    ];
    const pane = subject({
      redaction: new FakeRedaction(
        new Map([
          ['JWT' as SecretName, long],
          ['GH_TOKEN' as SecretName, token],
          ['REPLY' as SecretName, reply],
        ]),
      ),
      screen: `${rows.join('\n')}\n`,
    });

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert: no piece of any value is in any field of the look; the gutters and borders stay where they stood.
    should(look).be.ok();
    const answered = JSON.stringify(look);
    for (const value of [long, token, reply])
      for (let at = 0; at + 8 <= value.length; at += 1) should(answered).not.containEql(value.slice(at, at + 8));
    should(look?.status).containEql(`  ⎿  ${'*'.repeat(75)}`);
    should(look?.status).containEql(`│ ${'*'.repeat(28)} │`);
    should(look?.status).containEql(`⏺ ${'*'.repeat(78)}`);
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

  it('BG-046 look answers nothing for a screen too large to mask, and nothing of it leaves unmasked', async () => {
    // Arrange: a pane whose screen is far past what the masker takes, with a value the Vault knows in it.
    const pane = subject({ screen: `${SECRET}\n${'a'.repeat(300_000)}` });

    // Act
    const look = await pane.runner.look(pane.handle);

    // Assert: no look (no evidence), and the scope was never handed a cut piece of the screen to mask.
    should(look).be.undefined();
    should(pane.masked).deepEqual([]);
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

  it('should not put back the pane text a stop forgot when a look was in flight across the stop', async () => {
    // Arrange: a look waiting on its capture.
    const pane = subject();
    const release = pane.holdNext('capture-pane');
    const inFlight = pane.runner.look(pane.handle);
    await Bun.sleep(0);

    // Act: the pane is stopped while the capture is out, then the capture lands.
    await pane.runner.stop(pane.handle, 'polite');
    release();
    await inFlight;
    await pane.runner.look(pane.handle);

    // Assert: the look after the stop captured again: nothing was served from memory.
    should(pane.captures()).equal(2);
  });

  it('should keep no pane text from a look that fell wholly inside a stop', async () => {
    // Arrange: a stop waiting on its pane facts.
    const pane = subject();
    const release = pane.holdNext('facts');
    const stopping = pane.runner.stop(pane.handle, 'polite');
    await Bun.sleep(0);

    // Act: a whole look runs (and captures) while the stop is out, then the stop ends.
    await pane.runner.look(pane.handle);
    release();
    await stopping;
    await pane.runner.look(pane.handle);

    // Assert
    should(pane.captures()).equal(2);
  });

  it('should keep no pane text from a look that began inside a stop and landed after it', async () => {
    // Arrange: a stop waiting on its pane facts, and a look begun meanwhile, waiting on its capture.
    const pane = subject();
    const releaseStop = pane.holdNext('facts');
    const stopping = pane.runner.stop(pane.handle, 'polite');
    await Bun.sleep(0);
    const releaseCapture = pane.holdNext('capture-pane');
    const inFlight = pane.runner.look(pane.handle);
    await Bun.sleep(0);

    // Act: the stop ends first, then the capture lands.
    releaseStop();
    await stopping;
    releaseCapture();
    await inFlight;
    await pane.runner.look(pane.handle);

    // Assert
    should(pane.captures()).equal(2);
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
