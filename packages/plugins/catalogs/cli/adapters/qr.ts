import qrcode from 'qrcode-generator';
import type { IQrEncoder } from '../lib/catalog-share/ports.ts';

/** Light modules are drawn, dark ones left as the terminal's background, around a one-module quiet zone. */
const QUIET = 1;

/**
 * Draws a share link as a QR made of block characters, generated here and never by an image service (today's
 * `QrCodeTerminal` over `qrcode-terminal`, which is not a workspace dependency on 5.0; `qrcode-generator` is). BLOCKS,
 * NOT AN IMAGE FILE: the owner is often at the far end of an ssh session. `compact` puts two module rows in one text
 * row with half blocks so the code fits an unscrolled window; `large` spends two columns and one row per module.
 */
export class BlockQrEncoder implements IQrEncoder {
  async encode(value: string, size: 'compact' | 'large'): Promise<string> {
    const code = qrcode(0, 'L');
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    const span = count + QUIET * 2;
    const light = (row: number, column: number): boolean => {
      const r = row - QUIET;
      const c = column - QUIET;
      return r < 0 || c < 0 || r >= count || c >= count || !code.isDark(r, c);
    };
    const lines: string[] = [];
    if (size === 'large') {
      for (let row = 0; row < span; row += 1) {
        let line = '';
        for (let column = 0; column < span; column += 1) line += light(row, column) ? '██' : '  ';
        lines.push(line);
      }
      return lines.join('\n');
    }
    for (let row = 0; row < span; row += 2) {
      let line = '';
      for (let column = 0; column < span; column += 1) {
        const top = light(row, column);
        const bottom = row + 1 < span ? light(row + 1, column) : false;
        line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}
