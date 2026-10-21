import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';

import { MAP_TILE_ORIGIN } from '../../src/lib/fy-render-map-tiles.ts';
import { contentTypeFor, parseReleaseHeaders, releaseHeadersFor } from '../../src/lib/release-headers.ts';

const headerMap = (headers: readonly (readonly [string, string])[]): Record<string, string> =>
  Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value]));

describe('parseReleaseHeaders', () => {
  it('reads rules, sets and detaches in order, skipping comments, blanks and stray lines', () => {
    // Arrange
    const text = [
      'stray: before any rule',
      '/*',
      '  X-One: 1',
      '  # a comment',
      '',
      '  ! X-Two',
      '  no colon here',
      '  : no name',
      'Not-Indented: ignored',
      '/assets/*',
      '  Cache-Control: immutable',
    ].join('\n');

    // Act
    const actual = parseReleaseHeaders(text);

    // Assert
    should(actual).eql([
      { pattern: '/*', detach: ['X-Two'], set: [['X-One', '1']] },
      { pattern: '/assets/*', detach: [], set: [['Cache-Control', 'immutable']] },
    ]);
  });
});

describe('releaseHeadersFor', () => {
  const rules = parseReleaseHeaders(
    [
      '/*',
      '  Content-Security-Policy: default-src self',
      '  X-Content-Type-Options: nosniff',
      '  Content-Type: text/html',
      '/frame.html',
      '  ! Content-Security-Policy',
      '  Content-Security-Policy: sandbox',
      '/assets/*',
      '  Cache-Control: immutable',
      '  X-Content-Type-Options: again',
      '/users/:id/profile.txt',
      '  X-Profile: yes',
      '/manifest*.webmanifest',
      '  Cache-Control: no-cache',
    ].join('\n'),
  );

  it('applies every matching rule, joining a header set twice', () => {
    should(headerMap(releaseHeadersFor('/assets/app.js', 'assets/app.js', rules))).eql({
      'content-security-policy': 'default-src self',
      'x-content-type-options': 'nosniff, again',
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'immutable',
    });
  });

  it('lets a later rule detach what an earlier rule set', () => {
    should(headerMap(releaseHeadersFor('/frame.html', 'frame.html', rules))['content-security-policy']).equal(
      'sandbox',
    );
  });

  it('matches by the REQUESTED path, and types by the SERVED file', () => {
    // A rewrite: `/app/settings` answered with `app/index.html`.
    const actual = headerMap(releaseHeadersFor('/app/settings', 'app/index.html', rules));
    should(actual['content-type']).equal('text/html; charset=utf-8');
    should(actual['cache-control']).be.undefined();
  });

  it.each([
    ['a placeholder matches one segment', '/users/42/profile.txt', true],
    ['a placeholder never spans segments', '/users/4/2/profile.txt', false],
    ['a splat matches inside a name', '/manifest.app.webmanifest', true],
    ['a dot is literal', '/manifestXwebmanifest', false],
  ])('%s', (_name, pathname, matches) => {
    const actual = headerMap(releaseHeadersFor(pathname, pathname.slice(1), rules));
    should(actual['x-profile'] !== undefined || actual['cache-control'] !== undefined).equal(matches);
  });

  it('never lets a rule choose the content type', () => {
    should(headerMap(releaseHeadersFor('/a.js', 'a.js', rules))['content-type']).equal(
      'text/javascript; charset=utf-8',
    );
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/a.css', 'text/css; charset=utf-8'],
    ['release.json', 'application/json'],
    ['manifest.webmanifest', 'application/manifest+json'],
    ['icons/a.png', 'image/png'],
    ['a.svg', 'image/svg+xml'],
    ['favicon.ico', 'image/x-icon'],
    ['notes.txt', 'text/plain; charset=utf-8'],
    ['font.woff2', 'font/woff2'],
    ['mystery.bin', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'],
  ])('types %s as %s', (path, expected) => {
    should(contentTypeFor(path)).equal(expected);
  });
});

describe('the committed public/_headers', () => {
  const committed = async () =>
    parseReleaseHeaders(await readFile(join(import.meta.dir, '../../public/_headers'), 'utf8'));

  it('gives every page the app policy, and the render sandbox only its own', async () => {
    // Arrange
    const rules = await committed();

    // Act
    const page = headerMap(releaseHeadersFor('/app/', 'app/index.html', rules));
    const sandbox = headerMap(releaseHeadersFor('/fy-render-sandbox.html', 'fy-render-sandbox.html', rules));

    // Assert
    should(page['content-security-policy']).startWith("default-src 'self'");
    should(page['content-security-policy']).containEql("frame-ancestors 'none'");
    should(page['x-content-type-options']).equal('nosniff');
    should(sandbox['content-security-policy']).equal("frame-ancestors 'self'; sandbox allow-scripts");
  });

  it('lets pictures come from the map tile host and nowhere else', async () => {
    // Arrange
    const rules = await committed();

    // Act
    const policy = headerMap(releaseHeadersFor('/app/', 'app/index.html', rules))['content-security-policy'] ?? '';
    const imgSrc = policy.split(';').find(directive => directive.trim().startsWith('img-src')) ?? '';
    const sources = imgSrc.trim().split(/\s+/u).slice(1);

    // Assert — a bare `https:` would make every Markdown image a request this policy permits.
    should(sources).eql(["'self'", 'data:', 'blob:', MAP_TILE_ORIGIN]);
    should(sources).not.containEql('https:');
  });
});
