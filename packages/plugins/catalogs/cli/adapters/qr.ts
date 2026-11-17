import { localQr } from '@ferretry/std/qr';
import type { IQrEncoder } from '../lib/catalog-share/ports.ts';

/** Light modules are drawn, dark ones left as the terminal's background, around a one-module quiet zone. */
const QUIET = 1;

/**
 * Draws a share link as a QR made of block characters, generated here and never by an image service. The MODULES are
 * the workspace's one encoder (`@ferretry/std/qr`, the same one the app halves draw with; a CLI half may not import the
 * app shell, so it lives in the shared package); this file only turns them into text. BLOCKS, NOT AN IMAGE FILE: the
 * owner is often at the far end of an ssh session. `compact` puts two module rows in one text row with half blocks so
 * the code fits an unscrolled window; `large` spends two columns and one row per module. A link too long for a symbol a
 * phone reads reliably throws `QrEncodeError` rather than drawing a truncated code.
 */
export class BlockQrEncoder implements IQrEncoder {
  async encode(value: string, size: 'compact' | 'large'): Promise<string> {
    const { modules, size: count } = localQr(value);
    const span = count + QUIET * 2;
    const light = (row: number, column: number): boolean => {
      const r = row - QUIET;
      const c = column - QUIET;
      return r < 0 || c < 0 || r >= count || c >= count || modules[r]?.[c] !== true;
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
