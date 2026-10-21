import { describe, it } from 'bun:test';
import { FY_VERSION_HEADER } from '@ferretry/protocol';
import should from 'should';
import {
  conditional,
  entityTag,
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  noStore,
  PROMETHEUS_CONTENT_TYPE,
  textResponse,
  unknownRouteResponse,
} from '../../../src/lib/api/index.ts';
import { daemonVersion } from '../../../src/lib/version.ts';
import { jsonBody } from './support.ts';

describe('jsonResponse', () => {
  it('should serialize the value and declare JSON', () => {
    // Arrange / Act
    const response = jsonResponse({ ok: true });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ ok: true });
    should(response.headers.get('content-type')).equal('application/json; charset=utf-8');
  });

  it('should carry the daemon version so a client can name a skew', () => {
    // Arrange / Act
    const response = jsonResponse({});

    // Assert
    should(response.headers.get(FY_VERSION_HEADER)).equal(daemonVersion);
  });

  it('should let a caller add headers, case-insensitively', () => {
    // Arrange / Act
    const response = jsonResponse({}, 201, { 'Cache-Control': 'no-store' });

    // Assert
    should(response.status).equal(201);
    should(response.headers.get('cache-control')).equal('no-store');
  });
});

describe('textResponse', () => {
  it('should default to plain text', () => {
    // Arrange / Act
    const response = textResponse('hello');

    // Assert
    should(response.body).equal('hello');
    should(response.headers.get('content-type')).equal('text/plain; charset=utf-8');
  });

  it('should carry a caller-chosen content type and extra headers', () => {
    // Arrange / Act
    const response = textResponse('# HELP x\n', 200, PROMETHEUS_CONTENT_TYPE, { 'X-Trace': 'abc' });

    // Assert
    should(response.headers.get('content-type')).equal(PROMETHEUS_CONTENT_TYPE);
    should(response.headers.get('x-trace')).equal('abc');
  });
});

describe('errorResponse', () => {
  it('should carry only the message when there is no code', () => {
    // Arrange / Act
    const response = errorResponse(400, 'bad');

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).deepEqual({ error: 'bad' });
  });

  it('should carry a machine-readable code when one is given', () => {
    // Arrange / Act
    const response = errorResponse(403, 'nope', 'forbidden');

    // Assert
    should(jsonBody(response)).deepEqual({ error: 'nope', code: 'forbidden' });
  });
});

describe('unknownRouteResponse', () => {
  it('should name the exact route so a version skew is diagnosable', () => {
    // Arrange / Act
    const response = unknownRouteResponse('POST', '/v1/future');

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).deepEqual({
      error: 'no route POST /v1/future',
      code: 'unknown_route',
      method: 'POST',
      path: '/v1/future',
    });
  });
});

describe('methodNotAllowedResponse', () => {
  it('should send the Allow header the specification requires', () => {
    // Arrange / Act
    const response = methodNotAllowedResponse('DELETE', '/v1/sessions', ['GET', 'POST']);

    // Assert
    should(response.status).equal(405);
    should(response.headers.get('allow')).equal('GET, POST');
    should(jsonBody(response).allowed).deepEqual(['GET', 'POST']);
  });
});

describe('noStore', () => {
  it('should mark a response uncacheable without disturbing the rest of it', () => {
    // Arrange
    const original = jsonResponse({ secret: true }, 200, { 'X-Trace': 'abc' });

    // Act
    const marked = noStore(original);

    // Assert
    should(marked.headers.get('cache-control')).equal('no-store');
    should(marked.headers.get('x-trace')).equal('abc');
    should(marked.body).equal(original.body);
    should(original.headers.has('cache-control')).be.false();
  });
});

describe('entityTag', () => {
  it('should name equal bodies alike and different bodies differently, as a strong quoted tag', () => {
    // Act
    const tag = entityTag('the transcript');

    // Assert
    should(tag).match(/^"[A-Za-z0-9_-]{43}"$/u);
    should(entityTag('the transcript')).equal(tag);
    should(entityTag('the transcript.')).not.equal(tag);
  });
});

describe('conditional', () => {
  it('should tag a response the request holds no validator for, leaving the rest of it as it was', () => {
    // Arrange
    const original = textResponse('the transcript');

    // Act
    const answered = conditional(original, undefined);

    // Assert
    should(answered.status).equal(200);
    should(answered.body).equal('the transcript');
    should(answered.headers.get('etag')).equal(entityTag('the transcript'));
    should(answered.headers.get('content-type')).equal('text/plain; charset=utf-8');
    should(original.headers.has('etag')).be.false();
  });

  it('should answer 304 with no body when the request already holds this tag', () => {
    // Arrange
    const tag = entityTag('the transcript');

    // Act
    const answered = conditional(textResponse('the transcript'), tag);

    // Assert
    should(answered.status).equal(304);
    should(answered.body).equal('');
    should(answered.headers.get('etag')).equal(tag);
  });

  it('should serve the whole body when the held tag names an older answer', () => {
    // Act
    const answered = conditional(textResponse('the transcript, moved on'), entityTag('the transcript'));

    // Assert
    should(answered.status).equal(200);
    should(answered.body).equal('the transcript, moved on');
  });

  it('should match a tag anywhere in a list, weakly, and match a wildcard', () => {
    // Arrange
    const tag = entityTag('the transcript');

    // Act
    const listed = conditional(textResponse('the transcript'), `"other", W/${tag}`);
    const wildcard = conditional(textResponse('the transcript'), '*');

    // Assert
    should(listed.status).equal(304);
    should(wildcard.status).equal(304);
  });
});
