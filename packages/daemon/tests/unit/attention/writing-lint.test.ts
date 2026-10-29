import { describe, it } from 'bun:test';
import should from 'should';
import { lintAttentionWriting } from '../../../src/lib/attention/writing-lint.ts';

const clean = {
  title: 'Work login plan',
  subject: 'Pick a login plan',
  context: '- the old login expires\n- two plans fit',
  questions: [{ question: 'Which plan should I build?' }],
};

describe('attention writing lint', () => {
  it('should say nothing about a short, plain, self-contained item', () => {
    should(lintAttentionWriting(clean)).deepEqual([]);
  });

  it('should warn about an ask over the target length', () => {
    const actual = lintAttentionWriting({ ...clean, subject: 'word '.repeat(30).trim() });

    should(actual).have.length(1);
    should(actual[0]).match(/^ask is 149 characters; keep it under 120: .*--context/u);
  });

  it('should warn about ticket and pull request ids, naming where they sit', () => {
    const actual = lintAttentionWriting({ ...clean, subject: 'Unblock ABC-123', context: 'See #1234 and #77.' });

    should(actual).have.length(1);
    should(actual[0]).match(/ticket or PR ids \("ABC-123", "#1234", "#77"\) in ask, context/u);
  });

  it('should warn about links and file paths but not about plain slashes', () => {
    const actual = lintAttentionWriting({
      ...clean,
      context: 'Read https://example.com/a and edit packages/cli/src/main.ts or ~/notes/todo, either/or.',
    });

    should(actual).have.length(2);
    should(actual[0]).match(/^links \("https:\/\/example\.com\/a"\)/u);
    should(actual[1]).match(/^file paths \(.*packages\/cli\/src\/main\.ts.*\)/u);
    should(actual[1]).not.match(/either\/or/u);
  });

  it('should warn about capitals nobody explained, and accept those defined in terms', () => {
    const bare = lintAttentionWriting({ ...clean, context: 'The OCI login and the VPN are down. OK?' });
    const defined = lintAttentionWriting({
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
    const actual = lintAttentionWriting({
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
    const actual = lintAttentionWriting({ ...clean, context: 'ABC-123 lives in docs/ATTENTION/NOTES.md' });

    should(actual.join('\n')).not.match(/unexplained capitals/u);
  });
});

describe('attention writing lint steps and body', () => {
  it('should not flag commands, paths or links inside steps and body', () => {
    const actual = lintAttentionWriting({
      ...clean,
      steps: ['Run `fy login` then open https://example.com/a and edit packages/cli/src/main.ts (ABC-123)'],
      body: '```sh\ncat ~/notes/todo\n```',
    } as Parameters<typeof lintAttentionWriting>[0]);

    should(actual).deepEqual([]);
  });
});

describe('attention writing lint: an isolated card', () => {
  it('should ask for a title when the card has none, saying how to add one', () => {
    const { title: _, ...untitled } = clean;
    const actual = lintAttentionWriting(untitled);

    should(actual).have.length(1);
    should(actual[0]).match(/^no title: .*--title "<what this is about>".*under 40 characters.*notification heading/u);
  });

  it('should warn about a title too long for a lock screen', () => {
    const actual = lintAttentionWriting({ ...clean, title: 'Decide how the work login gets renewed overnight' });

    should(actual).have.length(1);
    should(actual[0]).match(/^title is 48 characters; keep it under 40/u);
  });

  it('should read the title for ids and jargon like any other field', () => {
    const actual = lintAttentionWriting({ ...clean, title: 'Unblock KT-412 OCI cron' });

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
      const actual = lintAttentionWriting({ ...clean, context });

      should(actual).have.length(1);
      should(actual[0]).match(/^points elsewhere \(.+\) in context: .*say the thing itself on the card/u);
    }
  });

  it('should not mistake ordinary words for a back-reference', () => {
    const actual = lintAttentionWriting({
      ...clean,
      context: 'The login expired earlier today. Renewal runs above the rate limit. See the steps below.',
    });

    should(actual).deepEqual([]);
  });

  it('should accept an id that says what it is in brackets, and still flag a bare one', () => {
    const described = lintAttentionWriting({ ...clean, context: 'Waits on #812 (the push worker fix).' });
    const bare = lintAttentionWriting({ ...clean, context: 'Waits on #812 and KT-9 (fix).' });

    should(described).deepEqual([]);
    should(bare).have.length(1);
    should(bare[0]).match(/"KT-9", "#812".*"#812 \(the push worker fix\)"/u);
  });

  it('should warn about choice options that do not say what choosing them does', () => {
    const actual = lintAttentionWriting({
      ...clean,
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'Option 2' }, { label: 'Ship it today' }] },
    });

    should(actual).have.length(1);
    should(actual[0]).match(/^options "A", "Option 2" do not say what choosing them does/u);
  });

  it('should accept a short option with a description, and yes or no', () => {
    const actual = lintAttentionWriting({
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
    const actual = lintAttentionWriting({
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
    const actual = lintAttentionWriting(bare);

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
      should(lintAttentionWriting(decision).join('\n')).match(/cannot tell what is going on/u);
    }
  });

  it('should accept either a premise or a context, and say nothing about a to-do or an info card', () => {
    const base = { title: 'Work login plan', subject: 'Pick a login plan' };

    should(lintAttentionWriting({ ...bare, premise: '- the old login expires' })).deepEqual([]);
    should(lintAttentionWriting({ ...bare, context: '- two plans fit' })).deepEqual([]);
    should(lintAttentionWriting({ ...base, kind: 'task', ask: { kind: 'task' } })).deepEqual([]);
    should(lintAttentionWriting({ ...base, kind: 'info' })).deepEqual([]);
  });

  it('should read the premise and the decided points for ids, paths and jargon like any other field', () => {
    const actual = lintAttentionWriting({
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
