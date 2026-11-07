import { describe, it } from 'bun:test';
import should from 'should';
import {
  currentTmuxSocket,
  ExactTmuxAttacher,
  type ProcessStart,
  type TmuxAttachProcess,
} from '../../../../cli/adapters/attach/tmux-attacher.ts';
import { AttachController } from '../../../../cli/lib/attach/controller.ts';
import type { AttachTarget } from '../../../../cli/lib/protocol/attach-target.ts';
import { capturedIo, invocation, recordingClient } from '../../../support/cli/doubles.ts';

const TARGET: AttachTarget = {
  socketPath: '/run/fy/tmux.sock',
  tmuxSession: 'fy-wren',
  paneId: '%3',
  pid: 4242,
  processStartTicks: 900,
};

/** A tmux that is never real: it reports `observed` and records what it would have run. */
function fakeTmux(observed: string, start: ProcessStart = { kind: 'known', value: 900 }) {
  const ran: (readonly string[])[] = [];
  const process: TmuxAttachProcess = {
    executable: () => '/usr/bin/tmux',
    inspect: async () => ({ code: 0, stdout: observed, stderr: '' }),
    interact: async argv => {
      ran.push(argv);
      return 0;
    },
    processStart: async () => start,
  };
  return { ran, process };
}

describe('ExactTmuxAttacher', () => {
  it('should attach to the proved session once tmux reports the same pane, pid and start', async () => {
    // Arrange
    const { ran, process } = fakeTmux('fy-wren\t%3\t4242');
    const sut = new ExactTmuxAttacher(process, {});

    // Act
    const code = await sut.attach(TARGET);

    // Assert
    should(code).equal(0);
    should(ran).deepEqual([
      ['/usr/bin/tmux', '-S', '/run/fy/tmux.sock', 'select-pane', '-t', '%3', ';', 'attach-session', '-t', 'fy-wren'],
    ]);
  });

  it('should switch the client inside the same tmux server rather than nest', async () => {
    // Arrange
    const { ran, process } = fakeTmux('fy-wren\t%3\t4242');
    const sut = new ExactTmuxAttacher(process, { TMUX: '/run/fy/tmux.sock,77,0' });

    // Act
    await sut.attach(TARGET);

    // Assert
    should(ran[0]).containEql('switch-client');
  });

  it('should refuse, naming each failed check, when the pane no longer matches the proof', async () => {
    // Arrange
    const { ran, process } = fakeTmux('fy-wren\t%3\t4242', { kind: 'known', value: 901 });
    const sut = new ExactTmuxAttacher(process, {});

    // Act
    const failure = await sut.attach(TARGET).catch((error: unknown) => error);

    // Assert
    should(ran).deepEqual([]);
    should((failure as Error).message).match(/process start identity is 901, the daemon proved 900/u);
  });

  it('should refuse inside a different tmux server', async () => {
    // Arrange
    const { ran, process } = fakeTmux('fy-wren\t%3\t4242');
    const sut = new ExactTmuxAttacher(process, { TMUX: '/tmp/other.sock,77,0' });

    // Act
    const failure = await sut.attach(TARGET).catch((error: unknown) => error);

    // Assert
    should(ran).deepEqual([]);
    should((failure as Error).message).match(/different tmux server/u);
  });

  it('should read the socket out of a TMUX record and nothing out of a malformed one', () => {
    should(currentTmuxSocket('/run/a,b/tmux.sock,77,0')).equal('/run/a,b/tmux.sock');
    should(currentTmuxSocket('relative,77,0')).be.undefined();
    should(currentTmuxSocket('/run/tmux.sock')).be.undefined();
  });
});

describe('AttachController', () => {
  it('should ask the daemon for the ferret’s attach proof and hand it to the attacher', async () => {
    // Arrange
    const { calls, client } = recordingClient(() => TARGET);
    const seen: AttachTarget[] = [];
    const sut = new AttachController(
      client,
      {
        attach: async target => {
          seen.push(target);
          return 0;
        },
      },
      capturedIo(),
    );

    // Act
    const code = await sut.attach(invocation(['f-1']));

    // Assert
    should(code).equal(0);
    should(calls).deepEqual([{ route: 'GET /v1/ferrets/:ferretId/attach', params: { ferretId: 'f-1' } }]);
    should(seen).deepEqual([TARGET]);
  });

  it('should refuse a proof that is not one, without attaching', async () => {
    // Arrange
    const { client } = recordingClient(() => ({ ...TARGET, socketPath: 'relative.sock' }));
    const io = capturedIo();
    let attached = false;
    const sut = new AttachController(
      client,
      {
        attach: async () => {
          attached = true;
          return 0;
        },
      },
      io,
    );

    // Act
    const code = await sut.attach(invocation(['f-1']));

    // Assert
    should(code).equal(1);
    should(attached).be.false();
  });

  it('should exit 2 when no ferret is named', async () => {
    // Arrange
    const { calls, client } = recordingClient(() => TARGET);
    const sut = new AttachController(client, { attach: async () => 0 }, capturedIo());

    // Act
    const code = await sut.attach(invocation([]));

    // Assert
    should(code).equal(2);
    should(calls).deepEqual([]);
  });
});
