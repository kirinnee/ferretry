import { describe, it } from 'bun:test';
import should from 'should';
import { routePattern } from '../../../src/lib/performance/route-pattern.ts';

describe('routePattern', () => {
  it('should keep route words and drop the origin and the query', () => {
    // Arrange
    const url = 'https://studio.local:8787/v1/fleet/runtimes?search=secret%20words';

    // Act
    const actual = routePattern('get', url);

    // Assert
    should(actual).equal('GET /v1/fleet/runtimes');
  });

  it('should mask every id-shaped segment', () => {
    // Arrange
    const urls = [
      'https://d.test/v1/sessions/fy_s_abc123/logs',
      'https://d.test/v1/sessions/550e8400-e29b-41d4-a716-446655440000',
      'https://d.test/v1/attachments/Report%20Q3.pdf',
      'https://d.test/v1/learning/proposals/42/apply-preview',
    ];

    // Act
    const actual = urls.map(url => routePattern('POST', url));

    // Assert
    should(actual).eql([
      'POST /v1/sessions/:id/logs',
      'POST /v1/sessions/:id',
      'POST /v1/attachments/:id',
      'POST /v1/learning/proposals/:id/apply-preview',
    ]);
  });

  it('should mask a member a person named even when it reads like a route word', () => {
    // Arrange — a terminal called `dev` and a runtime called `claude-default`.
    const urls = [
      'https://d.test/v1/sessions/fy_s_1/surfaces/terminals/dev',
      'https://d.test/v1/fleet/runtimes/claude-default/check',
      'https://d.test/v1/sessions/fy_s_1/surfaces/terminals/control',
    ];

    // Act
    const actual = urls.map(url => routePattern('GET', url));

    // Assert
    should(actual).eql([
      'GET /v1/sessions/:id/surfaces/terminals/:id',
      'GET /v1/fleet/runtimes/:id/check',
      'GET /v1/sessions/:id/surfaces/terminals/control',
    ]);
  });

  it('should cut a deep path short rather than keep a file path', () => {
    // Arrange
    const url = 'https://d.test/v1/sessions/fy_s_1/fs/file/src/lib/deep/path/name.ts';

    // Act
    const actual = routePattern('GET', url);

    // Assert
    should(actual).equal('GET /v1/sessions/:id/fs/file/src/lib/deep/…');
  });

  it('should name a relative path by its route, and an unparsable one as unparsed', () => {
    // Arrange / Act
    const relative = routePattern('GET', '/v1/usage');
    const root = routePattern('GET', 'https://d.test/');
    const broken = routePattern('GET', 'http://[broken');

    // Assert
    should(relative).equal('GET /v1/usage');
    should(root).equal('GET /');
    should(broken).equal('GET :unparsed');
  });
});
