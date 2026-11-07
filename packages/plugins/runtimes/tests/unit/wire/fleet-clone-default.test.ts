/**
 * The default runtime for new agents across a Clone: which runtimes a copy can offer, and the one it
 * proposes. The app's Preview and the target's planner both read these, so they must agree.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLONE_FALLBACK_RUNTIME,
  type CloneAgentRuntime,
  cloneAgentRuntimes,
  suggestCloneDefault,
} from '../../src/lib/fleet-clone-default.ts';
import type { FleetCloneBundle } from '../../src/lib/fleet-setup.ts';
import { INSTANT } from '../fixtures.ts';

const bundleWith = (runtimes: FleetCloneBundle['runtimes']): FleetCloneBundle => ({
  format: 'ferretry-clone',
  version: 1,
  machine: 'ip-172-27-76-90',
  exportedAt: INSTANT,
  credentials: [
    { id: 'claude-you', harness: 'claude' },
    { id: 'codex-work', harness: 'codex' },
  ],
  components: {},
  profiles: {},
  runtimes,
  files: [],
  notCopied: [],
});

const claude = (name: string): CloneAgentRuntime => ({ name, harness: 'claude' });
const codex = (name: string): CloneAgentRuntime => ({ name, harness: 'codex' });

describe('cloneAgentRuntimes', () => {
  it('should list only agent runtimes, sorted, with the family of their login unless they name one', () => {
    // Act
    const actual = cloneAgentRuntimes(
      bundleWith({
        'codex-work': { credential: 'codex-work', profile: 'p', agent: true },
        'claude-b': { credential: 'claude-you', profile: 'p', agent: true },
        helper: { credential: 'claude-you', profile: 'p', agent: false },
        'claude-a': { credential: 'claude-you', profile: 'p', agent: true, harness: 'claude' },
        plain: { credential: 'claude-you', profile: 'p' },
        dual: { credential: 'claude-you', profile: 'p', agent: true, harness: 'codex' },
      }),
    );

    // Assert
    should(actual).deepEqual([claude('claude-a'), claude('claude-b'), codex('codex-work'), codex('dual')]);
  });

  it('should skip a runtime whose family cannot be told instead of guessing', () => {
    // Act
    const actual = cloneAgentRuntimes(bundleWith({ lost: { credential: 'gone', profile: 'p', agent: true } }));

    // Assert
    should(actual).deepEqual([]);
  });

  it('should read a malformed runtime as having none of these fields', () => {
    // Act
    const actual = cloneAgentRuntimes(bundleWith({ odd: 'text', list: [1], none: null }));

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('suggestCloneDefault', () => {
  const candidates = [claude('claude-liftoff'), codex('codex-a'), claude(CLONE_FALLBACK_RUNTIME)];

  it('should take the source default when the copy brings that runtime', () => {
    should(suggestCloneDefault({ candidates, carried: 'codex-a' })).equal('codex-a');
  });

  it('should fall back to claude-default when the carried one is not copied', () => {
    should(suggestCloneDefault({ candidates, carried: 'gone' })).equal(CLONE_FALLBACK_RUNTIME);
  });

  it('should prefer the family of the default being replaced when claude-default is not copied', () => {
    // Arrange
    const noFallback = [claude('claude-liftoff'), codex('codex-a')];

    // Act / Assert
    should(suggestCloneDefault({ candidates: noFallback, droppedHarness: 'codex' })).equal('codex-a');
    should(suggestCloneDefault({ candidates: noFallback, droppedHarness: 'claude' })).equal('claude-liftoff');
  });

  it('should take the first runtime when nothing else matches, and nothing when there is none', () => {
    should(suggestCloneDefault({ candidates: [codex('codex-a')], droppedHarness: 'claude' })).equal('codex-a');
    should(suggestCloneDefault({ candidates: [] })).be.undefined();
    should(suggestCloneDefault({ candidates, carried: null })).equal(CLONE_FALLBACK_RUNTIME);
  });
});
