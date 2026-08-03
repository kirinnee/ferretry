import { describe, it } from 'bun:test';
import should from 'should';
import { QR_INDENT, qrColumns, qrFitsTerminal } from '../../../src/lib/pair/qr';

const QR = ['▀▄█▀▄█', '█▄▀▄█ ', '▀▀▀▀▀▀'].join('\n');

describe('terminal QR fit', () => {
  it('should measure the widest line in characters, not UTF-16 units', () => {
    // Every module is a multi-byte block character; measuring `.length` would double every width.
    should(qrColumns(QR)).equal(6);
    should(qrColumns('')).equal(0);
    should(qrColumns(`${QR}\n▀▄█▀▄█▀▄`)).equal(8);
  });

  it('should reserve the indent, because the QR is drawn inset', () => {
    // Arrange + Act + Assert
    should(qrFitsTerminal(QR, 6 + QR_INDENT)).be.true();
    should(qrFitsTerminal(QR, 6 + QR_INDENT - 1)).be.false();
  });

  it('should draw the QR when the terminal states no width at all', () => {
    // A pipe reports nothing. Withholding the QR there would strip it from a captured session, and a
    // terminal that declines to answer is not evidence of a narrow one.
    should(qrFitsTerminal(QR, undefined)).be.true();
  });
});
