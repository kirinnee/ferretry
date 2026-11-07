import { describe, it } from 'bun:test';
import should from 'should';
import { buildRequest, isRepeatable, refusalText } from '../../src/lib/request.ts';

describe('buildRequest', () => {
  it('should encode parameters and the query', () => {
    should(
      buildRequest('GET /v1/cards/:id/notes/:note', { params: { id: 'a/b', note: 'x' }, query: { q: 'a b' } }),
    ).deepEqual({
      method: 'GET',
      path: '/v1/cards/a%2Fb/notes/x?q=a+b',
    });
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
