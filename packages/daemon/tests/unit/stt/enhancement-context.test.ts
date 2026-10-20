import { describe, it } from 'bun:test';
import { peerEnvelopePreamble, type SttEnhancementResult, turnFileInstruction } from '@ferretry/protocol';
import should from 'should';
import {
  type AuthorizedOutcome,
  buildEnhancementBody,
  CLEANUP_VIOLATION_REASONS,
  type CleanupViolation,
  CONTEXT_LIMITS,
  classifyEnhancementOutcome,
  cleanupViolation,
  completionBudget,
  conversationReference,
  DEFAULT_CLEANUP_SETTINGS,
  DEFAULT_ENHANCEMENT_PROVIDERS,
  type EnhancementAuthorizer,
  type EnhancementHttpRequest,
  type EnhancementReport,
  enhancementErrorForStatus,
  estimateTokens,
  parseChatCompletion,
  parseEnhancementRequest,
  type SttEnhancementError,
  SttEnhancementService,
  type SttMonotonicClockPort,
  withoutReasoning,
} from '../../../src/lib/index.ts';

const FENCE = '```';

describe('conversation reference', () => {
  it('should drop fenced code, keeping the prose around it', () => {
    // Arrange
    const reply = `I changed the loader.\n\n${FENCE}ts\nconst secretValue = load();\nexport default secretValue;\n${FENCE}\n\nThen the build passed.`;

    // Act
    const actual = conversationReference([reply], 8);

    // Assert
    should(actual).deepEqual(['I changed the loader. Then the build passed.']);
  });

  it('should drop an unterminated code fence to the end of the message', () => {
    // Arrange
    const reply = `Here is the patch for the loader.\n${FENCE}diff\n+const a = 1;\n+const b = 2;`;

    // Assert
    should(conversationReference([reply], 8)).deepEqual(['Here is the patch for the loader.']);
  });

  it('should flatten markdown to plain words and keep identifiers intact', () => {
    // Arrange
    const reply = '## Plan\n- **Rename** `read_config` in [the docs](https://example.com/docs/a)\n1. Run the checks';

    // Assert
    should(conversationReference([reply], 8)).deepEqual(['Plan Rename read_config in the docs Run the checks']);
  });

  it('should drop tool output, stack traces, diffs, tables, urls, long hashes and file paths', () => {
    // Arrange
    const noisy = [
      'The run failed with a timeout in the relay tests.',
      '$ bun test packages/relay',
      'TypeError: boom at the thing',
      '    at run (/srv/app/src/run.ts:10:4)',
      '@@ -1,3 +1,4 @@',
      '| name | value |',
      '|------|-------|',
      `See https://example.com/very/long/path and ${'a'.repeat(64)} in /srv/app/src/deep/file.ts for more.`,
    ].join('\n');

    // Act
    const actual = conversationReference([noisy], 8);

    // Assert
    should(actual).deepEqual(['The run failed with a timeout in the relay tests. See and in for more.']);
  });

  it('should drop Ferretry plumbing: notices and turn-file pointers', () => {
    // Arrange
    const pointer = turnFileInstruction('/home/x/.fy/s/turns/turn-001.md');
    const notice = '[ferretry] your message to the other agent did not arrive';

    // Act
    const actual = conversationReference([pointer, notice, 'Please check the staging deploy tonight.'], 8);

    // Assert
    should(actual).deepEqual(['Please check the staging deploy tonight.']);
  });

  it('should keep only the body of a peer message and unwrap a paste block', () => {
    // Arrange
    const peerBanner = peerEnvelopePreamble({ name: 'kite', sessionId: 's-1', kind: 'message', clientName: 'fy' });
    const pasted = '<pasted_content id="1">\nthe migration is ready for review today\n</pasted_content>';

    // Act
    const actual = conversationReference([`${peerBanner}the schema change landed overnight`, pasted], 8);

    // Assert
    should(actual.at(-1)).equal('the migration is ready for review today');
    should(actual.join(' ')).not.match(/not from the owner/u);
  });

  it('should keep the newest messages within the count and the budget, oldest first', () => {
    // Arrange
    const messages = Array.from({ length: 10 }, (_, index) => `message number ${String(index)} says something plain`);

    // Act
    const actual = conversationReference(messages, 3);

    // Assert
    should(actual).deepEqual([
      'message number 7 says something plain',
      'message number 8 says something plain',
      'message number 9 says something plain',
    ]);
  });

  it('should cap each message and the total, even for multi-megabyte replies', () => {
    // Arrange
    const huge = `${'plain words '.repeat(300_000)}final words`;

    // Act
    const actual = conversationReference([huge, huge, huge, huge, huge], 8);

    // Assert
    should(actual.every(line => line.length <= CONTEXT_LIMITS.maxMessageChars)).be.true();
    should(actual.join('\n').length).be.belowOrEqual(CONTEXT_LIMITS.maxTotalChars);
    should(actual.at(-1)?.endsWith('final words')).be.true();
  });

  it('should stop when the token budget is spent, which is what keeps a CJK conversation under a provider limit', () => {
    // Arrange — one script-without-spaces character costs about a token
    const cjk = '这是一个很长的句子需要被清理'.repeat(60);

    // Act
    const actual = conversationReference([cjk, cjk, cjk], 8);

    // Assert
    should(estimateTokens(actual.join(''))).be.belowOrEqual(CONTEXT_LIMITS.maxTotalTokens);
    should(actual.length).be.aboveOrEqual(1);
  });

  it('should skip empty messages and tolerate no context at all', () => {
    should(conversationReference(undefined, 8)).deepEqual([]);
    should(conversationReference(['', '   ', `${FENCE}\ncode only\n${FENCE}`], 8)).deepEqual([]);
  });

  it('should drop a message whose newest words alone overrun the token budget', () => {
    // Arrange — a short budget left over so only a sliver fits
    const first = '汉'.repeat(600);
    const second = '字'.repeat(600);

    // Act
    const actual = conversationReference([first, second], 8);

    // Assert
    should(estimateTokens(actual.join(''))).be.belowOrEqual(CONTEXT_LIMITS.maxTotalTokens);
  });

  it('should estimate tokens by script', () => {
    should(estimateTokens('abcd')).equal(2);
    should(estimateTokens('é')).equal(1);
    should(estimateTokens('漢')).equal(1);
  });
});

describe('the cleanup guard against real transcripts', () => {
  const spoken = 'um so i think we should use the type script compiler flag for the new package';
  const verdict = (output: string, reference: string[] = [], style: 'fix' | 'polish' = 'fix') =>
    cleanupViolation({ raw: spoken, output, style, reference });

  it('should accept a spelling fix that lands on a phrase the conversation also used', () => {
    // Arrange — a five-word run in the reference, one word of it new
    const reference = ['we should use the TypeScript compiler flag for the new package everywhere'];

    // Assert
    should(verdict('So I think we should use the TypeScript compiler flag for the new package.', reference)).equal(
      undefined,
    );
  });

  it('should reject context merged into the reply', () => {
    // Arrange
    const reference = ['the rollout needs the signing keys rotated before friday'];
    const merged = 'I think we should use the compiler flag, and the rollout needs the signing keys rotated.';

    // Assert
    should(verdict(merged, reference, 'polish')).equal('merged_context');
  });

  it('should reject a reply that answers instead of correcting', () => {
    // Arrange — same length, almost none of the dictated words
    const answer = 'Sure, the strict flag turns on stricter checks across every package you build later.';

    // Assert
    should(verdict(answer)).equal('not_the_dictation');
  });

  it('should reject a reply that is much longer, much shorter, or tagged', () => {
    should(verdict(`${spoken} ${spoken} ${spoken}`)).equal('too_long');
    should(verdict('Use it.')).equal('too_short');
    should(verdict('<dictation>So I think we should use the type script compiler flag.</dictation>')).equal('tags');
  });

  it('should not judge novelty for dictations too short to compare, or for scripts without spaces', () => {
    // Assert
    should(
      cleanupViolation({ raw: 'what is the time', output: 'It is noon here.', style: 'fix', reference: [] }),
    ).equal(undefined);
    should(
      cleanupViolation({
        raw: '我想把这个部署到生产环境',
        output: '我想把这个部署到生产环境。',
        style: 'fix',
        reference: [],
      }),
    ).equal(undefined);
  });

  it('should give every violation a sentence a person can read', () => {
    // Assert
    const names: CleanupViolation[] = ['tags', 'too_long', 'too_short', 'merged_context', 'not_the_dictation'];
    for (const name of names) should(CLEANUP_VIOLATION_REASONS[name]).match(/^The cleanup reply /u);
  });
});

describe('reasoning that must never reach the dictation', () => {
  it('should strip closed, unclosed and orphaned thinking and gpt-oss channel markup', () => {
    // Assert
    should(withoutReasoning('<think>plan it</think>Fixed text.')).equal('Fixed text.');
    should(withoutReasoning('Fixed text.<think>and then I wondered')).equal('Fixed text.');
    should(withoutReasoning('I should correct this</think>Fixed text.')).equal('Fixed text.');
    should(withoutReasoning('analysis We need to fix it.assistantfinalFixed text.')).equal('Fixed text.');
    should(withoutReasoning('<|channel|>analysis<|message|>hmm<|end|><|channel|>final<|message|>Fixed text.')).equal(
      'Fixed text.',
    );
    should(withoutReasoning('Fixed <|return|>text.')).equal('Fixed text.');
  });

  it('should read a reply whose content is not a string as unexpected', () => {
    should(parseChatCompletion({ choices: [{ message: { content: null, reasoning: 'thinking' } }] })).equal(undefined);
  });
});

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
