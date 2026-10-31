import { describe, it } from 'bun:test';
import { AgendaItemSchema, MAX_AGENDA_URGENCY_LENGTH } from '@ferretry/protocol';
import should from 'should';
import {
  type BriefFile,
  type BriefFlags,
  composeAddRequest,
  composeEditRequest,
  parseBriefFile,
} from '../../../src/lib/agenda/brief';

/** Every card needs a title, so the tests that are about something else give one. */
const add = (words: readonly string[], flags: BriefFlags = {}, file: BriefFile = {}) =>
  composeAddRequest(words, { title: 'Plan approval', ...flags }, file);

describe('agenda brief composition', () => {
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
      howToResolve: 'Answer this item on the agenda (it records who answered).',
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
    should(() => add(['x'], { question: ['a?', 'b?'], option: ['yes', 'no'] })).throw(
      /several questions → write them as a numbered list for the owner to answer in the reply/u,
    );
    should(() => add(['x'], { term: ['no meaning here'] })).throw(/--term needs TERM=meaning/u);
  });

  it('should name the field a limit refused', () => {
    // Arrange / Act / Assert
    should(() => add(['x'], { urgency: 'u'.repeat(MAX_AGENDA_URGENCY_LENGTH + 1) })).throw(/^urgency: /u);
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

describe('agenda brief points and edits', () => {
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

  it('should strip a leading list marker from a point but keep a multi-line value as written', () => {
    // Arrange / Act
    const marked = add(['pick'], { premise: ['- You asked to', '* second'], decided: ['- only one'] });
    const block = add(['pick'], { decided: ['- a\n- b'] });

    // Assert
    should(marked).containDeep({ premise: '- You asked to\n- second', decided: 'only one' });
    should(block).containDeep({ decided: '- a\n- b' });
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

  it('should turn repeated still-open flags into bullets on add and edit, and read them from a JSON body', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ summary: 'Pick', stillOpen: ['rollback plan', 'who signs'] }));

    // Act
    const several = add(['pick'], { stillOpen: ['rollback plan', 'who signs'] });
    const one = add(['pick'], { stillOpen: ['rollback plan'] });
    const none = add(['pick'], {});
    const fromFile = add([], {}, file);
    const flagged = add([], { stillOpen: ['from the flag'] }, file);
    const edit = composeEditRequest('A3', { stillOpen: ['a', 'b'] }, undefined);

    // Assert
    should(several).containDeep({ stillOpen: '- rollback plan\n- who signs' });
    should(one).containDeep({ stillOpen: 'rollback plan' });
    should(none).not.have.property('stillOpen');
    should(fromFile).containDeep({ stillOpen: '- rollback plan\n- who signs' });
    should(flagged).containDeep({ stillOpen: 'from the flag' });
    should(edit).deepEqual({ action: 'edit', id: 'A3', stillOpen: '- a\n- b' });
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
    const current = AgendaItemSchema.parse({
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
    should(() => composeEditRequest('A3', { question: ['a?'] }, undefined)).throw(/no open agenda item A3/u);
  });
});

describe('agenda brief steps and body', () => {
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

describe('agenda brief to-do asks', () => {
  it('should make steps with no question a task, and let --task or --kind task force it', () => {
    // Arrange / Act
    const implied = add(['Log in'], { step: ['Run `fy login`'] });
    const forced = add(['Log in'], { task: true });
    const named = add(['Log in'], { kind: 'task' });
    const open = add(['Why?'], {});

    // Assert
    should(implied).containDeep({ ask: { kind: 'task' } });
    should(forced).containDeep({ ask: { kind: 'task' } });
    should(named).containDeep({ ask: { kind: 'task' } });
    should(open).containDeep({ ask: { kind: 'open-question' } });
  });

  it('should refuse a task that also asks a question', () => {
    // Act + Assert
    should(() => add(['Log in'], { task: true, question: ['Which?'] })).throw(
      /^a to-do asks nothing: steps, then Mark as done/u,
    );
  });
});

describe('agenda brief card title and ask', () => {
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

describe('agenda brief card kinds and answers', () => {
  const answersOf = (flags: BriefFlags) => add(['Ask'], flags).answers?.map(a => `${a.direction}:${a.does}:${a.label}`);

  it('should compose a task: Mark as done on the right, and nothing else', () => {
    // Act
    const request = add(['Log in'], { kind: 'task' });

    // Assert
    should(request.kind).equal('task');
    should(request.ask).deepEqual({ kind: 'task' });
    should(answersOf({ kind: 'task' })).deepEqual(['right:done:Mark as done']);
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

  it('should compose a permission: Deny on the left, Approve on the right', () => {
    // Act + Assert
    should(add(['Run it?'], { kind: 'permission' }).kind).equal('permission');
    should(answersOf({ kind: 'permission' })).deepEqual(['left:reject:Deny', 'right:approve:Approve']);
  });

  it('should compose a review: Request changes on the left, Approve on the right', () => {
    // Act + Assert
    const request = add(['Is this right?'], { kind: 'review' });
    should(request.ask).deepEqual({ kind: 'answer-review' });
    should(answersOf({ kind: 'review' })).deepEqual(['left:clarify:Request changes', 'right:good:Approve']);
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

  it('should lay a two-option choice out with the first option in the middle', () => {
    // Act + Assert
    should(answersOf({ option: ['Ship', 'Hold'] })).deepEqual(['left:choose:Hold', 'up:choose:Ship']);
  });

  it('should lay a three-option choice out left, up and right, recommended in the middle', () => {
    // Act + Assert
    should(answersOf({ option: ['A', 'B', 'C'] })).deepEqual(['left:choose:B', 'up:choose:A', 'right:choose:C']);
    should(answersOf({ option: ['A', 'B', 'C'], recommend: 'B' })).deepEqual([
      'left:choose:A',
      'up:choose:B',
      'right:choose:C',
    ]);
  });

  it('should put a recommended option from a JSON body in the middle too', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ options: ['A', 'B'], recommendation: 'B' }));

    // Act
    const request = add(['Which?'], {}, file);

    // Assert
    should(request.answers?.map(a => a.label)).deepEqual(['A', 'B']);
    should(request.answers?.find(a => a.direction === 'up')?.label).equal('B');
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
    should(() => add(['x'], { kind: 'maybe' })).throw(/unknown --kind "maybe" — use todo, yesno, permission/u);
  });

  it('should refuse a question on an info card', () => {
    // Act + Assert
    should(() => add(['x'], { kind: 'info', question: ['Which?'] })).throw(
      /^an info card only tells: no --question, --option or --step/u,
    );
  });
});

describe('agenda brief up answer', () => {
  it('should add Skip on the up swipe of a task, which dismisses', () => {
    // Act
    const request = add(['Log in'], { kind: 'task', up: 'Skip it', upWhy: 'Not needed now' });

    // Assert
    should(request.answers).deepEqual([
      { direction: 'up', does: 'dismiss', label: 'Skip it', description: 'Not needed now' },
      { direction: 'right', does: 'done', label: 'Mark as done' },
    ]);
  });

  it('should add Always allow on the up swipe of a permission, which approves', () => {
    // Act
    const request = add(['Run it?'], { kind: 'permission', up: 'Always allow' });

    // Assert
    should(request.answers).deepEqual([
      { direction: 'left', does: 'reject', label: 'Deny' },
      { direction: 'up', does: 'approve', label: 'Always allow' },
      { direction: 'right', does: 'approve', label: 'Approve' },
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
      /--up only fits --kind todo .* or --kind permission .*, not choice/u,
    );
    should(() => add(['x'], { kind: 'review', up: 'Maybe' })).throw(/--up only fits/u);
    should(() => add(['x'], { kind: 'task', upWhy: 'because' })).throw(/--up-why describes --up/u);
  });
});

describe('agenda brief answer limit', () => {
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

describe('a confirmation of a held configuration change (--confirms)', () => {
  it('should name the file and leave the card’s kind, ask and answers to the daemon', () => {
    // Arrange / Act
    const request = add(['Allow the Jev price correction?'], {
      confirms: 'warden.yaml',
      premise: ['the cap counted with $2 per million tokens'],
      step: ['Read the diff'],
    });

    // Assert
    should(request).deepEqual({
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Allow the Jev price correction?',
      title: 'Plan approval',
      why: 'Allow the Jev price correction?',
      context: null,
      premise: 'the cap counted with $2 per million tokens',
      howToResolve: 'Answer this item on the agenda (it records who answered).',
      steps: ['Read the diff'],
      confirms: 'warden.yaml',
    });
  });

  it('should read the file from the JSON body too', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ confirms: 'pack.yaml' }));

    // Act
    const request = add(['Allow Pack mode?'], {}, file);

    // Assert
    should(request).containDeep({ confirms: 'pack.yaml' });
    should(request).not.have.property('ask');
  });

  it('should refuse the flags that would choose the card’s own answers', () => {
    // Arrange / Act / Assert
    should(() => add(['Allow it?'], { confirms: 'warden.yaml', kind: 'yesno' })).throw(
      "--confirms writes the card's answers itself (Allow, Deny, Discard change): drop --kind",
    );
    should(() =>
      add(['Allow it?'], { confirms: 'warden.yaml', option: ['a', 'b'], question: ['which?'], up: 'Skip' }),
    ).throw(/drop --option, --question, --up$/u);
    should(() => add(['Allow it?'], { confirms: 'warden.yaml' }, { up: { label: 'Skip' } })).throw(/drop --up$/u);
  });
});

describe('agenda option details', () => {
  const options = ['Go', 'Wait'];

  it('should split "Label: detail" on the first colon when the label is short, leaving the label as the option', () => {
    // Arrange / Act
    const request = add(['Ship it?'], { option: ['Go: Ship now: it is **ready**', 'Wait'] });

    // Assert
    should(request).containDeep({
      ask: { kind: 'multiple-choice', options: [{ label: 'Go' }, { label: 'Wait' }] },
      optionDetails: [{ label: 'Go', detail: 'Ship now: it is **ready**' }],
    });
  });

  it('should keep a long lead as the whole label, and a label with nothing after the colon', () => {
    // Arrange
    const long = 'A very long option label that runs past forty characters: why';

    // Act
    const request = add(['Ship it?'], { option: [long, 'Wait: '] });

    // Assert
    should(request).not.have.property('optionDetails');
    should(request).containDeep({ ask: { options: [{ label: long }, { label: 'Wait:' }] } });
  });

  it('should read --option-detail as label=markdown, the later words winning over the same option', () => {
    // Arrange / Act
    const request = add(['Ship it?'], {
      option: ['Go: first words', 'Wait'],
      optionDetail: ['Wait=Cheaper, see `plan.md`', 'Go=Final = **words**'],
    });

    // Assert
    should(request).containDeep({
      optionDetails: [
        { label: 'Go', detail: 'Final = **words**' },
        { label: 'Wait', detail: 'Cheaper, see `plan.md`' },
      ],
    });
  });

  it('should take the details from the JSON body too, and refuse one that names no option', () => {
    // Arrange
    const file = parseBriefFile(JSON.stringify({ optionDetails: [{ label: 'Go', detail: 'Now.' }] }));

    // Act / Assert
    should(add(['Ship it?'], { option: options }, file)).containDeep({
      optionDetails: [{ label: 'Go', detail: 'Now.' }],
    });
    should(() => add(['Ship it?'], { option: options, optionDetail: ['Stop=x'] })).throw(/"Stop"/u);
  });

  it('should refuse an --option-detail that is not label=markdown', () => {
    // Arrange / Act / Assert
    should(() => add(['Ship it?'], { option: options, optionDetail: ['Go'] })).throw(
      '--option-detail needs label=markdown, got "Go"',
    );
    should(() => add(['Ship it?'], { option: options, optionDetail: ['=x'] })).throw(/needs label=markdown/u);
  });

  it('should edit the details through either flag, and refuse a bare option, which an edit cannot add', () => {
    // Arrange / Act
    const edit = composeEditRequest('A1', { option: ['Go: Now.'], optionDetail: ['Wait=Later.'] }, undefined);

    // Assert
    should(edit).containDeep({
      optionDetails: [
        { label: 'Go', detail: 'Now.' },
        { label: 'Wait', detail: 'Later.' },
      ],
    });
    should(() => composeEditRequest('A1', { option: ['Go'] }, undefined)).throw(/cannot change the options/u);
  });
});

describe('agenda brief answer shapes', () => {
  const STEPS_ONLY_TODO =
    /^--step is only for a to-do \(--kind todo\): steps, then Mark as done\. Steps AND a question/u;
  const OPTIONS_ONLY_CHOICE = /^--option is only for a choice: ONE question, 2–3 options, each explained/u;
  const SEVERAL =
    /^several questions → write them as a numbered list for the owner to answer in the reply: .*no --option/u;

  it('should make several plain questions one reply with no buttons, the owner answering each in words', () => {
    // Act
    const request = add(['Three answers'], { question: ['Which region?', 'OK to restart?', 'Your work email?'] });

    // Assert
    should(request.kind).equal('reply');
    should(request.ask).deepEqual({ kind: 'open-question' });
    should(request).not.have.property('answers');
    should(request.questions?.map(each => each.question)).deepEqual([
      'Which region?',
      'OK to restart?',
      'Your work email?',
    ]);
  });

  it('should refuse several questions given options or another kind, naming the numbered-reply shape', () => {
    // Arrange
    const optioned = parseBriefFile(
      JSON.stringify({ questions: [{ question: 'Which region?', options: ['EU', 'US'] }, 'OK to restart?'] }),
    );

    // Act + Assert
    should(() => add(['x'], { question: ['a?', 'b?'], option: ['A', 'B'] })).throw(SEVERAL);
    should(() => add(['x'], {}, optioned)).throw(SEVERAL);
    for (const kind of ['choice', 'yesno', 'permission', 'review']) {
      should(() => add(['x'], { kind, question: ['a?', 'b?'] })).throw(SEVERAL);
    }
    should(add(['x'], { kind: 'reply', question: ['a?', 'b?'] }).kind).equal('reply');
  });

  it('should keep options to a choice: never on a reply, a permission, a review, a to-do or an info card', () => {
    // Act + Assert
    for (const kind of ['reply', 'permission', 'review', 'todo', 'info']) {
      should(() => add(['x'], { kind, option: ['A', 'B'] })).throw(OPTIONS_ONLY_CHOICE);
    }
    should(add(['x'], { kind: 'choice', option: ['A: first', 'B: second'] }).kind).equal('choice');
  });

  it('should keep steps to a to-do: a question with steps is a mix, refused with the shape to write instead', () => {
    // Act + Assert
    should(() => add(['Which?'], { step: ['One'], option: ['A', 'B'] })).throw(STEPS_ONLY_TODO);
    should(() => add(['Which?'], { step: ['One'], question: ['Which?'] })).throw(STEPS_ONLY_TODO);
    for (const kind of ['reply', 'permission', 'review', 'yesno']) {
      should(() => add(['x'], { kind, step: ['One'] })).throw(STEPS_ONLY_TODO);
    }
    should(() => add(['x'], { kind: 'info', step: ['One'] })).throw(/^an info card only tells/u);
    should(add(['x'], { step: ['One'] }).kind).equal('task');
  });

  it('should refuse an edit that gives steps to an item that is not a to-do', () => {
    // Arrange
    const reply = AgendaItemSchema.parse({
      id: 'A3',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'x',
      why: 'x',
      waitingSince: '2026-10-26T09:00:00.000Z',
      howToResolve: 'x',
      ask: { kind: 'open-question' },
      kind: 'reply',
      raisedBy: 'agent',
      raisedBySession: 's',
      raisedByName: 'Ada',
    });
    const todo = AgendaItemSchema.parse({ ...reply, ask: { kind: 'task' }, kind: 'task' });

    // Act + Assert
    should(() => composeEditRequest('A3', { step: ['One'] }, reply)).throw(STEPS_ONLY_TODO);
    should(composeEditRequest('A3', { step: ['One'] }, todo)).containDeep({ steps: ['One'] });
  });
});
