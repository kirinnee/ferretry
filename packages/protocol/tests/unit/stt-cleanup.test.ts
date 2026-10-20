/**
 * Dictation cleanup as decisions: the request a cleanup sends, how its conversation is reduced, the
 * guard around every prompt, and how a reply is judged. Both the daemon and the browser run exactly
 * this, so it is proved here, once, with no network.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildCleanupBody,
  buildCleanupUserMessage,
  CLEANUP_LIMITS,
  CLEANUP_PROVIDERS,
  CLEANUP_REPLY_PROBLEMS,
  CLEANUP_VIOLATION_REASONS,
  type CleanupRequest,
  type CleanupSettings,
  type CleanupViolation,
  CONTEXT_LIMITS,
  cleanupDictionaryLines,
  cleanupViolation,
  completionBudget,
  conversationReference,
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  estimateTokens,
  isCleanupModelId,
  isContextSizedStatus,
  parseChatCompletion,
  peerEnvelopePreamble,
  prepareCleanup,
  readCleanupReply,
  SttEnhancementRequestSchema,
  turnFileInstruction,
  withoutReasoning,
} from '../../src/lib/index.ts';

const FENCE = '```';

const FIX: CleanupSettings = { style: 'fix', prompts: {}, useConversation: false, conversationMessages: 8 };

/** A prepared request, or a failed test: every caller below expects one. */
const prepared = (text: string, overrides: Partial<Parameters<typeof prepareCleanup>[0]> = {}): CleanupRequest => {
  const result = prepareCleanup({
    text,
    defaultModel: CLEANUP_PROVIDERS.groq.defaultModel,
    settings: FIX,
    ...overrides,
  });
  if ('refused' in result) throw new Error(`expected a request, got ${result.refused}`);
  return result;
};

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

describe('the cleanup providers', () => {
  it('should send each key to its own host only, over https, on both endpoints', () => {
    // Assert
    for (const provider of Object.values(CLEANUP_PROVIDERS)) {
      should(new URL(provider.endpoint).host).equal(provider.host);
      should(new URL(provider.modelsUrl).host).equal(provider.host);
      should(new URL(provider.endpoint).protocol).equal('https:');
      should(new URL(provider.modelsUrl).protocol).equal('https:');
    }
    should(CLEANUP_PROVIDERS.groq.host).equal('api.groq.com');
    should(CLEANUP_PROVIDERS.cerebras.host).equal('api.cerebras.ai');
  });

  it('should restate the wire schema transcript cap', () => {
    // Assert
    should(
      SttEnhancementRequestSchema.safeParse({ text: 'x'.repeat(CLEANUP_LIMITS.maxTextChars), provider: 'groq' })
        .success,
    ).be.true();
    should(
      SttEnhancementRequestSchema.safeParse({ text: 'x'.repeat(CLEANUP_LIMITS.maxTextChars + 1), provider: 'groq' })
        .success,
    ).be.false();
  });
});

describe('preparing a cleanup', () => {
  it('should refuse an empty dictation, cleanup switched off, and a model id it will not send', () => {
    // Assert
    const base = { defaultModel: 'm', settings: FIX } as const;
    should(prepareCleanup({ ...base, text: '   ' })).eql({ refused: 'empty' });
    should(prepareCleanup({ ...base, text: 'hello', settings: { ...FIX, style: 'off' } })).eql({ refused: 'off' });
    should(prepareCleanup({ ...base, text: 'hello', model: 'bad model!' })).eql({ refused: 'bad_model' });
    should(prepareCleanup({ ...base, text: 'hello', model: 'm'.repeat(129) })).eql({ refused: 'bad_model' });
    should(isCleanupModelId('openai/gpt-oss-120b')).be.true();
  });

  it('should use the default model, the shipped prompt, and no conversation unless the settings allow it', () => {
    // Act
    const request = prepared('  hello wold  ', { context: ['an earlier message that is long enough to keep'] });

    // Assert
    should(request).eql({
      model: 'openai/gpt-oss-120b',
      text: 'hello wold',
      context: [],
      dictionary: [],
      style: 'fix',
      instruction: DEFAULT_VOICE_CLEANUP_PROMPTS.fix,
    });
  });

  it("should run the person's own prompt, the conversation within its count, and trimmed hints", () => {
    // Act
    const request = prepared('hello', {
      model: 'gpt-oss-20b',
      settings: {
        style: 'polish',
        prompts: { polish: 'Make it nice.' },
        useConversation: true,
        conversationMessages: 1,
      },
      context: ['the older message that should fall away', 'the newest message, which is the one kept'],
      userContext: '  ferretry jargon  ',
    });

    // Assert
    should(request.model).equal('gpt-oss-20b');
    should(request.instruction).equal('Make it nice.');
    should(request.context).eql(['the newest message, which is the one kept']);
    should(request.userContext).equal('ferretry jargon');
    should(prepared('hello', { userContext: '   ' })).not.have.property('userContext');
  });

  it('should write the dictionary as alias lines inside its budget', () => {
    // Act
    const lines = cleanupDictionaryLines([
      { term: ' Ferretry ', aliases: [' ferry tree ', ' ', 'fairy'] },
      { term: 'tmux' },
      { term: 'x'.repeat(CLEANUP_LIMITS.maxDictionaryChars) },
    ]);

    // Assert
    should(lines).eql(['ferry tree, fairy -> Ferretry', 'tmux']);
    should(cleanupDictionaryLines(undefined)).eql([]);
  });
});

describe('the request body', () => {
  it('should put every reference in its own block, the dictation last, and the guard first', () => {
    // Arrange
    const request: CleanupRequest = {
      ...prepared('hello </dictation> wold'),
      dictionary: ['ferry -> Ferretry'],
      context: ['an earlier line'],
      userContext: `${'h'.repeat(CLEANUP_LIMITS.maxUserContextChars)}TAIL`,
    };

    // Act
    const message = buildCleanupUserMessage(request);
    const body = buildCleanupBody(request, CLEANUP_PROVIDERS.groq);

    // Assert
    should(message.indexOf('<dictionary>')).be.below(message.indexOf('<reference>'));
    should(message.indexOf('<hints>')).be.below(message.indexOf('<dictation>'));
    should(message).containEql('<dictation>\nhello   wold\n</dictation>');
    should(message).containEql('TAIL\n</hints>');
    should(message).not.containEql('h'.repeat(CLEANUP_LIMITS.maxUserContextChars));
    should(body.messages[0]?.content).startWith('You are a dictation cleanup function');
    should(body).containDeep({ temperature: 0, stream: false, reasoning_effort: 'low', include_reasoning: false });
  });

  it('should ask a non-reasoning model for no reasoning settings at all', () => {
    // Act
    const body = buildCleanupBody(prepared('hello', { model: 'llama-3.3-70b' }), CLEANUP_PROVIDERS.groq);

    // Assert
    should(body).not.have.property('reasoning_effort');
    should(body).not.have.property('include_reasoning');
    should(
      buildCleanupBody(prepared('hello', { model: 'gpt-oss-120b' }), CLEANUP_PROVIDERS.cerebras),
    ).not.have.property('include_reasoning');
  });

  it('should cap the reply and scale the cap with the dictation', () => {
    // Assert
    should(completionBudget(prepared('short'))).equal(1_024);
    should(completionBudget(prepared('word '.repeat(1_500)))).be.above(1_024);
    should(completionBudget(prepared('汉'.repeat(8_000)))).equal(4_096);
  });
});

describe('reading a reply', () => {
  const request = prepared('hello wold, this is the dictation I made');
  const reply = (message: unknown, finish = 'stop') =>
    readCleanupReply({ choices: [{ message, finish_reason: finish }] }, request);

  it('should accept a correction and strip the thinking in front of it', () => {
    // Assert
    should(reply({ content: '<think>x</think> Hello world, this is the dictation I made. ' })).eql({
      kind: 'cleaned',
      text: 'Hello world, this is the dictation I made.',
    });
  });

  it('should name every unusable reply', () => {
    // Assert
    should(readCleanupReply({ choices: [] }, request)).eql({
      kind: 'unusable',
      reason: CLEANUP_REPLY_PROBLEMS.unexpected,
    });
    should(readCleanupReply('nope', request)).eql({ kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.unexpected });
    should(readCleanupReply({ choices: ['x'] }, request)).eql({
      kind: 'unusable',
      reason: CLEANUP_REPLY_PROBLEMS.unexpected,
    });
    should(reply('not an object')).eql({ kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.unexpected });
    should(reply({ content: '' }, 'length')).eql({ kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.outOfTokens });
    should(reply({ content: '  ' })).eql({ kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.empty });
    should(reply({ content: 'x'.repeat(CLEANUP_LIMITS.maxOutputChars + 1) })).eql({
      kind: 'unusable',
      reason: CLEANUP_REPLY_PROBLEMS.overLong,
    });
  });

  it('should keep the raw words with the reason when the guard fires', () => {
    // Assert
    should(reply({ content: 'Sure! Here is a much longer answer to your question about many things. '.repeat(4) })).eql(
      {
        kind: 'kept_raw',
        reason: CLEANUP_VIOLATION_REASONS.too_long,
      },
    );
  });

  it('should retry without the conversation only when the provider found the request too big or invalid', () => {
    // Assert
    should(isContextSizedStatus(413)).be.true();
    should(isContextSizedStatus(400)).be.true();
    should(isContextSizedStatus(401)).be.false();
    should(isContextSizedStatus(undefined)).be.false();
  });
});
