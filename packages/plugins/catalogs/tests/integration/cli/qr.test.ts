import { describe, it } from 'bun:test';
import should from 'should';
import { localQr, QrEncodeError } from '@ferretry/std/qr';
import { BlockQrEncoder } from '../../../cli/adapters/qr.ts';
import { workingDirectory } from '../../../cli/adapters/working-directory.ts';

const LINK = 'https://share.example.test/c/abc123';

describe('the catalogs CLI block QR', () => {
  it('should draw a large QR as a square of two-column modules inside a one-module quiet zone', async () => {
    // Arrange
    const encoder = new BlockQrEncoder();

    // Act
    const lines = (await encoder.encode(LINK, 'large')).split('\n');

    // Assert: square, a light frame all round, dark modules left as the terminal's background.
    const span = lines.length;
    should(span).be.above(21 + 2 - 1);
    for (const line of lines) should(line.length).equal(span * 2);
    should(lines[0]).equal('██'.repeat(span));
    should(lines.at(-1)).equal('██'.repeat(span));
    for (const line of lines) {
      should(line.startsWith('██')).be.true();
      should(line.endsWith('██')).be.true();
    }
    should(lines.join('').includes('  ')).be.true();
    should(new Set(lines.join('').replaceAll('██', 'L').replaceAll('  ', 'D'))).eql(new Set(['L', 'D']));
  });

  it('should draw a compact QR with two module rows to a text row, in half blocks', async () => {
    // Arrange
    const encoder = new BlockQrEncoder();
    const span = (await encoder.encode(LINK, 'large')).split('\n').length;

    // Act
    const lines = (await encoder.encode(LINK, 'compact')).split('\n');

    // Assert
    should(lines.length).equal(Math.ceil(span / 2));
    for (const line of lines) should(line.length).equal(span);
    // The first text row is the quiet zone over the first module row: its top half is always light.
    for (const glyph of lines[0] ?? '') should('▀█'.includes(glyph)).be.true();
    // An odd span ends on a lone quiet-zone row: its top half is light and the missing bottom half is not drawn.
    if (span % 2 === 1) should(lines.at(-1)).equal('▀'.repeat(span));
    const glyphs = new Set(lines.join(''));
    for (const glyph of glyphs) should(' ▀▄█'.includes(glyph)).be.true();
    should(glyphs.has('▀') || glyphs.has('▄')).be.true();
  });

  it('should draw the same modules in both sizes', async () => {
    // Arrange
    const encoder = new BlockQrEncoder();

    // Act
    const large = (await encoder.encode(LINK, 'large')).split('\n');
    const compact = (await encoder.encode(LINK, 'compact')).split('\n');

    // Assert: a compact text row is the large rows 2r and 2r+1 folded together.
    const light = (row: number, column: number): boolean => row >= large.length || large[row]?.[column * 2] === '█';
    compact.forEach((line, row) => {
      [...line].forEach((glyph, column) => {
        const top = light(row * 2, column);
        const bottom = row * 2 + 1 < large.length ? light(row * 2 + 1, column) : false;
        should(glyph).equal(top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ');
      });
    });
  });
});

describe('the catalogs CLI block QR draws the shared encoder symbol', () => {
  it('should leave a dark module as the terminal background and draw a light one, exactly where the shared encoder puts them', async () => {
    // Arrange
    const { modules, size } = localQr(LINK);

    // Act
    const lines = (await new BlockQrEncoder().encode(LINK, 'large')).split('\n');

    // Assert: inside the one-module quiet zone, a module is '  ' where the encoder says dark and '██' where light.
    for (let row = 0; row < size; row += 1)
      for (let column = 0; column < size; column += 1)
        should(lines[row + 1]?.slice((column + 1) * 2, (column + 2) * 2)).equal(
          modules[row]?.[column] === true ? '  ' : '██',
        );
  });

  it('should refuse a link too long for a symbol a phone reads, rather than draw a truncated code', async () => {
    // Arrange / Act / Assert
    await should(
      new BlockQrEncoder().encode('https://share.example.test/c/'.concat('x'.repeat(1200)), 'compact'),
    ).rejectedWith(QrEncodeError);
  });
});

describe('the catalogs CLI working directory', () => {
  it('should be the folder this process was run from', () => {
    // Arrange / Act / Assert
    should(workingDirectory()).equal(process.cwd());
  });
});
