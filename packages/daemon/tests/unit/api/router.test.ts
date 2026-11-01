import { describe, it } from 'bun:test';
import should from 'should';
import { ApiRouter, jsonResponse, type ApiRoute } from '../../../src/lib/api/index.ts';

const route = (method: string, path: string): ApiRoute => ({
  method,
  path,
  minimum: 'operator',
  caller: 'any',
  handle: async () => jsonResponse({ path }),
});

describe('ApiRouter', () => {
  const router = new ApiRouter([
    route('GET', '/healthz'),
    route('GET', '/v1/sessions'),
    route('POST', '/v1/sessions'),
    route('GET', '/v1/sessions/summary'),
    route('GET', '/v1/sessions/:id'),
    route('POST', '/v1/sessions/:id/:action'),
    route('GET', '/v1/sessions/:id/fs/*rest'),
  ]);

  it('should match a literal path', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/healthz');

    // Assert
    should(lookup.kind).equal('matched');
    should(lookup.kind === 'matched' && lookup.route.path).equal('/healthz');
  });

  it('should treat a trailing slash as the same route', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/healthz/');

    // Assert
    should(lookup.kind).equal('matched');
  });

  it('should capture path parameters', () => {
    // Arrange / Act
    const lookup = router.lookup('POST', '/v1/sessions/s-1/send');

    // Assert
    should(lookup.kind).equal('matched');
    should(lookup.kind === 'matched' && [...lookup.params]).deepEqual([
      ['id', 's-1'],
      ['action', 'send'],
    ]);
  });

  it('should prefer a literal registered before a parameter', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1/sessions/summary');

    // Assert
    should(lookup.kind === 'matched' && lookup.route.path).equal('/v1/sessions/summary');
  });

  it('should capture the remainder into a catch-all', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1/sessions/s-1/fs/src/lib/index.ts');

    // Assert
    should(lookup.kind === 'matched' && lookup.params.get('rest')).equal('src/lib/index.ts');
  });

  it('should let a catch-all match an empty remainder', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1/sessions/s-1/fs');

    // Assert
    should(lookup.kind === 'matched' && lookup.params.get('rest')).equal('');
  });

  it('should leave a captured parameter percent-encoded', () => {
    // The authorization decision and the handler must see the SAME bytes; decoding during routing
    // is what lets an encoded traversal mean two different things.
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1/sessions/%2e%2e');

    // Assert
    should(lookup.kind === 'matched' && lookup.params.get('id')).equal('%2e%2e');
  });

  it('should not let a parameter capture an empty segment', () => {
    // Arrange / Act
    const lookup = router.lookup('POST', '/v1/sessions//send');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should report the allowed verbs when only the method is wrong', () => {
    // Arrange / Act
    const lookup = router.lookup('DELETE', '/v1/sessions');

    // Assert
    should(lookup.kind).equal('method-not-allowed');
    should(lookup.kind === 'method-not-allowed' && lookup.allowed).deepEqual(['GET', 'POST']);
  });

  it('should match the verb case-insensitively', () => {
    // Arrange / Act
    const lookup = router.lookup('get', '/healthz');

    // Assert
    should(lookup.kind).equal('matched');
  });

  it('should report an unknown path as not found', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1/nope');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should not match a path longer than the pattern', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/healthz/extra');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should not match a path shorter than the pattern', () => {
    // Arrange / Act
    const lookup = router.lookup('GET', '/v1');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should expose the registered routes', () => {
    // Arrange / Act / Assert
    should(router.routes).have.length(7);
    should(router.routes[0]?.path).equal('/healthz');
  });

  it('should match the root path against an empty pattern', () => {
    // Arrange
    const rootRouter = new ApiRouter([route('GET', '/')]);

    // Act
    const lookup = rootRouter.lookup('GET', '/');

    // Assert
    should(lookup.kind).equal('matched');
  });
});

describe('ApiRouter: a route that is not available', () => {
  const gated = (available: () => boolean): ApiRouter =>
    new ApiRouter([
      { ...route('GET', '/gated'), available },
      route('GET', '/open'),
      { ...route('GET', '/shared/:id'), available: () => true },
    ]);

  it('should not find an unavailable route, as if the path had never been registered', () => {
    // Arrange / Act
    const lookup = gated(() => false).lookup('GET', '/gated');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should not name an unavailable route in a 405 for another verb', () => {
    // Arrange / Act
    const lookup = gated(() => false).lookup('POST', '/gated');

    // Assert
    should(lookup.kind).equal('not-found');
  });

  it('should match an available route, and a route that sets no availability', () => {
    // Arrange
    const router = gated(() => true);

    // Act
    const gatedLookup = router.lookup('GET', '/gated');
    const openLookup = router.lookup('GET', '/open');
    const sharedLookup = router.lookup('GET', '/shared/1');

    // Assert
    should([gatedLookup.kind, openLookup.kind, sharedLookup.kind]).deepEqual(['matched', 'matched', 'matched']);
  });

  it('should ask again at every lookup', () => {
    // Arrange
    let open = false;
    const router = gated(() => open);

    // Act
    const closed = router.lookup('GET', '/gated').kind;
    open = true;
    const opened = router.lookup('GET', '/gated').kind;

    // Assert
    should([closed, opened]).deepEqual(['not-found', 'matched']);
  });
});
