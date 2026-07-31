import { describe, it } from 'bun:test';
import should from 'should';
import { requireSessionId, resolveTaskScope } from '../../../src/lib/tasks/task-scope';

describe('task scope', () => {
  it('should prefer an explicit --session over the ambient environment', () => {
    // Act
    const actual = resolveTaskScope({ session: 'chosen', environmentSessionId: 'ambient' });

    // Assert
    should(actual).eql({ sessionId: 'chosen' });
  });

  it('should fall back to the ambient session id', () => {
    // Act
    const actual = resolveTaskScope({ environmentSessionId: '  ambient  ' });

    // Assert
    should(actual).eql({ sessionId: 'ambient' });
  });

  it('should treat a blank flag as absent rather than as a session named ""', () => {
    // Act
    const actual = resolveTaskScope({ session: '   ', environmentSessionId: 'ambient' });

    // Assert
    should(actual).eql({ sessionId: 'ambient' });
  });

  it('should read the fleet when --all is given', () => {
    // Act
    const actual = resolveTaskScope({ all: true, environmentSessionId: 'ambient' });

    // Assert
    should(actual).eql({ sessionId: null });
  });

  it('should refuse --all together with --session, which name different things', () => {
    // Act + Assert
    should(() => resolveTaskScope({ all: true, session: 'chosen' })).throw(/--all or --session, not both/u);
  });

  it('should refuse to guess when nothing names a session', () => {
    // Act + Assert
    should(() => resolveTaskScope({ environmentSessionId: '  ' })).throw(/no session id/u);
  });

  it('should refuse a write against the fleet-wide read scope', () => {
    // Act + Assert
    should(() => requireSessionId({ sessionId: null })).throw(/--all is read-only/u);
  });

  it('should refuse with an input error the composition root can print without a stack', () => {
    // Act
    let actual: Error | undefined;
    try {
      resolveTaskScope({});
    } catch (error) {
      actual = error as Error;
    }

    // Assert
    should(actual?.name).equal('CliInputError');
    should(actual?.message).not.containEql('at ');
  });

  it('should hand back the session id for a write', () => {
    // Act
    const actual = requireSessionId({ sessionId: 'session-7' });

    // Assert
    should(actual).equal('session-7');
  });
});
