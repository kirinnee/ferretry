import type { SendResult } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import { Command, CommanderError } from 'commander';
import should from 'should';
import { AnswerQuestionController } from '../../../src/lib/session/answer-controller.ts';
import { InterruptSessionController, ResumeSessionController } from '../../../src/lib/session/lifecycle-controllers.ts';
import { SuggestNamesController } from '../../../src/lib/session/name-controller.ts';
import type { SessionEnvironment } from '../../../src/lib/session/ports.ts';
import { ListSessionsController } from '../../../src/lib/session/ps-controller.ts';
import { registerSessionCommands } from '../../../src/lib/session/registration.ts';
import { SendMessageController } from '../../../src/lib/session/send-controller.ts';
import { SignalSessionController } from '../../../src/lib/session/signal-controller.ts';
import { StartSessionController } from '../../../src/lib/session/start-controller.ts';
import { SessionStatusController } from '../../../src/lib/session/status-controller.ts';
import { attachmentView, type CapturedIo, capturedPresenter, FakeFiles, RecordingApi } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

const view = sessionView({ teammate: 'Hayden' });
const sendResult = (disposition: SendResult['disposition'] = 'delivered'): SendResult => ({ ...view, disposition });

interface Harness {
  readonly run: (argv: readonly string[]) => Promise<void>;
  readonly api: RecordingApi;
  readonly io: CapturedIo;
  readonly files: FakeFiles;
}

function harness(
  responses: ConstructorParameters<typeof RecordingApi>[0] = {},
  environment: SessionEnvironment = { cwd: '/work/repo' },
  files = new FakeFiles({ '/tmp/brief.md': 'from the file' }, { 'shot.png': { filename: 'shot.png', base64: 'AA' } }),
): Harness {
  const api = new RecordingApi({
    list: [view],
    get: view,
    suggestNames: ['Hayden'],
    start: view,
    send: sendResult(),
    answer: view,
    interrupt: view,
    resume: view,
    signal: view,
    upload: attachmentView,
    ...responses,
  });
  const { io, presenter } = capturedPresenter();
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommands(program, {
    presenter,
    start: new StartSessionController(api, files, presenter, environment),
    list: new ListSessionsController(api, presenter),
    status: new SessionStatusController(api, presenter),
    send: new SendMessageController(api, files, presenter, environment),
    answer: new AnswerQuestionController(api, presenter),
    names: new SuggestNamesController(api, presenter),
    interrupt: new InterruptSessionController(api, presenter),
    resume: new ResumeSessionController(api, presenter),
    signal: new SignalSessionController(api, presenter, environment),
  });
  return {
    api,
    io,
    files,
    run: async (argv: readonly string[]) => {
      await program.parseAsync(['node', 'fy', ...argv]);
    },
  };
}

describe('registerSessionCommands · start', () => {
  it('should map every start flag onto the wire request', async () => {
    // Arrange
    const subject = harness({}, { cwd: '/work/repo', callerSessionId: 'ses-lead' });

    // Act
    await subject.run([
      'start',
      'do',
      'the',
      'thing',
      '--agent',
      'claude-alpha',
      '--mode',
      'auto',
      '--name',
      'Fix Transcript Scrolling',
      '--teammate',
      'Hayden',
      '--teammate-fallback',
      '--label',
      'batch',
      '--model',
      'opus-5',
      '--rc',
      '--harness-flag',
      '--verbose',
      '--harness-flag',
      '--trace',
      '--cwd',
      '/elsewhere',
      '--prompt-file',
      '/tmp/brief.md',
      '--file',
      'shot.png',
      '--interval',
      '45',
      '--turn-timeout',
      '3600',
      '--nudge-after',
      '120',
      '--stall-kill-after',
      '600',
      '--direct-max',
      '250',
      '--max-snapshots',
      '9',
      '--detach',
      '--request-id',
      'req-9',
    ]);

    // Assert
    should(subject.api.calls[0]?.args[0]).deepEqual({
      mode: 'auto',
      prompt: 'do the thing\n\nfrom the file',
      agent: 'claude-alpha',
      boardAccess: 'none',
      cwd: '/elsewhere',
      harnessFlags: ['--verbose', '--trace'],
      name: 'Fix Transcript Scrolling',
      teammate: 'Hayden',
      teammateFallback: true,
      label: 'batch',
      parent: 'ses-lead',
      model: 'opus-5',
      remoteControl: true,
      intervalSeconds: 45,
      timeoutSeconds: 3600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 600,
      directSendMaxChars: 250,
      maxSnapshots: 9,
      detach: true,
      initialAttachments: [{ filename: 'shot.png', base64: 'AA' }],
    });
    should(subject.api.calls[0]?.args[1]).equal('req-9');
  });

  it('should send no remote-control decision unless one was typed', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['start', 'go', '--agent', 'claude-alpha']);

    // Assert
    should(subject.api.calls[0]?.args[0]).not.have.property('remoteControl');
  });

  it('should carry --no-rc as an explicit refusal', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['start', 'go', '--agent', 'claude-alpha', '--no-rc']);

    // Assert
    should(subject.api.calls[0]?.args[0]).containDeep({ remoteControl: false });
  });

  it('should pass an explicit parent and a board grant with its capability', async () => {
    // Arrange
    const subject = harness({}, { cwd: '/work/repo', boardCapability: 'cap-1' });

    // Act
    await subject.run(['start', 'go', '--agent', 'claude-alpha', '--parent', 'ses-lead', '--board-access', 'worker']);

    // Assert
    should(subject.api.calls[0]?.args[0]).containDeep({ parent: 'ses-lead', boardAccess: 'worker' });
    should(subject.api.calls[0]?.args[2]).equal('cap-1');
  });

  it('should reject an unknown --mode at parse time', async () => {
    // Arrange
    const subject = harness();

    // Act
    const failure = await subject.run(['start', 'go', '--agent', 'a', '--mode', 'sideways']).catch(error => error);

    // Assert
    should(failure).be.instanceof(CommanderError);
    should(subject.api.calls).be.empty();
  });

  it('should report a usage mistake as a message and exit code 2, not a stack trace', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['start', '--agent', 'claude-alpha']);

    // Assert
    should(subject.io.err.join('\n')).match(/provide a prompt/);
    should(subject.io.exitCode).equal(2);
    should(subject.api.calls).be.empty();
  });

  it('should report a daemon failure as a message and exit code 1', async () => {
    // Arrange
    const subject = harness({ failWith: new Error('connection refused') });

    // Act
    await subject.run(['ps']);

    // Assert
    should(subject.io.err).deepEqual(['connection refused']);
    should(subject.io.exitCode).equal(1);
  });
});

describe('registerSessionCommands · the rest of the group', () => {
  it('should list sessions with the filters the caller asked for', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['ps', '--all', '--label', 'batch', '--json']);

    // Assert
    should(subject.api.methods()).deepEqual(['list']);
    should(JSON.parse(subject.io.out.join('\n'))).be.empty();
  });

  it('should show one session', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['status', 'ses-1']);

    // Assert
    should(subject.api.calls).deepEqual([{ method: 'get', args: ['ses-1'] }]);
  });

  it('should send a message with its attachments and flags', async () => {
    // Arrange
    const subject = harness({}, { cwd: '/work/repo', callerSessionId: 'ses-caller' });

    // Act
    await subject.run([
      'send',
      'ses-1',
      'heads',
      'up',
      '--file',
      'shot.png',
      '--message-file',
      '/tmp/brief.md',
      '--now',
    ]);

    // Assert
    should(subject.api.methods()).deepEqual(['upload', 'send']);
    should(subject.api.calls[1]?.args[1]).deepEqual({
      message: 'heads up\n\nfrom the file',
      attachmentIds: ['att-1'],
      now: true,
    });
  });

  it('should ask for a reply and park the caller', async () => {
    // Arrange
    const subject = harness({}, { cwd: '/work/repo', callerSessionId: 'ses-caller' });

    // Act
    await subject.run(['send', 'ses-1', 'and you?', '--ask', '--until', '45m']);

    // Assert
    should(subject.api.methods()).deepEqual(['send', 'signal']);
    should(subject.api.calls[1]?.args[3]).containDeep({ peer: 'ses-1', until: '45m' });
  });

  it('should treat reply as the peer spelling of send', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['reply', 'ses-1', 'yes', 'go', 'ahead']);

    // Assert
    should(subject.api.methods()).deepEqual(['send']);
    should(subject.api.calls[0]?.args[1]).deepEqual({ message: 'yes go ahead', attachmentIds: [], now: false });
  });

  it('should answer a pending question with labels, other and responses', async () => {
    // Arrange
    const pending = sessionView(
      {},
      {
        status: 'awaiting_question',
        pendingQuestion: { toolUseId: 'tool-3', questions: [{ question: 'Ship it?' }] },
      },
    );
    const subject = harness({ get: pending });

    // Act
    await subject.run(['answer', 'ses-1', 'yes', '--other', 'with caveats', '--response', 'yes']);

    // Assert
    should(subject.api.calls[1]?.args).deepEqual(['ses-1', 'tool-3', ['yes'], 'with caveats', ['yes']]);
  });

  it('should interrupt a session', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['interrupt', 'ses-1']);

    // Assert
    should(subject.api.calls).deepEqual([{ method: 'interrupt', args: ['ses-1'] }]);
  });

  it('should resume a session with a message', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['resume', 'ses-1', 'carry', 'on']);

    // Assert
    should(subject.api.calls).deepEqual([{ method: 'resume', args: ['ses-1', 'carry on'] }]);
  });

  it('should suggest callsigns', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.run(['name', '--count', '1', '--json']);

    // Assert
    should(subject.api.calls).deepEqual([{ method: 'suggestNames', args: [1] }]);
    should(JSON.parse(subject.io.out.join('\n'))).deepEqual(['Hayden']);
  });

  it('should record a lifecycle signal for the current session', async () => {
    // Arrange
    const waiting = sessionView(
      {},
      { status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z', peer: 'ses-peer' } },
    );
    const subject = harness({ signal: waiting }, { cwd: '/work/repo', callerSessionId: 'ses-caller' });

    // Act
    await subject.run(['signal', 'waiting', 'external', 'build', '--peer', 'ses-peer', '--until', '45m', '--json']);

    // Assert
    should(subject.api.calls[0]?.args).deepEqual([
      'ses-caller',
      'waiting',
      'external build',
      { until: '45m', peer: 'ses-peer' },
    ]);
    should(JSON.parse(subject.io.out[0] ?? '')).have.property('state');
  });
});
