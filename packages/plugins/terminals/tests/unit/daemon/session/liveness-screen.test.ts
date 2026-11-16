import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { targetRef } from '@ferretry/core-vault/contract';
import { TerminalsPort } from '../../../../contract/index.ts';
import { ferretTmuxSession } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { ProcessHostReads } from '../../../../daemon/processes.ts';
import { FERRET, ScriptedTmux, SECRET, terminalsHalf } from '../../../support/daemon/half.ts';

/**
 * The Warden's liveness look at a ferret's own pane, driven through Terminals' whole daemon half (`buildTerminals`)
 * with a fake tmux and fake host reads: the screen is read as an ACT on the PROVED pane (so a hold or quarantine
 * refuses it) and masked inside one `Redaction.read`, and its digest is taken of the masked text only.
 */

const PANE = '%3';
const PANE_PID = 4242;
const START = 77;
const SCREEN = `export GITHUB_TOKEN=${SECRET}\n✢ Fixing… (5m 45s · ↓ 17.2k tokens)`;

/** No tool command, no helper: the pane's tree is empty, and its pid's start is the registered one. */
const host: ProcessHostReads = {
  incarnation: { startOf: async pid => (pid === PANE_PID ? START : undefined) },
  tree: {
    tree: async () => ({ kind: 'read', rows: [] }),
    listening: async () => new Set<number>(),
    startOf: async () => undefined,
  },
  provenance: { identify: async () => new Map() },
};

async function subject() {
  const tmux = new ScriptedTmux(args => {
    if (args[0] === 'display-message') return { stdout: `${PANE} ${PANE_PID}\n` };
    if (args[0] === 'capture-pane') return { stdout: SCREEN };
    return {};
  });
  const half = await terminalsHalf({ tmux, processHost: host });
  // The tmux runner's own record of the ferret's pane, as `remember` writes it when the pane starts.
  half.host.state('terminals').files.set(
    'terminals.json',
    JSON.stringify({
      format: 1,
      panes: {
        [FERRET]: { tmuxSession: ferretTmuxSession(FERRET), paneId: PANE, pid: PANE_PID, processStartTicks: START },
      },
      events: {},
    }),
  );
  const captures = (): (readonly string[])[] => tmux.calls.filter(call => call[0] === 'capture-pane');
  return { half, terminals: half.host.provided(TerminalsPort), captures };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the liveness screen read, through buildTerminals (act + mask on the proved pane)', () => {
  it('should mask a Vault value on the screen, and digest the MASKED text, never the raw screen', async () => {
    // Arrange
    const { half, terminals } = await subject();

    // Act
    const sample = await terminals.liveness(FERRET);
    await half.host.stop();

    // Assert
    if (sample.pane === undefined) throw new Error('expected the screen to be read');
    should(sample.pane).not.containEql(SECRET);
    should(sample.pane).containEql('✢ Fixing… (5m 45s · ↓ 17.2k tokens)');
    should(sample.paneHash).equal(sha256(sample.pane));
    should(sample.paneHash).not.equal(sha256(SCREEN));
  });

  it('should capture the PROVED pane by its id, and nothing else', async () => {
    // Arrange
    const { half, terminals, captures } = await subject();

    // Act
    await terminals.liveness(FERRET);
    await half.host.stop();

    // Assert
    should(captures()).eql([['capture-pane', '-p', '-t', PANE]]);
  });

  it('should answer no pane and no paneHash for a quarantined terminal:%N (the act refuses the read)', async () => {
    // Arrange
    const { half, terminals } = await subject();
    half.holds.quarantine(targetRef('terminal', PANE));

    // Act
    const sample = await terminals.liveness(FERRET);
    await half.host.stop();

    // Assert
    should(sample).not.have.property('pane');
    should(sample).not.have.property('paneHash');
  });

  it('should answer no pane and no paneHash for a held terminal:%N', async () => {
    // Arrange
    const { half, terminals } = await subject();
    half.holds.pageHold(targetRef('terminal', PANE), { onHeldDocument: true });

    // Act
    const sample = await terminals.liveness(FERRET);
    await half.host.stop();

    // Assert
    should(sample).not.have.property('pane');
    should(sample).not.have.property('paneHash');
  });
});
