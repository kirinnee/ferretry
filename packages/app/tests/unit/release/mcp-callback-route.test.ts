import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReleaseRewrites, releasePathForRequest } from '../../../src/release/manifest.ts';

/** The page every MCP sign-in provider sends the browser back to; MCP's contract owns the path (`MCP_OAUTH_CALLBACK_PATH`). */
const CALLBACK_PATH = '/oauth/mcp-callback';
const redirects = readFileSync(join(import.meta.dir, '../../../public/_redirects'), 'utf8');

describe('how the MCP callback page is served', () => {
  it('is what Pages and the service worker answer every provider’s callback path with, before the landing fallback', () => {
    const rewrites = parseReleaseRewrites(redirects);
    const files = { 'oauth/mcp-callback.html': 'h', 'oauth/mcp-callback.js': 'j', 'index.html': 'i' };
    // Each authorization server has its own path under the base (docs/mcp-oauth.md, the mix-up defence).
    expect(
      releasePathForRequest({ pathname: `${CALLBACK_PATH}/0123456789abcdef`, navigate: true }, files, rewrites),
    ).toBe('oauth/mcp-callback.html');
    expect(releasePathForRequest({ pathname: `${CALLBACK_PATH}.js`, navigate: false }, files, rewrites)).toBe(
      'oauth/mcp-callback.js',
    );
    const lines = redirects.trim().split('\n');
    expect(lines.indexOf(`${CALLBACK_PATH}/* ${CALLBACK_PATH}.html 200`)).toBe(lines.length - 2);
  });
});
