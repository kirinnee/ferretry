import { describe, expect, test } from 'bun:test';
import { HIDDEN_FRAGMENT, hideCredentialFragments, mapStrings } from '../../daemon/address-rule.ts';

/**
 * PARITY WITH v4 4.291.16 (#1596, "hide pairing codes in every browser tool result"): the cases that fix named, run
 * against 5.0's own address rule. FAKE material only.
 */
const FAKE_CODE = '7F3K-Q2ND';
const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const FRAGMENT = `#v1;url=${encodeURIComponent('https://box.example.test')};code=${FAKE_CODE};fp=${DAEMON_ID}`;

describe('v4 #1596 parity: the address rule hides every spelling that fix named', () => {
  test('hides the fragment, keeps the address, in a sentence and every time', () => {
    const hidden = hideCredentialFragments(
      `Read at https://x.test/pair${FRAGMENT} now. Earlier https://y.test/pair${FRAGMENT} ok`,
    );
    expect(hidden).not.toContain(FAKE_CODE);
    expect(hidden).not.toContain(DAEMON_ID);
    expect(hidden).toContain(`https://x.test/pair${HIDDEN_FRAGMENT}`);
    expect(hidden).toContain(`https://y.test/pair${HIDDEN_FRAGMENT}`);
  });

  for (const ignored of [
    'note=(a)',
    'note=[a]',
    'note={a}',
    "note=it's",
    'note="quoted"',
    'note=\\back',
    'note=<b>',
    'note=`tick`',
    'note=a,b:c!*~',
  ])
    test(`hides the code after an ignored field holding ${ignored}, raw and percent-encoded once or twice`, () => {
      const link = `https://app.example.test/pair#v1;${ignored};code=${FAKE_CODE};fp=${DAEMON_ID}`;
      const texts = [
        hideCredentialFragments(link),
        hideCredentialFragments(`https://login.test/?next=${encodeURIComponent(link)}&a=1`),
        hideCredentialFragments(`https://l.test/?n=${encodeURIComponent(encodeURIComponent(link))}`),
      ];
      for (const text of texts) {
        expect(text).not.toContain(FAKE_CODE);
        expect(text).not.toContain(DAEMON_ID);
      }
    });

  test('hides the code whatever the order of the fields, and a catalog link', () => {
    expect(hideCredentialFragments(`https://p.test/pair#v1;fp=${DAEMON_ID};code=${FAKE_CODE};url=x`)).toBe(
      `https://p.test/pair${HIDDEN_FRAGMENT}`,
    );
    expect(hideCredentialFragments('https://p.test/get#v1;b=abc;k=SECRETKEY;fp=xyz')).toBe(
      `https://p.test/get${HIDDEN_FRAGMENT}`,
    );
  });

  test('hides a long run of punctuation after a fragment', () => {
    const hidden = hideCredentialFragments(`#v1;${';'.repeat(2_000)}x`);
    expect(hidden).toBe(HIDDEN_FRAGMENT);
  });

  test('leaves an ordinary fragment, an address with none, a query code and plain text exactly as they are', () => {
    for (const text of [
      'https://docs.test/guide#section-2',
      'https://docs.test/guide#v10-notes',
      'https://docs.test/guide?code=7F3K-Q2ND',
      'Welcome back',
      '',
    ])
      expect(hideCredentialFragments(text)).toBe(text);
  });

  test('hides the fragment in every string of a nested result and leaves picture bytes and the input alone', () => {
    const link = `https://app.example.test/pair${FRAGMENT}`;
    const result = {
      status: { url: link, pages: [{ id: 'p1', url: link, title: 'Pair' }], viewers: 0 },
      text: `at ${link}`,
    };
    const hidden = mapStrings(result, hideCredentialFragments);
    expect(hidden.status.url).toBe(`https://app.example.test/pair${HIDDEN_FRAGMENT}`);
    expect(hidden.status.pages[0]?.title).toBe('Pair');
    expect(hidden.text).toBe(`at https://app.example.test/pair${HIDDEN_FRAGMENT}`);
    expect(result.status.url).toBe(link);
  });
});

describe('v4 #1596 parity: closing punctuation around an address is given back', () => {
  test('gives back a closing quote, and hides all of a link (5.0 also takes a bare closing paren with it: more hidden, never less)', () => {
    const hidden = hideCredentialFragments(
      `(see https://x.test/pair${FRAGMENT}). Then "https://y.test/pair${FRAGMENT}", ok`,
    );
    expect(hidden).toBe(`(see https://x.test/pair${HIDDEN_FRAGMENT} Then "https://y.test/pair${HIDDEN_FRAGMENT}", ok`);
    expect(hideCredentialFragments(`https://z.test/pair#v1;code=${FAKE_CODE}`)).toBe(
      `https://z.test/pair${HIDDEN_FRAGMENT}`,
    );
  });

  test('hides a quote-like stop inside the fragment of a link that is itself quoted', () => {
    const hidden = hideCredentialFragments(
      `open "https://p.test/pair#v1;note=it's;code=${FAKE_CODE};fp=${DAEMON_ID}" now`,
    );
    expect(hidden).toBe(`open "https://p.test/pair${HIDDEN_FRAGMENT}" now`);
  });
});

describe('v4 #1596 parity: the quote-stop stretch is hidden', () => {
  test('hides a long run of quote characters after a fragment ', () => {
    const hidden = hideCredentialFragments(`#v1;'${"'".repeat(2_000)}x`);
    expect(hidden).toBe(HIDDEN_FRAGMENT);
  });

  test('hides many short quote-bearing words after a fragment ', () => {
    const hidden = hideCredentialFragments(`#v1;${";x'y ".repeat(400)}`);
    expect(hidden).toContain(HIDDEN_FRAGMENT);
  });
});
