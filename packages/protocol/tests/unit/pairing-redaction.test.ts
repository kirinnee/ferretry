import { describe, it } from 'bun:test';
import {
  hidePairingFragments,
  hidePairingFragmentsIn,
  PAIRING_FRAGMENT_HIDDEN,
  PAIRING_SCREEN_META_NAME,
  PAIRING_SCREEN_SELECTOR,
} from '@ferretry/protocol';
import should from 'should';

const FAKE_CODE = '7F3K-Q2ND';
const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const FRAGMENT = `#v1;url=${encodeURIComponent('https://box.example.test')};code=${FAKE_CODE};fp=${DAEMON_ID}`;

describe('hidePairingFragments', () => {
  it('should hide the fragment of a pairing link and keep the rest of the address', () => {
    // Act
    const hidden = hidePairingFragments(`https://ferretry.pages.dev/pair${FRAGMENT}`);

    // Assert
    should(hidden).equal(`https://ferretry.pages.dev/pair${PAIRING_FRAGMENT_HIDDEN}`);
    should(hidden).not.containEql(FAKE_CODE);
  });

  it('should hide it wherever it sits in a sentence, and every time it appears', () => {
    // Act
    const hidden = hidePairingFragments(
      `Read at https://x.test/pair${FRAGMENT} now. Earlier https://y.test/pair${FRAGMENT} ok`,
    );

    // Assert — a fragment ends at whitespace, so what stands after it in the SAME word is hidden with it.
    should(hidden).equal(
      `Read at https://x.test/pair${PAIRING_FRAGMENT_HIDDEN} now. Earlier https://y.test/pair${PAIRING_FRAGMENT_HIDDEN} ok`,
    );
  });

  // docs/pairing.md: a reader ignores a field it does not know and does not care about field ORDER, so a valid
  // fragment can carry ANY punctuation in a field that stands before the code. The whole fragment is hidden once
  // it starts; no field is parsed to find where the code is.
  const IGNORED_FIELDS = [
    'note=(a)',
    'note=[a]',
    'note={a}',
    "note=it's",
    'note="quoted"',
    'note=\\back',
    'note=<b>',
    'note=`tick`',
    'note=a,b:c!*~',
  ];
  for (const ignored of IGNORED_FIELDS)
    it(`should hide the code that follows an ignored field holding ${ignored}`, () => {
      // Arrange
      const link = `https://ferretry.pages.dev/pair#v1;${ignored};code=${FAKE_CODE};fp=${DAEMON_ID}`;

      // Act
      const hidden = hidePairingFragments(link);
      const encoded = hidePairingFragments(`https://login.test/?next=${encodeURIComponent(link)}&a=1`);
      const twice = hidePairingFragments(`https://l.test/?n=${encodeURIComponent(encodeURIComponent(link))}`);

      // Assert
      should(hidden).equal(`https://ferretry.pages.dev/pair${PAIRING_FRAGMENT_HIDDEN}`);
      for (const text of [hidden, encoded, twice]) {
        should(text).not.containEql(FAKE_CODE);
        should(text).not.containEql(DAEMON_ID);
      }
      should(encoded).containEql(PAIRING_FRAGMENT_HIDDEN);
    });

  it('should give back the sentence punctuation that closes the address, and nothing the code could be in', () => {
    // Act
    const hidden = hidePairingFragments(
      `(see https://x.test/pair${FRAGMENT}). Then "https://y.test/pair${FRAGMENT}", ok`,
    );
    const bare = hidePairingFragments(`https://z.test/pair#v1;code=${FAKE_CODE}`);

    // Assert
    should(hidden).equal(
      `(see https://x.test/pair${PAIRING_FRAGMENT_HIDDEN}). Then "https://y.test/pair${PAIRING_FRAGMENT_HIDDEN}", ok`,
    );
    should(bare).equal(`https://z.test/pair${PAIRING_FRAGMENT_HIDDEN}`);
  });

  it('should hide a long run of punctuation after a fragment without taking quadratic time', () => {
    // Act
    const started = performance.now();
    const hidden = hidePairingFragments(`#v1;${';'.repeat(200_000)}x`);

    // Assert
    should(hidden).equal(PAIRING_FRAGMENT_HIDDEN);
    should(performance.now() - started).be.below(2000);
  });

  it('should hide the code whatever the order of the fields', () => {
    // Act
    const hidden = hidePairingFragments(`https://p.test/pair#v1;fp=${DAEMON_ID};code=${FAKE_CODE};url=x`);

    // Assert
    should(hidden).equal(`https://p.test/pair${PAIRING_FRAGMENT_HIDDEN}`);
  });

  it('should hide a fragment that was percent-encoded into another address', () => {
    // Act
    const hidden = hidePairingFragments(
      `https://login.test/?next=${encodeURIComponent(`https://ferretry.pages.dev/pair${FRAGMENT}`)}&a=1`,
    );

    // Assert
    should(hidden).not.containEql(FAKE_CODE);
    should(hidden).containEql(PAIRING_FRAGMENT_HIDDEN);
  });

  it('should hide a catalog link, which rides the same grammar', () => {
    // Act
    const hidden = hidePairingFragments('https://ferretry.pages.dev/get#v1;b=abc;k=SECRETKEY;fp=xyz');

    // Assert
    should(hidden).equal(`https://ferretry.pages.dev/get${PAIRING_FRAGMENT_HIDDEN}`);
  });

  it('should leave an ordinary fragment, an address with none, and plain text exactly as they are', () => {
    for (const text of [
      'https://docs.test/guide#section-2',
      'https://docs.test/guide#v10-notes',
      'https://docs.test/guide#v1',
      'https://docs.test/guide?code=7F3K-Q2ND',
      'Welcome back',
      '',
    ])
      should(hidePairingFragments(text)).equal(text);
  });
});

describe('hidePairingFragmentsIn', () => {
  it('should hide the fragment in every string of a nested result and leave the rest, picture bytes included', () => {
    // Arrange
    const link = `https://ferretry.pages.dev/pair${FRAGMENT}`;
    const result = {
      status: { url: link, pages: [{ id: 'p1', url: link, title: 'Pair' }], viewers: 0, ok: true },
      result: { text: `at ${link}`, screenshotBase64: `iVBOR${FRAGMENT}` },
    };

    // Act
    const hidden = hidePairingFragmentsIn(result);

    // Assert
    const hiddenLink = `https://ferretry.pages.dev/pair${PAIRING_FRAGMENT_HIDDEN}`;
    should(hidden.status.url).equal(hiddenLink);
    should(hidden.status.pages[0]?.url).equal(hiddenLink);
    should(hidden.status.pages[0]?.title).equal('Pair');
    should(hidden.status.viewers).equal(0);
    should(hidden.result.text).equal(`at ${hiddenLink}`);
    should(hidden.result.screenshotBase64).equal(result.result.screenshotBase64);
    // The input is not touched.
    should(result.status.url).equal(link);
  });
});

describe('the pairing-screen marker', () => {
  it('should name one meta element, and select exactly it', () => {
    should(PAIRING_SCREEN_META_NAME).equal('ferretry-pairing-screen');
    should(PAIRING_SCREEN_SELECTOR).equal('meta[name="ferretry-pairing-screen"]');
  });
});
