import { describe, it } from 'bun:test';
import should from 'should';
import { targetRef } from '@ferretry/core-vault/contract';
import { TerminalsPort } from '../../../../contract/index.ts';
import { ferretTmuxSession } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { FERRET, ScriptedTmux, SECRET, terminalsHalf } from '../../../support/daemon/half.ts';

/**
 * What a ferret's DEAD pane last showed (`TerminalsApi.deadPaneText`), driven through Terminals' whole daemon half
 * (`buildTerminals`) with a fake tmux: read by the registered pane id as an ACT on it (a hold refuses it), only for a
 * ferret's own session, and masked inside one `Redaction.read`.
 */

const PANE = '%3';
const SCREEN = `Error: workspace routing discovery failed\nexport GITHUB_TOKEN=${SECRET}`;

async function subject(options: { readonly session?: string; readonly registered?: boolean } = {}) {
  const session = options.session ?? ferretTmuxSession(FERRET);
  const tmux = new ScriptedTmux(args => {
    // A pane that has ended: tmux still answers for it (`pane_dead` 1), its pid gone.
    if (args[0] === 'display-message') return { stdout: `${PANE}|0|1|${session}|1700000000\n` };
    if (args[0] === 'capture-pane') return { stdout: SCREEN };
    return {};
  });
  const half = await terminalsHalf({ tmux });
  if (options.registered !== false)
    half.host.state('terminals').files.set(
      'terminals.json',
      JSON.stringify({
        format: 1,
        panes: {
          [FERRET]: { tmuxSession: ferretTmuxSession(FERRET), paneId: PANE, pid: 4242, processStartTicks: 77 },
        },
        events: {},
      }),
    );
  const captures = (): (readonly string[])[] => tmux.calls.filter(call => call[0] === 'capture-pane');
  return { half, terminals: half.host.provided(TerminalsPort), captures };
}

describe('the dead pane read, through buildTerminals', () => {
  it('should answer what the dead pane last showed, with a Vault value masked', async () => {
    const { half, terminals, captures } = await subject();

    const text = await terminals.deadPaneText(FERRET);
    await half.host.stop();

    should(text).containEql('Error: workspace routing discovery failed');
    should(text).not.containEql(SECRET);
    should(captures()).eql([['capture-pane', '-p', '-t', PANE]]);
  });

  it('should answer an empty text, reading nothing, for a ferret with no registered pane', async () => {
    const { half, terminals, captures } = await subject({ registered: false });

    const text = await terminals.deadPaneText(FERRET);
    await half.host.stop();

    should(text).equal('');
    should(captures()).eql([]);
  });

  it('should answer an empty text for a pane that is not a ferret’s own session', async () => {
    const { half, terminals, captures } = await subject({ session: 'fy-webterm-person-1' });

    const text = await terminals.deadPaneText(FERRET);
    await half.host.stop();

    should(text).equal('');
    should(captures()).eql([]);
  });

  it('should answer an empty text for a held terminal:%N (the act refuses the read)', async () => {
    const { half, terminals } = await subject();
    half.holds.pageHold(targetRef('terminal', PANE), { onHeldDocument: true });

    const text = await terminals.deadPaneText(FERRET);
    await half.host.stop();

    should(text).equal('');
  });
});
