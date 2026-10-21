import { describe, it } from 'bun:test';
import should from 'should';
import {
  briefFileReference,
  briefHash,
  deriveTaskTitle,
  fallbackTaskTitle,
  taskTitleFor,
} from '../../src/lib/task-title.ts';

describe('deriveTaskTitle', () => {
  it('prefers the first heading, skipping headings that say nothing', () => {
    should(deriveTaskTitle('# Assigned task\n\nbody\n\n## fix the sessions filter\n')).equal('Fix the Sessions Filter');
  });

  it('drops role-play and read-this-file sentences, keeping the first that names work', () => {
    should(deriveTaskTitle('You are a Ferretry implementer. Read /tmp/briefs/x.md and follow it exactly.')).be.null();
    should(deriveTaskTitle('You are a Ferretry implementer. Fix the composer padding on phones. Then test.')).equal(
      'Fix the Composer Padding',
    );
    should(deriveTaskTitle('Ferretry small changes. First read /tmp/a/b.md and follow it.')).equal(
      'Ferretry Small Changes',
    );
  });

  it('reads a list item or a labelled line, and strips markdown, links, urls and paths', () => {
    should(deriveTaskTitle('- **Add** [the docs](http://x.dev/y) page: details follow')).equal('Add the Docs Page');
    should(deriveTaskTitle('Update /home/k/ferretry/README.md https://example.com now')).equal('Update Now');
  });

  it('keeps acronyms and numbers as written, and shortens a long title', () => {
    should(deriveTaskTitle('migrate the PWA to v2 quickly')).equal('Migrate the PWA to v2');
    should(deriveTaskTitle(`${'x'.repeat(70)} one`)).equal(`X${'x'.repeat(58)}…`);
  });

  it('ignores fences and rules, handles CRLF, and is null when nothing is left', () => {
    should(deriveTaskTitle('---\r\n```\r\nship the thing\r\n')).equal('Ship the Thing');
    should(deriveTaskTitle('')).be.null();
    should(deriveTaskTitle('# Task\n# ...')).be.null();
    should(deriveTaskTitle('to the')).be.null();
  });
});

describe('briefFileReference', () => {
  it('finds the file a brief points at, in each spelling, without trailing punctuation', () => {
    should(briefFileReference('Read /tmp/claude/briefs/kt.md and follow it.')).equal('/tmp/claude/briefs/kt.md');
    should(briefFileReference('Please follow `./docs/plan.md`.')).equal('./docs/plan.md');
    should(briefFileReference('see docs/plan.md.')).equal('docs/plan.md');
    should(briefFileReference('open BRIEF.md')).equal('BRIEF.md');
    should(briefFileReference('fix the thing')).be.null();
  });
});

describe('the fallback title', () => {
  it('is a labelled, stable four-character hash', () => {
    should(briefHash('abc')).equal(briefHash('abc'));
    should(briefHash('abc')).not.equal(briefHash('abd'));
    should(briefHash('x')).match(/^[0-9a-z]{4}$/u);
    should(fallbackTaskTitle('code-review', 'abc')).equal(`Code Review ${briefHash('abc')}`);
    should(fallbackTaskTitle('---', 'abc')).equal(`Task ${briefHash('abc')}`);
  });

  it('is used only when the brief says nothing', () => {
    should(taskTitleFor('Fix the login bug', 'review')).equal('Fix the Login Bug');
    should(taskTitleFor('You are an implementer. Read /a/b.md', 'review')).equal(
      `Review ${briefHash('You are an implementer. Read /a/b.md')}`,
    );
  });
});
