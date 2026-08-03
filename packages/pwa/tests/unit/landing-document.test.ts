import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = join(import.meta.dir, '../..');
const landing = readFileSync(join(packageDir, 'index.html'), 'utf8');
const redirects = readFileSync(join(packageDir, 'public/_redirects'), 'utf8');
const headers = readFileSync(join(packageDir, 'public/_headers'), 'utf8');

describe('the static landing document', () => {
  it('does not boot the PWA bundle and offers the app as an explicit next step', () => {
    expect(landing).not.toContain('/src/main.tsx');
    expect(landing).not.toContain('type="module"');
    expect(landing).toContain('href="/setup"');
    expect(landing).toContain('href="/?stay"');
  });

  it('keeps a tab favicon without presenting itself as the installable app', () => {
    expect(landing).toContain('rel="icon" href="/icons/favicon.svg"');
    expect(landing).toContain('rel="icon" href="/icons/favicon-32.png"');
    expect(landing).not.toContain('rel="manifest"');
    expect(landing).not.toContain('apple-mobile-web-app-capable');
  });

  it('allows a valid, content-free pairing marker to redirect before paint and otherwise fails open', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(landing)?.[1];
    expect(script).toBeDefined();
    expect(script).toContain("localStorage.getItem('fy-has-pairings-v1') === '1'");
    expect(script).toContain("has('stay')");
    expect(script).toContain("location.replace('/app/')");
    expect(script).toContain('try');
    expect(script).toContain('catch');
    expect(script).not.toContain('indexedDB');

    const hash = createHash('sha256')
      .update(script ?? '')
      .digest('base64');
    expect(headers).toContain(`'sha256-${hash}'`);
  });

  it('routes both app navigation and QR pairing deep links to the PWA entry', () => {
    expect(redirects).toContain('/app/* /app/index.html 200');
    expect(redirects).toContain('/d/* /app/index.html 200');
    expect(redirects).toContain('/setup /app/index.html 200');
    expect(redirects).toContain('/pair /app/index.html 200');
    expect(redirects).toContain('/pair/* /app/index.html 200');
  });
});
