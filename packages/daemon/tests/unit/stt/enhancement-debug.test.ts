/**
 * The debug echo of a daemon enhancement call: asked for by the caller, built from the same shared
 * decisions the browser uses, returned to that caller only, and never part of what the daemon logs.
 */

import { describe, it } from 'bun:test';
import { TRACE_REDACTED } from '@ferretry/protocol';
import should from 'should';
import {
  type AuthorizedOutcome,
  DEFAULT_CLEANUP_SETTINGS,
  type EnhancementAuthorizer,
  type EnhancementHttpRequest,
  type EnhancementReport,
  enhancementErrorView,
  SttEnhancementError,
  SttEnhancementService,
  type SttMonotonicClockPort,
} from '../../../src/lib/index.ts';

class ScriptedAuthorizer implements EnhancementAuthorizer {
  readonly sent: EnhancementHttpRequest[] = [];

  constructor(private readonly outcomes: AuthorizedOutcome[]) {}

  async send(_secret: string, _hosts: readonly string[], request: EnhancementHttpRequest): Promise<AuthorizedOutcome> {
    this.sent.push(request);
    const next = this.outcomes.shift();
    if (next === undefined) throw new Error('no outcome scripted');
    return next;
  }
}

class StepClock implements SttMonotonicClockPort {
  private now = 0;

  monotonicMs(): number {
    this.now += 10;
    return this.now;
  }
}

const completion = (content: string, extra: Record<string, unknown> = {}): AuthorizedOutcome => ({
  kind: 'completion',
  payload: {
    choices: [{ message: { content, reasoning: 'thinking aloud' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
    ...extra,
  },
});

const WITH_CONTEXT = { ...DEFAULT_CLEANUP_SETTINGS, useConversation: true };

function harness(outcomes: AuthorizedOutcome[]) {
  const reports: EnhancementReport[] = [];
  const authorizer = new ScriptedAuthorizer(outcomes);
  const service = new SttEnhancementService(authorizer, new StepClock(), {
    cleanup: () => WITH_CONTEXT,
    report: report => reports.push(report),
  });
  return { authorizer, service, reports };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  text: 'send the report to bob',
  provider: 'groq',
  context: ['an earlier line'],
  debug: true,
  ...overrides,
});

describe('the daemon debug echo', () => {
  it('should return the record of a cleaned call, redacted and timed on the monotonic clock', async () => {
    // Arrange
    const { service } = harness([completion('Send the report to Bob.')]);

    // Act
    const actual = await service.enhance(body());

    // Assert
    const trace = actual.debug;
    should(trace?.via).equal('daemon');
    should(trace?.outcome).equal('cleaned');
    should(trace?.finalText).equal('Send the report to Bob.');
    should(trace?.host).equal('api.groq.com');
    should(trace?.startedAt).be.undefined();
    should(trace?.attempts).have.length(1);
    const attempt = trace?.attempts[0];
    should(attempt?.withContext).be.true();
    should(attempt?.request.headers.authorization).equal(TRACE_REDACTED);
    should(attempt?.request.messages[1]?.content)
      .containEql('send the report to bob')
      .and.containEql('an earlier line');
    should(attempt?.response?.reasoning).equal('thinking aloud');
    should(attempt?.response?.usage).deepEqual({ promptTokens: 50, completionTokens: 9, totalTokens: 59 });
    should(attempt?.timings.totalMs).equal(10);
    should(attempt?.timings.firstByteMs).be.undefined();
  });

  it('should return the record of a call whose reply the guard refused', async () => {
    // Arrange
    const { service } = harness([completion('Sure! Here is a poem about a completely different subject entirely.')]);

    // Act
    const actual = await service.enhance(body());

    // Assert
    should(actual.kept).equal('raw');
    should(actual.debug?.outcome).equal('kept_raw');
    should(actual.debug?.finalText).equal('send the report to bob');
    should(actual.debug?.attempts[0]?.response?.steps.map(step => step.step)).deepEqual(['guard_rejected', 'kept_raw']);
  });

  it('should hand the record of a failed call to the error, with the status and no provider body', async () => {
    // Arrange
    const { service } = harness([{ kind: 'status', status: 401 }]);

    // Act
    const failure = await service.enhance(body()).then(
      () => undefined,
      (error: unknown) => error as SttEnhancementError,
    );

    // Assert
    should(failure?.code).equal('secret_invalid');
    const view = failure === undefined ? undefined : enhancementErrorView(failure);
    should(view?.debug?.outcome).equal('failed');
    should(view?.debug?.failure).deepEqual({ code: 'secret_invalid', message: failure?.message });
    should(view?.debug?.attempts[0]?.status).equal(401);
    should(view?.debug?.attempts[0]?.failure).equal(failure?.message);
    should(view?.debug?.attempts[0]?.response).be.undefined();
  });

  it('should record both attempts when the call is repeated without the conversation', async () => {
    // Arrange
    const { service, authorizer } = harness([{ kind: 'status', status: 413 }, completion('Send the report to Bob.')]);

    // Act
    const actual = await service.enhance(body());

    // Assert
    should(authorizer.sent).have.length(2);
    should(actual.debug?.attempts.map(attempt => attempt.withContext)).deepEqual([true, false]);
    should(actual.debug?.attempts[0]?.status).equal(413);
    should(actual.debug?.outcome).equal('cleaned');
  });

  it('should keep nothing and read the clock no more than before when the caller did not ask', async () => {
    // Arrange
    const { service } = harness([completion('Send the report to Bob.')]);

    // Act
    const actual = await service.enhance(body({ debug: undefined }));
    const refused = await harness([{ kind: 'status', status: 401 }])
      .service.enhance(body({ debug: false }))
      .then(
        () => undefined,
        (error: unknown) => enhancementErrorView(error as SttEnhancementError),
      );

    // Assert
    should(actual).not.have.property('debug');
    should(refused).deepEqual({
      error: 'enhancement provider rejected the daemon credentials (HTTP 401); check the provider key',
      code: 'secret_invalid',
    });
  });

  it('should carry no record on a refusal that happened before any call was made', async () => {
    // Arrange
    const { service } = harness([]);

    // Act
    const failure = await service.enhance(body({ text: '   ' })).then(
      () => undefined,
      (error: unknown) => error as SttEnhancementError,
    );

    // Assert
    should(failure?.code).equal('bad_request');
    should(failure?.trace).be.undefined();
  });

  it('should never put the record, the dictation or the reply in what the daemon logs', async () => {
    // Arrange
    const { service, reports } = harness([completion('Send the report to Bob.')]);

    // Act
    await service.enhance(body());

    // Assert
    const logged = JSON.stringify(reports);
    should(reports).have.length(1);
    should(logged).not.containEql('debug');
    should(logged).not.containEql('send the report');
    should(logged).not.containEql('Send the report');
    should(logged).not.containEql('thinking aloud');
  });

  it('should describe an attempt that ended without a reply by what it failed with', async () => {
    // Arrange
    const { service } = harness([{ kind: 'timeout' }]);

    // Act
    const failure = await service.enhance(body({ context: undefined })).then(
      () => undefined,
      (error: unknown) => error as SttEnhancementError,
    );

    // Assert
    should(failure?.trace?.attempts[0]?.withContext).be.false();
    should(failure?.trace?.attempts[0]?.failure).equal('enhancement request timed out');
    should(failure?.trace?.attempts[0]?.status).be.undefined();
  });
});
