import { describe, it } from 'bun:test';
import { hidePairingFragments, PAIRING_FRAGMENT_HIDDEN } from '@ferretry/protocol';
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
      `Read (now at https://x.test/pair${FRAGMENT}). Earlier "https://y.test/pair${FRAGMENT}" and again`,
    );

    // Assert
    should(hidden).equal(
      `Read (now at https://x.test/pair${PAIRING_FRAGMENT_HIDDEN}). Earlier "https://y.test/pair${PAIRING_FRAGMENT_HIDDEN}" and again`,
    );
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
