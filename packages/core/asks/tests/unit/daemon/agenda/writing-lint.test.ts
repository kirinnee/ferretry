import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENDA_MIXED_BODY_LENGTH,
  AGENDA_MIXED_BODY_SECTIONS,
  lintAgendaWriting,
} from '../../../../daemon/lib/agenda/writing-lint.ts';

const clean = {
  title: 'Work login plan',
  subject: 'Pick a login plan',
  context: '- the old login expires\n- two plans fit',
  questions: [{ question: 'Which plan should I build?' }],
};

describe('attention writing lint', () => {
  it('should say nothing about a short, plain, self-contained item', () => {
    should(lintAgendaWriting(clean)).deepEqual([]);
  });

  it('should warn about an ask over the target length', () => {
    const actual = lintAgendaWriting({ ...clean, subject: 'word '.repeat(20).trim() });

    should(actual).have.length(1);
    should(actual[0]).match(/^ask is 99 characters; keep it to about 80: .*--body/u);
  });

  it('should accept an ask of exactly the target length', () => {
    should(lintAgendaWriting({ ...clean, subject: 'x'.repeat(80) })).deepEqual([]);
  });

  it('should warn about ticket and pull request ids, naming where they sit', () => {
    const actual = lintAgendaWriting({ ...clean, subject: 'Unblock ABC-123', context: 'See #1234 and #77.' });

    should(actual).have.length(1);
    should(actual[0]).match(/ticket or PR ids \("ABC-123", "#1234", "#77"\) in ask, context/u);
  });

  it('should warn about links and file paths but not about plain slashes', () => {
    const actual = lintAgendaWriting({
      ...clean,
      context: 'Read https://example.com/a and edit packages/cli/src/main.ts or ~/notes/todo, either/or.',
    });

    should(actual).have.length(2);
    should(actual[0]).match(/^links \("https:\/\/example\.com\/a"\)/u);
    should(actual[1]).match(/^file paths \(.*packages\/cli\/src\/main\.ts.*\)/u);
    should(actual[1]).not.match(/either\/or/u);
  });

  it('should warn about capitals nobody explained, and accept those defined in terms', () => {
    const bare = lintAgendaWriting({ ...clean, context: 'The OCI login and the VPN are down. OK?' });
    const defined = lintAgendaWriting({
      ...clean,
      context: 'The OCI login and the VPN are down.',
      terms: [
        { term: 'OCI work login', meaning: 'the cloud login' },
        { term: 'vpn', meaning: 'the private network' },
      ],
    });

    should(bare).have.length(1);
    should(bare[0]).match(/unexplained capitals \("OCI", "VPN"\) in context/u);
    should(defined).deepEqual([]);
  });

  it('should read every field, including questions, the recommendation, impact and urgency', () => {
    const actual = lintAgendaWriting({
      ...clean,
      questions: [{ question: 'Use JWT?', why: 'Matches XYZ.' }],
      recommendation: { decision: 'Yes, DNS first', why: 'Cheap' },
      impact: 'Blocks DEV-9',
      urgency: 'Before EOD',
    });

    should(actual.join('\n')).match(/"JWT", "XYZ", "DNS" …/u);
    should(actual.join('\n')).match(/"DEV-9"/u);
  });

  it('should not count a ticket id or path as an acronym as well', () => {
    const actual = lintAgendaWriting({ ...clean, context: 'ABC-123 lives in docs/AGENDA/NOTES.md' });

    should(actual.join('\n')).not.match(/unexplained capitals/u);
  });
});

describe('attention writing lint steps and body', () => {
  it('should not flag commands, paths or links inside steps and body', () => {
    const actual = lintAgendaWriting({
      ...clean,
      steps: ['Run `fy login` then open https://example.com/a and edit packages/cli/src/main.ts (ABC-123)'],
      body: '```sh\ncat ~/notes/todo\n```',
    } as Parameters<typeof lintAgendaWriting>[0]);

    should(actual).deepEqual([]);
  });
});

describe('attention writing lint: an isolated card', () => {
  it('should ask for a title when the card has none, saying how to add one', () => {
    const { title: _, ...untitled } = clean;
    const actual = lintAgendaWriting(untitled);

    should(actual).have.length(1);
    should(actual[0]).match(/^no title: .*--title "<what this is about>".*under 40 characters.*notification heading/u);
  });

  it('should warn about a title too long for a lock screen', () => {
    const actual = lintAgendaWriting({ ...clean, title: 'Decide how the work login gets renewed overnight' });

    should(actual).have.length(1);
    should(actual[0]).match(/^title is 48 characters; keep it under 40/u);
  });

  it('should read the title for ids and jargon like any other field', () => {
    const actual = lintAgendaWriting({ ...clean, title: 'Unblock KT-412 OCI cron' });

    should(actual.join('\n')).match(/"KT-412"\) in title/u);
    should(actual.join('\n')).match(/unexplained capitals \("OCI"\) in title/u);
  });

  it('should warn about pointing at earlier messages, and say where', () => {
    const cases = [
      'Do it as above.',
      'Ship the plan as discussed.',
      'Merge the earlier pull request first.',
      'The previous message has the details.',
      'Approve the fix we discussed.',
      'Same as before, per our discussion.',
    ];
    for (const context of cases) {
      const actual = lintAgendaWriting({ ...clean, context });

      should(actual).have.length(1);
      should(actual[0]).match(/^points elsewhere \(.+\) in context: .*say the thing itself on the card/u);
    }
  });

  it('should not mistake ordinary words for a back-reference', () => {
    const actual = lintAgendaWriting({
      ...clean,
      context: 'The login expired earlier today. Renewal runs above the rate limit. See the steps below.',
    });

    should(actual).deepEqual([]);
  });

  it('should accept an id that says what it is in brackets, and still flag a bare one', () => {
    const described = lintAgendaWriting({ ...clean, context: 'Waits on #812 (the push worker fix).' });
    const bare = lintAgendaWriting({ ...clean, context: 'Waits on #812 and KT-9 (fix).' });

    should(described).deepEqual([]);
    should(bare).have.length(1);
    should(bare[0]).match(/"KT-9", "#812".*"#812 \(the push worker fix\)"/u);
  });

  it('should warn about choice options that do not say what choosing them does', () => {
    const actual = lintAgendaWriting({
      ...clean,
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'Option 2' }, { label: 'Ship it today' }] },
    });

    should(actual).have.length(1);
    should(actual[0]).match(/^options "A", "Option 2" do not say what choosing them does/u);
  });

  it('should accept a short option with a description, and yes or no', () => {
    const actual = lintAgendaWriting({
      ...clean,
      kind: 'choice',
      ask: {
        kind: 'multiple-choice',
        options: [{ label: 'A', description: 'Renew the login every 30 minutes' }, { label: 'No' }, { label: 'Later' }],
      },
    });

    should(actual).deepEqual([]);
  });

  it('should read the answers a card offers for jargon', () => {
    const actual = lintAgendaWriting({
      ...clean,
      kind: 'permission',
      ask: { kind: 'permission' },
      answers: [
        { direction: 'left', does: 'reject', label: 'Deny' },
        { direction: 'up', does: 'approve', label: 'Always allow', description: 'Add it to the OCI allowlist' },
        { direction: 'right', does: 'approve', label: 'Allow' },
      ],
    });

    should(actual.join('\n')).match(/unexplained capitals \("OCI"\) in answer "Always allow"/u);
  });
});

describe('attention writing lint: premise and isolation', () => {
  const { context: _, ...bare } = clean;

  it('should warn strongly when a decision has neither premise nor context, and say how to fix it', () => {
    const actual = lintAgendaWriting(bare);

    should(actual).have.length(1);
    should(actual[0]).match(/^a reader opening this cold cannot tell what is going on — add --premise points/u);
    should(actual[0]).match(/agenda edit <id> --premise/u);
  });

  it('should warn for each kind of decision: permission, choice, yes/no, open question and questions', () => {
    const base = { title: 'Work login plan', subject: 'Pick a login plan' };
    const decisions = [
      { ...base, kind: 'permission' as const },
      { ...base, kind: 'choice' as const },
      { ...base, kind: 'yesno' as const },
      { ...base, ask: { kind: 'open-question' as const } },
      { ...base, questions: [{ question: 'Which plan?' }] },
    ];

    for (const decision of decisions) {
      should(lintAgendaWriting(decision).join('\n')).match(/cannot tell what is going on/u);
    }
  });

  it('should accept either a premise or a context, and say nothing about a to-do or an info card', () => {
    const base = { title: 'Work login plan', subject: 'Pick a login plan' };

    should(lintAgendaWriting({ ...bare, premise: '- the old login expires' })).deepEqual([]);
    should(lintAgendaWriting({ ...bare, context: '- two plans fit' })).deepEqual([]);
    should(lintAgendaWriting({ ...base, kind: 'task', ask: { kind: 'task' } })).deepEqual([]);
    should(lintAgendaWriting({ ...base, kind: 'info' })).deepEqual([]);
  });

  it('should read the premise and the decided points for ids, paths and jargon like any other field', () => {
    const actual = lintAgendaWriting({
      ...clean,
      premise: 'The OCI login broke after #1234 as discussed.',
      decided: 'You chose the plan in packages/cli/src/main.ts.',
    });
    const text = actual.join('\n');

    should(text).match(/points elsewhere \("as discussed"\) in premise/u);
    should(text).match(/ticket or PR ids \("#1234"\) in premise/u);
    should(text).match(/file paths \(.*main\.ts.*\) in decided/u);
    should(text).match(/unexplained capitals \("OCI"\) in premise/u);
  });
});

describe('attention writing lint: headings', () => {
  it('should warn about a heading line in the ask, naming it and the fix', () => {
    const actual = lintAgendaWriting({ ...clean, subject: '# Pick a login plan' });

    should(actual).have.length(1);
    should(actual[0]).match(/^markdown headings \(# …\) in ask: /u);
    should(actual[0]).containEql('short points (- …) or a bold lead');
  });

  it('should name every segment that carries a heading, once, at any level', () => {
    const actual = lintAgendaWriting({
      ...clean,
      premise: '## Situation\n- the login expires',
      context: '- fine\n###### Deep\n- fine',
      decided: '#\n- empty heading',
      stillOpen: '   # indented up to three spaces',
      questionAnswer: '# Answer',
    });

    should(actual).have.length(1);
    should(actual[0]).match(
      /^markdown headings \(# …\) in premise, context, decided, still open, answer to the question: /u,
    );
  });

  it('should leave references, bold leads, fenced code and a body alone', () => {
    const context =
      '#812 (the push worker fix) is merged\n#812 (the push worker fix) again\n**Decided:** ship it\n\n```sh\n# a comment, not a heading\n```';
    const body = '# Steps\n\n## Run it\n- do the thing';

    should(lintAgendaWriting({ ...clean, context, body })).deepEqual([]);
  });

  it('should not take a hash with no space after it, or four spaces of indent, for a heading', () => {
    should(lintAgendaWriting({ ...clean, context: '#tag and #1b\n    # code block line' })).deepEqual([]);
  });
});

describe('attention writing lint: walls of text', () => {
  const wall = `${'Yes, by design: one plan and one data model. '.repeat(8)}Done.`;

  it('should warn about a segment that is one paragraph past the target, naming it and the fix', () => {
    const actual = lintAgendaWriting({ ...clean, questionAnswer: wall });

    should(actual).have.length(1);
    should(actual[0]).match(/^answer to the question is one paragraph over 280 characters: /u);
    should(actual[0]).containEql('split this into short points (- …) or bold the answer first');
  });

  it('should name every segment that is a wall, once, and read the premise, context, still open, body and an option', () => {
    const actual = lintAgendaWriting({
      ...clean,
      premise: wall,
      context: wall,
      stillOpen: wall,
      body: wall,
      optionDetails: [{ label: 'Ship', detail: wall }],
    });

    should(actual).have.length(1);
    should(actual[0]).match(/^premise, context, still open, body, option "Ship" are one paragraph over 280 /u);
  });

  it('should say nothing about short points, a bold lead over bullets, or a paragraph at the target', () => {
    const bullets = Array.from({ length: 12 }, () => '- one plan and one data model for everyone').join('\n');

    should(lintAgendaWriting({ ...clean, questionAnswer: `**Yes, by design.**\n${bullets}` })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, context: 'x'.repeat(280) })).deepEqual([]);
  });

  it('should judge each line on its own: a long text broken into short lines is fine, one long line among them is not', () => {
    const lines = Array.from({ length: 10 }, () => 'One short line of the answer.').join('\n');

    should(lintAgendaWriting({ ...clean, context: lines })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, context: `${lines}\n${wall}` })).have.length(1);
  });

  it('should leave fenced code, tables and headings in a body alone', () => {
    const body = `# ${wall}\n\n| ${wall} |\n\n\`\`\`\n${wall}\n\`\`\``;

    should(lintAgendaWriting({ ...clean, body })).deepEqual([]);
  });
});

describe('attention writing lint: a link says what it is', () => {
  it('should warn, never refuse, for a link with no meaning, naming it and the form', () => {
    // Arrange / Act
    const actual = lintAgendaWriting({
      ...clean,
      links: [
        { label: 'Plan', target: '&F12' },
        { target: '#F13' },
        { label: 'PR', target: '#F14', meaning: 'The fix' },
      ],
    });

    // Assert
    should(actual).have.length(1);
    should(actual[0]).match(/^links without a meaning \("Plan", "#F13"\): say what each is, in plain words/u);
    should(actual[0]).containEql('--link "label=target=meaning"');
  });

  it('should say it in the singular for one link', () => {
    should(lintAgendaWriting({ ...clean, links: [{ label: 'Plan', target: '&F12' }] })[0]).containEql(
      'say what it is, in plain words',
    );
  });

  it('should say nothing when every link has a meaning, or there are no links', () => {
    should(lintAgendaWriting({ ...clean, links: [{ label: 'Plan', target: '&F12', meaning: 'The plan' }] })).deepEqual(
      [],
    );
    should(lintAgendaWriting(clean)).deepEqual([]);
  });
});

describe('attention writing lint: a long body that may be several kinds of content (&F946)', () => {
  const part = (title: string, length: number): string =>
    `## ${title}\n\n${'- A plain point about it.\n'.repeat(Math.ceil(length / 26))}`;
  const long = [part('Steps', 1_500), part('Status', 1_500), part('Results', 1_500)].join('\n');

  it('should hint, never refuse, at tabs for a long body with several top-level sections', () => {
    should(long.length).be.above(AGENDA_MIXED_BODY_LENGTH);
    const actual = lintAgendaWriting({ ...clean, body: long });

    should(actual).have.length(1);
    should(actual[0]).match(
      /^the body has 3 sections in \d+ characters: .*--tab-file "Name=file".*continuous report.*one tab$/u,
    );
  });

  it('should say nothing for a short body, too few sections, or headings inside fenced code', () => {
    const short = [part('Steps', 200), part('Status', 200), part('Results', 200)].join('\n');
    const two = [part('Steps', 2_500), part('Status', 2_500)].join('\n');
    const fenced = `\`\`\`md\n${long}\n\`\`\`\n${'More words. '.repeat(10)}`;
    const deep = long.replaceAll('## ', '### ');
    // A four-backtick example showing a three-backtick block (headings and all) is one block of code; so is a tilde
    // fence holding backticks. An unclosed fence runs to the end.
    const nested = `\`\`\`\`md\n\`\`\`text\n${long}\n\`\`\`\n\`\`\`\``;
    const tilde = `~~~\n\`\`\`\n${long}\n~~~`;
    const unclosed = `\`\`\`\n${long}`;

    should(AGENDA_MIXED_BODY_SECTIONS).equal(3);
    should(lintAgendaWriting({ ...clean, body: short })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: two })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: fenced })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: deep })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: nested })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: tilde })).deepEqual([]);
    should(lintAgendaWriting({ ...clean, body: unclosed })).deepEqual([]);
    // After a fence closes, its sections count again; a fence line with words after it does not close it.
    should(lintAgendaWriting({ ...clean, body: `\`\`\`\`\n\`\`\`\` not yet\n\`\`\`\`\n${long}` })).have.length(1);
    should(lintAgendaWriting({ ...clean })).deepEqual([]);
  });
});
