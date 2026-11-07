import { describe, it } from 'bun:test';
import should from 'should';
import { buildRequest, isRepeatable, refusalText } from '../../src/lib/request.ts';

describe('buildRequest', () => {
  it('should encode parameters and the query', () => {
    should(
      buildRequest('GET /v1/cards/:id/notes/:note', { params: { id: 'a b', note: 'é' }, query: { q: 'a b' } }),
    ).deepEqual({
      method: 'GET',
      path: '/v1/cards/a%20b/notes/%C3%A9?q=a+b',
    });
  });

  it('should keep ?, #, &, = and non-ASCII in keys and values inside the query', () => {
    const { path } = buildRequest('GET /v1/x/:id', {
      params: { id: 'a' },
      query: { 'k&x=y?z#w': 'a?b#c/d&e=f', kéy: 'välue ✓' },
    });
    const url = new URL(path, 'http://daemon.test');
    should(url.pathname).equal('/v1/x/a');
    should(url.hash).equal('');
    should([...url.searchParams.entries()]).deepEqual([
      ['k&x=y?z#w', 'a?b#c/d&e=f'],
      ['kéy', 'välue ✓'],
    ]);
    for (const encoded of ['%3F', '%23', '%26', '%3D', '%2F', '%C3%A9', '%E2%9C%93']) should(path).containEql(encoded);
    should(path.match(/\?/gu)).have.length(1);
  });

  it('should refuse a parameter that is "." or ".." or holds a "/", which would reach another route', () => {
    for (const id of ['.', '..', 'a/b', '../stream'])
      should(() => buildRequest('GET /v1/cards/:id/stream', { params: { id } })).throw(
        /cannot be "\." or "\.\." or hold a "\/"/u,
      );
    should(buildRequest('GET /v1/cards/:id/stream', { params: { id: '..a' } }).path).equal('/v1/cards/..a/stream');
  });

  it('should carry the body only when there is one', () => {
    should(buildRequest('POST /v1/x', { body: { a: 1 } })).deepEqual({ method: 'POST', path: '/v1/x', body: { a: 1 } });
    should('body' in buildRequest('POST /v1/x')).be.false();
  });

  it('should refuse a missing or an unused parameter', () => {
    should(() => buildRequest('GET /v1/cards/:id')).throw(/needs the parameter "id"/u);
    should(() => buildRequest('GET /v1/cards', { params: { id: 'a' } })).throw(/has no parameter "id"/u);
  });

  it('should know which methods are safe to repeat, and read a refusal’s sentence or its status', () => {
    should(isRepeatable('GET')).be.true();
    should(isRepeatable('POST')).be.false();
    should(refusalText(403, { error: 'no', code: 'owner_only' })).deepEqual({ message: 'no', code: 'owner_only' });
    should(refusalText(502, 'text').message).equal('the daemon answered HTTP 502');
  });
});
