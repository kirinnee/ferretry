import qrcodeTerminal from 'qrcode-terminal';
import type { IQrEncoder } from '../../lib/pair/ports.ts';

/**
 * Draws a pairing link as a QR made of block characters.
 *
 * BLOCKS, NOT AN IMAGE FILE. The operator is often on the far end of an ssh session to a headless
 * box, where a written PNG is a file nobody will ever open. Block characters are the only carrier
 * that survives that, and they do scan: a phone camera reads luminance, and a block against the
 * terminal background carries as much contrast as printed ink.
 *
 * `compact` uses half-height blocks, so the QR is about 25 rows instead of 50 and fits an unscrolled
 * 80×30 window — which is what makes it scannable at all, because a QR split across a scroll is not a
 * QR. `large` spends a full row per module for a camera that will not focus on the dense one; the
 * caller checks the terminal width before drawing either.
 */
export class QrCodeTerminal implements IQrEncoder {
  encode(value: string, size: 'compact' | 'large'): Promise<string> {
    return new Promise(resolve => {
      // Trailing NEWLINES only. A QR line can legitimately end in spaces, which are white modules, so
      // trimming whitespace would silently narrow the code by a column.
      qrcodeTerminal.generate(value, { small: size === 'compact' }, rendered => resolve(rendered.replace(/\n+$/u, '')));
    });
  }
}
