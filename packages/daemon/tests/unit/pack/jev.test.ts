import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildPackJevBody,
  JevPackRanker,
  PACK_JEV_INSTRUCTIONS,
  PACK_JEV_LIMITS,
  PACK_JEV_TIMEOUT_MS,
  parsePackJevReply,
  type RankableCandidate,
} from '../../../src/lib/pack/jev.ts';
import { JEV_DEFAULT_ENDPOINT, JEV_DEFAULT_MODEL, JEV_HOST } from '../../../src/lib/speedups/catalog.ts';
import type { AuthorizedOutcome, OutboundAuthorizerPort } from '../../../src/lib/speedups/ports.ts';

const CANDIDATES: readonly RankableCandidate[] = [
  { model: 'opus', runtime: 'claude-main', why: 'The strongest.' },
  { model: 'sonnet', runtime: 'claude-main', why: 'Balanced.' },
  { model: 'haiku', runtime: 'claude-fast', why: 'Cheap.' },
];

const reply = (model: unknown, usage?: unknown): unknown => ({
  answers: { model },
  ...(usage === undefined ? {} : { usage }),
});

describe('buildPackJevBody', () => {
  it('should send the task and one criterion per candidate, numbered from c1', () => {
    // Arrange / Act
    const body = buildPackJevBody('fix the bug', CANDIDATES, 'jev-test');

    // Assert
    should(body).deepEqual({
      model: 'jev-test',
      state: { task: 'fix the bug' },
      questions: {
        model: {
          type: 'choice',
          instructions: PACK_JEV_INSTRUCTIONS,
          criteria: {
            c1: 'opus on claude-main: The strongest.',
            c2: 'sonnet on claude-main: Balanced.',
            c3: 'haiku on claude-fast: Cheap.',
          },
        },
      },
    });
  });

  it('should bound the task and each reason so a long brief cannot become a large bill', () => {
    // Arrange
    const task = 'x'.repeat(PACK_JEV_LIMITS.maxTaskChars + 500);
    const why = 'y'.repeat(PACK_JEV_LIMITS.maxWhyChars + 500);

    // Act
    const body = buildPackJevBody(task, [{ model: 'm', runtime: 'r', why }], 'jev') as {
      state: { task: string };
      questions: { model: { criteria: Record<string, string> } };
    };

    // Assert
    should(body.state.task).have.length(PACK_JEV_LIMITS.maxTaskChars);
    should(body.questions.model.criteria.c1).equal(`m on r: ${'y'.repeat(PACK_JEV_LIMITS.maxWhyChars)}`);
  });
});

describe('buildPackJevBody with the routing prompt', () => {
  it("should give Jev the owner's routing prompt as guidance, and each candidate's quota", () => {
    // Arrange
    const candidates: readonly RankableCandidate[] = [
      { model: 'opus', runtime: 'claude-kirin', why: 'The strongest.', quota: '5h 10% · wk 91%' },
      { model: 'sonnet', runtime: 'claude-atomi', why: 'Balanced.' },
    ];

    // Act
    const body = buildPackJevBody('review the diff', candidates, 'jev', {
      routing: 'Reviews on Opus; Sonnet when Opus is low.',
    });

    // Assert
    should(body).deepEqual({
      model: 'jev',
      state: {
        task: 'review the diff',
        guidance: 'Reviews on Opus; Sonnet when Opus is low.',
      },
      questions: {
        model: {
          type: 'choice',
          instructions: PACK_JEV_INSTRUCTIONS,
          criteria: {
            c1: 'opus on claude-kirin (quota used: 5h 10% · wk 91%): The strongest.',
            c2: 'sonnet on claude-atomi: Balanced.',
          },
        },
      },
    });
    should((body.state as Record<string, unknown>).useCase).be.undefined();
    should(PACK_JEV_INSTRUCTIONS).containEql("Follow the owner's routing prompt");
    should(PACK_JEV_INSTRUCTIONS).containEql('quota left');
  });

  it('should send no guidance when there is no routing prompt', () => {
    // Act
    const body = buildPackJevBody('t', CANDIDATES, 'jev', {}) as { state: Record<string, unknown> };

    // Assert
    should(Object.keys(body.state)).deepEqual(['task']);
  });

  it('should bound the guidance', () => {
    // Act
    const body = buildPackJevBody('t', CANDIDATES, 'jev', {
      routing: 'g'.repeat(PACK_JEV_LIMITS.maxGuidanceChars + 10),
    }) as { state: { guidance: string } };

    // Assert
    should(body.state.guidance).have.length(PACK_JEV_LIMITS.maxGuidanceChars);
  });

  it('should offer a bounded number of candidates for the caller to cut to', () => {
    // Assert
    should(PACK_JEV_LIMITS.maxCandidates).be.a.Number();
    should(PACK_JEV_LIMITS.maxCandidates).be.within(1, 50);
  });
});

describe('parsePackJevReply', () => {
  it('should put the chosen candidate first and order the rest by probability', () => {
    // Arrange
    const payload = reply({ choice: 'c2', probabilities: { c1: 0.1, c2: 0.6, c3: 0.3 } }, { input_tokens: 812.4 });

    // Act
    const ranking = parsePackJevReply(payload, 3);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [1, 2, 0], inputTokens: 812 });
  });

  it('should put the chosen candidate first even when its probability is not the highest', () => {
    // Arrange
    const payload = reply({ choice: 'c3', probabilities: { c1: 0.9, c2: 0.5, c3: 0.1 } });

    // Act
    const ranking = parsePackJevReply(payload, 3);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [2, 0, 1], inputTokens: 0 });
  });

  it('should rank the chosen one first and keep the guide’s order when there are no probabilities', () => {
    // Arrange
    const payload = reply({ choice: 'c3' });

    // Act
    const ranking = parsePackJevReply(payload, 3);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [2, 0, 1], inputTokens: 0 });
  });

  it('should ignore a probability that is not a finite number and break ties by position', () => {
    // Arrange
    const payload = reply({ choice: 'c1', probabilities: { c2: 'high', c3: Number.POSITIVE_INFINITY } });

    // Act
    const ranking = parsePackJevReply(payload, 3);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [0, 1, 2], inputTokens: 0 });
  });

  it('should read nonsense usage as zero tokens', () => {
    // Arrange
    const negative = reply({ choice: 'c1' }, { input_tokens: -5 });
    const text = reply({ choice: 'c1' }, { input_tokens: '12' });
    const unusable = { ...(reply({ choice: 'c1' }) as object), usage: 'many' };

    // Act
    const answers = [negative, text, unusable].map(payload => parsePackJevReply(payload, 1));

    // Assert
    should(answers.map(answer => (answer?.kind === 'ranked' ? answer.inputTokens : -1))).deepEqual([0, 0, 0]);
  });

  it('should answer nothing for a reply that is not an answer to this question', () => {
    // Arrange
    const shapes: unknown[] = [
      undefined,
      null,
      'ok',
      [],
      {},
      { answers: [] },
      { answers: {} },
      { answers: { model: [] } },
      reply({}),
      reply({ choice: 7 }),
      reply({ choice: 'c4' }),
      reply({ choice: 'other' }),
    ];

    // Act
    const answers = shapes.map(payload => parsePackJevReply(payload, 3));

    // Assert
    should(answers.every(answer => answer === undefined)).be.true();
  });

  it('should accept a probabilities field that is not an object as absent', () => {
    // Arrange
    const payload = reply({ choice: 'c2', probabilities: ['x'] });

    // Act
    const ranking = parsePackJevReply(payload, 2);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [1, 0], inputTokens: 0 });
  });
});

class FakeAuthorizer implements OutboundAuthorizerPort {
  readonly sent: Array<{
    secret: string;
    hosts: readonly string[];
    request: Parameters<OutboundAuthorizerPort['send']>[2];
  }> = [];

  constructor(private readonly outcome: AuthorizedOutcome) {}

  async send(secret: string, hosts: readonly string[], request: Parameters<OutboundAuthorizerPort['send']>[2]) {
    this.sent.push({ secret, hosts, request });
    return this.outcome;
  }
}

describe('JevPackRanker', () => {
  it('should ask Jev its default question through the holder of the key and read the answer', async () => {
    // Arrange
    const authorizer = new FakeAuthorizer({
      kind: 'completion',
      payload: reply({ choice: 'c2' }, { input_tokens: 40 }),
    });

    // Act
    const ranking = await new JevPackRanker(authorizer).rank('fix it', CANDIDATES);

    // Assert
    should(ranking).deepEqual({ kind: 'ranked', order: [1, 0, 2], inputTokens: 40 });
    should(authorizer.sent).have.length(1);
    const sent = authorizer.sent[0];
    should(sent?.secret).equal('JEV_API_KEY');
    should(sent?.hosts).deepEqual([JEV_HOST]);
    should(sent?.request.method).equal('POST');
    should(sent?.request.url).equal(JEV_DEFAULT_ENDPOINT);
    should(sent?.request.timeoutMs).equal(PACK_JEV_TIMEOUT_MS);
    should(sent?.request.maxResponseBytes).equal(PACK_JEV_LIMITS.maxResponseBytes);
    should(JSON.parse(sent?.request.body ?? '{}')).deepEqual(buildPackJevBody('fix it', CANDIDATES, JEV_DEFAULT_MODEL));
  });

  it('should use the endpoint, model and timeout it was given', async () => {
    // Arrange
    const authorizer = new FakeAuthorizer({ kind: 'completion', payload: reply({ choice: 'c1' }) });
    const ranker = new JevPackRanker(authorizer, {
      endpoint: 'https://example.com/ask',
      model: 'jev-x',
      timeoutMs: 123,
    });

    // Act
    await ranker.rank('t', CANDIDATES);

    // Assert
    const sent = authorizer.sent[0];
    should(sent?.request.url).equal('https://example.com/ask');
    should(sent?.request.timeoutMs).equal(123);
    should((JSON.parse(sent?.request.body ?? '{}') as { model: string }).model).equal('jev-x');
  });

  it('should say in words why each kind of failure failed', async () => {
    // Arrange
    const outcomes: ReadonlyArray<readonly [AuthorizedOutcome, string]> = [
      [{ kind: 'secret_missing' }, 'no Jev key is set'],
      [{ kind: 'vault_damaged' }, 'the secret store could not be opened'],
      [{ kind: 'refused' }, 'the Jev endpoint is not one the key may reach'],
      [{ kind: 'timeout' }, 'Jev did not answer in time'],
      [{ kind: 'unreachable' }, 'Jev could not be reached'],
      [{ kind: 'oversized' }, 'Jev answered with more than an answer'],
      [{ kind: 'unreadable' }, 'Jev answered with something unreadable'],
      [{ kind: 'status', status: 429 }, 'Jev refused the question'],
    ];

    // Act
    const rankings = await Promise.all(
      outcomes.map(([outcome]) => new JevPackRanker(new FakeAuthorizer(outcome)).rank('t', CANDIDATES)),
    );

    // Assert
    should(rankings).deepEqual(outcomes.map(([, reason]) => ({ kind: 'failed', reason })));
  });

  it('should fail as unreadable when the completion is not an answer to the question', async () => {
    // Arrange
    const authorizer = new FakeAuthorizer({ kind: 'completion', payload: { answers: { model: { choice: 'c9' } } } });

    // Act
    const ranking = await new JevPackRanker(authorizer).rank('t', CANDIDATES);

    // Assert
    should(ranking).deepEqual({ kind: 'failed', reason: 'Jev answered with something unreadable' });
  });
});
