/** r12 H2 — the URL policy every hypermedia link passes: outside http(s)/mailto and in-page anchors only; never an image, an app route or a reference envelope. */
import { describe, expect, it } from 'bun:test';
import { hypermediaUrlPolicy } from '../../../../app/hypermedia/url-policy.ts';

const link = (url: string): string | null => hypermediaUrlPolicy(url, 'link');

describe('hypermediaUrlPolicy', () => {
  it('lets an outside link, a mail link and an in-page anchor through', () => {
    expect(link('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(link('http://example.com')).toBe('http://example.com');
    expect(link('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(link('#a-heading')).toBe('#a-heading');
  });

  it('drops a script, a data URL and anything that is not a plain outside address', () => {
    for (const url of [
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'blob:x',
      '//evil.test/x',
      'docs/a.md',
      '/d/daemon/session/x',
      '/',
      '',
      ' ',
    ])
      expect(link(url)).toBeNull();
  });

  it('drops a reference envelope however it is spelled', () => {
    for (const url of [
      '#fy-reference?kind=task&id=F12',
      '#FY-Reference?kind=task',
      '#%66y-reference?kind=task',
      '# fy-reference?kind=task',
      '#fy-reference',
    ])
      expect(link(url)).toBeNull();
  });

  it('never draws an image', () => {
    expect(hypermediaUrlPolicy('https://example.com/a.png', 'image')).toBeNull();
    expect(hypermediaUrlPolicy('a.png', 'image')).toBeNull();
  });
});
