import { describe, it } from 'bun:test';
import should from 'should';
import { lintAttentionWriting } from '../../../src/lib/attention/writing-lint.ts';

const clean = {
  subject: 'Pick a login plan',
  context: '- the old login expires\n- two plans fit',
  questions: [{ question: 'Which plan should I build?' }],
};

describe('attention writing lint', () => {
  it('should say nothing about a short, plain, self-contained item', () => {
    should(lintAttentionWriting(clean)).deepEqual([]);
  });

  it('should warn about a summary over the target length', () => {
    const actual = lintAttentionWriting({ ...clean, subject: 'word '.repeat(30).trim() });

    should(actual).have.length(1);
    should(actual[0]).match(/^summary is 149 characters; keep it under 90/u);
  });

  it('should warn about ticket and pull request ids, naming where they sit', () => {
    const actual = lintAttentionWriting({ ...clean, subject: 'Unblock ABC-123', context: 'See #1234 and #77.' });

    should(actual).have.length(1);
    should(actual[0]).match(/ticket or PR ids \("ABC-123", "#1234", "#77"\) in summary, context/u);
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
