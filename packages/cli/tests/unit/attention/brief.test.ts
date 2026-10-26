import { describe, it } from 'bun:test';
import { MAX_ATTENTION_URGENCY_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { composeAddRequest, parseBriefFile } from '../../../src/lib/attention/brief';

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
