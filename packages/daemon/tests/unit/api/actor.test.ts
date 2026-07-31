import { describe, it } from 'bun:test';
import should from 'should';
import {
  isHumanAdminActor,
  parseActor,
  peerActor,
  resolveApiActor,
  wardenActor,
  type ApiActorInput,
} from '../../../src/lib/api/index.ts';

describe('resolveApiActor', () => {
  const cases: readonly (readonly [string, ApiActorInput, string])[] = [
    ['the admin token with no headers is the web UI', { tokenClass: 'admin' }, 'admin-ui'],
    ['the admin token self-identifying as the CLI', { tokenClass: 'admin', client: 'cli' }, 'admin-cli'],
    ['an admin token from inside a pane is that peer', { tokenClass: 'admin', sessionId: 's-1' }, 'peer:s-1'],
    ['the warden token with no pane is the generic warden', { tokenClass: 'warden' }, 'warden'],
    ['the warden token from inside a pane names it', { tokenClass: 'warden', sessionId: 's-2' }, 'warden:s-2'],
    ['a session id wins over the client header', { tokenClass: 'admin', sessionId: 's-3', client: 'cli' }, 'peer:s-3'],
    ['a blank session id is no session id', { tokenClass: 'admin', sessionId: '   ' }, 'admin-ui'],
    ['a blank warden session id falls back to the generic warden', { tokenClass: 'warden', sessionId: ' ' }, 'warden'],
    ['an unknown client is the UI, not an invented kind', { tokenClass: 'admin', client: 'curl' }, 'admin-ui'],
  ];

  for (const [name, input, expected] of cases) {
    it(`should attribute ${name}`, () => {
      // Arrange / Act
      const actor = resolveApiActor(input);

      // Assert
      should(actor).equal(expected);
    });
  }

  it('should never attribute an API request to the daemon itself', () => {
    // Arrange
    const inputs: readonly ApiActorInput[] = cases.map(([, input]) => input);

    // Act
    const actors = inputs.map(resolveApiActor);

    // Assert
    should(actors.some(actor => actor === 'daemon')).be.false();
  });
});

describe('actor helpers', () => {
  it('should build prefixed warden and peer actors', () => {
    // Arrange / Act / Assert
    should(wardenActor('abc')).equal('warden:abc');
    should(peerActor('abc')).equal('peer:abc');
  });

  it('should split a structured actor into kind and id', () => {
    // Arrange / Act
    const parsed = parseActor('warden:s-9');

    // Assert
    should(parsed).deepEqual({ kind: 'warden', id: 's-9', raw: 'warden:s-9' });
  });

  it('should round-trip an unknown kind rather than collapsing it', () => {
    // Arrange / Act
    const parsed = parseActor('cron:nightly');

    // Assert
    should(parsed.kind).equal('cron');
    should(parsed.id).equal('nightly');
  });

  it('should treat an unstructured actor as its own kind', () => {
    // Arrange / Act
    const parsed = parseActor('admin-ui');

    // Assert
    should(parsed).deepEqual({ kind: 'admin-ui', raw: 'admin-ui' });
  });

  it('should keep everything after the FIRST colon as the id', () => {
    // Arrange / Act
    const parsed = parseActor('peer:a:b');

    // Assert
    should(parsed.id).equal('a:b');
  });
});

describe('isHumanAdminActor', () => {
  const cases: readonly (readonly [string | undefined, boolean])[] = [
    ['admin-ui', true],
    ['admin-cli', true],
    ['warden:s-1', false],
    ['peer:s-1', false],
    ['daemon', false],
    [undefined, false],
  ];

  for (const [actor, expected] of cases) {
    it(`should answer ${String(expected)} for ${String(actor)}`, () => {
      // Arrange / Act / Assert
      should(isHumanAdminActor(actor)).equal(expected);
    });
  }
});
