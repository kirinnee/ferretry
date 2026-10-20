import { describe, it } from 'bun:test';
import { completionBudget, type SttEnhancementResult } from '@ferretry/protocol';
import should from 'should';
import {
  type AuthorizedOutcome,
  buildEnhancementBody,
  classifyEnhancementOutcome,
  DEFAULT_CLEANUP_SETTINGS,
  DEFAULT_ENHANCEMENT_PROVIDERS,
  type EnhancementAuthorizer,
  type EnhancementHttpRequest,
  type EnhancementReport,
  enhancementErrorForStatus,
  parseEnhancementRequest,
  type SttEnhancementError,
  SttEnhancementService,
  type SttMonotonicClockPort,
} from '../../../src/lib/index.ts';

describe('request budget', () => {
  const parsed = (text: string, context: string[] = []) =>
    parseEnhancementRequest({ text, provider: 'groq', context }, DEFAULT_ENHANCEMENT_PROVIDERS, {
      ...DEFAULT_CLEANUP_SETTINGS,
      useConversation: true,
    });

  it('should cap the reply and scale the cap with the dictation', () => {
    // Assert
    should(completionBudget(parsed('short'))).equal(1_024);
    should(completionBudget(parsed('word '.repeat(1_500)))).be.above(1_024);
    should(completionBudget(parsed('汉'.repeat(8_000)))).equal(4_096);
    should(buildEnhancementBody(parsed('short')).max_completion_tokens).equal(1_024);
  });

  it('should send each reference message on its own line inside the reference block', () => {
    // Arrange
    const request = parsed('hello', ['the first earlier message', 'the second earlier message']);

    // Act
    const content = buildEnhancementBody(request).messages[1]?.content ?? '';

    // Assert
    should(content).containEql('<reference>\nthe first earlier message\nthe second earlier message\n</reference>');
  });
});

describe('every way the provider can fail', () => {
  const request = parseEnhancementRequest(
    { text: 'hello wold', provider: 'groq' },
    DEFAULT_ENHANCEMENT_PROVIDERS,
    DEFAULT_CLEANUP_SETTINGS,
  );
  const completion = (message: Record<string, unknown>, finish = 'stop'): AuthorizedOutcome => ({
    kind: 'completion',
    payload: { choices: [{ message, finish_reason: finish }] },
  });
  const failure = (outcome: AuthorizedOutcome): SttEnhancementError => {
    try {
      classifyEnhancementOutcome(outcome, request, 0);
    } catch (error) {
      return error as SttEnhancementError;
    }
    throw new Error('expected a rejection');
  };

  it('should name the status and the next step for each HTTP failure', () => {
    // Assert
    should(enhancementErrorForStatus(413).code).equal('too_long');
    should(enhancementErrorForStatus(413).message).match(/too large.*HTTP 413/u);
    should(enhancementErrorForStatus(400).message).match(/rejected the request \(HTTP 400\)/u);
    should(enhancementErrorForStatus(503).message).match(/HTTP 503/u);
    should(enhancementErrorForStatus(401).message).match(/check the provider key/u);
    should(enhancementErrorForStatus(404).message).match(/pick another model/u);
    should(enhancementErrorForStatus(429, 12).message).match(/try again in 12s/u);
    should(enhancementErrorForStatus(429).message).not.match(/try again/u);
    should(enhancementErrorForStatus(400).providerStatus).equal(400);
  });

  it('should say when the model spent its whole budget thinking and returned nothing', () => {
    // Assert
    should(failure(completion({ content: '', reasoning: 'hmm' }, 'length')).message).match(/whole reply budget/u);
    should(failure(completion({ content: '   ' })).message).match(/empty reply/u);
    should(failure(completion({ content: '<think>only thinking</think>' })).message).match(/empty reply/u);
  });

  it('should refuse an over-long reply rather than insert it', () => {
    // Assert
    should(failure(completion({ content: 'x'.repeat(16_001) })).message).match(/over-long/u);
  });

  it('should keep the raw transcript with the reason when the reply merges context, not throw', () => {
    // Act
    const actual = classifyEnhancementOutcome(
      completion({ content: '<think>x</think>Here is a long answer. '.repeat(8) }),
      request,
      3,
    );

    // Assert
    should(actual.kept).equal('raw');
    should(actual.text).equal('hello wold');
    should(actual.keptReason).match(/^The cleanup reply /u);
  });
});

class ScriptedProvider implements EnhancementAuthorizer {
  readonly bodies: string[] = [];
  constructor(private readonly script: readonly AuthorizedOutcome[]) {}

  async send(_secret: string, _hosts: readonly string[], request: EnhancementHttpRequest): Promise<AuthorizedOutcome> {
    this.bodies.push(request.body ?? '');
    const outcome = this.script[this.bodies.length - 1] ?? this.script.at(-1);
    if (outcome === undefined) throw new Error('empty script');
    return outcome;
  }
}

class Ticks implements SttMonotonicClockPort {
  private now = 0;
  monotonicMs(): number {
    this.now += 10;
    return this.now;
  }
}

const ok = (content: string): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { choices: [{ message: { content }, finish_reason: 'stop' }] },
});
const status = (code: number): AuthorizedOutcome => ({ kind: 'status', status: code });

describe('enhancement service with a fake provider', () => {
  const settings = { ...DEFAULT_CLEANUP_SETTINGS, useConversation: true };
  const input = {
    text: 'hello wold',
    provider: 'groq',
    context: ['the earlier agent reply about the world map'],
  };

  const run = async (script: readonly AuthorizedOutcome[], body: unknown = input) => {
    const provider = new ScriptedProvider(script);
    const reports: EnhancementReport[] = [];
    const service = new SttEnhancementService(provider, new Ticks(), {
      cleanup: () => settings,
      report: report => reports.push(report),
    });
    let result: SttEnhancementResult | undefined;
    let error: SttEnhancementError | undefined;
    try {
      result = await service.enhance(body);
    } catch (thrown) {
      error = thrown as SttEnhancementError;
    }
    return { provider, reports, result, error };
  };

  it('should retry once without the conversation when the provider says the request is too large', async () => {
    // Act
    const { provider, reports, result } = await run([status(413), ok('hello world')]);

    // Assert
    should(result?.text).equal('hello world');
    should(provider.bodies).have.length(2);
    should(provider.bodies[0]).containEql('the earlier agent reply');
    should(provider.bodies[1]).not.containEql('the earlier agent reply');
    should(reports).have.length(1);
    should(reports[0]).containDeep({ outcome: 'cleaned', retriedWithoutContext: true, contextMessages: 1 });
  });

  it("should retry on a provider 400 as well, and fail with the retry's own error when it fails too", async () => {
    // Act
    const { provider, reports, error } = await run([status(400), status(400)]);

    // Assert
    should(provider.bodies).have.length(2);
    should(error?.code).equal('provider_error');
    should(reports[0]).containDeep({
      outcome: 'failed',
      code: 'provider_error',
      providerStatus: 400,
      retriedWithoutContext: true,
    });
  });

  it('should not retry when there was no conversation to drop, or the failure is another kind', async () => {
    // Act
    const noContext = await run([status(413)], { text: 'hello wold', provider: 'groq' });
    const rateLimited = await run([{ kind: 'status', status: 429, retryAfterSeconds: 3 }]);
    const timedOut = await run([{ kind: 'timeout' }]);

    // Assert
    should(noContext.provider.bodies).have.length(1);
    should(rateLimited.provider.bodies).have.length(1);
    should(rateLimited.error?.retryAfterMs).equal(3_000);
    should(timedOut.error?.code).equal('timeout');
    should(timedOut.reports[0]).containDeep({ outcome: 'failed', code: 'timeout' });
  });

  it('should log a kept-raw reply with its reason and never the text', async () => {
    // Arrange
    const secret = 'quarterly numbers are confidential';

    // Act
    const { reports, result } = await run(
      [ok('Sure! Here is a much longer answer about something else entirely. '.repeat(3))],
      {
        ...input,
        text: secret,
        context: [`${secret} and more`],
      },
    );

    // Assert
    should(result?.kept).equal('raw');
    should(result?.text).equal(secret);
    should(reports[0]).containDeep({ outcome: 'kept_raw' });
    should(JSON.stringify(reports)).not.containEql('confidential');
    should(JSON.stringify(reports)).not.containEql('earlier agent');
  });

  it('should let a non-enhancement failure through without reporting it as one', async () => {
    // Act
    const { reports, error } = await run([ok('x')], { text: '', provider: 'groq' });

    // Assert
    should(error?.code).equal('bad_request');
    should(reports).have.length(0);
  });
});
