import { describe, it } from 'bun:test';
import should from 'should';
import {
  originOfAddress,
  PAIRING_HISTORY_ORIGINS_MAX,
  PAIRING_HISTORY_OVERFLOW,
  PairingNavigationLedger,
} from '../../../../src/lib/browser/transport/pairing-history.ts';

/** The repo's committed fake code (`HARNESS_INVITE`, the pair fixtures): never a minted one. */
const FAKE_LINK =
  'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fhost.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_x';
const APP = 'https://ferretry.pages.dev';

const document = { mainFrame: true, sameDocument: false } as const;
const within = { mainFrame: false, sameDocument: true } as const;

describe('originOfAddress', () => {
  it('should name the origin, and nothing for an address that has none', () => {
    should(originOfAddress('https://ferretry.pages.dev/pair#x')).equal(APP);
    should(originOfAddress('about:blank')).equal('');
    should(originOfAddress('not an address')).equal('');
    should(originOfAddress('data:text/html,hi')).equal('');
  });
});

describe('PairingNavigationLedger', () => {
  it('should count a commit that carried a pairing fragment, by origin, and never keep the address', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');

    // Act
    ledger.committed('p1', { address: FAKE_LINK, ...document });
    ledger.committed('p1', { address: 'https://ferretry.pages.dev/other', ...document });

    // Assert
    const look = ledger.look(['p1']);
    should(look.commits).eql({ [APP]: 1 });
    should(JSON.stringify(look)).not.containEql('7F3K');
  });

  it('should count a fragment that only moved inside the document, and one in a frame inside the page', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', APP + '/');

    // Act
    ledger.committed('p1', { address: FAKE_LINK, ...within });
    ledger.committed('p1', { address: FAKE_LINK, mainFrame: false, sameDocument: false });

    // Assert
    should(ledger.look(['p1']).commits).eql({ [APP]: 2 });
  });

  it('should start a page that was already on a pairing link as linked', () => {
    const ledger = new PairingNavigationLedger();

    ledger.watch('p1', FAKE_LINK);

    should(ledger.look(['p1'])).eql({ commits: { [APP]: 1 }, linked: true, links: 1, lost: 0, blind: false });
  });

  it('should keep the document linked when the fragment is only dropped, and free it when a new document replaces it', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');
    ledger.committed('p1', { address: FAKE_LINK, ...document });

    // Act — a router drops the fragment inside the same document
    ledger.committed('p1', { address: APP + '/pair', ...within });
    const dropped = ledger.look(['p1']).linked;
    ledger.committed('p1', { address: APP + '/pair', mainFrame: false, sameDocument: false });
    const frame = ledger.look(['p1']).linked;
    ledger.committed('p1', { address: 'https://example.test/', ...document });
    const replaced = ledger.look(['p1']);

    // Assert — the count never goes down
    should(dropped).be.true();
    should(frame).be.true();
    should(replaced).eql({ commits: { [APP]: 1 }, linked: false, links: 1, lost: 0, blind: false });
  });

  it('should answer for the pages it is asked about, and keep a closed page’s commits', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');
    ledger.watch('p2', 'about:blank');
    ledger.committed('p2', { address: FAKE_LINK, ...document });

    // Act
    const mine = ledger.look(['p1']);
    const theirs = ledger.look(['p1', 'p2']);
    ledger.closed('p2');
    const gone = ledger.look(['p1', 'p2']);

    // Assert
    should(mine.linked).be.false();
    should(theirs.linked).be.true();
    should(gone).eql({ commits: { [APP]: 1 }, linked: false, links: 1, lost: 0, blind: false });
  });

  it('should count every loss on a counter that never goes down, whatever the page does or however it ends', () => {
    // Arrange — a related window loses its tracking, then leaves, then closes
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');
    ledger.watch('p2', 'about:blank');
    const before = ledger.look(['p1']).lost;

    // Act
    ledger.lost('p2');
    const during = ledger.look(['p1']).lost;
    ledger.committed('p2', { address: 'https://example.test/', ...document });
    ledger.closed('p2');
    ledger.lost('p1');

    // Assert — the page that lost it is no longer in the group, and the counter still moved
    should(before).equal(0);
    should(during).equal(1);
    should(ledger.look(['p1']).lost).equal(2);
    should(ledger.look([]).lost).equal(2);
  });

  it('should stay blind after the page that lost its history leaves the group or closes, until a fresh ledger', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');
    ledger.watch('p2', 'about:blank');

    // Act
    ledger.lost('p2');
    ledger.closed('p2');

    // Assert — an unrelated page's look is blind too: the missed navigation's origin cannot be proved safe
    should(ledger.look(['p1']).blind).be.true();
    should(ledger.look([]).blind).be.true();
    should(new PairingNavigationLedger().look(['p1']).blind).be.false();
  });

  it('should fold origins past its bound into one bucket a guard reads as every origin', () => {
    // Arrange
    const ledger = new PairingNavigationLedger();
    ledger.watch('p1', 'about:blank');

    // Act
    for (let at = 0; at < PAIRING_HISTORY_ORIGINS_MAX + 3; at += 1)
      ledger.committed('p1', { address: `https://o${String(at)}.example.test/#v1;code=x`, ...document });

    // Assert
    const { commits } = ledger.look(['p1']);
    should(Object.keys(commits)).have.length(PAIRING_HISTORY_ORIGINS_MAX + 1);
    should(commits[PAIRING_HISTORY_OVERFLOW]).equal(3);
  });
});

describe('PairingNavigationLedger — pairing links on any origin', () => {
  const ELSEWHERE_LINK = 'https://other.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A9;code=FAKE-FAKE;fp=fake';
  const ELSEWHERE = 'https://other.example.test/';

  it('should count the links a set of pages entered, on whatever origin, even when the document is replaced at once', () => {
    // Arrange — the reviewer's third probe: a link-entered document that commits only briefly
    const ledger = new PairingNavigationLedger();
    ledger.watch('p', ELSEWHERE);
    should(ledger.look(['p']).links).equal(0);

    // Act
    ledger.committed('p', { address: ELSEWHERE_LINK, ...document });
    ledger.committed('p', { address: ELSEWHERE, ...document });

    // Assert — the document is no longer linked, and the count still says it was
    const look = ledger.look(['p']);
    should(look.linked).be.false();
    should(look.links).equal(1);
  });

  it('should count by page, so a page outside the set does not move the set’s count, and a closed page keeps its links', () => {
    const ledger = new PairingNavigationLedger();
    ledger.watch('p', ELSEWHERE);
    ledger.watch('q', ELSEWHERE);

    ledger.committed('q', { address: ELSEWHERE_LINK, ...document });
    should(ledger.look(['p']).links).equal(0);

    ledger.closed('q');
    should(ledger.look(['p', 'q']).links).equal(1);
    should(JSON.stringify(ledger.look(['q']))).not.containEql('FAKE');
  });

  it('should count a fragment that only moved inside the document, and one in a frame', () => {
    const ledger = new PairingNavigationLedger();
    ledger.watch('p', ELSEWHERE);

    ledger.committed('p', { address: ELSEWHERE_LINK, ...within });
    ledger.committed('p', { address: ELSEWHERE_LINK, mainFrame: false, sameDocument: false });

    should(ledger.look(['p']).links).equal(2);
  });
});
