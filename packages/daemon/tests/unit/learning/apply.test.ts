import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { LEARNING_ABSENT_FILE_ETAG } from '@ferretry/protocol';
import should from 'should';
import {
  insertLesson,
  LESSONS_HEADING,
  lessonBullet,
  lessonFileEtag,
  repoInstructionsFileName,
  unifiedDiff,
} from '../../../src/lib/learning/index.ts';

/**
 * Applying a lesson: the exact text change, the diff the owner approves, and the etag that pins it.
 * Every case states the whole file before and after, because "nothing else in the file moves" is the
 * property an owner is trusting when they press Apply.
 */

const RULE = 'Use bun for scripts.';

describe('applying a lesson', () => {
  describe('the bullet', () => {
    it('should collapse the rule onto one Markdown bullet', () => {
      // Arrange / Act / Assert
      should(lessonBullet('  Use bun\n   for\tscripts.  ')).equal('- Use bun for scripts.');
    });
  });

  describe('insertLesson', () => {
    it('should create the heading and the bullet when the file is absent', () => {
      // Arrange / Act / Assert
      should(insertLesson(undefined, RULE)).equal(`${LESSONS_HEADING}\n\n- Use bun for scripts.\n`);
    });

    it('should treat an empty or blank file as absent', () => {
      // Arrange / Act / Assert
      should(insertLesson('', RULE)).equal('## Lessons\n\n- Use bun for scripts.\n');
      should(insertLesson(' \n\n', RULE)).equal('## Lessons\n\n- Use bun for scripts.\n');
    });

    it('should append the heading at the end of a file that has none', () => {
      // Arrange
      const before = '# Guide\n\nBe kind.\n';

      // Act / Assert
      should(insertLesson(before, RULE)).equal('# Guide\n\nBe kind.\n\n## Lessons\n\n- Use bun for scripts.\n');
    });

    it('should put the first bullet under an empty heading after one blank line', () => {
      // Arrange / Act / Assert
      should(insertLesson('# Guide\n\n## Lessons\n', RULE)).equal('# Guide\n\n## Lessons\n\n- Use bun for scripts.\n');
      // An empty section followed straight by the next heading keeps that heading where it was.
      should(insertLesson('## Lessons\n## Next\n', RULE)).equal('## Lessons\n\n- Use bun for scripts.\n## Next\n');
    });

    it('should append after the last bullet and keep the blank line before the next heading', () => {
      // Arrange
      const before = '## Lessons\n\n- Run task test.\n\n## Other\nText.\n';

      // Act / Assert
      should(insertLesson(before, RULE)).equal(
        '## Lessons\n\n- Run task test.\n- Use bun for scripts.\n\n## Other\nText.\n',
      );
    });

    it('should leave the trailing blank lines of a final section where they were', () => {
      // Arrange
      const before = '## Lessons\n- Run task test.\n\n\n';

      // Act / Assert
      should(insertLesson(before, RULE)).equal('## Lessons\n- Run task test.\n- Use bun for scripts.\n\n\n');
    });

    it('should treat a level-three heading as part of the section', () => {
      // Arrange
      const before = '## Lessons\n- one\n### Detail\n- two\n';

      // Act / Assert
      should(insertLesson(before, RULE)).equal('## Lessons\n- one\n### Detail\n- two\n- Use bun for scripts.\n');
    });

    it('should find the heading even when it carries surrounding whitespace', () => {
      // Arrange / Act / Assert
      should(insertLesson('  ## Lessons  \n- one', RULE)).equal('  ## Lessons  \n- one\n- Use bun for scripts.\n');
    });
  });

  describe('unifiedDiff', () => {
    it('should show a new file as created from /dev/null', () => {
      // Arrange
      const after = insertLesson(undefined, RULE);

      // Act / Assert
      should(unifiedDiff('AGENTS.md', undefined, after)).equal(
        '--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1,3 @@\n+## Lessons\n+\n+- Use bun for scripts.\n',
      );
    });

    it('should show an empty existing file as itself rather than as /dev/null', () => {
      // Arrange / Act
      const diff = unifiedDiff('CLAUDE.md', '', 'one\n');

      // Assert
      should(diff).equal('--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -0,0 +1 @@\n+one\n');
    });

    it('should show an insertion with three lines of context on each side', () => {
      // Arrange
      const before = 'a\nb\nc\nd\n## Lessons\n- one\n\n## Next\ne\nf\ng\nh\n';
      const after = insertLesson(before, RULE);

      // Act / Assert
      should(unifiedDiff('AGENTS.md', before, after)).equal(
        [
          '--- a/AGENTS.md',
          '+++ b/AGENTS.md',
          '@@ -4,6 +4,7 @@',
          ' d',
          ' ## Lessons',
          ' - one',
          '+- Use bun for scripts.',
          ' ',
          ' ## Next',
          ' e',
          '',
        ].join('\n'),
      );
    });

    it('should show an append at the very end with only leading context', () => {
      // Arrange
      const before = 'a\nb\nc\nd\n## Lessons\n- one\n';

      // Act / Assert
      should(unifiedDiff('x.md', before, insertLesson(before, RULE))).equal(
        '--- a/x.md\n+++ b/x.md\n@@ -4,3 +4,4 @@\n d\n ## Lessons\n - one\n+- Use bun for scripts.\n',
      );
    });

    it('should stay a truthful diff for a replacement', () => {
      // Arrange / Act / Assert
      should(unifiedDiff('x.md', 'a\n', 'b\n')).equal('--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n');
    });
  });

  describe('lessonFileEtag', () => {
    it('should pin an absent file to the protocol absent token', () => {
      // Arrange / Act / Assert
      should(lessonFileEtag(undefined)).equal(LEARNING_ABSENT_FILE_ETAG);
    });

    it('should pin a present file to a digest of its content', () => {
      // Arrange
      const text = '## Lessons\n';

      // Act
      const etag = lessonFileEtag(text);

      // Assert
      should(etag).equal(createHash('sha256').update(text).digest('hex').slice(0, 32));
      should(etag).have.length(32);
      should(lessonFileEtag('')).not.equal(LEARNING_ABSENT_FILE_ETAG);
      should(lessonFileEtag(`${text} `)).not.equal(etag);
    });
  });

  describe('repoInstructionsFileName', () => {
    const cases: ReadonlyArray<readonly [boolean, boolean, 'claude' | 'codex', string]> = [
      [true, true, 'claude', 'AGENTS.md'],
      [true, false, 'claude', 'AGENTS.md'],
      [false, true, 'codex', 'CLAUDE.md'],
      [false, false, 'claude', 'CLAUDE.md'],
      [false, false, 'codex', 'AGENTS.md'],
    ];

    for (const [agents, claude, harness, expected] of cases) {
      it(`should choose ${expected} when AGENTS.md is ${agents ? 'there' : 'absent'}, CLAUDE.md is ${claude ? 'there' : 'absent'} and the ferret runs ${harness}`, () => {
        // Arrange / Act / Assert
        should(repoInstructionsFileName({ agents, claude }, harness)).equal(expected);
      });
    }
  });
});
