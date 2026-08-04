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

  it('positions Ferretry as the self-hosted guide for developers running agents', () => {
    expect(landing).toContain('Your agents keep working.');
    expect(landing).toContain('Ferretry is an agent operating system for Claude and Codex:');
    expect(landing).toContain('It does not replace either harness.');
    expect(landing).toContain('No Ferretry server.');
  });

  it('does not market known unmounted or unenforced surfaces as complete', () => {
    expect(landing).not.toContain('Agent-to-agent messages');
    expect(landing).not.toContain('Peer messages carry their sender');
    expect(landing).not.toContain('same-kind accounts');
    expect(landing).not.toContain('automatic failover');
    expect(landing).not.toContain('remote browser');
    expect(landing).not.toContain('structured question');
    expect(landing).not.toContain('spend and tokens');
    expect(landing).not.toContain('from anywhere');
    expect(landing).not.toContain('phone');
    expect(landing).not.toContain('tunnel');
    expect(landing).not.toContain('tailnet');
    expect(landing).not.toContain('remote');
  });

  it('keeps a tab favicon without presenting itself as the installable app', () => {
    expect(landing).toContain('rel="icon" href="/icons/favicon.svg"');
    expect(landing).toContain('rel="icon" href="/icons/favicon-32.png"');
    expect(landing).not.toContain('rel="manifest"');
    expect(landing).not.toContain('apple-mobile-web-app-capable');
  });

  it('allows a valid, content-free pairing marker to redirect before paint and otherwise fails open', () => {
    const scripts = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)].flatMap(match =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(scripts).toHaveLength(2);
    const redirectScript = scripts[0] ?? '';
    expect(redirectScript).toContain("localStorage.getItem('fy-has-pairings-v1') === '1'");
    expect(redirectScript).toContain("has('stay')");
    expect(redirectScript).toContain("location.replace('/app/')");
    expect(redirectScript).toContain('try');
    expect(redirectScript).toContain('catch');
    expect(redirectScript).not.toContain('indexedDB');

    for (const script of scripts) {
      const hash = createHash('sha256').update(script).digest('base64');
      expect(headers).toContain(`'sha256-${hash}'`);
    }
  });

  it('routes both app navigation and QR pairing deep links to the PWA entry', () => {
    expect(redirects).toContain('/app/* /app/index.html 200');
    expect(redirects).toContain('/d/* /app/index.html 200');
    expect(redirects).toContain('/setup /app/index.html 200');
    expect(redirects).toContain('/pair /app/index.html 200');
    expect(redirects).toContain('/pair/* /app/index.html 200');
  });
});
