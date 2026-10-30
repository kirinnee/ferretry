import { describe, it } from 'bun:test';
import type { SendRecord, SendResult } from '@ferretry/protocol';
import should from 'should';
import { AnswerQuestionController } from '../../../src/lib/session/answer-controller.ts';
import { InterruptSessionController, ResumeSessionController } from '../../../src/lib/session/lifecycle-controllers.ts';
import { SuggestNamesController } from '../../../src/lib/session/name-controller.ts';
import type { SessionEnvironment } from '../../../src/lib/session/ports.ts';
import { ListSessionsController } from '../../../src/lib/session/ps-controller.ts';
import { SendMessageController } from '../../../src/lib/session/send-controller.ts';
import { describeDisposition, describeFate } from '../../../src/lib/session/send-plan.ts';
import { SignalSessionController } from '../../../src/lib/session/signal-controller.ts';
import { StartSessionController } from '../../../src/lib/session/start-controller.ts';
import { SessionStatusController } from '../../../src/lib/session/status-controller.ts';
import {
  attachmentView,
  capturedPresenter,
  FakeFiles,
  RecordingApi,
  RecordingBoard,
  SteppedClock,
  WAIT_CLOCK,
} from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

const HERE: SessionEnvironment = { cwd: '/work/repo' };
const IN_PANE: SessionEnvironment = { cwd: '/work/repo', callerSessionId: 'ses-caller' };

const sendResult = (disposition: SendResult['disposition'], teammate?: string): SendResult => ({
  ...sessionView(teammate === undefined ? {} : { teammate }),
  disposition,
});

describe('StartSessionController', () => {
  it('should compose the prompt from arguments and the prompt file, then print the session', async () => {
    // Arrange
    const api = new RecordingApi({ start: sessionView({ teammate: 'Hayden' }) });
    const files = new FakeFiles({ '/tmp/brief.md': 'the long brief' });
    const { io, presenter } = capturedPresenter();
    const controller = new StartSessionController(api, files, presenter, HERE, 'fy');

    // Act
    await controller.execute({ agent: 'claude-alpha', mode: 'auto', prompt: 'do it', promptFile: '/tmp/brief.md' });

    // Assert
    should(api.calls[0]?.args[0]).containDeep({ prompt: 'do it\n\nthe long brief', agent: 'claude-alpha' });
    should(io.out[0]).startWith('Hayden (ses-1)');
    should(io.err).be.empty();
  });

  it('should title a pointer prompt from the file it points at, and never override --name', async () => {
    // Arrange
    const api = new RecordingApi({ start: sessionView() });
    const files = new FakeFiles({ '/tmp/brief.md': '# Add Interactive Default' });
    const { presenter } = capturedPresenter();
    const controller = new StartSessionController(api, files, presenter, HERE, 'fy');
    const prompt = 'You are an implementer. Read /tmp/brief.md and follow it.';

    // Act
    await controller.execute({ agent: 'claude-alpha', mode: 'auto', prompt });
    await controller.execute({ agent: 'claude-alpha', mode: 'auto', prompt, name: 'Mine' });

    // Assert
    should(api.calls[0]?.args[0]).containDeep({ name: 'Add Interactive Default' });
    should(api.calls[1]?.args[0]).containDeep({ name: 'Mine' });
  });

  it('should read every attachment and pass the idempotency key through', async () => {
    // Arrange
    const api = new RecordingApi({ start: sessionView() });
    const files = new FakeFiles({}, { 'shot.png': { filename: 'shot.png', mime: 'image/png', base64: 'AAAA' } });
    const { presenter } = capturedPresenter();
    const controller = new StartSessionController(api, files, presenter, HERE, 'fy');

    // Act
    await controller.execute({
      agent: 'claude-alpha',
      mode: 'auto',
      prompt: 'look',
      filePaths: ['shot.png'],
      requestId: 'req-1',
    });

    // Assert
    should(api.calls[0]?.args[0]).containDeep({ initialAttachments: [{ filename: 'shot.png', mime: 'image/png' }] });
    should(api.calls[0]?.args[1]).equal('req-1');
  });

  it('should report a start warning on stderr so --json output stays parseable', async () => {
    // Arrange
    const api = new RecordingApi({ start: sessionView() });
    const { io, presenter } = capturedPresenter();
    const controller = new StartSessionController(api, new FakeFiles(), presenter, HERE, 'fy');

    // Act
    await controller.execute({ agent: 'claude-alpha', mode: 'auto', prompt: 'go', turnTimeout: 60, json: true });

    // Assert
    should(io.err[0]).match(/hard KILL timer/);
    should(JSON.parse(io.out.join('\n'))).containDeep({ config: { id: 'ses-1' } });
  });

  it('should say where to watch a session that is still launching', async () => {
    // Arrange
    const api = new RecordingApi({ start: sessionView({}, { status: 'starting' }) });
    const { io, presenter } = capturedPresenter();
    const controller = new StartSessionController(api, new FakeFiles(), presenter, HERE, 'foo');

    // Act
    await controller.execute({ agent: 'claude-alpha', mode: 'auto', prompt: 'go' });

    // Assert
    should(io.err.join('\n')).match(/still launching in the background/);
    // The hint names the binary it was given, so a renamed CLI never advises a command that is gone.
    should(io.err.join('\n')).match(/watch it with `foo ps` or `foo status /);
  });

  it('should refuse an auto start with no prompt before calling the daemon', async () => {
    // Arrange
    const api = new RecordingApi();
    const { presenter } = capturedPresenter();
    const controller = new StartSessionController(api, new FakeFiles(), presenter, HERE, 'fy');

    // Act
    const failure = await controller.execute({ agent: 'claude-alpha', mode: 'auto' }).catch((error: Error) => error);

    // Assert
    should((failure as Error).message).match(/provide a prompt/);
    should(api.calls).be.empty();
  });
});

describe('ListSessionsController', () => {
  it('should print the table of live sessions', async () => {
    // Arrange
    const api = new RecordingApi({
      list: [sessionView({ id: 'ses-1' }), sessionView({ id: 'ses-2' }, { status: 'completed' })],
    });
    const board = new RecordingBoard();
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, board, { amber: cell => cell }).execute();

    // Assert
    should(io.out[0]).startWith('TEAMMATE');
    should(io.out).have.length(2);
    should(io.out[1]).match(/ses-1/);
    should(board.calls).equal(0);
  });

  it('should name each focus card and its lane in the CARD column, one board read for all of them', async () => {
    // Arrange
    const api = new RecordingApi({
      list: [
        sessionView({ id: 'ses-1', focusTask: { id: 'F18' }, name: 'Send Retry Duplicates' }),
        sessionView({ id: 'ses-2', focusTask: { id: 'F21' }, name: 'Board Activity Finish' }),
      ],
    });
    const board = new RecordingBoard(
      new Map([
        ['F18', 'Plan/Design'],
        ['F21', 'Implement'],
      ]),
    );
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, board, { amber: cell => cell }).execute();

    // Assert
    should(io.out[1]).match(/&F18 Plan\/Design/);
    should(io.out[2]).match(/&F21 Implement/);
    should(board.calls).equal(1);
  });

  it('should still print the ids when the board cannot be read', async () => {
    // Arrange
    const api = new RecordingApi({ list: [sessionView({ id: 'ses-1', focusTask: { id: 'F18' } })] });
    const board = new RecordingBoard(new Map(), new Error('daemon: no board'));
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, board, { amber: cell => cell }).execute();

    // Assert
    should(io.err).be.empty();
    should(io.out[1]).match(/&F18( |$)/);
  });

  it('should print the empty explanation rather than a bare header', async () => {
    // Arrange
    const api = new RecordingApi({ list: [] });
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, new RecordingBoard(), { amber: cell => cell }).execute({
      label: 'batch',
    });

    // Assert
    should(io.out).deepEqual(['no sessions with label "batch"']);
  });

  it('should print an empty JSON array instead of prose when --json is asked for', async () => {
    // Arrange
    const api = new RecordingApi({ list: [] });
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, new RecordingBoard(), { amber: cell => cell }).execute({
      json: true,
    });

    // Assert
    should(JSON.parse(io.out.join('\n'))).deepEqual([]);
  });

  it('should add the focus card and its lane to each --json row without touching the rest', async () => {
    // Arrange
    const api = new RecordingApi({
      list: [
        sessionView({ id: 'ses-1', focusTask: { id: 'F18' } }),
        // A card the board read missed: cited, with no lane name invented for it.
        sessionView({ id: 'ses-2', focusTask: { id: 'F19' } }),
        sessionView({ id: 'ses-3' }),
      ],
    });
    const board = new RecordingBoard(new Map([['F18', 'Plan/Design']]));
    const { io, presenter } = capturedPresenter();

    // Act
    await new ListSessionsController(api, presenter, board, { amber: cell => cell }).execute({ json: true });

    // Assert
    const rows = JSON.parse(io.out.join('\n')) as Array<Record<string, unknown>>;
    should(rows[0]).properties({ focusCard: '&F18', focusLaneName: 'Plan/Design' });
    should(rows[0]?.config).properties({ id: 'ses-1', focusTask: { id: 'F18' } });
    should(rows[1]).property('focusCard', '&F19');
    should(Object.keys(rows[1] ?? {})).not.containEql('focusLaneName');
    should(Object.keys(rows[2] ?? {})).not.containEql('focusCard');
  });
});

describe('SessionStatusController', () => {
  it('should print one session in detail', async () => {
    // Arrange
    const api = new RecordingApi({ get: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SessionStatusController(api, presenter).execute('ses-1');

    // Assert
    should(api.calls).deepEqual([{ method: 'get', args: ['ses-1'] }]);
    should(io.out.join('\n')).match(/liveness:/);
  });

  it('should publish the schema-parsed view for --json', async () => {
    // Arrange
    const api = new RecordingApi({ get: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SessionStatusController(api, presenter).execute('ses-1', { json: true });

    // Assert
    should(JSON.parse(io.out.join('\n'))).have.property('directory', '/state/sessions/ses-1');
  });
});

describe('SendMessageController', () => {
  it('should upload the attachments, send the message, and report the disposition', async () => {
    // Arrange
    const api = new RecordingApi({
      send: sendResult('delivered'),
      upload: attachmentView,
    });
    const files = new FakeFiles();
    const { io, presenter } = capturedPresenter();

    // Act
    await new SendMessageController(api, files, presenter, HERE, WAIT_CLOCK).execute('ses-1', {
      message: 'look at this',
      attachmentPaths: ['shot.png'],
    });

    // Assert
    should(api.methods()).deepEqual(['upload', 'send']);
    should(api.calls[1]?.args[1]).deepEqual({ message: 'look at this', attachmentIds: ['att-1'], now: false });
    should(io.err).containEql('delivered');
  });

  it('should read a message file and join it after the typed words', async () => {
    // Arrange
    const api = new RecordingApi({ send: sendResult('queued') });
    const files = new FakeFiles({ '/tmp/msg.md': 'the details' });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SendMessageController(api, files, presenter, HERE, WAIT_CLOCK).execute('ses-1', {
      message: 'heads up',
      messageFile: '/tmp/msg.md',
    });

    // Assert
    should(api.calls[0]?.args[1]).containDeep({ message: 'heads up\n\nthe details' });
    should(io.err.join('\n')).match(/auto-submits at the turn boundary/);
  });

  it('should never upload an attachment for a send it is going to refuse', async () => {
    // Arrange
    const api = new RecordingApi({ send: sendResult('delivered') });
    const { presenter } = capturedPresenter();

    // Act
    const failure = await new SendMessageController(api, new FakeFiles(), presenter, HERE, WAIT_CLOCK)
      .execute('ses-1', { message: 'and you?', ask: true, attachmentPaths: ['shot.png'] })
      .catch((error: Error) => error);

    // Assert
    should((failure as Error).message).match(/only works from inside a session/);
    should(api.calls).be.empty();
  });

  it('should park the caller on the peer it messaged', async () => {
    // Arrange
    const api = new RecordingApi({ send: sendResult('queued', 'Hayden'), signal: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SendMessageController(api, new FakeFiles(), presenter, IN_PANE, WAIT_CLOCK).execute('Hayden', {
      message: 'and you?',
      ask: true,
      until: '2h',
    });

    // Assert
    should(api.methods()).deepEqual(['send', 'signal']);
    should(api.calls[0]?.args[1]).containDeep({ replyExpected: true });
    should(api.calls[1]?.args).deepEqual([
      'ses-caller',
      'waiting',
      undefined,
      { peer: 'ses-1', until: '2h', condition: 'a reply from Hayden' },
    ]);
    should(io.err.join('\n')).match(/parked awaiting a reply from Hayden \(until 2h\)/);
  });

  it('should keep a delivered send a success when only the park after it failed', async () => {
    // Arrange — no `signal` stub, so the park is refused the way an unreachable daemon refuses it.
    const api = new RecordingApi({ send: sendResult('queued', 'Hayden') });
    const { io, presenter } = capturedPresenter();

    // Act — resolving, not rejecting: a script that retried a non-zero exit would send it twice.
    await new SendMessageController(api, new FakeFiles(), presenter, IN_PANE, WAIT_CLOCK).execute('Hayden', {
      message: 'and you?',
      ask: true,
    });

    // Assert
    should(api.methods()).deepEqual(['send', 'signal']);
    should(io.exitCode).equal(0);
    should(io.err.join('\n')).match(
      /message sent, but this session could not be parked to wait for Hayden \(the test did not stub signal\); do not send it again/u,
    );
    should(io.err.join('\n')).not.match(/parked awaiting a reply/u);
    should(io.out).not.be.empty();
  });

  it('should refuse to park when the message only queued for a revive', async () => {
    // Arrange
    const api = new RecordingApi({ send: sendResult('queued-for-revive', 'Hayden') });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SendMessageController(api, new FakeFiles(), presenter, IN_PANE, WAIT_CLOCK).execute('Hayden', {
      message: 'and you?',
      ask: true,
    });

    // Assert
    should(api.methods()).deepEqual(['send']);
    should(io.err.join('\n')).match(/was not parked/);
  });

  it('should mark an immediate steer on the wire', async () => {
    // Arrange
    const api = new RecordingApi({ send: sendResult('delivered') });
    const { presenter } = capturedPresenter();

    // Act
    await new SendMessageController(api, new FakeFiles(), presenter, HERE, WAIT_CLOCK).execute('ses-1', {
      message: 'stop',
      now: true,
    });

    // Assert
    should(api.calls[0]?.args[1]).containDeep({ now: true });
  });
});

describe('SendMessageController --wait', () => {
  const row = (fate: SendRecord['fate'], extra: Partial<SendRecord> = {}): SendRecord => ({
    v: 1,
    sendId: 'req-1',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    acceptedTurn: 1,
    path: 'direct',
    message: 'hi',
    attachmentIds: [],
    fate,
    ...extra,
  });
  const tracked = (disposition: SendResult['disposition'] = 'sent'): SendResult => ({
    ...sendResult(disposition),
    sendId: 'req-1',
    fate: 'accepted',
  });

  it('should poll the send until it is delivered, and say so', async () => {
    // Arrange
    const api = new RecordingApi({ send: tracked(), sendStatus: [row('accepted'), row('queued'), row('delivered')] });
    const { io, presenter } = capturedPresenter();
    const clock = new SteppedClock();

    // Act
    await new SendMessageController(api, new FakeFiles(), presenter, HERE, clock).execute('ses-1', {
      message: 'hi',
      wait: true,
    });

    // Assert
    should(api.methods()).deepEqual(['send', 'sendStatus', 'sendStatus', 'sendStatus']);
    should(api.calls[1]?.args).deepEqual(['ses-1', 'req-1']);
    should(clock.slept).deepEqual([2_000, 2_000]);
    should(io.err.join('\n')).match(/delivered — the agent’s transcript shows the message/);
  });

  it('should fail a send proven not delivered, and only report an unconfirmed one', async () => {
    // Arrange
    const lost = new RecordingApi({
      send: tracked(),
      sendStatus: [row('timed_out', { unaccountedReason: 'not_delivered', attempt: 2 })],
    });
    const unsure = new RecordingApi({ send: tracked(), sendStatus: [row('unaccounted')] });
    const unsureIo = capturedPresenter();

    // Act
    const failure = await new SendMessageController(
      lost,
      new FakeFiles(),
      capturedPresenter().presenter,
      HERE,
      WAIT_CLOCK,
    )
      .execute('ses-1', { message: 'hi', wait: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await new SendMessageController(unsure, new FakeFiles(), unsureIo.presenter, HERE, WAIT_CLOCK).execute('ses-1', {
      message: 'hi',
      wait: true,
    });

    // Assert
    should((failure as Error).message).equal(
      'not delivered (not delivered) after 2 attempt(s); it is safe to send it again',
    );
    should(unsureIo.io.err.join('\n')).match(/unconfirmed \(timeout\) — it may still have landed/);
  });

  it('should fail a wait on a send a person cancelled, saying what the cancel did', async () => {
    // Arrange
    const api = new RecordingApi({
      send: tracked(),
      sendStatus: [row('cancelled', { cancelEffect: 'left_in_queue' })],
    });

    // Act
    const failure = await new SendMessageController(
      api,
      new FakeFiles(),
      capturedPresenter().presenter,
      HERE,
      WAIT_CLOCK,
    )
      .execute('ses-1', { message: 'hi', wait: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should((failure as Error).message).match(/^cancelled by a person — the agent was already holding it/);
    should(describeFate(row('cancelled'))).match(/it never reached the agent/);
    should(describeFate(row('accepted', { typedNotSent: true }))).match(/typed into the agent’s composer and not sent/);
  });

  it('should stop waiting after five minutes, and cannot wait on a daemon that names no send', async () => {
    // Arrange
    const slow = new RecordingApi({ send: tracked(), sendStatus: [row('queued')] });
    const slowIo = capturedPresenter();
    const old = new RecordingApi({ send: sendResult('delivered') });
    const oldIo = capturedPresenter();

    // Act
    await new SendMessageController(slow, new FakeFiles(), slowIo.presenter, HERE, new SteppedClock()).execute(
      'ses-1',
      { message: 'hi', wait: true },
    );
    await new SendMessageController(old, new FakeFiles(), oldIo.presenter, HERE, WAIT_CLOCK).execute('ses-1', {
      message: 'hi',
      wait: true,
    });

    // Assert
    should(slow.methods().filter(method => method === 'sendStatus')).have.length(151);
    should(slowIo.io.err.join('\n')).match(
      /still queued — the agent is holding it until its current turn ends after 5m/,
    );
    should(oldIo.io.err.join('\n')).match(/cannot be waited on/);
    should(describeFate(row('accepted'))).equal('accepted — not yet proven anywhere');
    should(describeDisposition('sent')).match(/not yet proven queued/);
  });
});

describe('AnswerQuestionController', () => {
  it('should answer the tool call the session is actually waiting on', async () => {
    // Arrange
    const pending = sessionView(
      {},
      { status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-7', questions: [{ question: 'Ship it?' }] } },
    );
    const api = new RecordingApi({ get: pending, answer: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new AnswerQuestionController(api, presenter).execute('ses-1', { labels: ['yes'] });

    // Assert
    should(api.methods()).deepEqual(['get', 'answer']);
    should(api.calls[1]?.args).deepEqual(['ses-1', 'tool-7', ['yes'], undefined, undefined]);
    should(io.out[0]).startWith('- (ses-1)');
  });

  it('should not send an answer to a session with no question pending', async () => {
    // Arrange
    const api = new RecordingApi({ get: sessionView(), answer: sessionView() });
    const { presenter } = capturedPresenter();

    // Act
    const failure = await new AnswerQuestionController(api, presenter)
      .execute('ses-1', { labels: ['yes'] })
      .catch((error: Error) => error);

    // Assert
    should((failure as Error).message).match(/no pending question/);
    should(api.methods()).deepEqual(['get']);
  });
});

describe('SuggestNamesController', () => {
  it('should print one callsign per line by default', async () => {
    // Arrange
    const api = new RecordingApi({ suggestNames: ['Hayden'] });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SuggestNamesController(api, presenter).execute();

    // Assert
    should(api.calls).deepEqual([{ method: 'suggestNames', args: [1] }]);
    should(io.out).deepEqual(['Hayden']);
  });

  it('should print a JSON array when asked', async () => {
    // Arrange
    const api = new RecordingApi({ suggestNames: ['Hayden', 'Marlow'] });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SuggestNamesController(api, presenter).execute({ count: 2, json: true });

    // Assert
    should(JSON.parse(io.out.join('\n'))).deepEqual(['Hayden', 'Marlow']);
  });

  const badCounts: readonly number[] = [0, -1, 1.5, Number.NaN];
  for (const count of badCounts) {
    it(`should refuse the count ${count} instead of silently asking for one`, async () => {
      // Arrange
      const api = new RecordingApi({ suggestNames: ['Hayden'] });
      const { presenter } = capturedPresenter();

      // Act
      const failure = await new SuggestNamesController(api, presenter)
        .execute({ count })
        .catch((error: Error) => error);

      // Assert
      should((failure as Error).message).match(/--count must be an integer of at least 1/);
      should(api.calls).be.empty();
    });
  }
});

describe('InterruptSessionController', () => {
  it('should interrupt and print the resulting session', async () => {
    // Arrange
    const api = new RecordingApi({ interrupt: sessionView({}, { status: 'interrupted' }) });
    const { io, presenter } = capturedPresenter();

    // Act
    await new InterruptSessionController(api, presenter).execute('ses-1');

    // Assert
    should(api.calls).deepEqual([{ method: 'interrupt', args: ['ses-1'] }]);
    should(io.out[0]).match(/interrupted/);
  });

  it('should publish JSON when asked', async () => {
    // Arrange
    const api = new RecordingApi({ interrupt: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new InterruptSessionController(api, presenter).execute('ses-1', { json: true });

    // Assert
    should(JSON.parse(io.out.join('\n'))).have.property('config');
  });
});

describe('ResumeSessionController', () => {
  it('should resume with the message the caller typed', async () => {
    // Arrange
    const api = new RecordingApi({ resume: sessionView() });
    const { presenter } = capturedPresenter();

    // Act
    await new ResumeSessionController(api, presenter).execute('ses-1', { message: ' pick this up ' });

    // Assert
    should(api.calls).deepEqual([{ method: 'resume', args: ['ses-1', 'pick this up'] }]);
  });

  it('should resume bare when no message was given', async () => {
    // Arrange
    const api = new RecordingApi({ resume: sessionView() });
    const { io, presenter } = capturedPresenter();

    // Act
    await new ResumeSessionController(api, presenter).execute('ses-1', { message: '   ', json: true });

    // Assert
    should(api.calls).deepEqual([{ method: 'resume', args: ['ses-1', undefined] }]);
    should(JSON.parse(io.out.join('\n'))).have.property('state');
  });

  it('should resume with no flags at all', async () => {
    // Arrange
    const api = new RecordingApi({ resume: sessionView() });
    const { presenter } = capturedPresenter();

    // Act
    await new ResumeSessionController(api, presenter).execute('ses-1');

    // Assert
    should(api.calls).deepEqual([{ method: 'resume', args: ['ses-1', undefined] }]);
  });
});

describe('SignalSessionController', () => {
  it('should record a declared peer wait for the calling session', async () => {
    // Arrange
    const waiting = sessionView(
      {},
      { status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z', peer: 'ses-peer', peerName: 'Hayden' } },
    );
    const api = new RecordingApi({ signal: waiting });
    const { io, presenter } = capturedPresenter();
    const controller = new SignalSessionController(api, presenter, IN_PANE);

    // Act
    await controller.execute('waiting', ' build ', { peer: ' Hayden ', on: ' a reply ', until: ' 2h ' });

    // Assert
    should(api.calls[0]?.args).deepEqual([
      'ses-caller',
      'waiting',
      'build',
      { until: '2h', condition: 'a reply', peer: 'Hayden' },
    ]);
    should(io.out[0]).containEql('waiting recorded for a reply from Hayden (open-ended)');
    should(io.out[0]).containEql('daemon wakes this session');
  });

  it('should accept an explicit session and report a condition deadline', async () => {
    // Arrange
    const waiting = sessionView(
      {},
      {
        status: 'waiting',
        waiting: { since: '2026-01-01T00:00:00.000Z', condition: 'CI', until: '2026-01-01T02:00:00.000Z' },
      },
    );
    const api = new RecordingApi({ signal: waiting });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SignalSessionController(api, presenter, HERE).execute('waiting', undefined, {
      session: ' Fable ',
      on: 'CI',
    });

    // Assert
    should(api.calls[0]?.args[0]).equal('Fable');
    should(io.out[0]).containEql('for CI until 2026-01-01T02:00:00.000Z');
  });

  it('should print the resulting session as JSON', async () => {
    // Arrange
    const api = new RecordingApi({ signal: sessionView({}, { status: 'completed' }) });
    const { io, presenter } = capturedPresenter();

    // Act
    await new SignalSessionController(api, presenter, IN_PANE).execute('done', undefined, { json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.property('state');
  });

  it('should render each non-waiting lifecycle acknowledgement', async () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    for (const kind of ['done', 'help', 'working'] as const) {
      const api = new RecordingApi({ signal: sessionView() });
      await new SignalSessionController(api, presenter, IN_PANE).execute(
        kind,
        kind === 'help' ? 'blocked' : undefined,
        {},
      );
    }

    // Assert
    should(io.out).deepEqual(['done signal recorded', 'help signal recorded', 'working signal recorded']);
  });

  it('should reject caller mistakes before contacting the daemon', async () => {
    // Arrange
    const api = new RecordingApi({ signal: sessionView() });
    const { presenter } = capturedPresenter();

    // Act + Assert
    await should(new SignalSessionController(api, presenter, IN_PANE).execute('nope', undefined, {})).be.rejectedWith(
      /kind must be one of/u,
    );
    await should(new SignalSessionController(api, presenter, HERE).execute('done', undefined, {})).be.rejectedWith(
      /FY_SESSION_ID is unset/u,
    );
    await should(new SignalSessionController(api, presenter, IN_PANE).execute('help', '   ', {})).be.rejectedWith(
      'signal help requires a message',
    );
    await should(
      new SignalSessionController(api, presenter, IN_PANE).execute('done', undefined, { until: '2h' }),
    ).be.rejectedWith('--until/--on/--peer apply to `signal waiting`');
    should(api.calls).be.empty();
  });

  it('should fail closed when a waiting response carries no wait evidence', async () => {
    // Arrange
    const api = new RecordingApi({ signal: sessionView({}, { status: 'waiting' }) });
    const { presenter } = capturedPresenter();

    // Act + Assert
    await should(
      new SignalSessionController(api, presenter, IN_PANE).execute('waiting', undefined, {}),
    ).be.rejectedWith('daemon accepted waiting but returned no declared-wait state');
  });
});
