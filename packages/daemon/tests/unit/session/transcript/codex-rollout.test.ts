import { describe, it } from 'bun:test';
import should from 'should';
import { selectCodexRollout, type CodexRolloutCandidate } from '../../../../src/lib/session/transcript/index.ts';

const candidate = (id: string, correlated: boolean): CodexRolloutCandidate => ({
  id,
  file: `/home/agent/.codex/sessions/${id}.jsonl`,
  correlated,
});

describe('selectCodexRollout', () => {
  it('should choose the one rollout that carries this session’s token', () => {
    // Arrange
    const candidates = [candidate('other', false), candidate('mine', true)];

    // Act
    const chosen = selectCodexRollout(candidates, { baseline: [] });

    // Assert
    should(chosen?.id).equal('mine');
  });

  it('should refuse a rollout that existed before the launch even when it carries the token', () => {
    // Arrange: a resumed rollout from a previous session can contain the same directory path.
    const candidates = [candidate('old', true)];

    // Act
    const chosen = selectCodexRollout(candidates, { baseline: ['old'] });

    // Assert
    should(chosen).be.undefined();
  });

  it('should refuse a rollout another live session has already been attributed', () => {
    // Arrange
    const candidates = [candidate('taken', true)];

    // Act
    const chosen = selectCodexRollout(candidates, { baseline: [], claimed: ['taken'] });

    // Assert
    should(chosen).be.undefined();
  });

  it('should refuse every uncorrelated candidate rather than pick the newest', () => {
    // Arrange: this is the shortcut the audit rejected — same account, same cwd, same minute.
    const candidates = [candidate('teammate-a', false), candidate('teammate-b', false)];

    // Act
    const chosen = selectCodexRollout(candidates, { baseline: [] });

    // Assert
    should(chosen).be.undefined();
  });

  it('should refuse an ambiguous answer rather than resolve it', () => {
    // Arrange: two correlated rollouts means the token was not unique, so neither is proven.
    const candidates = [candidate('first', true), candidate('second', true)];

    // Act
    const chosen = selectCodexRollout(candidates, { baseline: [] });

    // Assert
    should(chosen).be.undefined();
  });

  it('should answer nothing when the home holds no rollouts at all', () => {
    // Arrange / Act
    const chosen = selectCodexRollout([], { baseline: ['old'] });

    // Assert
    should(chosen).be.undefined();
  });
});
