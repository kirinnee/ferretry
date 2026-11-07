import { describe, it } from 'bun:test';
import type { SecretName } from '@ferretry/core-vault/contract';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { AUDIT } from '../../../../contract/policy.ts';
import manifest from '../../../../manifest.ts';
import { redactorOf } from '../../../../daemon/processes.ts';
import { consoleInputHandler } from '../../../../daemon/lib/runtime/mounts/session-console-input.ts';
import {
  ATTACH_PANE,
  answer,
  consoleSubsystem,
  consoleTmux,
  ferretDirectory,
} from '../runtime/mounts/processes-support.ts';
import {
  claudeWrapper,
  HARNESS_PID,
  idOf,
  processWorld,
  rowOf,
  SESSION,
  taskFile,
  taskPath,
} from './processes/support.ts';

/**
 * The rows this slice owns, each named by its id: what a ferret's Processes tab, Console and attach must never do.
 */

/** A tool command the harness started, as Claude Code starts one, writing to a task file. */
const shell = (pid: number, command: string) =>
  rowOf({ pid, ppid: HARNESS_PID, argv: claudeWrapper(command), stdout: taskFile(`t${pid}`) });

describe('the processes, console and attach rows', () => {
  it('G29 the Console types only into the pane the attach proof names, never by a session name', async () => {
    // Arrange — the same ferret three ways: its proved pane, a replaced pane, and no recorded pane at all.
    const proved = consoleTmux();
    const replaced = consoleTmux();
    const unrecorded = consoleTmux();
    const type = async (world: Parameters<typeof consoleSubsystem>[0], tmux: typeof proved) =>
      await answer(consoleInputHandler(consoleSubsystem(world, tmux), ferretDirectory()), {
        body: JSON.stringify({ data: 'rm -rf build\r' }),
      });

    // Act
    const typed = await type({}, proved);
    const mismatched = await type({ observation: { ...ATTACH_PANE, processStartTicks: 1 } }, replaced);
    const missing = await type({ registration: undefined }, unrecorded);

    // Assert — the one command addresses the pane by id; a pane that is no longer the recorded incarnation, or a
    // ferret with no recorded pane, is refused with nothing sent, and nothing ever targets `fy-s1` by name.
    should(typed.status).equal(200);
    should(proved.commands.map(command => command.slice(0, 4))).deepEqual([['send-keys', '-H', '-t', '%7']]);
    should([mismatched.status, mismatched.code]).deepEqual([409, 'attach_identity_mismatch']);
    should([missing.status, missing.code]).deepEqual([409, 'attach_registration_missing']);
    should([...replaced.commands, ...unrecorded.commands]).deepEqual([]);
    should(JSON.stringify(proved.commands)).not.containEql(ATTACH_PANE.tmuxSession);
  });

  it('G30 Console input is audited as terminal.input by its descriptor, and the answer never carries what was typed', async () => {
    // Arrange
    const tmux = consoleTmux();
    const declared = manifest.actions.routes.find(route => route.key === 'POST /v1/ferrets/:ferretId/console/input');

    // Act
    const typed = await answer(consoleInputHandler(consoleSubsystem({}, tmux), ferretDirectory()), {
      body: JSON.stringify({ data: 'my typed passphrase' }),
    });

    // Assert — the kernel writes the audit row from the descriptor, so the handler holds no audit call of its own
    // that could leak the text; the answer is a byte count only.
    should(declared?.audit).deepEqual({ record: AUDIT.terminalInput });
    should(String(AUDIT.terminalInput)).equal('terminal.input');
    should(typed.body).deepEqual({ written: 19 });
    should(JSON.stringify(typed)).not.containEql('passphrase');
  });

  it('G34 Stop re-proves each pid and its start before SIGTERM, and signals nothing it cannot prove', async () => {
    // Arrange — one process whose pid was reused since the list was drawn, one whose id names another start.
    const reused = processWorld();
    reused.tree.rows = [...reused.tree.rows, shell(200, 'bun test')];
    reused.tree.startOverrides.set(200, 424_242);
    const stale = processWorld();
    stale.tree.rows = [...stale.tree.rows, shell(200, 'bun test')];
    const proved = processWorld();
    proved.tree.rows = [...proved.tree.rows, shell(200, 'bun test')];
    const id = idOf(shell(200, 'bun test'));

    // Act
    const skipped = await reused.service.stop(SESSION, id);
    const refused = await stale.service.stop(SESSION, '200.1').then(
      () => 'stopped',
      (error: unknown) => (error as { failure?: string }).failure,
    );
    const stopped = await proved.service.stop(SESSION, id);

    // Assert — the start is read again immediately before the signal; a mismatch is a skip or a refusal, never a kill.
    should(reused.tree.startAsked).containEql(200);
    should(reused.signals.sent).deepEqual([]);
    should(skipped.signalled).equal(0);
    should(refused).equal('changed');
    should(stale.signals.sent).deepEqual([]);
    should(proved.tree.startAsked).containEql(200);
    should(proved.signals.sent).deepEqual([200]);
    should(stopped.signalled).equal(1);
  });

  it('S17 every command line and output byte is masked inside one Redaction.read per answer', async () => {
    // Arrange — the kernel's redaction port over a vault that holds one value.
    const vault = new FakeRedaction(new Map([['TOKEN' as SecretName, 'hunter2']]));
    const world = processWorld({ redaction: redactorOf(vault.read.bind(vault)) });
    world.tree.rows = [...world.tree.rows, shell(200, 'curl -H "Authorization: hunter2" https://example.test')];
    world.files.put(taskPath('t200'), 'connected with hunter2\n');
    const id = idOf(shell(200, ''));

    // Act
    const list = await world.service.list(SESSION);
    const afterList = vault.opens;
    const output = await world.service.output(SESSION, id, undefined);

    // Assert — one read for the list and one for the output, and the value appears in neither.
    should(afterList).equal(1);
    should(vault.opens).equal(2);
    should(JSON.stringify(list)).not.containEql('hunter2');
    should(output.text).not.containEql('hunter2');
    should(output.text).startWith('connected with ');
  });
});
