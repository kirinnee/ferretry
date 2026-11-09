import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../../vite.config.ts';

/**
 * S14 (m6): the static `/get-started/` page is Onboarding's own document, emitted by the shell's build, and its one
 * inline script is allowed by the shell's CSP by HASH — not by `'unsafe-inline'`. These are the two assertions the
 * page's own suite dropped when it moved out of the old PWA: the build entry, and the CSP hash.
 */

const page = readFileSync(
  fileURLToPath(new URL('../../../plugins/onboarding/app/get-started/index.html', import.meta.url)),
  'utf8',
);
const headers = readFileSync(fileURLToPath(new URL('../../public/_headers', import.meta.url)), 'utf8');
const release = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../release.json', import.meta.url)), 'utf8'),
) as { version: string };

/** The page's inline scripts, exactly as the browser hashes them (the text between the tags). */
const inlineScripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  match => match[1] ?? '',
);
const hashOf = (text: string): string => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const scriptSrc = (headers.match(/^\s*Content-Security-Policy: (.*)$/m)?.[1] ?? '')
  .split(';')
  .map(part => part.trim())
  .find(part => part.startsWith('script-src '));

describe('S14 the get-started page', () => {
  it('has inline scripts, none of them carrying the release placeholder (a stamped script would change its hash)', () => {
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const script of inlineScripts) expect(script).not.toContain('%FY_RELEASE_VERSION%');
  });

  it('the CSP hash matches every inline script', () => {
    expect(scriptSrc).toBeDefined();
    for (const script of inlineScripts) expect(scriptSrc).toContain(hashOf(script));
  });

  it('the CSP lets scripts run by hash alone: no unsafe-inline in script-src', () => {
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('the build emits the page as get-started/index.html with the release version stamped in', () => {
    const plugin = (config.plugins ?? [])
      .flat()
      .find(
        (candidate): candidate is { name: string; generateBundle: (this: unknown) => void } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'name' in candidate &&
          candidate.name === 'fy-get-started-page',
      );
    expect(plugin).toBeDefined();
    const emitted: { type: string; fileName: string; source: string }[] = [];
    plugin?.generateBundle.call({ emitFile: (file: (typeof emitted)[number]) => emitted.push(file) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe('get-started/index.html');
    expect(emitted[0]?.type).toBe('asset');
    expect(emitted[0]?.source).toBe(page.replaceAll('%FY_RELEASE_VERSION%', release.version));
    expect(emitted[0]?.source).not.toContain('%FY_RELEASE_VERSION%');
  });
});
