import { describe, expect, test } from 'bun:test';
import { DEFAULT_HOSTED_APP_ORIGIN, HOSTED_APP_ORIGIN, hostedAppOrigin } from '../../../contract/hosted-app.ts';

describe('the hosted app origin (one owner, set at build time)', () => {
  test('a build that defines nothing links to the production app', () => {
    expect(DEFAULT_HOSTED_APP_ORIGIN).toBe('https://ferretry.pages.dev');
    expect(hostedAppOrigin(undefined)).toBe(DEFAULT_HOSTED_APP_ORIGIN);
    expect(hostedAppOrigin('')).toBe(DEFAULT_HOSTED_APP_ORIGIN);
    expect(hostedAppOrigin('   ')).toBe(DEFAULT_HOSTED_APP_ORIGIN);
  });

  test('this test run (no define) reads the default', () => {
    expect(HOSTED_APP_ORIGIN).toBe(DEFAULT_HOSTED_APP_ORIGIN);
  });

  test('a build that defines another hosted app links to it', () => {
    expect(hostedAppOrigin('https://ferretry-v5.pages.dev')).toBe('https://ferretry-v5.pages.dev');
    expect(hostedAppOrigin('https://ferretry-v5.pages.dev/')).toBe('https://ferretry-v5.pages.dev');
  });

  test('a define that is not a plain https origin is ignored, never trusted', () => {
    for (const bad of [
      'http://ferretry-v5.pages.dev',
      'https://ferretry-v5.pages.dev/pair',
      'https://ferretry-v5.pages.dev/?x=1',
      'https://ferretry-v5.pages.dev/#frag',
      'https://user:pass@ferretry-v5.pages.dev',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(hostedAppOrigin(bad)).toBe(DEFAULT_HOSTED_APP_ORIGIN);
    }
  });
});
