/**
 * The debug record of a dictation cleanup call: the request as sent with every credential header
 * redacted, the provider's reply taken apart, and the steps between that reply and the kept words.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildCleanupBody,
  CLEANUP_PROVIDERS,
  type CleanupRequest,
  CleanupTraceSchema,
  describeCleanupReply,
  describeCleanupRequest,
  redactTraceHeaders,
  SttEnhancementErrorViewSchema,
  SttEnhancementRequestSchema,
  SttEnhancementResultSchema,
  TRACE_REDACTED,
} from '../../src/lib/index.ts';

const REQUEST: CleanupRequest = {
  model: 'openai/gpt-oss-120b',
  text: 'send the report to bob',
  context: ['an earlier line'],
  dictionary: [],
  style: 'fix',
  instruction: 'Fix recognition mistakes.',
};

const KEY = 'gsk_sentinel_value_that_must_never_appear';

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown => ({
  choices: [{ message, finish_reason: 'stop' }],
  ...extra,
});

describe('redactTraceHeaders', () => {
  it('should replace every secret-bearing header value and keep the rest', () => {
    // Act
    const actual = redactTraceHeaders({
      authorization: `Bearer ${KEY}`,
      Authorisation: KEY,
      'x-api-key': KEY,
      api_key: KEY,
      cookie: KEY,
      'x-auth-token': KEY,
      'client-secret': KEY,
      'content-type': 'application/json',
    });

    // Assert
    should(actual).deepEqual({
      authorization: TRACE_REDACTED,
      Authorisation: TRACE_REDACTED,
      'x-api-key': TRACE_REDACTED,
      api_key: TRACE_REDACTED,
      cookie: TRACE_REDACTED,
      'x-auth-token': TRACE_REDACTED,
      'client-secret': TRACE_REDACTED,
      'content-type': 'application/json',
    });
    should(JSON.stringify(actual)).not.containEql(KEY);
  });
});

describe('describeCleanupRequest', () => {
  it('should show the host, the path, the redacted headers, the params and the messages as sent', () => {
    // Arrange
    const body = buildCleanupBody(REQUEST, CLEANUP_PROVIDERS.groq);

    // Act
    const actual = describeCleanupRequest({
      endpoint: CLEANUP_PROVIDERS.groq.endpoint,
      headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' },
      body,
    });

    // Assert
    should(actual.host).equal('api.groq.com');
    should(actual.path).equal('/openai/v1/chat/completions');
    should(actual.headers).deepEqual({ authorization: TRACE_REDACTED, accept: 'application/json' });
    should(actual.params).containEql({ model: REQUEST.model, temperature: 0, stream: false, include_reasoning: false });
    should(actual.params).not.have.property('messages');
    should(actual.messages).deepEqual(body.messages.map(({ role, content }) => ({ role, content })));
    should(actual.messages[0]?.role).equal('system');
    should(actual.messages[1]?.content).containEql('send the report to bob').and.containEql('an earlier line');
    should(JSON.stringify(actual)).not.containEql(KEY);
  });
});

describe('describeCleanupReply', () => {
  it('should read a cleaned reply with its usage, finish reason and the thinking the provider sent apart', () => {
    // Arrange
    const payload = completion(
      { content: 'Send the report to Bob.', reasoning: 'The user said bob; capitalise.' },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    );

    // Act
    const actual = describeCleanupReply(payload, REQUEST);

    // Assert
    should(actual.verdict).equal('cleaned');
    should(actual.content).equal('Send the report to Bob.');
    should(actual.reasoning).equal('The user said bob; capitalise.');
    should(actual.finishReason).equal('stop');
    should(actual.usage).deepEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, reasoningTokens: 12 });
    should(actual.steps).deepEqual([{ step: 'guard_passed' }]);
    should(actual.reason).be.undefined();
    should(JSON.parse(actual.raw)).deepEqual(payload);
  });

  it('should read the alternate reasoning field and keep the text the caller passed as the raw reply', () => {
    // Act
    const actual = describeCleanupReply(
      completion({ content: 'Send the report to Bob.', reasoning_content: 'thinking' }),
      REQUEST,
      '{"as":"received"}',
    );

    // Assert
    should(actual.reasoning).equal('thinking');
    should(actual.raw).equal('{"as":"received"}');
  });

  it('should name the thinking that was stripped out of the message', () => {
    // Act
    const actual = describeCleanupReply(
      completion({ content: '<think>hmm, bob</think>Send the report to Bob.' }),
      REQUEST,
    );

    // Assert
    should(actual.verdict).equal('cleaned');
    should(actual.content).equal('<think>hmm, bob</think>Send the report to Bob.');
    should(actual.steps.map(step => step.step)).deepEqual(['reasoning_stripped', 'guard_passed']);
    should(actual.steps[0]?.detail).match(/removed \d+ characters/u);
  });

  it('should record the guard rejection and the fall back to the dictation as spoken', () => {
    // Act
    const actual = describeCleanupReply(
      completion({ content: 'Sure! Here is a poem about a completely different subject entirely.' }),
      REQUEST,
    );

    // Assert
    should(actual.verdict).equal('kept_raw');
    should(actual.steps.map(step => step.step)).deepEqual(['guard_rejected', 'kept_raw']);
    should(actual.steps[0]?.detail).equal(actual.reason);
    should(actual.reason).be.a.String().and.not.be.empty();
  });

  it('should record an unusable reply, with no content to show', () => {
    // Act
    const actual = describeCleanupReply({ unexpected: true }, REQUEST);

    // Assert
    should(actual.verdict).equal('unusable');
    should(actual.content).be.undefined();
    should(actual.reasoning).be.undefined();
    should(actual.finishReason).be.undefined();
    should(actual.usage).be.undefined();
    should(actual.steps.map(step => step.step)).deepEqual(['unusable']);
    should(actual.reason).be.a.String();
  });

  it('should not read a payload that is not an object, and ignore a usage block with nothing countable', () => {
    // Act
    const text = describeCleanupReply('not an object', REQUEST);
    const hollow = describeCleanupReply(
      completion({ content: 'Send the report to Bob.' }, { usage: { prompt_tokens: -1, total_tokens: 'many' } }),
      REQUEST,
    );
    const noChoice = describeCleanupReply({ choices: ['text'], usage: 'none' }, REQUEST);

    // Assert
    should(text.verdict).equal('unusable');
    should(hollow.usage).be.undefined();
    should(noChoice.verdict).equal('unusable');
    should(noChoice.usage).be.undefined();
  });

  it('should read partial usage', () => {
    // Act
    const actual = describeCleanupReply(
      completion(
        { content: 'Send the report to Bob.' },
        { usage: { total_tokens: 7, completion_tokens_details: 'x' } },
      ),
      REQUEST,
    );

    // Assert
    should(actual.usage).deepEqual({ totalTokens: 7 });
  });
});

describe('the debug record on the wire', () => {
  const trace = {
    via: 'daemon',
    provider: 'groq',
    model: REQUEST.model,
    host: 'api.groq.com',
    totalMs: 12,
    outcome: 'cleaned',
    finalText: 'Send the report to Bob.',
    attempts: [
      {
        withContext: true,
        request: describeCleanupRequest({
          endpoint: CLEANUP_PROVIDERS.groq.endpoint,
          headers: { authorization: `Bearer ${KEY}` },
          body: buildCleanupBody(REQUEST, CLEANUP_PROVIDERS.groq),
        }),
        response: describeCleanupReply(completion({ content: 'Send the report to Bob.' }), REQUEST),
        timings: { totalMs: 12 },
      },
    ],
  };

  it('should accept a built record, and never carry the credential', () => {
    // Act
    const parsed = CleanupTraceSchema.parse(trace);

    // Assert
    should(JSON.stringify(parsed)).not.containEql(KEY);
    should(parsed.attempts[0]?.request.headers.authorization).equal(TRACE_REDACTED);
  });

  it('should reject a record with a field it does not know', () => {
    // Act
    const parsed = CleanupTraceSchema.safeParse({ ...trace, apiKey: KEY });

    // Assert
    should(parsed.success).be.false();
  });

  it('should let a request ask for a record and a result or an error carry one', () => {
    // Act
    const request = SttEnhancementRequestSchema.safeParse({ text: 'hi', provider: 'groq', debug: true });
    const result = SttEnhancementResultSchema.safeParse({
      text: 'x',
      provider: 'groq',
      model: 'm',
      latencyMs: 1,
      debug: trace,
    });
    const error = SttEnhancementErrorViewSchema.safeParse({ error: 'e', code: 'timeout', debug: trace });

    // Assert
    should(request.success).be.true();
    should(result.success).be.true();
    should(error.success).be.true();
  });
});
