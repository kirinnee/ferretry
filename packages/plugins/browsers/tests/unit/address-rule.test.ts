import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { Redaction } from '@ferretry/kernel/contract';
import {
  HIDDEN_FRAGMENT,
  hideCredentialFragments,
  isCredentialFragment,
  PAIRING_FRAGMENT_PATTERN,
  withAddressRule,
} from '../../daemon/address-rule.ts';
import { browserKernel } from '../support/kernel.ts';

/** FAKE material only: no real pairing code, daemon address or fingerprint appears in any test. */
const FAKE_PAIRING = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';
const FAKE_CODE = 'FAKEFAKE';

describe('the address rule: a pairing-shaped fragment never leaves the browsers plugin', () => {
  test('a pairing link keeps its path and query and loses its fragment to the fixed marker', () => {
    const hidden = hideCredentialFragments(`https://app.example.test/pair?lang=en${FAKE_PAIRING}`);
    expect(hidden).toBe(`https://app.example.test/pair?lang=en${HIDDEN_FRAGMENT}`);
    expect(hidden).not.toContain(FAKE_CODE);
  });

  test('the catalog share link (/join#v1;…share=…) and the catalog get link (/get#v1;…) are hidden', () => {
    const share = hideCredentialFragments('https://app.example.test/join#v1;url=x;fp=00;share=FAKESHARE');
    const get = hideCredentialFragments('https://app.example.test/get#v1;b=FAKEB;k=FAKEKEY;fp=00');
    expect(share).toBe(`https://app.example.test/join${HIDDEN_FRAGMENT}`);
    expect(get).toBe(`https://app.example.test/get${HIDDEN_FRAGMENT}`);
  });

  test('a bare #v1 fragment is pairing-shaped too (the codec’s own pattern admits it)', () => {
    expect(hideCredentialFragments('https://app.example.test/#v1')).toBe(`https://app.example.test/${HIDDEN_FRAGMENT}`);
  });

  test('a fragment that carries a c=, code= or share= part is hidden whatever its version', () => {
    for (const fragment of ['#c=FAKEFAKE', '#v2;code=FAKEFAKE', '#a=1&share=FAKESHARE', '#CODE=FAKEFAKE']) {
      expect(hideCredentialFragments(`https://app.example.test/x${fragment}`)).toBe(
        `https://app.example.test/x${HIDDEN_FRAGMENT}`,
      );
    }
  });

  test('a harmless fragment, a query, and text without a fragment pass untouched', () => {
    for (const text of [
      'https://example.test/docs#section',
      'https://example.test/docs#/route/3',
      'https://example.test/cb?code=OAUTHCALLBACK&state=1',
      'https://example.test/#v10',
      'https://example.test/#codec=1',
      'plain text with no address at all',
      '',
    ]) {
      expect(hideCredentialFragments(text)).toBe(text);
    }
  });

  test('a title or page text that echoes the fragment is masked wherever it sits in the text', () => {
    const text = `Open https://app.example.test/pair${FAKE_PAIRING} now, or "${FAKE_PAIRING}" alone; also ${FAKE_PAIRING}`;
    const hidden = hideCredentialFragments(text);
    expect(hidden).not.toContain(FAKE_CODE);
    expect(hidden.split(HIDDEN_FRAGMENT)).toHaveLength(4);
    expect(hidden).toContain('Open https://app.example.test/pair');
  });

  test('the fragment percent-encoded inside a query is hidden too', () => {
    const hidden = hideCredentialFragments(
      'https://login.example.test/?next=https%3A%2F%2Fapp.example.test%2F%23v1%3Bc%3DFAKEFAKE',
    );
    expect(hidden).not.toContain(FAKE_CODE);
    expect(hidden).toContain(HIDDEN_FRAGMENT);
    expect(hidden.startsWith('https://login.example.test/?next=')).toBe(true);
  });

  test('FAILS CLOSED: an address nothing can parse has everything after its first # hidden', () => {
    expect(hideCredentialFragments('http://[::1#section')).toBe(`http://[::1${HIDDEN_FRAGMENT}`);
    expect(hideCredentialFragments(`https://[bad${FAKE_PAIRING}`)).toBe(`https://[bad${HIDDEN_FRAGMENT}`);
    // …but an unparseable string with no fragment has nothing to hide.
    expect(hideCredentialFragments('http://[::1')).toBe('http://[::1');
  });

  test('isCredentialFragment shares the access codec’s pattern: v1; and a bare v1, not v10 or v1.2', () => {
    expect(isCredentialFragment('#v1;x')).toBe(true);
    expect(isCredentialFragment('v1;x')).toBe(true);
    expect(isCredentialFragment('#v1')).toBe(true);
    expect(isCredentialFragment('#v10')).toBe(false);
    expect(isCredentialFragment('#v1.2')).toBe(false);
  });
});

describe('the pairing pattern is the access codec’s own', () => {
  test('the literal spelled here equals PAIRING_FRAGMENT_PATTERN in packages/plugins/access/contract/pairing.ts', () => {
    // Read as text, not imported: a package dependency on Access would move the pinned Bun install for one pattern.
    const owner = readFileSync(new URL('../../../access/contract/pairing.ts', import.meta.url), 'utf8');
    const declared = /export const PAIRING_FRAGMENT_PATTERN = \/(.+)\/([a-z]*);/u.exec(owner);
    expect(declared).not.toBeNull();
    expect(PAIRING_FRAGMENT_PATTERN.source).toBe(declared?.[1] as string);
    expect(PAIRING_FRAGMENT_PATTERN.flags).toBe(declared?.[2] as string);
  });
});

describe('withAddressRule decorates the one redaction seam', () => {
  test('text read under it is hidden after the inner redaction has masked its own secrets, on the original bytes', async () => {
    const redaction = withAddressRule(browserKernel({ secrets: ['hunter2-token'] }).kernel.redaction);
    const out = await redaction.read(scope => scope.text(`https://x.test/?t=hunter2-token${FAKE_PAIRING}`));
    expect(out).toBe(`https://x.test/?t=${'*'.repeat('hunter2-token'.length)}${HIDDEN_FRAGMENT}`);
  });

  test('a redaction that cannot open still fails the read, so nothing is served unmasked', async () => {
    const failing: Redaction = {
      read: async () => {
        throw new Error('vault unavailable');
      },
    };
    await expect(withAddressRule(failing).read(scope => scope.text(FAKE_PAIRING))).rejects.toThrow('vault unavailable');
  });
});
