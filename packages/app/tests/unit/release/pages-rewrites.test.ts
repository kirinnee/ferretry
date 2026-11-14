import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReleaseRewrites, releasePathForRequest } from '../../../src/release/manifest.ts';

/**
 * THE APP'S ROUTES MUST REACH THE APP ON A COLD LOAD. Cloudflare Pages treats a `200` rewrite whose target is
 * `/app/index.html` as the file it serves under its pretty-URL rule: an exact path (`/pair`) answers `308 → /app/`
 * (the path and so the route are lost) and a splat (`/pair/x`) falls through to the landing page. The one spelling it
 * serves as a rewrite, with the visitor's path and fragment intact, is the directory: `/app/`.
 * (https://developers.cloudflare.com/pages/configuration/redirects/ — proxying with status `200`;
 * https://developers.cloudflare.com/pages/configuration/serving-pages/ — `/page.html` and `/page/index.html` redirect
 * to `/page/`.) A warm browser never notices, because the service worker answers its navigations — only a first visit does.
 */
const redirects = readFileSync(join(import.meta.dir, '../../../public/_redirects'), 'utf8');
const rules = redirects.trim().split('\n');

const APP_ROUTES = ['/app/*', '/d/*', '/setup', '/pair', '/pair/*', '/join', '/shared', '/onboarding', '/onboarding/*'];

describe('public/_redirects app routes', () => {
  it.each(APP_ROUTES)('%s is a 200 rewrite to the directory /app/, not to /app/index.html', route => {
    expect(rules).toContain(`${route} /app/ 200`);
    expect(rules).not.toContain(`${route} /app/index.html 200`);
  });

  it('never names /app/index.html as a rewrite target (Pages answers that file with a 308 to /app/)', () => {
    expect(parseReleaseRewrites(redirects).filter(rule => rule.to === '/app/index.html')).toEqual([]);
  });

  it('keeps the MCP callback and the landing fallback after the app routes', () => {
    expect(rules.slice(-2)).toEqual(['/oauth/mcp-callback/* /oauth/mcp-callback.html 200', '/* /index.html 200']);
    expect(rules.slice(0, APP_ROUTES.length)).toEqual(APP_ROUTES.map(route => `${route} /app/ 200`));
  });

  it('is answered by the service worker, too, with the same shell for each route', () => {
    const files = { 'index.html': 'landing', 'app/index.html': 'shell' };
    const rewrites = parseReleaseRewrites(redirects);
    for (const pathname of [
      '/pair',
      '/pair/x',
      '/setup',
      '/join',
      '/shared',
      '/onboarding',
      '/onboarding/x',
      '/d/x',
      '/app/foo',
      '/app/',
    ]) {
      expect(releasePathForRequest({ pathname, navigate: true }, files, rewrites)).toBe('app/index.html');
    }
    expect(releasePathForRequest({ pathname: '/', navigate: true }, files, rewrites)).toBe('index.html');
    expect(releasePathForRequest({ pathname: '/anything', navigate: true }, files, rewrites)).toBe('index.html');
  });
});
