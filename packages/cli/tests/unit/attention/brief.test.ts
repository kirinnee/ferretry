import { describe, it } from 'bun:test';
import { AttentionItemSchema, MAX_ATTENTION_URGENCY_LENGTH } from '@ferretry/protocol';
import should from 'should';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  parseBriefFile,
} from '../../../src/lib/attention/brief';

/** Every card needs a title, so the tests that are about something else give one. */
const add = (words: readonly string[], flags: BriefFlags = {}, file: BriefFile = {}) =>
  composeAddRequest(words, { title: 'Plan approval', ...flags }, file);

describe('attention brief composition', () => {
  it('should compose a plain add as a titled reply with no answers', () => {
    // Arrange / Act
    const request = add(['pick', 'a', 'cluster'], {});

    // Assert
    should(request).deepEqual({
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'pick a cluster',
      title: 'Plan approval',
      kind: 'reply',
      why: 'pick a cluster',
      context: null,
      howToResolve: 'Answer this item on the attention board (it records who answered).',
      ask: { kind: 'open-question' },
    });
  });

  it('should carry every structured flag, and make a lone question with options a choice', () => {
    // Arrange / Act
    const request = add(['Approve the OCI work-login plan'], {
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
    const request = add([], {
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
    should(() => add(['x'], { question: ['a?', 'b?'], option: ['yes', 'no'] })).throw(/belongs to a single question/u);
    should(() => add(['x'], { term: ['no meaning here'] })).throw(/--term needs TERM=meaning/u);
  });

  it('should name the field a limit refused', () => {
    // Arrange / Act / Assert
    should(() => add(['x'], { urgency: 'u'.repeat(MAX_ATTENTION_URGENCY_LENGTH + 1) })).throw(/^urgency: /u);
    should(() => add([], {})).throw(/say what you need as words \(or --ask\)/u);
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
    const request = add([], { context: 'From the flag.' }, file);

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
    const request = add([], { kind: 'choice' }, file);

    // Assert
    should(request.ask).deepEqual({ kind: 'multiple-choice', options: [{ label: 'a' }, { label: 'b' }] });
  });

  it('should keep the descriptions a body gives its item-level options', () => {
    // Arrange
    const file = parseBriefFile(
      JSON.stringify({ summary: 'Pick', options: [{ label: 'a', description: 'the first' }, 'b'] }),
    );

    // Act
    const request = add([], {}, file);

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
    const several = add(['pick'], {
      context: ['the login expires', 'two plans fit'],
      impact: ['blocks release'],
    });
    const one = add(['pick'], { context: ['plain words'] });

    // Assert
    should(several).containDeep({ context: '- the login expires\n- two plans fit', impact: 'blocks release' });
    should(one).containDeep({ context: 'plain words' });
  });

  it('should turn repeated premise and decided flags into bullets, and leave one value as written', () => {
    // Arrange / Act
    const several = add(['pick'], {
      premise: ['the login expires', 'two plans fit'],
      decided: ['use the shared account'],
    });
    const one = add(['pick'], { premise: 'plain words' });
    const none = add(['pick'], {});

    // Assert
    should(several).containDeep({ premise: '- the login expires\n- two plans fit', decided: 'use the shared account' });
    should(one).containDeep({ premise: 'plain words' });
    should(none).not.have.property('premise');
    should(none).not.have.property('decided');
  });

  it('should read premise and decided from a JSON body, and let a flag win', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ summary: 'Pick', premise: ['one', 'two'], decided: 'earlier' }));

    // Act
    const fromFile = add([], {}, file);
    const flagged = add([], { premise: ['from the flag'] }, file);

    // Assert
    should(fromFile).containDeep({ premise: '- one\n- two', decided: 'earlier' });
    should(flagged).containDeep({ premise: 'from the flag', decided: 'earlier' });
  });

  it('should compose an edit that replaces the premise and the decided points', () => {
    // Arrange / Act
    const request = composeEditRequest('A3', { premise: ['a', 'b'], decided: ['c'] }, undefined);

    // Assert
    should(request).deepEqual({ action: 'edit', id: 'A3', premise: '- a\n- b', decided: 'c' });
  });

  it('should accept lists for context and impact in a JSON body', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ summary: 'Pick', context: ['one', 'two'], impact: 'plain' }));

    // Act
    const request = add([], {}, file);

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
    const fromFlags = add(['Log in'], {
      step: ['Run `fy login`', '  ', 'Paste the code'],
      body: ' ## Notes ',
    });
    const fromFile = add(['Log in'], {}, { steps: ['From file'], body: 'File body' });
    const flagWins = add(['Log in'], { step: ['Flag'], body: 'Flag body' }, { steps: ['File'], body: 'File body' });
    const blank = add(['Log in'], { step: [' '], body: ' ' });
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

describe('attention brief to-do asks', () => {
  it('should make steps with no question a task, and let --task or --kind task force it', () => {
    // Arrange / Act
    const implied = add(['Log in'], { step: ['Run `fy login`'] });
    const forced = add(['Log in'], { task: true });
    const named = add(['Log in'], { kind: 'task' });
    const question = add(['Which?'], { step: ['One'], option: ['a', 'b'] });
    const open = add(['Why?'], {});

    // Assert
    should(implied).containDeep({ ask: { kind: 'task' } });
    should(forced).containDeep({ ask: { kind: 'task' } });
    should(named).containDeep({ ask: { kind: 'task' } });
    should(question).containDeep({ ask: { kind: 'multiple-choice' } });
    should(open).containDeep({ ask: { kind: 'open-question' } });
  });

  it('should refuse a task that also asks a question', () => {
    // Act + Assert
    should(() => add(['Log in'], { task: true, question: ['Which?'] })).throw(/a task asks nothing/u);
  });
});

describe('attention brief card title and ask', () => {
  it('should refuse an add with no title, saying how to give one', () => {
    // Act + Assert
    should(() => composeAddRequest(['Approve the plan'], {})).throw(
      'give the card a title: --title "<what this is about, ≤40 chars, plain words, no IDs>" — it is the notification heading',
    );
    should(() => composeAddRequest(['Approve the plan'], { title: '   ' })).throw(/give the card a title/u);
  });

  it('should refuse a title past the 60-character hard limit', () => {
    // Act + Assert
    should(() => composeAddRequest(['Approve'], { title: 't'.repeat(61) })).throw(/title may not exceed 60/u);
    should(composeAddRequest(['Approve'], { title: 't'.repeat(60) }).title).have.length(60);
  });

  it('should take the title from a JSON body, and let the flag win', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ title: 'From file', ask: 'Approve the plan' }));

    // Act
    const fromFile = composeAddRequest([], {}, file);
    const fromFlag = composeAddRequest([], { title: 'From flag' }, file);

    // Assert
    should(fromFile).containDeep({ title: 'From file', subject: 'Approve the plan' });
    should(fromFlag.title).equal('From flag');
  });

  it('should read the ask from words, then --ask, then --summary, then the body', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ ask: 'file ask', summary: 'file summary' }));

    // Act + Assert
    should(add(['the words'], { ask: 'flag ask', summary: 'flag summary' }, file).subject).equal('the words');
    should(add([], { ask: 'flag ask', summary: 'flag summary' }, file).subject).equal('flag ask');
    should(add([], { summary: 'flag summary' }, file).subject).equal('flag summary');
    should(add([], {}, file).subject).equal('file ask');
    should(add([], {}, parseBriefFile(JSON.stringify({ summary: 'file summary' }))).subject).equal('file summary');
  });

  it('should reword the title of an open item on edit', () => {
    // Act
    const request = composeEditRequest('A3', { title: '  New title ' }, undefined);

    // Assert
    should(request).deepEqual({ action: 'edit', id: 'A3', title: 'New title' });
    should(() => composeEditRequest('A3', { title: 't'.repeat(61) }, undefined)).throw(/title may not exceed 60/u);
  });
});

describe('attention brief card kinds and answers', () => {
  const answersOf = (flags: BriefFlags) => add(['Ask'], flags).answers?.map(a => `${a.direction}:${a.does}:${a.label}`);

  it('should compose a task: Need more info on the left, Done on the right', () => {
    // Act
    const request = add(['Log in'], { kind: 'task' });

    // Assert
    should(request.kind).equal('task');
    should(request.ask).deepEqual({ kind: 'task' });
    should(answersOf({ kind: 'task' })).deepEqual(['left:needs-info:Need more info', 'right:done:Done']);
  });

  it('should compose a yesno with its own Yes and No', () => {
    // Act
    const request = add(['Ship it?'], { kind: 'yesno' });

    // Assert
    should(request.kind).equal('yesno');
    should(request.ask).deepEqual({ kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] });
    should(answersOf({ kind: 'yesno' })).deepEqual(['left:choose:No', 'right:choose:Yes']);
  });

  it('should refuse a yesno whose question brings options of its own', () => {
    // Arrange
    const file: BriefFile = { questions: [{ question: 'Ship it?', options: ['Ship', 'Hold'] }] };

    // Act + Assert
    should(() => add(['Ship it?'], { kind: 'yesno' }, file)).throw(/--kind yesno brings its own Yes and No/u);
  });

  it('should compose a permission: Deny on the left, Allow on the right', () => {
    // Act + Assert
    should(add(['Run it?'], { kind: 'permission' }).kind).equal('permission');
    should(answersOf({ kind: 'permission' })).deepEqual(['left:reject:Deny', 'right:approve:Allow']);
  });

  it('should compose a review: Needs changes on the left, Looks good on the right', () => {
    // Act + Assert
    const request = add(['Is this right?'], { kind: 'review' });
    should(request.ask).deepEqual({ kind: 'answer-review' });
    should(answersOf({ kind: 'review' })).deepEqual(['left:clarify:Needs changes', 'right:good:Looks good']);
  });

  it('should compose an info card with no ask and one Got it answer', () => {
    // Act
    const request = add(['FYI'], { kind: 'info' });

    // Assert
    should(request.kind).equal('info');
    should(request).not.have.property('ask');
    should(answersOf({ kind: 'info' })).deepEqual(['right:done:Got it']);
  });

  it('should compose a reply with no swipes at all', () => {
    // Act
    const request = add(['Why?'], { kind: 'reply' });

    // Assert
    should(request.kind).equal('reply');
    should(request.ask).deepEqual({ kind: 'open-question' });
    should(request).not.have.property('answers');
  });

  it('should lay a two-option choice out with the first option on the right', () => {
    // Act + Assert
    should(answersOf({ option: ['Ship', 'Hold'] })).deepEqual(['left:choose:Hold', 'right:choose:Ship']);
  });

  it('should lay a three-option choice out left, up and right, recommended on the right', () => {
    // Act + Assert
    should(answersOf({ option: ['A', 'B', 'C'] })).deepEqual(['left:choose:C', 'up:choose:B', 'right:choose:A']);
    should(answersOf({ option: ['A', 'B', 'C'], recommend: 'B' })).deepEqual([
      'left:choose:C',
      'up:choose:A',
      'right:choose:B',
    ]);
  });

  it('should put a recommended option from a JSON body on the right too', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ options: ['A', 'B'], recommendation: 'B' }));

    // Act
    const request = add(['Which?'], {}, file);

    // Assert
    should(request.answers?.map(a => a.label)).deepEqual(['A', 'B']);
    should(request.answers?.find(a => a.direction === 'right')?.label).equal('B');
  });

  it('should carry the option descriptions from a JSON body onto the answers', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ options: [{ label: 'A', description: 'the first' }, 'B'] }));

    // Act
    const request = add(['Which?'], {}, file);

    // Assert
    should(request.answers?.find(a => a.label === 'A')).containEql({ description: 'the first' });
  });

  it('should infer the kind when --kind is absent', () => {
    // Act + Assert
    should(add(['x'], { option: ['A', 'B'] }).kind).equal('choice');
    should(add(['x'], { option: ['Yes', 'No'] }).kind).equal('yesno');
    should(add(['x'], { step: ['Do it'] }).kind).equal('task');
    should(add(['x'], { question: ['Which?'], option: ['A', 'B'] }).kind).equal('choice');
    should(add(['x'], {}).kind).equal('reply');
  });

  it('should still accept the older kind names', () => {
    // Act + Assert
    should(add(['x'], { kind: 'open' }).kind).equal('reply');
    should(add(['x'], { kind: 'answer-review' }).kind).equal('review');
    should(add(['x'], { kind: 'multiple-choice', option: ['A', 'B'] }).kind).equal('choice');
  });

  it('should refuse a kind it does not know, listing the ones it does', () => {
    // Act + Assert
    should(() => add(['x'], { kind: 'maybe' })).throw(/unknown --kind "maybe" — use task, yesno, permission/u);
  });

  it('should refuse a question on an info card', () => {
    // Act + Assert
    should(() => add(['x'], { kind: 'info', question: ['Which?'] })).throw(/an info card asks nothing/u);
  });
});

describe('attention brief up answer', () => {
  it('should add Skip on the up swipe of a task, which dismisses', () => {
    // Act
    const request = add(['Log in'], { kind: 'task', up: 'Skip it', upWhy: 'Not needed now' });

    // Assert
    should(request.answers).deepEqual([
      { direction: 'left', does: 'needs-info', label: 'Need more info' },
      { direction: 'up', does: 'dismiss', label: 'Skip it', description: 'Not needed now' },
      { direction: 'right', does: 'done', label: 'Done' },
    ]);
  });

  it('should add Always allow on the up swipe of a permission, which approves', () => {
    // Act
    const request = add(['Run it?'], { kind: 'permission', up: 'Always allow' });

    // Assert
    should(request.answers).deepEqual([
      { direction: 'left', does: 'reject', label: 'Deny' },
      { direction: 'up', does: 'approve', label: 'Always allow' },
      { direction: 'right', does: 'approve', label: 'Allow' },
    ]);
  });

  it('should take the up answer from a JSON body as a string or an object', () => {
    // Act
    const text = add(['x'], { kind: 'task' }, parseBriefFile(JSON.stringify({ up: 'Skip' })));
    const object = add(
      ['x'],
      { kind: 'task' },
      parseBriefFile(JSON.stringify({ up: { label: 'Skip', description: 'Later' } })),
    );

    // Assert
    should(text.answers?.find(a => a.direction === 'up')).containEql({ label: 'Skip' });
    should(object.answers?.find(a => a.direction === 'up')).containEql({ label: 'Skip', description: 'Later' });
  });

  it('should refuse --up on a kind that cannot take it, and --up-why alone', () => {
    // Act + Assert
    should(() => add(['x'], { kind: 'choice', option: ['A', 'B'], up: 'Maybe' })).throw(
      /--up only fits --kind task .* or --kind permission .*, not choice/u,
    );
    should(() => add(['x'], { kind: 'review', up: 'Maybe' })).throw(/--up only fits/u);
    should(() => add(['x'], { kind: 'task', upWhy: 'because' })).throw(/--up-why describes --up/u);
  });
});

describe('attention brief answer limit', () => {
  const refusal =
    'a card offers at most 3 answers (swipe left, up, right). Split this into several items, or use --kind reply and let the owner answer in words.';

  it('should refuse more than three --option labels', () => {
    // Act + Assert
    should(() => add(['x'], { option: ['a', 'b', 'c', 'd'] })).throw(refusal);
    should(() => add(['x'], { kind: 'choice', option: ['a', 'b', 'c', 'd'] })).throw(refusal);
  });

  it('should refuse more than three options on a lone --question', () => {
    // Act + Assert
    should(() => add(['x'], { question: ['Which?'], option: ['a', 'b', 'c', 'd'] })).throw(refusal);
  });

  it('should refuse more than three options in a JSON body, item-level or on the lone question', () => {
    // Arrange
    const itemLevel = parseBriefFile(JSON.stringify({ options: ['a', 'b', 'c', 'd'] }));
    const onQuestion = parseBriefFile(
      JSON.stringify({ questions: [{ question: 'Which?', options: ['a', 'b', 'c', 'd'] }] }),
    );

    // Act + Assert
    should(() => add(['x'], {}, itemLevel)).throw(refusal);
    should(() => add(['x'], {}, onQuestion)).throw(refusal);
    should(() => add(['x'], { kind: 'reply' }, onQuestion)).throw(refusal);
  });

  it('should accept exactly three', () => {
    // Act + Assert
    should(add(['x'], { option: ['a', 'b', 'c'] }).answers).have.length(3);
  });

  it('should refuse --option on a yesno, which brings its own', () => {
    // Act + Assert
    should(() => add(['x'], { kind: 'yesno', option: ['Yes', 'No'] })).throw(/--kind yesno brings its own Yes and No/u);
    should(() => add(['x'], { kind: 'yesno' }, parseBriefFile(JSON.stringify({ options: ['Yes', 'No'] })))).throw(
      /--kind yesno brings its own Yes and No/u,
    );
  });
});
