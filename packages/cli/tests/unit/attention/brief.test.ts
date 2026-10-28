import { describe, it } from 'bun:test';
import { AttentionItemSchema, MAX_ATTENTION_URGENCY_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { composeAddRequest, composeEditRequest, parseBriefFile } from '../../../src/lib/attention/brief';

describe('attention brief composition', () => {
  it('should keep an old-style add exactly as it was', () => {
    // Arrange / Act
    const request = composeAddRequest(['pick', 'a', 'cluster'], {});

    // Assert
    should(request).deepEqual({
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'pick a cluster',
      why: 'pick a cluster',
      context: null,
      howToResolve: 'Answer this item on the attention board (it records who answered).',
      ask: { kind: 'open-question' },
    });
  });

  it('should carry every structured flag, and make a lone question with options a choice', () => {
    // Arrange / Act
    const request = composeAddRequest(['Approve the OCI work-login plan'], {
      context: 'The work login expires every day.',
      term: ['OCI=Oracle Cloud Infrastructure', 'launchd = the macOS service manager = not cron'],
      question: ['Which plan should I build?'],
      option: ['Go with the defaults', "I'll reply with changes"],
      recommend: 'Go with the defaults',
      recommendWhy: 'It matches what runs today.',
      impact: 'You stay logged out of every work account.',
      urgency: 'today',
      link: ['#F12', 'https://github.com/kirinnee/ferretry/pull/1'],
    });

    // Assert
    should(request).containDeep({
      subject: 'Approve the OCI work-login plan',
      context: 'The work login expires every day.',
      ask: {
        kind: 'multiple-choice',
        options: [{ label: 'Go with the defaults' }, { label: "I'll reply with changes" }],
      },
      terms: [
        { term: 'OCI', meaning: 'Oracle Cloud Infrastructure' },
        { term: 'launchd', meaning: 'the macOS service manager = not cron' },
      ],
      questions: [
        {
          question: 'Which plan should I build?',
          options: [{ label: 'Go with the defaults' }, { label: "I'll reply with changes" }],
          recommended: 'Go with the defaults',
          why: 'It matches what runs today.',
        },
      ],
      impact: 'You stay logged out of every work account.',
      urgency: 'today',
      links: [{ target: '#F12' }, { target: 'https://github.com/kirinnee/ferretry/pull/1' }],
    });
    // The pick is said once, on its question — not again as the overall recommendation.
    should(request.recommendation).be.undefined();
  });

  it('should answer several questions in words, and keep a worded recommendation overall', () => {
    // Arrange / Act
    const request = composeAddRequest([], {
      summary: 'Two choices for the relay rollout',
      question: ['Ship on Thursday?', 'Keep the old carrier for a week?'],
      recommend: 'Thursday, and keep it a week',
    });

    // Assert
    should(request.ask).deepEqual({ kind: 'open-question' });
    should(request.questions).have.length(2);
    should(request.recommendation).deepEqual({ decision: 'Thursday, and keep it a week' });
  });

  it('should refuse item-level options over several questions, and a malformed term', () => {
    // Arrange / Act / Assert
    should(() => composeAddRequest(['x'], { question: ['a?', 'b?'], option: ['yes', 'no'] })).throw(
      /belongs to a single question/u,
    );
    should(() => composeAddRequest(['x'], { term: ['no meaning here'] })).throw(/--term needs TERM=meaning/u);
  });

  it('should name the field a limit refused', () => {
    // Arrange / Act / Assert
    should(() => composeAddRequest(['x'], { urgency: 'u'.repeat(MAX_ATTENTION_URGENCY_LENGTH + 1) })).throw(
      /^urgency: /u,
    );
    should(() => composeAddRequest([], {})).throw(/say what you need/u);
  });

  it('should read a JSON body, with plain strings for options and questions, and let flags win', () => {
    // Arrange
    const file = parseBriefFile(
      JSON.stringify({
        summary: 'Approve the plan',
        context: 'From the file.',
        terms: [{ term: 'OCI', meaning: 'Oracle Cloud Infrastructure' }],
        questions: [
          {
            question: 'Which plan?',
            options: ['Defaults', { label: 'Changes', description: 'You reply with edits' }],
            recommended: 'Defaults',
          },
        ],
        recommendation: 'Defaults',
        links: ['#F12', { label: 'PR', target: 'https://example.invalid/pr/1' }],
      }),
    );

    // Act
    const request = composeAddRequest([], { context: 'From the flag.' }, file);

    // Assert
    should(request).containDeep({
      subject: 'Approve the plan',
      context: 'From the flag.',
      ask: { kind: 'multiple-choice', options: [{ label: 'Defaults' }, { label: 'Changes' }] },
      questions: [{ question: 'Which plan?', recommended: 'Defaults' }],
      recommendation: { decision: 'Defaults' },
      links: [{ target: '#F12' }, { label: 'PR', target: 'https://example.invalid/pr/1' }],
    });
    should(request.questions?.[0]?.options?.[1]).deepEqual({ label: 'Changes', description: 'You reply with edits' });
  });

  it('should choose between a lone body question options when --kind choice names no options', () => {
    // Arrange
    const file = parseBriefFile(
      JSON.stringify({ summary: 'Pick', questions: [{ question: 'Which?', options: ['a', 'b'] }] }),
    );

    // Act
    const request = composeAddRequest([], { kind: 'choice' }, file);

    // Assert
    should(request.ask).deepEqual({ kind: 'multiple-choice', options: [{ label: 'a' }, { label: 'b' }] });
  });

  it('should keep the descriptions a body gives its item-level options', () => {
    // Arrange
    const file = parseBriefFile(
      JSON.stringify({ summary: 'Pick', options: [{ label: 'a', description: 'the first' }, 'b'] }),
    );

    // Act
    const request = composeAddRequest([], {}, file);

    // Assert
    should(request.ask).deepEqual({
      kind: 'multiple-choice',
      options: [{ label: 'a', description: 'the first' }, { label: 'b' }],
    });
  });

  it('should name what is wrong with a JSON body', () => {
    // Arrange / Act / Assert
    should(() => parseBriefFile('{not json')).throw(/--json-file is not JSON/u);
    should(() => parseBriefFile(JSON.stringify({ summery: 'typo' }))).throw(/--json-file: /u);
    should(() => parseBriefFile(JSON.stringify({ terms: [{ term: 'x' }] }))).throw(/terms\.0\.meaning/u);
  });
});

describe('attention brief points and edits', () => {
  it('should turn repeated context and impact flags into bullets, and leave one value as written', () => {
    // Arrange / Act
    const several = composeAddRequest(['pick'], {
      context: ['the login expires', 'two plans fit'],
      impact: ['blocks release'],
    });
    const one = composeAddRequest(['pick'], { context: ['plain words'] });

    // Assert
    should(several).containDeep({ context: '- the login expires\n- two plans fit', impact: 'blocks release' });
    should(one).containDeep({ context: 'plain words' });
  });

  it('should accept lists for context and impact in a JSON body', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ summary: 'Pick', context: ['one', 'two'], impact: 'plain' }));

    // Act
    const request = composeAddRequest([], {}, file);

    // Assert
    should(request).containDeep({ context: '- one\n- two', impact: 'plain' });
  });

  it('should compose an edit from only the flags given', () => {
    // Arrange / Act
    const request = composeEditRequest(
      'A3',
      { summary: ' Plain ask ', context: ['a', 'b'], term: ['OCI=cloud login'] },
      undefined,
    );

    // Assert
    should(request).deepEqual({
      action: 'edit',
      id: 'A3',
      subject: 'Plain ask',
      context: '- a\n- b',
      terms: [{ term: 'OCI', meaning: 'cloud login' }],
    });
  });

  it('should reword questions in order, keeping their options and reasons', () => {
    // Arrange
    const current = AttentionItemSchema.parse({
      id: 'A3',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'x',
      why: 'x',
      waitingSince: '2026-10-26T09:00:00.000Z',
      howToResolve: 'x',
      ask: { kind: 'open-question' },
      raisedBy: 'agent',
      raisedBySession: 's',
      raisedByName: 'Ada',
      questions: [
        { question: 'Which plan?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'Cheaper.' },
      ],
    });

    // Act
    const request = composeEditRequest('A3', { question: ['Which login plan?'] }, current);

    // Assert
    should(request.questions).deepEqual([
      { question: 'Which login plan?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'Cheaper.' },
    ]);
    should(() => composeEditRequest('A3', { question: ['a?', 'b?'] }, current)).throw(/has 1 question/u);
    should(() => composeEditRequest('A3', { question: ['a?'] }, undefined)).throw(/no unresolved attention item A3/u);
  });
});

describe('attention brief steps and body', () => {
  it('should carry steps in order and a body, with a flag winning over the file and blanks dropped', () => {
    // Arrange / Act
    const fromFlags = composeAddRequest(['Log in'], {
      step: ['Run `fy login`', '  ', 'Paste the code'],
      body: ' ## Notes ',
    });
    const fromFile = composeAddRequest(['Log in'], {}, { steps: ['From file'], body: 'File body' });
    const flagWins = composeAddRequest(
      ['Log in'],
      { step: ['Flag'], body: 'Flag body' },
      { steps: ['File'], body: 'File body' },
    );
    const blank = composeAddRequest(['Log in'], { step: [' '], body: ' ' });
    const edited = composeEditRequest('A1', { step: ['One', 'Two'], body: 'Doc' }, undefined);

    // Assert
    should(fromFlags).containDeep({ steps: ['Run `fy login`', 'Paste the code'], body: '## Notes' });
    should(fromFile).containDeep({ steps: ['From file'], body: 'File body' });
    should(flagWins).containDeep({ steps: ['Flag'], body: 'Flag body' });
    should(blank).not.have.property('steps');
    should(blank).not.have.property('body');
    should(edited).deepEqual({ action: 'edit', id: 'A1', steps: ['One', 'Two'], body: 'Doc' });
  });

  it('should read steps and body from a JSON brief', () => {
    // Arrange / Act
    const file = parseBriefFile('{"summary":"Log in","steps":["a","b"],"body":"c"}');

    // Assert
    should(file).containDeep({ steps: ['a', 'b'], body: 'c' });
  });
});
