import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generated } from '../../../src/generated/surfaces.ts';
import { DEVICE_SETTINGS_HREF } from '../../../src/router/routes.ts';
import { parseReleaseRewrites, releasePathForRequest } from '../../../src/release/manifest.ts';

/**
 * EVERY ADDRESS THE APP DRAWS MUST SURVIVE A RELOAD. A route the router answers but `public/_redirects` does not
 * rewrite is served the marketing index on a cold load or a reload (the person lands on `/app/` and loses the page),
 * so the rules are proved against the router's own roots: the shell's `/settings` (this device's settings), `/d/*`,
 * and the `path` of every daemon-less screen any compiled plugin declares.
 */
const redirects = readFileSync(join(import.meta.dir, '../../../public/_redirects'), 'utf8');
const rewrites = parseReleaseRewrites(redirects);
const files = { 'index.html': 'landing', 'app/index.html': 'shell' };

const daemonlessRoots = generated.surfaces.flatMap(entry =>
  (entry.manifest.ui?.screens ?? []).filter(screen => screen.path.startsWith('/')).map(screen => screen.path),
);

describe('every app route is rewritten to the app shell', () => {
  const addresses = [DEVICE_SETTINGS_HREF, '/d/x', '/d/x/settings/warden', ...daemonlessRoots];

  it.each([...new Set(addresses)])('%s reaches the app on a cold load', pathname => {
    expect(releasePathForRequest({ pathname, navigate: true }, files, rewrites)).toBe('app/index.html');
  });

  it('declares at least the known daemon-less screens, so the loop above is not vacuous', () => {
    expect(daemonlessRoots).toEqual(expect.arrayContaining(['/join', '/shared', '/pair', '/onboarding', '/setup']));
  });
});
