import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { buildWorld } from '../../../bin/fyd.ts';
import { ABSENT_USER_HOME } from '../support/repository.ts';

describe('daemon transcript composition', () => {
  it('should wire one working file source to each harness parser', async () => {
    // Arrange
    const subject = buildWorld({}, { userHome: ABSENT_USER_HOME });
    const fixtures = new Map([
      ['claude', join(import.meta.dir, '../../fixtures/transcript/claude.jsonl')],
      ['codex', join(import.meta.dir, '../../fixtures/transcript/codex.jsonl')],
    ]);

    // Act
    const actual = await Promise.all(
      subject.transcripts.sources.map(async source => await source.read(fixtures.get(source.harness)!)),
    );
    const searched = subject.transcripts.search(actual[0]?.events ?? [], 'synthetic');

    // Assert
    should(subject.role).equal('daemon');
    should(subject.storage.open).be.a.Function();
    should(subject.worktrees.create).be.a.Function();
    should(subject.transcripts.sources).have.length(2);
    should(actual.map(batch => batch.harness)).deepEqual(['claude', 'codex']);
    should(actual.every(batch => batch.events.length > 0)).be.true();
    should(actual.every(batch => batch.observedInputs.length > 0)).be.true();
    should(actual.every(batch => batch.issues.length === 0)).be.true();
    should(searched).not.be.empty();
    should(searched.every(match => match.snippet.toLowerCase().includes('synthetic'))).be.true();
  });

  it('should carry the user home it was given, and refuse one that is not absolute', () => {
    // Act
    const subject = buildWorld({}, { userHome: ABSENT_USER_HOME });

    // Assert — a relative home would resolve against wherever the daemon started, and a cast that
    // smuggled no home in at all must not quietly become the developer's own.
    should(subject.userHome).equal(ABSENT_USER_HOME);
    should(() => buildWorld({}, { userHome: 'relative/home' })).throw(/absolute user home/u);
    should(() => buildWorld({}, {} as never)).throw(/absolute user home/u);
  });
});
