import { describe, it } from 'bun:test';
import should from 'should';
import { QrCodeTerminal } from '../../../src/adapters/pair/qr-terminal';
import { qrColumns } from '../../../src/lib/pair/qr';

/** A realistic pairing link: a tailnet origin plus a full SHA-256 fingerprint is the worst normal case. */
const LINK =
  'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fbox.tailnet-abc.ts.net;code=7F3K-Q2ND;fp=SHA256%3AzXcVbNmAsDfGhJkLqWeRtYuIoP0123456789abcdEF';

describe('terminal QR encoder', () => {
  it('should draw a compact QR that fits an ordinary 80-column window unscrolled', async () => {
    // Arrange
    const subject = new QrCodeTerminal();

    // Act
    const actual = await subject.encode(LINK, 'compact');
    const lines = actual.split('\n');

    // Assert
    should(actual).match(/[▀▄█]/u);
    should(qrColumns(actual)).be.within(30, 78);
    // 30 rows is a stock terminal; a QR that scrolls is not a QR.
    should(lines.length).be.belowOrEqual(30);
    // Trailing blank lines would make the fit check measure a row that is not there.
    should(lines.at(-1)).not.equal('');
  });

  it('should draw a taller QR when asked for the large one', async () => {
    // Arrange
    const subject = new QrCodeTerminal();

    // Act
    const compact = await subject.encode(LINK, 'compact');
    const large = await subject.encode(LINK, 'large');

    // Assert — the same code, spending more cells so a stubborn camera can resolve it.
    should(large.split('\n').length).be.above(compact.split('\n').length);
    should(qrColumns(large)).be.above(qrColumns(compact));
  });

  it('should encode the value it was given, not a cached one', async () => {
    // Arrange
    const subject = new QrCodeTerminal();

    // Act
    const first = await subject.encode(LINK, 'compact');
    const second = await subject.encode(`${LINK}X`, 'compact');

    // Assert
    should(first).not.equal(second);
  });
});
