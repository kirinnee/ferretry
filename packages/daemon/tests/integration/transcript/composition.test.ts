import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { buildWorld } from '../../../bin/fyd.ts';

describe('daemon transcript composition', () => {
  it('should wire one working file source to each harness parser', async () => {
    // Arrange
    const subject = buildWorld();
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
    should(subject.createAttentionLedgerRepository).be.a.Function();
    should(subject.transcripts.sources).have.length(2);
    should(actual.map(batch => batch.harness)).deepEqual(['claude', 'codex']);
    should(actual.every(batch => batch.events.length > 0)).be.true();
    should(actual.every(batch => batch.observedInputs.length > 0)).be.true();
    should(actual.every(batch => batch.issues.length === 0)).be.true();
    should(searched).not.be.empty();
    should(searched.every(match => match.snippet.toLowerCase().includes('synthetic'))).be.true();
  });
});
