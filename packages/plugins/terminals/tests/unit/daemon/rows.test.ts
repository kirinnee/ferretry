import { describe, it } from 'bun:test';
import { targetRef } from '@ferretry/core-vault/contract';
import { inputTargetConformance } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { FERRET, liveTerminalSubject, SECRET, terminalsHalf } from '../../support/daemon/half.ts';

/**
 * Terminals' rows on the whole daemon half (the kernel's test host), each named by its id. "With: vault" rows run
 * against the Vault's contract fakes (`FakeInputHolds`, `FakeRedaction`).
 */

const PANE = targetRef('terminal', '%1');

async function opened() {
  const half = await terminalsHalf();
  const open = await half.host.tool('terminal_open', { name: 'dev' });
  should(open.isError).not.equal(true);
  return half;
}

describe('the terminal rows', () => {
  it('I103 terminal.wait matches on the masked screen, so a hidden value never satisfies the wait', async () => {
    // Arrange — the screen shows the vault's value; the agent waits for that very text.
    const half = await opened();
    const [record] = half.runtime.records;
    half.runtime.screens.set(record?.id ?? '', `token: ${SECRET}`);

    // Act
    let answered = false;
    const waiting = half.host.tool('terminal_wait', { name: 'dev', text: SECRET, timeoutMs: 500 }).finally(() => {
      answered = true;
    });
    // The wait looks once per poll on the driven clock: advance it until the wait answers.
    for (let tick = 0; tick < 200 && !answered; tick += 1) {
      await half.host.clock.advance(250);
      await new Promise(resolve => setImmediate(resolve));
    }
    const answer = await waiting;

    // Assert — the wait timed out (the predicate saw the mask), and nothing it answered carries the value.
    should(answer.text).containEql('timed out');
    should(answer.text).not.containEql(SECRET);
    should(JSON.stringify(answer.data)).not.containEql(SECRET);
    should(half.host.acts.some(act => act.op === 'wait')).equal(true);
  });

  it('I72 a terminal in quarantine refuses read and wait to the agent, and keys still reach it', async () => {
    // Arrange
    const half = await opened();
    half.holds.quarantine(PANE);

    // Act
    const read = await half.host.tool('terminal_read', { name: 'dev' });
    const sent = await half.host.tool('terminal_send', { name: 'dev', text: 'ls', keys: ['enter'] });

    // Assert
    should(read.isError).equal(true);
    should(read.text).containEql('quarantined');
    should(sent.isError).not.equal(true);
    should(half.runtime.typed.map(entry => entry.text)).containEql('ls\r');
  });

  it('I72 a pending input card refuses the agent typing there, and nothing is typed', async () => {
    // Arrange
    const half = await opened();
    half.holds.pendingCard(PANE, { codeOnly: false });

    // Act
    const sent = await half.host.tool('terminal_send', { name: 'dev', text: 'hunter' });

    // Assert
    should(sent.isError).equal(true);
    should(sent.text).containEql('input request is pending');
    should(half.runtime.typed).have.length(0);
  });

  it('I105 a read is masked inside one Redaction.read before it leaves', async () => {
    // Arrange
    const half = await opened();
    const [record] = half.runtime.records;
    half.runtime.screens.set(record?.id ?? '', `export GITHUB_TOKEN=${SECRET}`);
    const opens = half.redaction.opens;

    // Act
    const read = await half.host.tool('terminal_read', { name: 'dev' });

    // Assert
    should(read.text).not.containEql(SECRET);
    should(half.redaction.opens - opens).equal(1);
  });

  it('I68 terminal_request_input raises an input card through the Vault, types nothing and is not an act', async () => {
    // Arrange
    const half = await opened();
    const acts = half.host.acts.length;

    // Act
    const asked = await half.host.tool('terminal_request_input', {
      name: 'dev',
      prompt: 'sudo asks for your password',
      sensitivity: 'secret',
    });

    // Assert
    should(asked.isError).not.equal(true);
    should(half.raised).have.length(1);
    should(half.raised[0]?.ferret).equal(FERRET);
    should(half.raised[0]?.raise.target).eql({ kind: 'terminal', key: 'dev' });
    should(half.host.acts.length).equal(acts);
    should(half.runtime.typed).have.length(0);
  });

  it('terminal_ask_owner hands the terminal over without an act', async () => {
    // Arrange
    const half = await opened();
    const acts = half.host.acts.length;

    // Act
    const asked = await half.host.tool('terminal_ask_owner', { name: 'dev', message: 'sign in please' });
    half.as('owner');
    const view = await half.host.request('GET', `/v1/ferrets/${FERRET}/surfaces/terminals/control`);

    // Assert
    should(asked.isError).not.equal(true);
    should(half.host.acts.length).equal(acts);
    should(JSON.parse(view.body).asked).have.length(1);
  });

  it('every terminal tool that touches the pane goes through the act runner, keyed by the tmux pane id', async () => {
    // Arrange
    const half = await opened();

    // Act
    await half.host.tool('terminal_send', { name: 'dev', keys: ['enter'] });
    await half.host.tool('terminal_read', { name: 'dev' });
    await half.host.tool('terminal_close', { name: 'dev' });

    // Assert
    const ops = half.host.acts.map(act => `${act.op}@${act.target.key}`);
    should(ops).containEql('keys@%1');
    should(ops).containEql('read@%1');
    should(ops).containEql('close@%1');
  });
});

describe('the tmux runner', () => {
  it('D15 attach adopts a live pane by its id without restarting it', async () => {
    // Arrange — tmux knows pane %7 in a ferret's session.
    const { TmuxRunner } = await import('../../../daemon/adapters/tmux/tmux-runner.ts');
    const { ScriptedTmux } = await import('../../support/daemon/half.ts');
    const tmux = new ScriptedTmux(args =>
      args[0] === 'display-message' && args.includes('%7')
        ? { stdout: `%7|4242|0|fy-${FERRET}|1762473600\n` }
        : { code: 1, stderr: "can't find pane" },
    );
    const remembered: string[] = [];
    const runner = new TmuxRunner({
      tmux,
      spawn: {
        run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
        runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
        start: () => undefined as never,
      },
      socketPath: '/state/terminals/tmux.sock',
      instantOf: seconds => `${String(seconds)}` as never,
      now: () => 'now' as never,
      remember: async ferret => {
        remembered.push(ferret);
      },
    });

    // Act
    const adopted = await runner.attach('%7' as never);
    const gone = await runner.attach('%8' as never);
    const notOurs = await runner.attach('nope' as never);

    // Assert — the handle stays the pane id; only questions were asked, nothing sent or started.
    should(adopted.ok && adopted.value.handle).equal('%7');
    should(adopted.ok && adopted.value.pid).equal(4242);
    should(gone.ok ? undefined : gone.error).equal('gone');
    should(notOurs.ok ? undefined : notOurs.error).equal('unsupported');
    should(remembered).eql([FERRET]);
    should(tmux.calls.every(call => call[0] === 'display-message')).equal(true);
  });

  it('D15 a person shell pane is never adopted as a ferret', async () => {
    const { TmuxRunner } = await import('../../../daemon/adapters/tmux/tmux-runner.ts');
    const { ScriptedTmux } = await import('../../support/daemon/half.ts');
    const tmux = new ScriptedTmux(() => ({ stdout: '%3|99|0|fy-webterm-dev-abc-0123456789ab|1\n' }));
    const runner = new TmuxRunner({
      tmux,
      spawn: {
        run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
        runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
        start: () => undefined as never,
      },
      socketPath: '/s/tmux.sock',
      instantOf: () => 'x' as never,
      now: () => 'x' as never,
    });

    const adopted = await runner.attach('%3' as never);

    should(adopted.ok ? undefined : adopted.error).equal('not-a-ferret');
  });
});

inputTargetConformance('terminals', liveTerminalSubject);
