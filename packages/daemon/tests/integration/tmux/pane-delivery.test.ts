import { describe, it } from 'bun:test';
import should from 'should';
import { PaneDeliveryError, TmuxPaneDelivery } from '../../../src/adapters/index.ts';
import { TmuxController } from '../../../src/lib/index.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';

const SESSION = 'fy-session-1';

/** No real waiting: the loops are bounded by attempts, not by a clock. */
function delivery(server: FakeTmuxServer, options = {}) {
  const slept: number[] = [];
  const subject = new TmuxPaneDelivery(
    new TmuxController(server),
    async milliseconds => {
      slept.push(milliseconds);
    },
    options,
  );
  return { subject, slept };
}

describe('tmux pane delivery — readiness', () => {
  it('should answer the trust prompt a first launch in a new directory always shows', async () => {
    // Arrange — the modal renders a prompt line under it, which is what used to read as ready.
    const server = new FakeTmuxServer();
    server.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION);

    // Assert
    should(server.calls.filter(call => call[0] === 'send-keys')).deepEqual(
      [['send-keys', '-t', SESSION, 'Enter']],
      'the affirmative row is already selected, so one Enter answers it',
    );
  });

  it('should walk the resume menu to the configured row rather than pressing Enter on the default', async () => {
    // Arrange — Claude Code's large-session gate, cursor on row 1.
    const server = new FakeTmuxServer();
    server.modal = [
      'This session is 2h 45m old and 382k tokens.',
      '❯ 1. Resume from summary (recommended)',
      '  2. Resume full session as-is',
      "  3. Don't ask me again",
    ].join('\n');
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION, { resumeMenuChoice: 'full' });

    // Assert
    should(server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1))).deepEqual(
      ['Down', 'Enter'],
      'row 2 is one step below the highlighted row; option 3 must never be reachable',
    );
  });

  it('should stop rather than keep answering a dialog its keys are not clearing', async () => {
    // Arrange — a modal that comes straight back after every answer.
    const server = new FakeTmuxServer();
    server.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
    server.modalsToClear = 0;
    const { subject } = delivery(server);

    // Act / Assert
    await should(subject.waitReady(SESSION)).be.rejectedWith(/claude-trust dialog did not close after 3 attempts/u);
    should(server.calls.filter(call => call[0] === 'send-keys')).have.length(3);
  });

  it('should wait out a booting harness and give up rather than type into it', async () => {
    // Arrange
    const booting = new FakeTmuxServer();
    booting.bootCaptures = 4;
    const wedged = new FakeTmuxServer();
    wedged.bootCaptures = Number.MAX_SAFE_INTEGER;

    // Act
    await delivery(booting).subject.waitReady(SESSION);
    const waited = delivery(wedged, { readinessAttempts: 2 });

    // Assert
    await should(waited.subject.waitReady(SESSION)).be.rejectedWith(/did not become ready to accept a turn/u);
    should(waited.slept).deepEqual([100, 200]);
    should(wedged.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should refuse a pane whose harness has exited, and say what tmux reported', async () => {
    // Arrange
    const gone = new FakeTmuxServer();
    gone.alive = false;
    const died = new FakeTmuxServer();
    died.dead = true;
    died.exitCode = '137';

    // Act / Assert
    await should(delivery(gone).subject.waitReady(SESSION)).be.rejectedWith(/exited; tmux reported no exit code/u);
    await should(delivery(died).subject.waitReady(SESSION)).be.rejectedWith(/exited \(137\)/u);
  });
});

describe('tmux pane delivery — landing proof', () => {
  it('should type a short single-line turn literally and submit it once it is proven on screen', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, 'continue');

    // Assert
    should(actual).equal('turn-started');
    should(server.submitted).deepEqual(['continue']);
    should(server.calls.filter(call => call.includes('-l'))).deepEqual([
      ['send-keys', '-t', SESSION, '-l', 'continue'],
    ]);
  });

  it('should send a multi-line turn as one bracketed paste and accept the placeholder as proof', async () => {
    // Arrange — the payload the harness collapses and renders NONE of.
    const server = new FakeTmuxServer();
    const brief = 'Read the file /turns/turn-001.md now,\nthen follow every instruction inside it.';
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, brief);

    // Assert
    should(actual).equal('turn-started');
    should(server.submitted).deepEqual([brief], 'the pane received the whole brief as one message');
    should(server.commands()).containEql('load-buffer');
    should(server.calls.some(call => call[0] === 'paste-buffer' && call.includes('-p'))).be.true();
    should(server.heldBuffers()).deepEqual([], 'a delivered paste leaves no payload in the tmux server');
  });

  it('should report a slash command the TUI handled itself as delivered, not as a failure', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.localCommand = true;
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, '/status');

    // Assert
    should(actual).equal('handled-local');
    should(server.submitted).deepEqual(['/status']);
  });

  it('should refuse to claim delivery when nothing ever reaches the composer', async () => {
    // Arrange — a pane that swallows every keystroke.
    const server = new FakeTmuxServer();
    server.execute = async argv => {
      server.calls.push(argv);
      if (argv[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
      if (argv[0] === 'display-message') return { code: 0, stdout: '0||2|1|24|80\n', stderr: '' };
      if (argv[0] === 'capture-pane') return { code: 0, stdout: 'the last frame\n> \n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const { subject } = delivery(server, { composerAttempts: 2, composerPolls: 1 });

    // Act / Assert
    await should(subject.deliver(SESSION, 'continue')).be.rejectedWith(/did not land in the composer/u);
    should(server.calls.filter(call => call.at(-1) === 'Enter')).deepEqual([], 'Enter is never pressed on a guess');
  });

  it('should clear the composer between retries only while nothing has landed', async () => {
    // Arrange — the first literal send is dropped; the second lands.
    const server = new FakeTmuxServer();
    let literals = 0;
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv.includes('-l')) {
        literals += 1;
        if (literals === 1) {
          server.calls.push(argv);
          return { code: 0, stdout: '', stderr: '' };
        }
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server, { composerPolls: 1 });

    // Act
    const actual = await subject.deliver(SESSION, 'continue');

    // Assert
    should(actual).equal('turn-started');
    should(server.calls.filter(call => call.at(-1) === 'C-u')).have.length(1, 'cleared once, before the retry');
    should(server.submitted).deepEqual(['continue']);
  });

  it('should keep pressing Enter while the payload is visibly stuck, then refuse', async () => {
    // Arrange — a composer that holds text no matter what Enter does.
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv[0] === 'send-keys' && argv.at(-1) === 'Enter') {
        server.calls.push(argv);
        return { code: 0, stdout: '', stderr: '' };
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server, { submitAttempts: 2, submitPolls: 1 });

    // Act / Assert
    await should(subject.deliver(SESSION, 'continue')).be.rejectedWith(/landed but stayed in the composer/u);
    should(server.calls.filter(call => call.at(-1) === 'Enter')).have.length(2);
  });
});

describe('tmux paste buffers', () => {
  it('should refuse an empty paste and leave no buffer behind when the paste itself fails', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const failing = new FakeTmuxServer();
    const underlying = failing.execute.bind(failing);
    failing.execute = async (argv, stdin) => {
      if (argv[0] === 'paste-buffer') {
        failing.calls.push(argv);
        return { code: 1, stdout: '', stderr: 'no client' };
      }
      return await underlying(argv, stdin);
    };
    const controller = new TmuxController(server);

    // Act / Assert
    await should(controller.paste(SESSION, '')).be.rejectedWith('paste text must not be empty');
    await should(new TmuxController(failing).paste(SESSION, 'a\nb')).be.rejectedWith('no client');
    should(failing.heldBuffers()).deepEqual([], 'a failed paste must not leave the payload in the server');
    should(new PaneDeliveryError('x').name).equal('PaneDeliveryError');
  });

  it('should surface a load failure rather than pasting a buffer it never filled', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv[0] === 'load-buffer') {
        server.calls.push(argv);
        return { code: 1, stdout: '', stderr: 'buffer too large' };
      }
      return await underlying(argv, stdin);
    };

    // Act / Assert
    await should(new TmuxController(server).paste(SESSION, 'a\nb')).be.rejectedWith('buffer too large');
    should(server.commands()).not.containEql('paste-buffer');
  });
});
